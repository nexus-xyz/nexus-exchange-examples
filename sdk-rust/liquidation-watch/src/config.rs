//! Configuration, validated before a single request goes out.
//!
//! Every check here is local: it costs nothing, and a misconfiguration caught on
//! this machine never becomes a request against someone's account.

use std::env;

/// Testnet's durable base. The `/indexer` prefix is load-bearing — the whole API
/// is mounted under it and the bare host answers `404`.
///
/// This is spelled out rather than left to `Network::Testnet` on purpose. In SDK
/// `0.11.0`, `Network::Testnet.base_url()` is still
/// `https://exchange.nexus.xyz/api/exchange`, which is decommissioned and
/// answers `500` on every route (measured 2026-09-09). Naming the base here is
/// what makes the example run at all; see the README's "Which deployment it
/// talks to".
pub const TESTNET_BASE_URL: &str = "https://api.testnet.nexus.xyz/indexer";

/// Label for the [`CustomNetwork`](nexus_exchange::CustomNetwork) this app
/// builds.
///
/// Not decoration: the SDK namespaces stored credentials by this label and
/// **refuses every built-in network's own name**, including the literal
/// `"custom"` that its deprecated `Config::with_base_url` reserves. So the label
/// has to be a name no built-in answers to.
pub const NETWORK_LABEL: &str = "testnet-durable";

/// Server maximum for both ADL history reads.
const MAX_ADL_LIMIT: u32 = 1000;
const DEFAULT_ADL_LIMIT: u32 = 20;

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub api_secret: String,
    /// REST base. Defaults to [`TESTNET_BASE_URL`].
    pub base_url: String,
    /// `true` when the base is the app's own testnet default, which is the only
    /// target this app is willing to call play funds.
    pub base_is_default: bool,
    /// The account's own `0x` address, when supplied. There is no "who am I"
    /// read on the API surface the SDK wraps, so the account-scoped ADL history
    /// is skipped rather than guessed at when this is unset.
    pub address: Option<String>,
    pub adl_limit: u32,
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// Read an environment variable, treating blank as absent.
fn var(name: &str) -> Option<String> {
    match env::var(name) {
        Ok(raw) if !raw.trim().is_empty() => Some(raw.trim().to_string()),
        _ => None,
    }
}

/// Describe a credential without ever revealing it — a length and an alphabet,
/// never a value and never a prefix. A prefix is enough to confirm a guess, so
/// "starts with `a1b2`" is a leak with extra steps.
pub fn describe_secret(value: &str) -> String {
    let alphabet = if value.chars().all(|c| c.is_ascii_hexdigit()) {
        "hex"
    } else if value.chars().all(|c| c.is_ascii_alphanumeric()) {
        "alphanumeric"
    } else {
        "mixed"
    };
    format!("set ({} characters, {alphabet})", value.chars().count())
}

/// A `0x`-prefixed 20-byte address, or a refusal.
///
/// Validated because it is interpolated into a request **path**. The SDK
/// percent-encodes the segment, so a bad value cannot escape the path — but it
/// would spend a signed request to learn that, and the resulting `404` looks
/// nothing like "you pasted a transaction hash".
fn address() -> Result<Option<String>, ConfigError> {
    let Some(raw) = var("NEXUS_ACCOUNT_ADDRESS") else {
        return Ok(None);
    };
    let body = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X"));
    let Some(body) = body else {
        return Err(ConfigError(format!(
            "NEXUS_ACCOUNT_ADDRESS must be a 0x-prefixed account address, got {raw:?}"
        )));
    };
    if body.len() != 40 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ConfigError(format!(
            "NEXUS_ACCOUNT_ADDRESS must be 0x followed by 40 hex characters, got {} characters",
            body.len()
        )));
    }
    Ok(Some(format!("0x{}", body.to_ascii_lowercase())))
}

fn adl_limit() -> Result<u32, ConfigError> {
    let Some(raw) = var("NEXUS_ADL_LIMIT") else {
        return Ok(DEFAULT_ADL_LIMIT);
    };
    let limit: u32 = raw.parse().map_err(|_| {
        ConfigError(format!(
            "NEXUS_ADL_LIMIT must be a whole number of events, got {raw:?}"
        ))
    })?;
    if limit == 0 || limit > MAX_ADL_LIMIT {
        return Err(ConfigError(format!(
            "NEXUS_ADL_LIMIT must be between 1 and {MAX_ADL_LIMIT}, got {limit}"
        )));
    }
    Ok(limit)
}

/// What `--help` prints. The app takes no options at all, and saying so is
/// cheaper than making a reader open `main.rs` to find that out.
pub const USAGE: &str = "\
liquidation-watch — distance-to-liquidation and margin health for one Nexus
Exchange account, next to the venue's own ADL record.

Usage:
  liquidation-watch

Options:
  -h, --help   Print this and exit.

This app is read-only: it places no orders, cancels nothing, and moves no funds.
Credentials and settings come from the environment. See .env.example for every
variable and its meaning.";

pub enum Startup {
    Run(Box<Config>),
    /// `--help` was asked for: print [`USAGE`] and exit successfully.
    Usage,
}

pub fn load(args: &[String]) -> Result<Startup, ConfigError> {
    // Help wins over everything, including a bad argument alongside it: someone
    // asking what the flags are should be told, not corrected.
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Ok(Startup::Usage);
    }
    // Refused before credentials are touched. An ignored argument is the
    // dangerous default: this app has no flags, so anything passed is either a
    // typo or a belief about behaviour that does not exist.
    if let Some(unexpected) = args.first() {
        return Err(ConfigError(format!(
            "this app takes no arguments, got {unexpected:?}.\n\n{USAGE}"
        )));
    }

    // Half a credential pair is always a mistake — a typo'd variable name, a
    // shell that exported only one — and left alone it surfaces as an opaque 401
    // long after the cause.
    let (Some(api_key), Some(api_secret)) = (
        var("NEXUS_EXCHANGE_API_KEY"),
        var("NEXUS_EXCHANGE_API_SECRET"),
    ) else {
        return Err(ConfigError(
            "this example reads your account's positions and the venue's ADL history, \
             both of which are signed reads, so it needs both NEXUS_EXCHANGE_API_KEY \
             and NEXUS_EXCHANGE_API_SECRET.\n\
             Copy .env.example to .env and export them, or pass them inline."
                .to_string(),
        ));
    };

    let base_url = var("NEXUS_EXCHANGE_API_URL").unwrap_or_else(|| TESTNET_BASE_URL.to_string());
    // A base ending in `/api/v1` is the mistake this deployment invites, because
    // the `/api/v1` surface is mounted *under* the prefix rather than at the
    // host root. Left alone it sends `/api/v1/api/v1/...` and 404s on every read.
    if base_url.trim_end_matches('/').ends_with("/api/v1") {
        return Err(ConfigError(format!(
            "NEXUS_EXCHANGE_API_URL must not end in /api/v1 — the SDK appends the full \
             path itself. Use the base, e.g. {TESTNET_BASE_URL}"
        )));
    }

    Ok(Startup::Run(Box::new(Config {
        api_key,
        api_secret,
        base_is_default: base_url == TESTNET_BASE_URL,
        base_url,
        address: address()?,
        adl_limit: adl_limit()?,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_described_by_shape_and_never_by_value() {
        let described = describe_secret("00112233445566778899aabbccddeeff");
        assert_eq!(described, "set (32 characters, hex)");
        assert!(!described.contains("0011"));
        assert_eq!(describe_secret("abc-123"), "set (7 characters, mixed)");
        // An all-decimal string is hex too, and saying so is honest: the point
        // is the alphabet a reader can check against, not a claim about entropy.
        assert_eq!(describe_secret("0123456789"), "set (10 characters, hex)");
    }

    #[test]
    fn usage_does_not_promise_a_flag_the_app_does_not_have() {
        assert!(USAGE.contains("--help"));
        assert!(!USAGE.contains("--arm"));
    }
}
