//! A standing risk guard for one Nexus Exchange account.
//!
//! ```text
//! cargo run              # watch and report
//! cargo run -- --arm     # also cancel resting orders on a breach
//! ```
//!
//! It polls the account, checks it against limits you set, and — only when
//! armed — cancels every resting order the moment a limit is breached. That is
//! the entire write surface: **this app can only ever reduce exposure.** It
//! never places an order, never amends one, and deliberately does not flatten
//! positions, because flattening means sending a market order and a market
//! order is a new risk, not the removal of one.
//!
//! # What this example is for
//!
//! `exchange-api/trading-terminal` builds a trading app on the raw REST +
//! WebSocket API and spends ~2,700 lines doing it: HMAC signing, retry policy,
//! bounded response reads, clock-skew detection, exact decimal handling. This
//! app is a few hundred lines because the SDK already owns all of that. What is
//! left is the part that is actually yours — deciding what "too much risk"
//! means and what to do about it.
//!
//! # Concurrency, in full
//!
//! There is none to get wrong, and that is a design choice rather than an
//! accident. The loop is strictly sequential: fetch, evaluate, act, sleep. A
//! tick cannot start while the previous one is still running, so there is no
//! shared mutable state between overlapping ticks, no guard flag to forget, and
//! nothing to deadlock on. The one concurrent step is fetching the account and
//! the open orders together with [`tokio::try_join!`], and it is safe precisely
//! because the open orders do not feed any limit — they are only the thing
//! being cancelled.
//!
//! ## The cancellation hazard, which is specific to async Rust
//!
//! `tokio::select!` **drops the losing branch's future**. A future dropped at an
//! await point simply stops — mid-request, with no unwinding and no completion.
//! So the obvious shutdown shape is a trap:
//!
//! ```ignore
//! tokio::select! {
//!     result = client.cancel_all_orders() => { /* ... */ }
//!     _ = shutdown.changed() => return,   // <-- silently aborts the cancel
//! }
//! ```
//!
//! That makes Ctrl-C the thing that stops the risk-reducing request, which is a
//! shutdown that made the situation worse. Here, `select!` wraps **only the
//! sleep**. Every request runs to completion, so "not interruptible" has to mean
//! "bounded" — see [`MAX_SHUTDOWN_WAIT`] for what that bound actually is and how
//! it is derived. The cost is that a signal arriving mid-tick waits for that
//! tick, which is the right trade as long as the wait is a number you can state.

mod config;
mod risk;

use std::process::ExitCode;
use std::time::Duration;

use nexus_exchange::types::Order;
use nexus_exchange::{Client, Config as SdkConfig, CustomNetwork, Error, Funds, Network};

use crate::config::{Config, ConfigError, Startup};
use crate::risk::{State, Verdict};

/// Per-request ceiling. Generous for a cold start, short enough to fail.
///
/// The SDK's timeout bounds one *attempt*, which for some clients is not the
/// same as bounding the call — its unauthenticated public-data `GET` path
/// retries transient failures, so there a call can take `(max_retries + 1) ×`
/// this plus backoff. Every request this app makes is a **signed** one
/// (`fetch_balance`, `fetch_open_orders`, `cancel_all_orders`), and the SDK's
/// signed helpers deliberately do not auto-retry — a lost response on a
/// non-idempotent method must never be replayed, and the signed `GET` path is
/// written the same way. So for this app one call is one attempt, and this is
/// the whole per-call bound.
///
/// Deliberately tighter than the SDK's own 30s default, because
/// [`MAX_SHUTDOWN_WAIT`] is derived from it and that budget is the one an
/// operator feels.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The longest a shutdown signal can wait, because no request is interruptible.
///
/// A tick makes at most two sequential requests: the paired poll (two requests,
/// but concurrent, so one timeout between them) and the cancel that poll may
/// have triggered. Hence twice [`REQUEST_TIMEOUT`] — derived here rather than
/// written down a second time, so the two cannot drift apart.
///
/// Kept comfortably inside the 30s that Kubernetes'
/// `terminationGracePeriodSeconds` defaults to: a SIGTERM arriving at the worst
/// moment should end in a clean shutdown, not a SIGKILL.
const MAX_SHUTDOWN_WAIT: Duration = Duration::from_secs(2 * REQUEST_TIMEOUT.as_secs());

/// Label for the `NEXUS_EXCHANGE_API_URL` target.
///
/// Not decoration: the SDK namespaces stored credentials by this label, so it
/// validates the value and **refuses every built-in network's own name** — which
/// includes the literal `"custom"`, the name it reserves for the target its own
/// deprecated `Config::with_base_url` builds. The label therefore has to be a
/// name no built-in answers to, and naming it after the variable it came from
/// beats inventing something.
const OVERRIDE_LABEL: &str = "api-url-override";

fn log(message: impl AsRef<str>) {
    println!("{}", message.as_ref());
}

/// Collapse anything printable to one line, so an HTML error page cannot take
/// over the terminal.
fn one_line(value: impl ToString) -> String {
    let text = value.to_string();
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 200 {
        format!("{}…", flat.chars().take(200).collect::<String>())
    } else {
        flat
    }
}

/// A failure that retrying cannot fix, carrying the SDK's `sysexits.h` exit
/// code so a supervisor can tell *why* the guard stopped and not merely that it
/// did: `77` for credentials, `65` for another terminal error.
struct Fatal(i32);

/// Split an SDK error into "try again next tick" and "this will fail
/// identically forever".
///
/// The distinction is the whole point. A guard whose credentials were revoked
/// protects nothing, and the failure mode of treating that as transient is the
/// worst one this app has: it stays alive, logs the same line every tick, and
/// exits `0` if you ever stop it — so no supervisor restarts it and no operator
/// is told the account is now unwatched. Same rule as `Unknown` in
/// [`risk`](crate::risk): never let a failure read as a clean bill of health.
fn classify(err: &Error) -> Result<(), Fatal> {
    if err.is_retryable() {
        Ok(())
    } else {
        Err(Fatal(err.exit_code()))
    }
}

/// A stable identity for a failing poll, for deciding whether the failure is
/// news rather than the same outage repeating.
///
/// Groups by failure *class*, never by message. A transport error and a named
/// server rejection are different news and both print; the same outage reaching
/// a different URL is not, and does not. The prefix keeps a failure key from
/// ever comparing equal to a verdict summary.
fn failure_key(err: &Error) -> String {
    format!(
        "poll failed: {} {}",
        if err.is_retryable() {
            "transient"
        } else {
            "terminal"
        },
        err.code().unwrap_or("transport")
    )
}

/// Turn a `sysexits.h` code into a process exit code.
///
/// The codes in use are all well under 256, but clamp rather than truncate, and
/// never to zero: a code added later must not silently become a success.
fn exit_code(Fatal(code): Fatal) -> ExitCode {
    ExitCode::from(
        u8::try_from(code)
            .ok()
            .filter(|code| *code != 0)
            .unwrap_or(1),
    )
}

/// The process's shutdown signals, registered **once**.
///
/// Registering up front is what makes the two-stage shutdown honest. Asking
/// tokio for a signal replaces the OS default disposition for it, so after the
/// first Ctrl-C the kernel will no longer kill this process for us — and a
/// freshly created stream does not deliver a signal that arrived before the
/// stream existed. Re-registering for the second wait sits between those two
/// facts: a fast second Ctrl-C could be dropped *and* fail to terminate,
/// leaving no way out but SIGKILL. Owning both streams for the whole run closes
/// that window, because a signal arriving between the two waits is still
/// pending on a stream that already exists.
#[cfg(unix)]
struct Signals {
    interrupt: tokio::signal::unix::Signal,
    /// `None` when SIGTERM could not be registered. Not a reason to lose Ctrl-C.
    terminate: Option<tokio::signal::unix::Signal>,
}

#[cfg(unix)]
impl Signals {
    fn register() -> std::io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate()).ok(),
        })
    }

    /// Resolve on the next SIGINT or SIGTERM.
    ///
    /// Cancel-safe on both arms — `Signal::recv` is documented as such — so the
    /// `select!` here does not lose a signal the way the one in the module docs
    /// would lose a request.
    async fn next(&mut self) {
        match self.terminate.as_mut() {
            Some(terminate) => {
                tokio::select! {
                    _ = self.interrupt.recv() => {}
                    _ = terminate.recv() => {}
                }
            }
            None => {
                self.interrupt.recv().await;
            }
        }
    }
}

/// Ctrl-C only, and re-registered per wait: `tokio::signal::ctrl_c` builds a
/// fresh stream each call, so the window the unix path closes is still open
/// here. This example is developed and CI-built on unix; the non-unix path
/// exists so it compiles, not because it is the one under test.
#[cfg(not(unix))]
struct Signals;

#[cfg(not(unix))]
impl Signals {
    fn register() -> std::io::Result<Self> {
        Ok(Self)
    }

    async fn next(&mut self) {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// What the target's funds actually are — never an assumption.
///
/// A bare base URL declares nothing, so it arrives as [`Funds::Unknown`], and
/// printing "play funds" over an undeclared target is the one lie a risk tool
/// must not tell.
fn describe_funds(funds: Funds) -> &'static str {
    match funds {
        Funds::Play => "play funds",
        Funds::Real => "REAL FUNDS",
        Funds::Unknown => "funds not declared",
        // `Funds` is `#[non_exhaustive]`, so a classification added by a later
        // SDK lands here. Say "unrecognised", never "play": the wildcard arm of
        // a funds check has to be the cautious one.
        _ => "funds not recognised",
    }
}

fn summarise(verdict: &Verdict, orders: usize) -> String {
    let state = if verdict.breached() {
        "BREACHED"
    } else if verdict.indeterminate() {
        "UNPROVEN"
    } else {
        "ok"
    };
    let detail = verdict
        .findings
        .iter()
        .map(|f| {
            let state = match f.state {
                State::Within => "within",
                State::Breached => "breached",
                State::Unknown => "unknown",
            };
            format!("{}={state}", f.limit)
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("{state}  {detail}  resting={orders}")
}

/// Act on a breach: cancel every resting order, once there is one to cancel.
///
/// There is no "already fired" latch, and there does not need to be. The
/// condition is *breached and orders exist*, so a successful cancel makes the
/// next tick a no-op by itself, while an order placed during a still-live
/// breach is caught on the tick after it appears. A latch would have to be
/// cleared by something, and every rule for clearing it is a rule that can be
/// wrong.
///
/// `changed` says whether this tick's summary line was new. It gates the
/// watch-only advisory — a standing breach should not print the same "would
/// cancel" line 5,760 times a day — but never the outcome of a cancel, because
/// that is a write this app performed and belongs in the log every time.
async fn on_breach(
    client: &Client,
    config: &Config,
    orders: &[Order],
    changed: bool,
) -> Result<(), Fatal> {
    if orders.is_empty() {
        return Ok(());
    }
    if !config.armed {
        if changed {
            log(format!(
                "  would cancel {} resting order(s) — re-run with --arm",
                orders.len()
            ));
        }
        return Ok(());
    }
    // Not wrapped in `select!`: see the cancellation hazard in the module docs.
    match client.cancel_all_orders().await {
        // Deliberately not "cancelled N": `cancel_all_orders` is the
        // account-wide `DELETE /api/v1/orders`, and it runs *after* the fetch
        // above, so an order placed in between is cancelled too. The count is
        // what this app saw, and the audit line for its only write says exactly
        // that rather than implying a total the app cannot know. The response
        // body is unspecified in the v0.8.1 API spec, so it is not a number to
        // lean on either.
        Ok(_) => log(format!(
            "  cancelled every resting order on this account ({} seen this tick)",
            orders.len()
        )),
        Err(err) => {
            log(format!("  cancel failed: {}", one_line(&err)));
            // Cancelling is idempotent, so a transient failure just means the
            // next tick tries again — the right behaviour while a limit is
            // still breached. A terminal one will fail the same way forever,
            // and an armed guard that cannot cancel is not a guard.
            classify(&err)?;
            log("  will retry next tick");
        }
    }
    Ok(())
}

async fn run(config: Config) -> Result<ExitCode, Box<dyn std::error::Error>> {
    // Testnet is named rather than left to the default: an example should never
    // leave a reader guessing whose money it watches.
    //
    // An explicit base URL builds a `Network::Custom` with `Funds::Unknown`,
    // because a bare URL cannot declare what the target moves. Undeclared stays
    // undeclared — this app only reads and cancels, neither of which is
    // funds-guarded, so `Unknown` costs nothing here and is the honest value.
    // `CustomNetwork::new` also validates the URL, so a typo fails here instead
    // of at the first request.
    let network = match config.base_url.as_deref() {
        Some(url) => Network::Custom(
            CustomNetwork::new(OVERRIDE_LABEL, url, Funds::Unknown).map_err(|err| {
                ConfigError(format!(
                    "NEXUS_EXCHANGE_API_URL is not usable: {}",
                    one_line(err)
                ))
            })?,
        ),
        None => Network::Testnet,
    };
    // Read before the network moves into the config; the point of the SDK
    // modelling funds is that this is the value that gets printed.
    let funds = network.funds();

    let client = Client::new(
        SdkConfig::new(network)
            .api_key(config.api_key.clone(), config.api_secret.clone())
            .with_timeout(REQUEST_TIMEOUT),
    );

    log(format!(
        "risk-guard on {} ({})",
        client.base_url(),
        describe_funds(funds)
    ));
    log(describe_limits(&config));
    log(if config.armed {
        "--arm: a breach will cancel every resting order on this account".to_string()
    } else {
        "watch-only. Pass --arm to let a breach cancel resting orders.".to_string()
    });

    let mut signals = Signals::register()?;
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        signals.next().await;
        let _ = tx.send(true);
        eprintln!(
            "shutting down — finishing the current check (up to {}s)",
            MAX_SHUTDOWN_WAIT.as_secs()
        );
        // A second signal means the operator is done waiting.
        signals.next().await;
        eprintln!("forcing exit — a cancel may still have been in flight");
        std::process::exit(130);
    });

    // A key for the last status reported, so a steady state does not reprint
    // itself every interval — 5,760 identical lines a day at the default 15s.
    //
    // It is a key rather than the printed line because a failing poll's message
    // is not stable: `try_join!` surfaces whichever of its two concurrent
    // requests failed first, so a single outage alternates between two messages
    // that differ only in the URL, and comparing printed text would reprint
    // both forever. A verdict summary *is* its own key — every field in it is a
    // real change worth reprinting — and cannot collide with a failure key,
    // which `failure_key` prefixes for exactly that reason.
    let mut last_reported = String::new();

    while !*rx.borrow() {
        // Fetched together: two round trips of skew is less than doing them
        // back to back, and the orders do not feed any limit anyway.
        match tokio::try_join!(client.fetch_balance(), client.fetch_open_orders()) {
            Ok((account, orders)) => {
                let verdict = risk::evaluate(
                    &account.positions,
                    account.available_margin,
                    &config.limits,
                );

                let line = summarise(&verdict, orders.len());
                let changed = line != last_reported;
                if changed {
                    last_reported = line.clone();
                    log(line);
                    for finding in &verdict.findings {
                        if finding.state != State::Within {
                            log(format!("  {}: {}", finding.limit, finding.detail));
                        }
                    }
                }

                if verdict.breached() {
                    if let Err(fatal) = on_breach(&client, &config, &orders, changed).await {
                        return Ok(exit_code(fatal));
                    }
                } else if verdict.indeterminate() && changed {
                    // Reported, never acted on. Cancelling because a mark price
                    // is temporarily unavailable would make an indexer hiccup
                    // into a trading decision. The honest posture is to say the
                    // limit cannot be proven and let a human look.
                    log("  a limit could not be proven — not acting on data this app does not trust");
                }
            }
            Err(err) => {
                // A failed poll is not evidence of safety. Report it, and stop
                // outright if retrying cannot help — see `classify`.
                let key = failure_key(&err);
                if key != last_reported {
                    last_reported = key;
                    log(format!("poll failed: {}", one_line(&err)));
                }
                if let Err(fatal) = classify(&err) {
                    log("this cannot succeed by retrying, so the guard is stopping rather than pretending to watch");
                    return Ok(exit_code(fatal));
                }
            }
        }

        // The only interruptible wait in the process. Everything above runs to
        // completion — see the module docs.
        tokio::select! {
            _ = tokio::time::sleep(config.interval) => {}
            _ = rx.changed() => {}
        }
    }

    Ok(ExitCode::SUCCESS)
}

fn describe_limits(config: &Config) -> String {
    let mut parts = Vec::new();
    if config.limits.max_notional.is_some() {
        parts.push("max-notional");
    }
    if config.limits.max_loss.is_some() {
        parts.push("max-loss");
    }
    if config.limits.min_available_margin.is_some() {
        parts.push("min-available-margin");
    }
    format!(
        "limits: {} — polling every {}s",
        parts.join(", "),
        config.interval.as_secs()
    )
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = match config::load(&args) {
        Ok(Startup::Run(config)) => config,
        Ok(Startup::Usage) => {
            println!("{}", config::USAGE);
            return ExitCode::SUCCESS;
        }
        Err(ConfigError(message)) => {
            eprintln!("\n{message}");
            return ExitCode::FAILURE;
        }
    };
    match run(config).await {
        Ok(code) => code,
        Err(err) => {
            eprintln!("\n{}", one_line(err));
            ExitCode::FAILURE
        }
    }
}
