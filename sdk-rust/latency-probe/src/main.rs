//! Place/cancel latency for one Nexus Exchange testnet account.
//!
//! ```text
//! cargo run              # dry run: read the market, print the order, place nothing
//! cargo run -- --live    # place and cancel post-only orders, then report
//! ```
//!
//! Each round trip places one post-only buy far below the mark, waits for the
//! account WebSocket to report it, cancels it, and waits for the WebSocket to
//! report that. Four stages are timed, on the local monotonic clock:
//!
//! | stage | from | to |
//! |---|---|---|
//! | `place→REST ack` | just before `create_order` | its response |
//! | `place→WS` | just before `create_order` | first `orders` frame for it that says it is resting |
//! | `cancel→REST ack` | just before `cancel_order` | its response |
//! | `cancel→WS` | just before `cancel_order` | first `orders` frame for it that says it is cancelled |
//!
//! # Safety, in the order it is enforced
//!
//! 1. **The order cannot fill.** Post-only, priced from the venue's own
//!    `price_band_bps` and tick size (80% of the band below the mark by
//!    default), refused if it would cross the best ask, at `min_order_size`.
//!    See [`plan`].
//! 2. **The volume is bounded by constants.** At most [`config::MAX_ITERATIONS`]
//!    round trips, never closer together than [`config::MIN_INTERVAL`], and
//!    stretched further to use at most a quarter of the account's rate-limit
//!    budget ([`BUDGET_SHARE`]).
//! 3. **A submission is never retried.** A placement that errors ambiguously (a
//!    timeout, a 5xx) may or may not have created an order, so it is recorded
//!    as *uncertain* and the run stops. Resubmitting would risk two orders to
//!    save one measurement.
//! 4. **Everything it placed is cancelled and then checked.** On a normal exit,
//!    an error, a panic in the probe or Ctrl-C, [`cleanup`] cancels every order
//!    this run placed **by id** — never the account-wide cancel-all, which
//!    would take your other orders with it — then lists open orders and looks
//!    for anything with this run's ids or client-id prefix. Anything still
//!    resting is printed and the process exits non-zero.
//!
//! # Measuring honestly
//!
//! A WS stage whose frame does not arrive inside the wait window is recorded as
//! **missing**. It is not given the window as a latency (that would invent a
//! number) and it is not dropped silently (that would flatter the percentiles).
//! Frames that arrive late, or that the app did not expect, are catalogued at
//! the end with their shape, so what the venue actually sent is on the record.

mod config;
mod frames;
mod plan;
mod stats;

use std::collections::{BTreeMap, HashSet};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use nexus_exchange::types::{Market, OrderRequest, RateLimitStatus, Side, TimeInForce};
use nexus_exchange::ws::{Channel, ServerMessage};
use nexus_exchange::{Client, Config as SdkConfig, CustomNetwork, Error, Funds, Network};
use rust_decimal::Decimal;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::time::sleep_until;

use crate::config::{Config, ConfigError, Startup};
use crate::frames::Kind;
use crate::plan::Plan;
use crate::stats::{ClockBounds, Stage};

/// Per-request ceiling. Signed calls are one attempt each (the SDK does not
/// retry them), so this is the whole bound on one call.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the `orders` subscription to be acknowledged before
/// giving up — and before anything has been placed.
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Share of the account's rate-limit budget this app will use. A probe that
/// consumes the budget measures its own throttling, not the venue.
const BUDGET_SHARE: f64 = 0.25;

/// Signed requests per round trip: one place, one cancel.
const REQUESTS_PER_ROUND: f64 = 2.0;

/// Re-read the mark, book and rate-limit status every this many rounds, so a
/// drifting market cannot walk the price out of the band during a long run.
const REFRESH_EVERY: u32 = 10;

/// Generous so a burst of other account activity never makes the SDK drop a
/// frame — a dropped frame would read as "missing" and be the app's fault.
const WS_CHANNEL_CAPACITY: usize = 4096;

fn log(message: impl AsRef<str>) {
    println!("{}", message.as_ref());
}

fn one_line(value: impl ToString) -> String {
    let text = value.to_string();
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 240 {
        format!("{}…", flat.chars().take(240).collect::<String>())
    } else {
        flat
    }
}

fn wall_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn describe_funds(funds: Funds) -> &'static str {
    match funds {
        Funds::Play => "play funds",
        Funds::Real => "REAL FUNDS",
        Funds::Unknown => "funds not declared",
        _ => "funds not recognised",
    }
}

// ── Signals ────────────────────────────────────────────────────────────────
// Registered once for the whole run, as in `risk-guard`: re-registering for
// the second wait would open a window where a fast second Ctrl-C is lost.

#[cfg(unix)]
struct Signals {
    interrupt: tokio::signal::unix::Signal,
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

// ── What this run placed ───────────────────────────────────────────────────

/// Every order this run created or may have created. Shared with the cleanup
/// path through a mutex that is never held across an `.await`, so a panic in
/// the probe cannot leave it locked in a way cleanup would wait on.
#[derive(Debug, Default)]
struct Ledger {
    /// This run's client-order-id prefix. Anything open with it is ours.
    prefix: String,
    /// `(order id, cancel acknowledged)`.
    placed: Vec<(String, bool)>,
    /// Client ids of submissions that errored ambiguously.
    uncertain: Vec<String>,
}

type SharedLedger = Arc<Mutex<Ledger>>;

fn lock(ledger: &SharedLedger) -> std::sync::MutexGuard<'_, Ledger> {
    ledger.lock().unwrap_or_else(|e| e.into_inner())
}

// ── The WebSocket side ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Frame {
    at: Instant,
    wall_ms: f64,
    emitted_at: Option<i64>,
    kind: Kind,
    shape: String,
    payload: Value,
    /// Which stage timed this frame, if any.
    timed_as: Option<&'static str>,
}

enum WsItem {
    Subscribed(String),
    Frame(Box<Frame>),
    Problem(String),
}

/// Read the stream in its own task and timestamp every frame the moment it is
/// decoded. Doing it here, not in the probe loop, keeps the probe's own awaits
/// (a REST call in flight) out of the WS measurement.
fn spawn_reader(mut stream: nexus_exchange::ws::MessageStream, tx: mpsc::UnboundedSender<WsItem>) {
    tokio::spawn(async move {
        while let Some(item) = stream.next().await {
            let (at, wall) = (Instant::now(), wall_ms());
            let out = match item {
                Ok(ServerMessage::Subscribed { channel, .. }) => WsItem::Subscribed(channel),
                Ok(ServerMessage::Event {
                    channel,
                    payload,
                    engine_envelope,
                    ..
                }) if channel == "orders" => {
                    let emitted_at = engine_envelope
                        .map(|e| e.emitted_at)
                        .filter(|ms| *ms > 0)
                        .or_else(|| frames::emitted_at(&payload));
                    WsItem::Frame(Box::new(Frame {
                        at,
                        wall_ms: wall,
                        emitted_at,
                        kind: frames::classify(&payload),
                        shape: frames::shape(&payload),
                        payload,
                        timed_as: None,
                    }))
                }
                Ok(ServerMessage::OutOfSync { channel, .. }) => {
                    WsItem::Problem(format!("{channel}: out_of_sync — the stream has a gap"))
                }
                Ok(ServerMessage::Error { message }) => WsItem::Problem(format!(
                    "server error frame: {}",
                    message.unwrap_or_default()
                )),
                Ok(_) => continue,
                Err(err) => WsItem::Problem(one_line(err)),
            };
            if tx.send(out).is_err() {
                return;
            }
        }
    });
}

enum Wait {
    Got {
        at: Instant,
        wall_ms: f64,
        emitted_at: Option<i64>,
        shape: String,
    },
    Missing,
    Interrupted,
}

// ── The probe ──────────────────────────────────────────────────────────────

struct Probe {
    client: Client,
    config: Config,
    market: Market,
    band_bps: u32,
    plan: Plan,
    interval: Duration,
    ledger: SharedLedger,
    rx: mpsc::UnboundedReceiver<WsItem>,
    shutdown: watch::Receiver<bool>,
    frames: Vec<Frame>,
    subscribed_acks: usize,
    problems: Vec<String>,
    place_ack: Stage,
    place_ws: Stage,
    cancel_ack: Stage,
    cancel_ws: Stage,
    clock: ClockBounds,
    ws_before_ack: usize,
    rounds: u32,
    stopped_because: Option<String>,
}

impl Probe {
    fn absorb(&mut self, item: WsItem) {
        match item {
            WsItem::Subscribed(channel) => {
                self.subscribed_acks += 1;
                if self.subscribed_acks > 1 {
                    // The SDK reconnects transparently and resubscribes; a
                    // second ack is the only sign. Frames across it may be lost.
                    self.problems.push(format!(
                        "WS reconnected (a fresh `subscribed` for {channel}) during round {}",
                        self.rounds
                    ));
                }
            }
            WsItem::Frame(frame) => self.frames.push(*frame),
            WsItem::Problem(p) => self.problems.push(p),
        }
    }

    fn interrupted(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// Wait for the first unclaimed frame of `want` that mentions one of `ids`
    /// and arrived after `after`, until `deadline`.
    async fn wait_frame(
        &mut self,
        ids: &[&str],
        want: Kind,
        after: Instant,
        deadline: tokio::time::Instant,
        stage: &'static str,
    ) -> Wait {
        loop {
            if let Some(frame) = self.frames.iter_mut().find(|f| {
                f.timed_as.is_none()
                    && f.at >= after
                    && f.kind == want
                    && ids.iter().any(|id| frames::mentions(&f.payload, id))
            }) {
                frame.timed_as = Some(stage);
                return Wait::Got {
                    at: frame.at,
                    wall_ms: frame.wall_ms,
                    emitted_at: frame.emitted_at,
                    shape: frame.shape.clone(),
                };
            }
            if self.interrupted() {
                return Wait::Interrupted;
            }
            tokio::select! {
                item = self.rx.recv() => match item {
                    Some(item) => self.absorb(item),
                    None => {
                        self.problems.push("WS reader ended".to_string());
                        return Wait::Missing;
                    }
                },
                _ = sleep_until(deadline) => return Wait::Missing,
                _ = self.shutdown.changed() => {}
            }
        }
    }

    /// Drain whatever the reader has queued without waiting.
    fn drain(&mut self) {
        while let Ok(item) = self.rx.try_recv() {
            self.absorb(item);
        }
    }

    /// An `orders` frame reporting a fill on one of ours. Priced as it is, this
    /// should be impossible, so it stops the run rather than being averaged in.
    fn fill_alarm(&self, ids: &[&str]) -> Option<String> {
        self.frames
            .iter()
            .find(|f| {
                f.kind == Kind::Filled && ids.iter().any(|id| frames::mentions(&f.payload, id))
            })
            .map(|f| {
                format!(
                    "an orders frame reported a FILL on this run's order: {}",
                    f.shape
                )
            })
    }

    async fn sleep_interruptible(&mut self, d: Duration) {
        let deadline = tokio::time::Instant::now() + d;
        while !self.interrupted() {
            tokio::select! {
                _ = sleep_until(deadline) => return,
                item = self.rx.recv() => if let Some(item) = item { self.absorb(item) },
                _ = self.shutdown.changed() => {}
            }
        }
    }

    async fn refresh(&mut self) -> Result<(), String> {
        let (mark, book) = tokio::try_join!(
            self.client.fetch_mark_price(&self.config.market),
            self.client.fetch_order_book(&self.config.market)
        )
        .map_err(|e| format!("re-reading mark/book failed: {}", one_line(e)))?;
        let ask = book.asks.first().map(|l| l.price());
        self.plan = plan::plan_order(
            &self.market,
            self.band_bps,
            mark.mark_price,
            ask,
            self.config.offset_bps,
        )
        .map_err(|e| format!("re-plan refused: {e}"))?;
        if let Ok(status) = self.client.fetch_rate_limit_status().await {
            self.interval = pace(self.config.interval, &status);
            wait_for_budget(&status, &mut self.shutdown).await;
        }
        Ok(())
    }

    async fn run(mut self) -> Probe {
        for round in 1..=self.config.iterations {
            if self.interrupted() {
                self.stopped_because = Some("interrupted".to_string());
                break;
            }
            self.rounds = round;
            if round > 1 && (round - 1) % REFRESH_EVERY == 0 {
                if let Err(reason) = self.refresh().await {
                    self.stopped_because = Some(reason);
                    break;
                }
            }
            if let Err(reason) = self.round(round).await {
                self.stopped_because = Some(reason);
                break;
            }
            if round < self.config.iterations {
                self.sleep_interruptible(self.interval).await;
            }
        }
        // Give frames still in flight for the last round a chance to land, so
        // the catalogue reflects what the venue sent, not when we stopped.
        let settle = tokio::time::Instant::now() + Duration::from_millis(500);
        while tokio::time::Instant::now() < settle {
            tokio::select! {
                item = self.rx.recv() => match item { Some(i) => self.absorb(i), None => break },
                _ = sleep_until(settle) => break,
            }
        }
        self.drain();
        self
    }

    async fn round(&mut self, round: u32) -> Result<(), String> {
        let prefix = lock(&self.ledger).prefix.clone();
        let client_id = format!("{prefix}{round}");
        let order = OrderRequest::limit(
            &self.config.market,
            Side::Buy,
            self.plan.price,
            self.plan.size,
            TimeInForce::PostOnly,
        )
        .with_client_order_id(&client_id);

        // ── place ──
        let (sent, sent_wall) = (Instant::now(), wall_ms());
        let placed = self.client.create_order(&order).await;
        let (acked, acked_wall) = (Instant::now(), wall_ms());
        let response = match placed {
            Ok(r) => r,
            Err(err) => {
                if err.is_retryable() {
                    // Ambiguous: the request may have reached the engine. Not
                    // retried — cleanup looks for it by client id instead.
                    lock(&self.ledger).uncertain.push(client_id.clone());
                    return Err(format!(
                        "round {round}: placement failed ambiguously ({}); not retried — \
                         cleanup will look for {client_id}",
                        one_line(&err)
                    ));
                }
                return Err(format!(
                    "round {round}: the venue refused the order: {}",
                    one_line(&err)
                ));
            }
        };
        let id = response.order.id.clone();
        lock(&self.ledger).placed.push((id.clone(), false));
        self.place_ack.samples.push(ms(acked - sent));
        self.clock
            .add_rest(response.order.created_at, sent_wall, acked_wall);

        if !response.fills.is_empty() || response.order.filled_qty > Decimal::ZERO {
            return Err(format!(
                "round {round}: order {id} reported a fill on placement — stopping"
            ));
        }
        let status = response.order.status.clone();
        if !matches!(status.as_str(), "Open" | "New" | "Accepted" | "") {
            return Err(format!(
                "round {round}: order {id} came back {status:?}, not resting — stopping"
            ));
        }

        let ids = [id.as_str(), client_id.as_str()];
        let deadline = tokio::time::Instant::from_std(sent + self.config.ws_wait);
        let place_ws = self
            .wait_frame(&ids, Kind::Resting, sent, deadline, "place→WS")
            .await;
        let place_cell = match &place_ws {
            Wait::Got {
                at,
                wall_ms,
                emitted_at,
                shape,
            } => {
                if *at < acked {
                    self.ws_before_ack += 1;
                }
                self.place_ws.samples.push(ms(*at - sent));
                if let Some(e) = emitted_at {
                    self.clock.add_ws(*e, *wall_ms);
                }
                format!("{:>7.1} [{shape}]", ms(*at - sent))
            }
            Wait::Missing => {
                self.place_ws.missing += 1;
                "MISSING".to_string()
            }
            // The order is resting and a signal arrived: cancel it now rather
            // than finish the wait. Not a measurement either way.
            Wait::Interrupted => {
                self.place_ws.interrupted += 1;
                "interrupted".to_string()
            }
        };

        // ── cancel ──
        // Not wrapped in `select!` with the shutdown signal: a dropped future
        // mid-request is a cancel that may or may not have happened.
        let c_sent = Instant::now();
        let cancelled = self.client.cancel_order(&id, &self.config.market).await;
        let c_acked = Instant::now();
        if let Err(err) = cancelled {
            return Err(format!(
                "round {round}: cancel of {id} failed ({}); cleanup will retry it",
                one_line(&err)
            ));
        }
        if let Some(entry) = lock(&self.ledger).placed.iter_mut().find(|(i, _)| *i == id) {
            entry.1 = true;
        }
        self.cancel_ack.samples.push(ms(c_acked - c_sent));

        let deadline = tokio::time::Instant::from_std(c_sent + self.config.ws_wait);
        let cancel_cell = match self
            .wait_frame(&ids, Kind::Cancelled, c_sent, deadline, "cancel→WS")
            .await
        {
            Wait::Got {
                at,
                wall_ms,
                emitted_at,
                shape,
            } => {
                self.cancel_ws.samples.push(ms(at - c_sent));
                if let Some(e) = emitted_at {
                    self.clock.add_ws(e, wall_ms);
                }
                format!("{:>7.1} [{shape}]", ms(at - c_sent))
            }
            Wait::Missing => {
                self.cancel_ws.missing += 1;
                "MISSING".to_string()
            }
            Wait::Interrupted => {
                self.cancel_ws.interrupted += 1;
                "interrupted".to_string()
            }
        };

        log(format!(
            "#{round:03} place→ack {:>7.1}  →WS {place_cell}  cancel→ack {:>7.1}  →WS {cancel_cell}",
            ms(acked - sent),
            ms(c_acked - c_sent),
        ));

        self.drain();
        if let Some(alarm) = self.fill_alarm(&ids) {
            return Err(alarm);
        }
        Ok(())
    }
}

/// The gap between rounds: the configured interval, stretched so this app uses
/// at most [`BUDGET_SHARE`] of the account's rate limit. Never shortened.
fn pace(configured: Duration, status: &RateLimitStatus) -> Duration {
    match status.limit {
        Some(limit) if limit > 0 => {
            let floor =
                Duration::from_secs_f64(REQUESTS_PER_ROUND / (f64::from(limit) * BUDGET_SHARE));
            configured.max(floor)
        }
        _ => configured,
    }
}

/// If the bucket is nearly empty (someone else is using this key), wait for the
/// venue's own reset time rather than spending what is left. Bounded.
async fn wait_for_budget(status: &RateLimitStatus, shutdown: &mut watch::Receiver<bool>) {
    let (Some(remaining), Some(reset)) = (status.remaining, status.reset_at_ms) else {
        return;
    };
    if f64::from(remaining) >= REQUESTS_PER_ROUND * 2.0 || reset <= 0 {
        return;
    }
    let wait_ms = (reset as f64 - wall_ms()).clamp(0.0, 10_000.0);
    log(format!(
        "rate-limit budget low ({remaining} left) — waiting {wait_ms:.0} ms for the venue's reset"
    ));
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs_f64(wait_ms / 1000.0)) => {}
        _ = shutdown.changed() => {}
    }
}

// ── Setup and teardown ─────────────────────────────────────────────────────

fn build_client(config: &Config) -> Result<Client, ConfigError> {
    let funds = if config.target_is_default {
        Funds::Play
    } else {
        Funds::Unknown
    };
    let custom = CustomNetwork::new(config::NETWORK_LABEL, &config.base_url, funds)
        .and_then(|c| c.with_ws_url(&config.ws_url))
        .map_err(|e| ConfigError(format!("target URL is not usable: {}", one_line(e))))?;
    let mut sdk = SdkConfig::new(Network::Custom(custom))
        .with_timeout(REQUEST_TIMEOUT)
        .with_channel_capacity(WS_CHANNEL_CAPACITY);
    if let Some((key, secret)) = &config.credentials {
        sdk = sdk.api_key(key.clone(), secret.clone());
    }
    Ok(Client::new(sdk))
}

/// `GET /markets`, raw. The SDK's `Market` does not carry `price_band_bps`, and
/// the band is the one number that decides whether the venue accepts a price
/// this far from the mark — so it is read off the wire, and its absence is a
/// refusal, not a default.
async fn read_market(base: &str, market_id: &str) -> Result<(Market, u32), String> {
    let http = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(one_line)?;
    let url = format!("{}/markets", base.trim_end_matches('/'));
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {}", one_line(e)))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("GET {url}: {}", one_line(e)))?;
    if !status.is_success() {
        return Err(format!("GET {url} answered {status}: {}", one_line(body)));
    }
    let markets: Vec<Value> =
        serde_json::from_str(&body).map_err(|e| format!("GET {url}: not a market list: {e}"))?;
    let raw = markets
        .iter()
        .find(|m| m.get("market_id").and_then(Value::as_str) == Some(market_id))
        .ok_or_else(|| {
            let ids: Vec<&str> = markets
                .iter()
                .filter_map(|m| m.get("market_id").and_then(Value::as_str))
                .collect();
            format!(
                "market {market_id} not listed. Available: {}",
                ids.join(", ")
            )
        })?;
    let band = raw
        .get("price_band_bps")
        .and_then(Value::as_u64)
        .filter(|b| *b > 0)
        .and_then(|b| u32::try_from(b).ok())
        .ok_or_else(|| {
            format!(
                "{market_id}: the venue did not report a usable price_band_bps, so this app \
                 cannot show its price is inside the collar. Refusing rather than guessing."
            )
        })?;
    let market: Market = serde_json::from_value(raw.clone())
        .map_err(|e| format!("{market_id}: market rules did not decode: {e}"))?;
    Ok((market, band))
}

struct Preflight {
    market: Market,
    band_bps: u32,
    plan: Plan,
}

async fn preflight(client: &Client, config: &Config) -> Result<Preflight, String> {
    let (market, band_bps) = read_market(&config.base_url, &config.market).await?;
    log(format!(
        "market    {}  tick {}  lot {}  min size {}  band {} bps (from GET /markets)",
        market.market_id, market.tick_size, market.lot_size, market.min_order_size, band_bps
    ));
    let status = client
        .fetch_market_status(&config.market)
        .await
        .map_err(|e| format!("market status: {}", one_line(e)))?;
    if status.status != "active" {
        return Err(format!(
            "{} is {:?}{}, not active",
            config.market,
            status.status,
            status
                .halt_reason
                .map(|r| format!(" ({r})"))
                .unwrap_or_default()
        ));
    }
    let mark = client
        .fetch_mark_price(&config.market)
        .await
        .map_err(|e| format!("mark price: {}", one_line(e)))?;
    let book = client
        .fetch_order_book(&config.market)
        .await
        .map_err(|e| format!("order book: {}", one_line(e)))?;
    let bid = book.bids.first().map(|l| l.price());
    let ask = book.asks.first().map(|l| l.price());
    let show = |p: Option<Decimal>| p.map_or("none".to_string(), |p| p.to_string());
    log(format!(
        "book      mark {}  best bid {}  best ask {}",
        mark.mark_price,
        show(bid),
        show(ask)
    ));
    let plan = plan::plan_order(&market, band_bps, mark.mark_price, ask, config.offset_bps)
        .map_err(|e| format!("refusing to place: {e}"))?;
    log(format!(
        "order     post-only BUY {} @ {}  ({} bps below mark; band floor {}; {})",
        plan.size,
        plan.price,
        plan.offset_bps,
        plan.band_floor.round_dp(8),
        plan.below_best_ask_bps
            .map_or("book has no asks".to_string(), |b| format!(
                "{b} bps below best ask"
            ))
    ));
    Ok(Preflight {
        market,
        band_bps,
        plan,
    })
}

/// Cancel what this run placed, by id, then prove nothing of ours is resting.
/// Returns the ids still resting — empty is the only clean exit.
///
/// Cancels here may be retried once: cancelling is idempotent, so a repeat can
/// only ever find the order already gone. The no-retry rule is for submissions.
async fn cleanup(client: &Client, market: &str, ledger: &SharedLedger) -> Result<(), String> {
    let (prefix, pending, uncertain, all_ids): (String, Vec<String>, usize, HashSet<String>) = {
        let l = lock(ledger);
        (
            l.prefix.clone(),
            l.placed
                .iter()
                .filter(|(_, done)| !done)
                .map(|(id, _)| id.clone())
                .collect(),
            l.uncertain.len(),
            l.placed.iter().map(|(id, _)| id.clone()).collect(),
        )
    };
    log(format!(
        "cleanup   {} placed this run, {} not yet confirmed cancelled, {} uncertain submission(s)",
        all_ids.len(),
        pending.len(),
        uncertain
    ));
    for id in &pending {
        match client.cancel_order(id, market).await {
            Ok(_) => log(format!("          cancelled {id}")),
            Err(e) => log(format!("          cancel {id}: {}", one_line(e))),
        }
    }

    for attempt in 1..=3 {
        let open = match client.fetch_open_orders().await {
            Ok(open) => open,
            Err(e) => {
                log(format!(
                    "          listing open orders failed: {}",
                    one_line(e)
                ));
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let ours: Vec<_> = open
            .iter()
            .filter(|o| {
                all_ids.contains(&o.id)
                    || o.client_order_id
                        .as_deref()
                        .is_some_and(|c| c.starts_with(&prefix))
            })
            .collect();
        if ours.is_empty() {
            log(format!(
                "verified  GET /api/v1/orders lists {} open order(s) on this account, none of them this run's",
                open.len()
            ));
            return Ok(());
        }
        if attempt == 3 {
            return Err(ours
                .iter()
                .map(|o| format!("{} ({})", o.id, o.client_order_id.as_deref().unwrap_or("-")))
                .collect::<Vec<_>>()
                .join(", "));
        }
        for o in ours {
            log(format!("          still resting: {} — cancelling", o.id));
            let _ = client.cancel_order(&o.id, &o.market_id).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("could not list open orders to verify".to_string())
}

fn report(p: &Probe) {
    log("");
    log(format!(
        "results   {} round(s) attempted of {} requested; interval {} ms; WS wait window {} ms",
        p.rounds,
        p.config.iterations,
        p.interval.as_millis(),
        p.config.ws_wait.as_millis()
    ));
    let stages = [&p.place_ack, &p.place_ws, &p.cancel_ack, &p.cancel_ws];
    print!("{}", stats::table(&stages));
    log("          * = this percentile is the max at this n (nearest-rank)");
    for w in stats::sample_warnings(&stages) {
        log(format!("warning   {w}"));
    }
    if p.ws_before_ack > 0 {
        log(format!(
            "note      the WS frame beat the REST ack on {} of {} placements",
            p.ws_before_ack,
            p.place_ws.samples.len()
        ));
    }

    // What the `orders` channel actually carried.
    let ours: HashSet<String> = lock(&p.ledger)
        .placed
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    let prefix = lock(&p.ledger).prefix.clone();
    let mut catalogue: BTreeMap<(String, &'static str), usize> = BTreeMap::new();
    let mut foreign = 0;
    for f in &p.frames {
        let mine = ours.iter().any(|id| frames::mentions(&f.payload, id))
            || frames_mention_prefix(&f.payload, &prefix);
        if mine {
            let bucket = f.timed_as.unwrap_or("not timed (late or unexpected)");
            *catalogue.entry((f.shape.clone(), bucket)).or_default() += 1;
        } else {
            foreign += 1;
        }
    }
    log("");
    log(format!(
        "observed  `orders` frames for this run's orders ({} placed):",
        ours.len()
    ));
    if catalogue.is_empty() {
        log("          none — the channel carried nothing for these orders");
    }
    for ((shape, bucket), n) in &catalogue {
        log(format!("          {n:>4} × {shape:<36} {bucket}"));
    }
    if foreign > 0 {
        log(format!(
            "          {foreign} other `orders` frame(s) for this account were not this run's"
        ));
    }
    for problem in &p.problems {
        log(format!("ws        {problem}"));
    }

    log("");
    for line in p.clock.describe() {
        log(format!("clock     {line}"));
    }
    if let Some(reason) = &p.stopped_because {
        log("");
        log(format!("stopped   {reason}"));
    }
}

/// Client ids are `<prefix><round>`, so an exact-match search needs the round.
/// Checking string prefixes directly catches a frame for an uncertain
/// submission that never got an order id back.
fn frames_mention_prefix(value: &Value, prefix: &str) -> bool {
    match value {
        Value::String(s) => !prefix.is_empty() && s.starts_with(prefix),
        Value::Array(items) => items.iter().any(|v| frames_mention_prefix(v, prefix)),
        Value::Object(map) => map.values().any(|v| frames_mention_prefix(v, prefix)),
        _ => false,
    }
}

async fn run(config: Config) -> Result<ExitCode, Box<dyn std::error::Error>> {
    let client = build_client(&config)?;
    let funds = if config.target_is_default {
        Funds::Play
    } else {
        Funds::Unknown
    };
    log(format!(
        "latency-probe — {} ({})",
        client.base_url(),
        describe_funds(funds)
    ));
    log(format!("ws        {}", config.ws_url));

    let pre = match preflight(&client, &config).await {
        Ok(pre) => pre,
        Err(reason) => {
            log(format!("refused   {reason}"));
            log("          nothing was placed.");
            return Ok(ExitCode::from(2));
        }
    };

    if !config.live {
        log("");
        log(format!(
            "dry run   nothing placed. `--live` would run {} round trip(s), ≥{} ms apart.",
            config.iterations,
            config.interval.as_millis()
        ));
        return Ok(ExitCode::SUCCESS);
    }

    // Before anything is placed: the budget, and a live subscription.
    let rate = client.fetch_rate_limit_status().await?;
    let interval = pace(config.interval, &rate);
    log(format!(
        "budget    tier {}  limit {}/s  remaining {}  → one round every {} ms (≤{:.0}% of budget)",
        rate.tier,
        rate.limit
            .map_or("unlimited".to_string(), |l| l.to_string()),
        rate.remaining.map_or("-".to_string(), |r| r.to_string()),
        interval.as_millis(),
        BUDGET_SHARE * 100.0
    ));

    let stream = client.subscribe(vec![Channel::Orders])?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    spawn_reader(stream, tx);
    let deadline = tokio::time::Instant::now() + SUBSCRIBE_TIMEOUT;
    let mut early = Vec::new();
    loop {
        tokio::select! {
            item = rx.recv() => match item {
                Some(WsItem::Subscribed(_)) => break,
                Some(WsItem::Problem(p)) => log(format!("ws        {p}")),
                Some(other) => early.push(other),
                None => { log("refused   WS reader ended before subscribing; nothing placed."); return Ok(ExitCode::from(2)); }
            },
            _ = sleep_until(deadline) => {
                log(format!("refused   no `subscribed` ack for `orders` within {}s; nothing placed.", SUBSCRIBE_TIMEOUT.as_secs()));
                return Ok(ExitCode::from(2));
            }
        }
    }
    log("ws        subscribed to `orders`");

    let run_id = format!("{:x}", (wall_ms() as u64) % 0xff_ffff_ffff);
    let ledger: SharedLedger = Arc::new(Mutex::new(Ledger {
        prefix: format!("lp-{run_id}-"),
        ..Ledger::default()
    }));
    log(format!(
        "run       client ids lp-{run_id}-<n>; cancel+verify on exit, panic or Ctrl-C"
    ));
    log("");

    let (stop_tx, stop_rx) = watch::channel(false);
    let mut signals = Signals::register()?;
    let signal_ledger = ledger.clone();
    tokio::spawn(async move {
        signals.next().await;
        let _ = stop_tx.send(true);
        eprintln!(
            "stopping — cancelling this run's orders, then verifying (Ctrl-C again to abandon)"
        );
        signals.next().await;
        let l = lock(&signal_ledger);
        let resting: Vec<&str> = l
            .placed
            .iter()
            .filter(|(_, done)| !done)
            .map(|(id, _)| id.as_str())
            .collect();
        eprintln!(
            "abandoned — cleanup did not finish. Check for resting orders: {} (client ids {}*)",
            if resting.is_empty() {
                "none known".to_string()
            } else {
                resting.join(", ")
            },
            l.prefix
        );
        std::process::exit(130);
    });

    let mut probe = Probe {
        client: client.clone(),
        market: pre.market,
        band_bps: pre.band_bps,
        plan: pre.plan,
        interval,
        ledger: ledger.clone(),
        rx,
        shutdown: stop_rx,
        frames: Vec::new(),
        subscribed_acks: 1,
        problems: Vec::new(),
        place_ack: Stage::new("place→REST ack"),
        place_ws: Stage::new("place→WS (resting)"),
        cancel_ack: Stage::new("cancel→REST ack"),
        cancel_ws: Stage::new("cancel→WS (cancelled)"),
        clock: ClockBounds::default(),
        ws_before_ack: 0,
        rounds: 0,
        stopped_because: None,
        config: config.clone(),
    };
    for item in early {
        probe.absorb(item);
    }

    // The probe runs in its own task so a panic inside it is a `JoinError`
    // here, not an unwinding main that skips cleanup.
    let outcome = tokio::spawn(probe.run()).await;
    let cleaned = cleanup(&client, &config.market, &ledger).await;

    let mut code = ExitCode::SUCCESS;
    match &outcome {
        Ok(probe) => {
            report(probe);
            if probe.stopped_because.is_some() {
                code = ExitCode::from(2);
            }
        }
        Err(e) => {
            log(format!(
                "PANIC     the probe task failed ({}); orders were cleaned up, no report",
                one_line(e)
            ));
            code = ExitCode::from(101);
        }
    }
    if let Err(resting) = cleaned {
        log("");
        log(format!(
            "DANGER    could not verify this run's orders are gone. Still listed: {resting}"
        ));
        log("          cancel them in the Exchange app or with DELETE /api/v1/orders/{id}.");
        code = ExitCode::from(3);
    }
    Ok(code)
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
            let code = err
                .downcast_ref::<Error>()
                .map(|e| e.exit_code())
                .and_then(|c| u8::try_from(c).ok())
                .filter(|c| *c != 0)
                .unwrap_or(1);
            eprintln!("\n{}", one_line(err));
            ExitCode::from(code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(limit: Option<u32>) -> RateLimitStatus {
        serde_json::from_value(serde_json::json!({
            "tier": "pro", "limit": limit, "remaining": limit, "reset_at_ms": 0
        }))
        .unwrap()
    }

    #[test]
    fn pacing_only_ever_lengthens_the_interval() {
        let one_sec = Duration::from_secs(1);
        // 10 req/s × 25% = 2.5 req/s → 2 requests per round → 800 ms. Keep 1 s.
        assert_eq!(pace(one_sec, &status(Some(10))), one_sec);
        // 2 req/s × 25% = 0.5 req/s → one round every 4 s.
        assert_eq!(pace(one_sec, &status(Some(2))), Duration::from_secs(4));
        assert_eq!(pace(one_sec, &status(None)), one_sec);
    }

    #[test]
    fn prefix_search_finds_uncertain_submissions() {
        let v = serde_json::json!({"OrderUpdate": {"order": {"client_order_id": "lp-ab-3"}}});
        assert!(frames_mention_prefix(&v, "lp-ab-"));
        assert!(!frames_mention_prefix(&v, "lp-cd-"));
        assert!(!frames_mention_prefix(&v, ""));
    }
}
