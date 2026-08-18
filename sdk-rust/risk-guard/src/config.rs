//! Configuration, validated before a single request goes out.
//!
//! Every check here is local: it costs nothing, and a misconfiguration caught
//! on this machine never becomes a request against someone's account.

use std::env;
use std::str::FromStr;
use std::time::Duration;

use rust_decimal::Decimal;

/// Shortest polling interval. A guard that hammers the API is its own problem.
const MIN_INTERVAL_SECONDS: u64 = 2;
const DEFAULT_INTERVAL_SECONDS: u64 = 15;

/// A limit left unset is `None` — not zero. Zero is a real limit that would
/// fire permanently, so the two must never collapse into one value.
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_notional: Option<Decimal>,
    pub max_loss: Option<Decimal>,
    pub min_available_margin: Option<Decimal>,
}

impl Limits {
    fn is_empty(&self) -> bool {
        self.max_notional.is_none()
            && self.max_loss.is_none()
            && self.min_available_margin.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub api_key: String,
    pub api_secret: String,
    pub base_url: Option<String>,
    pub limits: Limits,
    pub interval: Duration,
    /// True when `--arm` was passed: the guard may cancel resting orders.
    pub armed: bool,
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

/// Parse a limit as an exact decimal.
///
/// Plain decimals only — no exponents, no `NaN`/`inf`, no thousands separators.
/// Every one of those has a plausible-looking parse, which is exactly why they
/// are refused: this value decides whether the guard fires. `from_str_exact`
/// then rejects anything that would lose precision rather than rounding it.
///
/// Limits must be strictly positive. A zero or negative limit is almost always
/// a typo, and it is the kind that either fires the guard forever or never.
fn limit(name: &str) -> Result<Option<Decimal>, ConfigError> {
    let Some(raw) = var(name) else {
        return Ok(None);
    };
    let body = raw.strip_prefix(['+', '-']).unwrap_or(&raw);
    let plain = !body.is_empty()
        && body.chars().all(|c| c.is_ascii_digit() || c == '.')
        && body.matches('.').count() <= 1
        && body.chars().any(|c| c.is_ascii_digit());
    if !plain {
        return Err(ConfigError(format!(
            "{name} must be a plain decimal number, got {raw:?}"
        )));
    }
    let value = Decimal::from_str_exact(&raw)
        .map_err(|err| ConfigError(format!("{name}: {err}")))?;
    if value <= Decimal::ZERO {
        return Err(ConfigError(format!(
            "{name} must be greater than zero, got {raw}"
        )));
    }
    Ok(Some(value))
}

fn interval() -> Result<Duration, ConfigError> {
    let Some(raw) = var("NEXUS_GUARD_INTERVAL_SECONDS") else {
        return Ok(Duration::from_secs(DEFAULT_INTERVAL_SECONDS));
    };
    let seconds = u64::from_str(&raw).map_err(|_| {
        ConfigError(format!(
            "NEXUS_GUARD_INTERVAL_SECONDS must be a whole number of seconds, got {raw}"
        ))
    })?;
    if seconds < MIN_INTERVAL_SECONDS {
        return Err(ConfigError(format!(
            "NEXUS_GUARD_INTERVAL_SECONDS must be at least {MIN_INTERVAL_SECONDS}, got {raw}"
        )));
    }
    Ok(Duration::from_secs(seconds))
}

pub fn load(args: &[String]) -> Result<Config, ConfigError> {
    // Half a credential pair is always a mistake — a typo'd variable name, a
    // shell that only exported one — and left alone it surfaces as an opaque
    // 401 long after the cause.
    let (Some(api_key), Some(api_secret)) = (
        var("NEXUS_EXCHANGE_API_KEY"),
        var("NEXUS_EXCHANGE_API_SECRET"),
    ) else {
        return Err(ConfigError(
            "this example watches your account, so it needs both \
             NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET.\n\
             Copy .env.example to .env and export them, or pass them inline."
                .to_string(),
        ));
    };

    let limits = Limits {
        max_notional: limit("NEXUS_GUARD_MAX_NOTIONAL")?,
        max_loss: limit("NEXUS_GUARD_MAX_LOSS")?,
        min_available_margin: limit("NEXUS_GUARD_MIN_AVAILABLE_MARGIN")?,
    };

    // A guard with no limits is not a guard, and it would sit there printing
    // reassuring output forever. Refuse rather than imply coverage that does
    // not exist.
    if limits.is_empty() {
        return Err(ConfigError(
            "no limits configured, so there is nothing to guard. Set at least one \
             of NEXUS_GUARD_MAX_NOTIONAL, NEXUS_GUARD_MAX_LOSS or \
             NEXUS_GUARD_MIN_AVAILABLE_MARGIN — see .env.example."
                .to_string(),
        ));
    }

    Ok(Config {
        api_key,
        api_secret,
        base_url: var("NEXUS_EXCHANGE_API_URL"),
        limits,
        interval: interval()?,
        armed: args.iter().any(|arg| arg == "--arm"),
    })
}
