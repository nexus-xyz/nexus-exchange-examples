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
//! sleep**. Every request runs to completion, bounded by the client's own
//! per-request timeout rather than by a signal, so "not interruptible" never
//! means "hangs forever". The cost is that Ctrl-C during a poll waits for that
//! poll — bounded, and the right trade.

mod config;
mod risk;

use std::process::ExitCode;
use std::time::Duration;

use nexus_exchange::types::Order;
use nexus_exchange::{Client, Config as SdkConfig, CustomNetwork, Funds, Network};

use crate::config::{Config, ConfigError};
use crate::risk::{State, Verdict};

/// Per-request ceiling. Generous for a cold start, short enough to fail.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Resolve once, on the first signal; force an exit on the second.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            // No SIGTERM handler is not a reason to lose Ctrl-C.
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
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
async fn on_breach(client: &Client, config: &Config, orders: &[Order]) {
    if orders.is_empty() {
        return;
    }
    if !config.armed {
        log(format!(
            "  would cancel {} resting order(s) — re-run with --arm",
            orders.len()
        ));
        return;
    }
    // Not wrapped in `select!`: see the cancellation hazard in the module docs.
    match client.cancel_all_orders().await {
        Ok(_) => log(format!("  cancelled {} resting order(s)", orders.len())),
        // Cancelling is idempotent, so the next tick simply tries again — which
        // is the right behaviour while a limit is still breached.
        Err(err) => log(format!(
            "  cancel failed: {} — will retry next tick",
            one_line(err)
        )),
    }
}

async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    // Testnet is named rather than left to the default: an example should never
    // leave a reader guessing whose money it watches.
    //
    // An explicit base URL builds a `Network::Custom` with `Funds::Unknown`,
    // because a bare URL cannot declare what the target moves. Undeclared stays
    // undeclared — this app only reads and cancels, neither of which is
    // funds-guarded, so `Unknown` costs nothing here and is the honest value.
    let network = match config.base_url.as_deref() {
        Some(url) => Network::Custom(CustomNetwork::new("custom", url, Funds::Unknown)?),
        None => Network::Testnet,
    };
    let client = Client::new(
        SdkConfig::new(network)
            .api_key(config.api_key.clone(), config.api_secret.clone())
            .with_timeout(REQUEST_TIMEOUT),
    );

    log(format!("risk-guard on {} (play funds)", client.base_url()));
    log(describe_limits(&config));
    log(if config.armed {
        "--arm: a breach will cancel every resting order on this account".to_string()
    } else {
        "watch-only. Pass --arm to let a breach cancel resting orders.".to_string()
    });

    let (tx, mut rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = tx.send(true);
        eprintln!("shutting down — finishing the current check");
        // A second signal means the user is done waiting.
        shutdown_signal().await;
        eprintln!("forcing exit — a cancel may still have been in flight");
        std::process::exit(130);
    });

    let mut last_line = String::new();

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
                if line != last_line {
                    last_line = line.clone();
                    log(line);
                    for finding in &verdict.findings {
                        if finding.state != State::Within {
                            log(format!("  {}: {}", finding.limit, finding.detail));
                        }
                    }
                }

                if verdict.breached() {
                    on_breach(&client, &config, &orders).await;
                } else if verdict.indeterminate() {
                    // Reported, never acted on. Cancelling because a mark price
                    // is temporarily unavailable would make an indexer hiccup
                    // into a trading decision. The honest posture is to say the
                    // limit cannot be proven and let a human look.
                    log("  a limit could not be proven — not acting on data this app does not trust");
                }
            }
            Err(err) => {
                // A failed poll is not evidence of safety. Report it and try
                // again next tick; never let it read as a clean bill of health.
                log(format!("poll failed: {}", one_line(err)));
                last_line.clear();
            }
        }

        // The only interruptible wait in the process. Everything above runs to
        // completion — see the module docs.
        tokio::select! {
            _ = tokio::time::sleep(config.interval) => {}
            _ = rx.changed() => {}
        }
    }

    Ok(())
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
        Ok(config) => config,
        Err(ConfigError(message)) => {
            eprintln!("\n{message}");
            return ExitCode::FAILURE;
        }
    };
    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("\n{}", one_line(err));
            ExitCode::FAILURE
        }
    }
}
