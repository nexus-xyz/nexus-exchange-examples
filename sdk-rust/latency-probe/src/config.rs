//! Configuration, validated before a single request goes out.
//!
//! Every limit here is a **hard** bound, not a default a reader can talk their
//! way past: this app places real orders, so the worst case it can be configured
//! into has to be a number printed in this file.

use std::env;
use std::time::Duration;

/// Testnet's durable REST base. The `/indexer` prefix is load-bearing: the whole
/// API is mounted under it and the bare host answers `404`.
///
/// Spelled out rather than left to `Network::Testnet`, as `liquidation-watch`
/// does and for the same reason: in SDK `0.11.0`, `Network::Testnet.base_url()`
/// is still the decommissioned `https://exchange.nexus.xyz/api/exchange`.
pub const TESTNET_BASE_URL: &str = "https://api.testnet.nexus.xyz/indexer";

/// Testnet's WebSocket origin, prefix included.
///
/// `Network::Testnet.ws_base()` is `None` in SDK `0.11.0` (ENG-3398), so the
/// stream has to be told where to go. It is the same deployment as
/// [`TESTNET_BASE_URL`], which matters: the upgrade token is minted over REST
/// and is only good on the origin that issued it.
pub const TESTNET_WS_URL: &str = "wss://api.testnet.nexus.xyz/indexer/ws";

/// Label for the `CustomNetwork` this app builds. The SDK refuses every
/// built-in network's own name here, `"custom"` included.
pub const NETWORK_LABEL: &str = "testnet-durable";

/// Hard ceiling on round trips per run. Two orders a second for a hundred
/// seconds is already more than enough to see a p99.
pub const MAX_ITERATIONS: u32 = 200;
const DEFAULT_ITERATIONS: u32 = 30;

/// Floor on the gap between round trips. Rate-limit pacing can only make it
/// longer (see `main::pace`), never shorter.
pub const MIN_INTERVAL: Duration = Duration::from_millis(250);
const DEFAULT_INTERVAL_MS: u64 = 1000;

/// How long to wait for a WebSocket frame before recording that stage as
/// missing. Bounded both ways: too short reports slow frames as absent, too long
/// leaves an order resting for no reason.
const MIN_WS_WAIT_MS: u64 = 500;
const MAX_WS_WAIT_MS: u64 = 30_000;
const DEFAULT_WS_WAIT_MS: u64 = 3000;

pub const DEFAULT_MARKET: &str = "BTC-USDX-PERP";

#[derive(Debug, Clone)]
pub struct Config {
    /// `Some` only in `--live` mode. The dry run is public data only.
    pub credentials: Option<(String, String)>,
    pub base_url: String,
    pub ws_url: String,
    /// True when both URLs are this app's own testnet defaults — the only
    /// target it is willing to call play funds.
    pub target_is_default: bool,
    pub market: String,
    pub iterations: u32,
    pub interval: Duration,
    pub ws_wait: Duration,
    /// Distance below the mark to rest the order, in bps. `None` means "80% of
    /// the venue's live band", which is decided once the band is read.
    pub offset_bps: Option<u32>,
    pub live: bool,
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

pub enum Startup {
    Run(Config),
    Usage,
}

pub const USAGE: &str = "\
latency-probe — place/cancel latency for one Nexus Exchange testnet account.

Usage:
  latency-probe            dry run: read the market, print the order it would
                           place, place nothing. No credentials needed.
  latency-probe --live     run the probe: place and cancel post-only orders.

Options:
  --live       Actually place orders. Needs NEXUS_EXCHANGE_API_KEY/SECRET.
  -h, --help   Print this and exit.

Everything else comes from the environment — see .env.example.";

fn var(name: &str) -> Option<String> {
    match env::var(name) {
        Ok(raw) if !raw.trim().is_empty() => Some(raw.trim().to_string()),
        _ => None,
    }
}

/// A whole number within `[min, max]`, or the default when unset. Out of range
/// is refused, never clamped: a clamped cap is a cap the reader did not choose.
fn bounded(name: &str, default: u64, min: u64, max: u64) -> Result<u64, ConfigError> {
    let Some(raw) = var(name) else {
        return Ok(default);
    };
    let value: u64 = raw
        .parse()
        .map_err(|_| ConfigError(format!("{name} must be a whole number, got {raw:?}")))?;
    if !(min..=max).contains(&value) {
        return Err(ConfigError(format!(
            "{name} must be between {min} and {max}, got {value}"
        )));
    }
    Ok(value)
}

/// Unknown arguments are refused rather than ignored: `--Live` or `--live=1`
/// silently becoming a dry run would be harmless, but the reverse habit is not.
fn parse_args(args: &[String]) -> Result<bool, ConfigError> {
    let mut live = false;
    for arg in args {
        match arg.as_str() {
            "--live" => live = true,
            other => {
                return Err(ConfigError(format!(
                    "unrecognised argument {other:?}.\n\n{USAGE}"
                )))
            }
        }
    }
    Ok(live)
}

pub fn load(args: &[String]) -> Result<Startup, ConfigError> {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        return Ok(Startup::Usage);
    }
    let live = parse_args(args)?;

    let credentials = match (
        var("NEXUS_EXCHANGE_API_KEY"),
        var("NEXUS_EXCHANGE_API_SECRET"),
    ) {
        (Some(key), Some(secret)) => Some((key, secret)),
        (None, None) => None,
        _ => {
            return Err(ConfigError(
                "only one of NEXUS_EXCHANGE_API_KEY / NEXUS_EXCHANGE_API_SECRET is set. \
                 Set both, or neither for a dry run."
                    .to_string(),
            ))
        }
    };
    if live && credentials.is_none() {
        return Err(ConfigError(
            "--live places orders, so it needs NEXUS_EXCHANGE_API_KEY and \
             NEXUS_EXCHANGE_API_SECRET. Run without --live for a credential-free dry run."
                .to_string(),
        ));
    }

    let base_override = var("NEXUS_EXCHANGE_API_URL");
    let ws_override = var("NEXUS_EXCHANGE_WS_URL");
    // Overriding one origin and not the other pairs a token minted by one host
    // with a socket on another, which fails in a confusing way. Refuse up front.
    if base_override.is_some() != ws_override.is_some() {
        return Err(ConfigError(
            "set NEXUS_EXCHANGE_API_URL and NEXUS_EXCHANGE_WS_URL together, or neither: \
             the WebSocket token is minted over REST and only works on the same deployment."
                .to_string(),
        ));
    }
    if let Some(base) = &base_override {
        if base.trim_end_matches('/').ends_with("/api/v1") {
            return Err(ConfigError(
                "NEXUS_EXCHANGE_API_URL must not end in /api/v1 — the SDK appends it itself."
                    .to_string(),
            ));
        }
    }

    let offset_bps = match var("NEXUS_PROBE_OFFSET_BPS") {
        None => None,
        Some(_) => Some(bounded("NEXUS_PROBE_OFFSET_BPS", 0, 50, 5000)? as u32),
    };

    Ok(Startup::Run(Config {
        credentials,
        target_is_default: base_override.is_none(),
        base_url: base_override.unwrap_or_else(|| TESTNET_BASE_URL.to_string()),
        ws_url: ws_override.unwrap_or_else(|| TESTNET_WS_URL.to_string()),
        market: var("NEXUS_PROBE_MARKET").unwrap_or_else(|| DEFAULT_MARKET.to_string()),
        iterations: bounded(
            "NEXUS_PROBE_ITERATIONS",
            DEFAULT_ITERATIONS as u64,
            1,
            MAX_ITERATIONS as u64,
        )? as u32,
        interval: Duration::from_millis(bounded(
            "NEXUS_PROBE_INTERVAL_MS",
            DEFAULT_INTERVAL_MS,
            MIN_INTERVAL.as_millis() as u64,
            60_000,
        )?),
        ws_wait: Duration::from_millis(bounded(
            "NEXUS_PROBE_WS_WAIT_MS",
            DEFAULT_WS_WAIT_MS,
            MIN_WS_WAIT_MS,
            MAX_WS_WAIT_MS,
        )?),
        offset_bps,
        live,
    }))
}
