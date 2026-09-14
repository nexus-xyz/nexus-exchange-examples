//! Distance-to-liquidation and margin health for one Nexus Exchange account,
//! next to the venue's own auto-deleveraging record.
//!
//! ```text
//! cargo run
//! ```
//!
//! It answers the venue's question rather than yours. `sdk-rust/risk-guard`
//! checks an account against limits *you* set; this asks how close the account
//! is to being closed by the **engine**, and then shows what that engine has
//! actually done in these markets when the insurance fund ran out.
//!
//! # Read-only, by construction
//!
//! Every call below is a `GET`. The app places no order, cancels nothing, moves
//! no funds, and mints no token. That is not a policy note — it is why there is
//! no `--arm`-style flag here and no shutdown choreography: there is no
//! in-flight write that a Ctrl-C could abort halfway, so the sibling's
//! `tokio::select!` hazard simply does not arise. A dropped `GET` costs a
//! report, not a position.
//!
//! # One coherent read, not two that can tear
//!
//! The account snapshot comes from `GET /api/v1/account/state`, which returns
//! the portfolio summary **and** every open position from a single server-side
//! read. Issuing `/account/summary` and `/positions` separately would be two
//! independent requests, and a fill landing between them yields an aggregate
//! that disagrees with the position list — an equity that has moved against a
//! maintenance total that has not. Every margin figure here is a subtraction
//! between those two halves, so a tear does not merely add noise; it invents
//! headroom that never existed. The single read is the whole reason the numbers
//! in this report are allowed to be subtracted from each other at all.
//!
//! The one deliberate exception is the **current** mark price, fetched per
//! market from `GET /api/v1/markets/{id}/mark-price` *after* the snapshot. It is
//! printed for context — how far the market has moved since the snapshot was
//! taken — and is pointedly **not** fed into the arithmetic, for the same
//! reason: a mark from a later read paired with an equity from an earlier one
//! is exactly the tear the single-call endpoint exists to prevent.
//!
//! # The gap this report cannot close: isolated margin
//!
//! The maths in [`margin`] is the **cross-margin** model, and the client has no
//! way to know whether it applies. The wire carries `margin_mode` on every
//! position (measured: `"margin_mode":"cross"` on the public demo mirror), but
//! the SDK's [`nexus_exchange::types::Position`] has no such field, so serde
//! drops it silently. There is no other read on the SDK's surface that reports
//! it.
//!
//! That matters because the venue has a live defect in the isolated admission
//! path, and it points the wrong way. Its pre-trade margin **check** charges the
//! raw order notional while the **reservation** a few lines later charges only
//! the netted added exposure — so an isolated account near full utilisation is
//! refused the plain reducing order that would relieve it. A `reduce_only`
//! order short-circuits the check and still gets through, but the ordinary one
//! does not. It is live for any market whose risk class forces isolated margin.
//!
//! So this report can say "8.4% from liquidation, you have room to trim" about
//! an account the venue would in fact refuse the trim on. It does not try to
//! detect that — it cannot — it prints the caveat every run, and it points at
//! the read that *can* answer the question: `POST /api/v1/orders/preview`
//! returns the venue's own `accepted` / `reject_reason` for an order it does not
//! submit. This app is read-only and deliberately does not call it. If you are
//! about to act on a distance printed here, preview the reducing order first.

mod adl;
mod config;
mod margin;

use std::collections::HashMap;
use std::process::ExitCode;
use std::time::Duration;

use nexus_exchange::types::{AdlEvent, MarketStatus, Position};
use nexus_exchange::{Client, Config as SdkConfig, CustomNetwork, Error, Funds, Network};
use rust_decimal::Decimal;

use crate::adl::AdlRecord;
use crate::config::{Config, ConfigError, Startup};
use crate::margin::{Assessment, Distance, Health, RiskParams, RiskParamsByMarket, Unproven};

/// Per-request ceiling.
///
/// Generous for a cold start, short enough to fail. Every signed call the SDK
/// makes is one attempt — its signed helpers deliberately do not auto-retry,
/// because replaying a lost response is unsafe in general — while the
/// unauthenticated `GET` path does retry, so a public read can take up to
/// `(retries + 1) ×` this plus backoff. Both are bounded, and nothing here
/// writes, so a slow read costs a slow report.
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

/// What the target's funds actually are — never an assumption.
fn describe_funds(funds: Funds) -> &'static str {
    match funds {
        Funds::Play => "play funds",
        Funds::Real => "REAL FUNDS",
        Funds::Unknown => "funds not declared",
        // `Funds` is `#[non_exhaustive]`, so a classification a later SDK adds
        // lands here. Say "unrecognised", never "play".
        _ => "funds not recognised",
    }
}

/// A soft read: a failure degrades one line of the report rather than ending it.
///
/// Used for every per-market read. The account snapshot is not soft — without it
/// there is no report — but a market whose risk parameters are unavailable
/// should cost that market an `Unknown`, not cost the reader the other markets'
/// answers. Returning `None` is what feeds the three-outcome discipline in
/// [`margin`]: the caller has no way to turn a missing value into a zero.
fn soft<T>(label: &str, result: Result<T, Error>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(err) => {
            log(format!("  ! {label}: {}", one_line(&err)));
            None
        }
    }
}

fn percent(fraction: Decimal) -> String {
    format!("{:.2}%", fraction * Decimal::ONE_HUNDRED)
}

fn render_health(health: &Health) {
    match health {
        Health::Breached => log(
            "    BREACHED — the account is provably at or past maintenance margin on the \
             terms that report. Nothing missing can undo that.",
        ),
        Health::Fragile(Distance {
            mark,
            liquidation_price,
            move_to_liquidation,
            fraction_of_mark,
            falls,
        }) => {
            let direction = if *falls { "fall" } else { "rise" };
            log(format!(
                "    estimate: liquidates if the mark {direction}s {} to {liquidation_price} \
                 — {} from {mark}",
                move_to_liquidation,
                percent(*fraction_of_mark)
            ));
        }
        Health::Unknown(reason) => log(format!("    UNPROVEN — {reason}. Not read as safe.")),
    }
}

fn render_market_context(status: Option<&MarketStatus>, mark_now: Option<Decimal>) {
    if let Some(status) = status {
        let halted = match (&status.halt_reason, status.halted_at) {
            (Some(reason), _) => format!(" (halt: {reason})"),
            (None, Some(at)) => format!(" (halted at {at})"),
            _ => String::new(),
        };
        log(format!(
            "    market: {}{halted}  ·  lifetime ADL events {}",
            status.status, status.adl_event_count
        ));
    }
    if let Some(mark) = mark_now {
        log(format!(
            "    current mark {mark} (a later read — context only, not an input above)"
        ));
    }
}

fn render_adl(record: &AdlRecord, scope: &str) {
    if record.is_empty() {
        log(format!(
            "    ADL record ({scope}): no events on this page. Not observed to reach the \
             tail, which is not the same as safe."
        ));
        return;
    }
    log(format!(
        "    ADL record ({scope}): {} event(s), {} counterparty position(s) closed, \
         {} absorbed by the insurance fund first",
        record.events, record.counterparty_closures, record.bad_debt_absorbed_by_fund
    ));
    if let (Some(timestamp), Some(sequence), Some(price)) = (
        record.latest_timestamp_ms,
        record.latest_sequence,
        record.latest_bankruptcy_price,
    ) {
        log(format!(
            "      most recent: seq {sequence} at {timestamp} ms, bankruptcy price {price}, \
             {} size closed",
            record.position_closed
        ));
    }
}

/// Everything read for one market, all of it optional.
struct MarketReads {
    params: Option<RiskParams>,
    status: Option<MarketStatus>,
    mark_now: Option<Decimal>,
    adl: AdlRecord,
}

async fn read_market(client: &Client, market_id: &str, adl_limit: u32) -> MarketReads {
    let params = soft(
        &format!("{market_id} risk-params"),
        client.fetch_market_risk_params(market_id).await,
    )
    .map(|params| RiskParams {
        maintenance_margin_rate: params.maintenance_margin_rate,
        initial_margin_rate: params.initial_margin_rate,
        max_leverage: params.max_leverage,
    });
    let status = soft(
        &format!("{market_id} status"),
        client.fetch_market_status(market_id).await,
    );
    let mark_now = soft(
        &format!("{market_id} mark-price"),
        client.fetch_mark_price(market_id).await,
    )
    .map(|mark| mark.mark_price);
    let events: Vec<AdlEvent> = soft(
        &format!("{market_id} adl-events"),
        client
            .fetch_market_adl_events(market_id, Some(adl_limit))
            .await,
    )
    .unwrap_or_default();
    MarketReads {
        params,
        status,
        mark_now,
        adl: adl::summarise(&events),
    }
}

fn render_row(assessment: &Assessment, reads: Option<&MarketReads>) {
    let notional = assessment
        .notional
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unavailable".to_string());
    let maintenance = assessment
        .maintenance_margin
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unavailable".to_string());
    log(format!(
        "\n  {}  {} {}  ·  notional {notional}  ·  maintenance {maintenance}",
        assessment.market_id, assessment.side, assessment.size
    ));
    render_health(&assessment.health);
    if let Some(reads) = reads {
        if let Some(params) = &reads.params {
            log(format!(
                "    risk params: maintenance {} · initial {} · max leverage {}x",
                params.maintenance_margin_rate, params.initial_margin_rate, params.max_leverage
            ));
        }
        render_market_context(reads.status.as_ref(), reads.mark_now);
        render_adl(&reads.adl, "this market");
    }
}

fn render_account(view: &margin::AccountView) {
    let equity = view
        .equity
        .map(|value| value.to_string())
        .unwrap_or_else(|| "not reported".to_string());
    let qualifier = if view.missing.is_empty() {
        ""
    } else {
        " (a lower bound — see below)"
    };
    log(format!(
        "account   equity {equity}  ·  maintenance margin {}{qualifier}",
        view.maintenance_margin
    ));
    match (view.headroom, view.provably_breached) {
        (Some(headroom), true) => log(format!(
            "          BREACHED — headroom {headroom}, provably at or past maintenance margin"
        )),
        (Some(headroom), false) if view.missing.is_empty() => {
            log(format!("          headroom {headroom}"))
        }
        (Some(headroom), false) => log(format!(
            "          headroom at most {headroom} — an upper bound, because no maintenance \
             term reported for {}",
            view.missing.join(", ")
        )),
        (None, _) => log(
            "          headroom unknown — the server did not report total_equity, and zero \
             is not a substitute",
        ),
    }
}

/// Printed on every run, whatever the numbers say. A distance-to-liquidation
/// that arrives without its caveats is the failure mode this example is most
/// able to cause.
fn render_caveats(base_is_default: bool) {
    log("\nwhat these numbers are not");
    log("  · An estimate, not the venue's number. The API reports \
         Position::liquidation_price as null with liquidation_price_error \
         'margin_state_not_mirrored', so there is no server-side figure to compare against.");
    log(
        "  · A single-market shock. Each row moves one mark and holds the rest still; a real \
         liquidation usually moves several at once, which is nearer than any row here.",
    );
    log(
        "  · Margin-mode aware. The wire carries margin_mode per position; the SDK's Position \
         type does not, so this report cannot tell cross from isolated and assumes cross.",
    );
    log(
        "  · An admission check. The venue's isolated pre-trade check charges raw order \
         notional while its reservation charges the netted exposure, so a full isolated \
         account can be refused the very reducing order this report implies it can send. \
         POST /api/v1/orders/preview is the read that answers that; this app never writes, \
         so it does not call it.",
    );
    log(
        "  · Fee-, funding- or penalty-adjusted. All three move the true trigger closer than \
         the number above, never further.",
    );
    if !base_is_default {
        log(
            "  · Pointed at the deployment this app knows. NEXUS_EXCHANGE_API_URL is set, so \
             the funds classification above is 'not declared' rather than a claim.",
        );
    }
}

async fn run(config: Config) -> Result<ExitCode, Box<dyn std::error::Error>> {
    // The base URL is named rather than left to `Network::Testnet`: in SDK
    // 0.11.0 that default is still the decommissioned gateway. See
    // `config::TESTNET_BASE_URL`. Funds are declared `Play` only for the base
    // this app recognises; a reader-supplied URL cannot say what it moves, so it
    // stays `Unknown` and the banner says so rather than claiming play funds.
    let funds = if config.base_is_default {
        Funds::Play
    } else {
        Funds::Unknown
    };
    // `CustomNetwork::new` validates the URL, so a typo fails here rather than
    // at the first request.
    let network = Network::Custom(
        CustomNetwork::new(config::NETWORK_LABEL, &config.base_url, funds).map_err(|err| {
            ConfigError(format!(
                "NEXUS_EXCHANGE_API_URL is not usable: {}",
                one_line(err)
            ))
        })?,
    );
    let client = Client::new(
        SdkConfig::new(network)
            .api_key(config.api_key.clone(), config.api_secret.clone())
            .with_timeout(REQUEST_TIMEOUT),
    );

    log(format!(
        "liquidation-watch — {} ({})",
        client.base_url(),
        describe_funds(funds)
    ));
    log(format!(
        "credentials  key {}, secret {}",
        config::describe_secret(&config.api_key),
        config::describe_secret(&config.api_secret)
    ));
    log("read-only: this app issues GETs only\n");

    // Not soft. Without the snapshot there is nothing to report, and reporting
    // "no positions" because a request failed is the one lie a margin tool must
    // not tell.
    let state = client.fetch_account_state().await?;
    let positions: Vec<Position> = state.positions;
    if positions.is_empty() {
        log("account   no open positions — nothing to liquidate");
        render_caveats(config.base_is_default);
        return Ok(ExitCode::SUCCESS);
    }

    let mut markets: Vec<String> = positions
        .iter()
        .map(|position| position.market_id.clone())
        .collect();
    markets.sort();
    markets.dedup();

    let mut reads: HashMap<String, MarketReads> = HashMap::new();
    for market_id in &markets {
        reads.insert(
            market_id.clone(),
            read_market(&client, market_id, config.adl_limit).await,
        );
    }
    let params: RiskParamsByMarket = reads
        .iter()
        .filter_map(|(market_id, read)| {
            read.params
                .clone()
                .map(|params| (market_id.clone(), params))
        })
        .collect();

    let view = margin::account_view(&positions, state.summary.total_equity, &params);
    render_account(&view);

    let mut rows: Vec<Assessment> = positions
        .iter()
        .map(|position| margin::assess(position, params.get(&position.market_id), &view))
        .collect();
    rows.sort_by_key(margin::fragility_key);

    log("\npositions, most fragile first");
    for row in &rows {
        render_row(row, reads.get(&row.market_id));
    }

    match &config.address {
        Some(address) => {
            log("");
            let events: Vec<AdlEvent> = soft(
                "account adl-history",
                client
                    .fetch_account_adl_history(address, Some(config.adl_limit))
                    .await,
            )
            .unwrap_or_default();
            log(format!("this account's own ADL history ({address})"));
            render_adl(&adl::summarise(&events), "this account");
        }
        None => log(
            "\nthis account's own ADL history: skipped. The endpoint is keyed by address and \
             the API surface the SDK wraps has no 'who am I' read, so set \
             NEXUS_ACCOUNT_ADDRESS rather than have this app guess.",
        ),
    }

    // Unproven rows are counted out loud. A reader scanning the tail of a long
    // report should not have to notice an absence.
    let unproven = rows
        .iter()
        .filter(|row| matches!(row.health, Health::Unknown(_)))
        .count();
    if unproven > 0 {
        let flat = rows
            .iter()
            .filter(|row| matches!(row.health, Health::Unknown(Unproven::FlatPosition)))
            .count();
        log(format!(
            "\n{unproven} of {} position(s) could not be proven either way ({flat} of them \
             merely flat). None of them is safe; they are unknown.",
            rows.len()
        ));
    }

    render_caveats(config.base_is_default);
    Ok(ExitCode::SUCCESS)
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = match config::load(&args) {
        Ok(Startup::Run(config)) => *config,
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
            eprintln!("\n{}", one_line(&err));
            // The SDK's `sysexits.h` code when it has one, so a supervisor can
            // tell revoked credentials (77) from any other terminal failure.
            match err_exit_code(err.as_ref()) {
                Some(code) => ExitCode::from(code),
                None => ExitCode::FAILURE,
            }
        }
    }
}

/// Map an SDK error onto its `sysexits.h` code, clamped and never to zero: a
/// code added later must not silently become a success.
fn err_exit_code(err: &(dyn std::error::Error + 'static)) -> Option<u8> {
    let err = err.downcast_ref::<Error>()?;
    u8::try_from(err.exit_code()).ok().filter(|code| *code != 0)
}
