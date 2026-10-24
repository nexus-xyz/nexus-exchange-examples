/*
 * Absence — the model for "this figure is not available", kept strictly separate
 * from "this figure is zero".
 *
 * WHY THIS FILE EXISTS
 *
 * `adapter.ts` is tolerant by design: a bad field degrades to a fallback and
 * records `errors["<wire_field>_error"]` (the resilience convention used
 * elsewhere across this platform). That is the right transport behaviour and
 * the wrong *rendering* behaviour, because the fallback for a number is `0`.
 * A blotter that prints `0` where the venue sent nothing is not an ugly panel
 * — it is a lying panel:
 *
 *   • `liquidation_price` is hardcoded `"0"` on the live `/positions` path. Shown
 *     as a price it says "this position liquidates at zero", i.e. is perfectly
 *     safe. That is the exact opposite of the truth, which is unknown.
 *   • `fee` is missing from engine-emitted fill events. Shown as `0` it says the
 *     venue trades free.
 *   • `equity` failing to parse and rendering `0` makes the margin-health ratio
 *     `0 / maint = 0%` (or `Infinity`), painting a liquidation that is not real.
 *
 * So: the adapter says *what broke*, this module turns that into a first-class
 * `Absent` value, and `components/terminal/states.tsx` renders it as `—` with the
 * reason on hover. Absence travels as data, not as a magic number.
 *
 * There is exactly one hard rule downstream: **never arithmetic on a `Maybe<T>`**.
 * Unwrap with `unwrapOr` at the point of use, and if the fallback would be a
 * fabricated figure, do not unwrap — render `<AbsentValue/>` instead.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ABSENCE INVENTORY
 *
 * Every field in ./README.md that can arrive absent, with the code it maps to.
 * This list — not the helpers — is the value of the file: it is the checklist for
 * "can this panel represent no-data", answered field by field. Divergence ids
 * (A.n) refer to ./README.md § Divergences A.
 *
 * ORDERS — `WireOrder`, `GET /orders`; `WireOrderHistoryEntry`, `/orders/history`
 *   price / limit_price      A.1  limit-family order carrying neither name.
 *                                 `price_error`. NOT absence for market-family
 *                                 orders, where null is the correct answer.
 *   order_type              A.4  unknown or unmapped snake_case value; adapter
 *                                 falls back to `Limit` + `order_type_error`. The
 *                                 fallback is a *guess* — badge it, don't trust it.
 *   status                  A.2  unknown value → falls back `Open` +
 *                                 `status_error`. `Triggered` is legal-but-
 *                                 undocumented, so an unknown status is more
 *                                 likely spec lag than corruption.
 *   quantity / filled_qty        missing or unparseable → 0 + `*_error`. This is
 *                                 the worst zero in the file: `filledPct` then
 *                                 reads 0% on an order that may be fully filled.
 *   time_in_force                absent ENTIRELY on `/orders/history`;
 *                                 `parseOrderHistoryEntry` hard-codes `GTC`.
 *                                 → NO_API_SURFACE, render `—` not "GTC".
 *   trigger_price / stop_price A.7 unparseable → `trigger_price_error`. Null on a
 *                                 non-trigger type is legitimate emptiness.
 *   trailing_offset_bps /
 *     limit_offset_bps           null off the trailing family — legitimate.
 *   client_id, stp,
 *     max_slippage_bps      A.11 engine-only, never on the HTTP surface.
 *                                 Permanently NO_API_SURFACE.
 *   cancellation_reason          null while the order lives — emptiness, not
 *                                 absence. Do not badge it.
 *
 * POSITIONS — `WirePosition`, `GET /positions`, `AccountSummary.positions`
 *   liquidation_price       A.6  hardcoded `"0"` live → NOT_COMPUTED. The
 *                                 headline case; `parsePosition` already maps 0 →
 *                                 null, this module supplies the reason string.
 *   leverage                A.13 no such field; not settable, only derivable as
 *                                 `1 / initial_margin_rate`. When the mirror has
 *                                 no margin state the API path yields
 *                                 `leverage: null` +
 *                                 `leverage_error: "margin_state_not_mirrored"`.
 *   margin_mode /
 *     allocated_margin      A.12 engine has Cross/Isolated, API exposes neither,
 *                                 even though `POST /account/margin` exists.
 *                                 NOT_MIRRORED — a cross/isolated toggle has
 *                                 nothing to bind to.
 *   funding_accrued /
 *     fee_pnl                    on the engine struct, not on the API's Position.
 *                                 When the mirror reports
 *                                 `total_pnl_complete: false` with
 *                                 `fee_pnl: null`, "Total PnL" is realized +
 *                                 unrealized MINUS NOTHING — a number that is
 *                                 wrong by the fee leg. INCOMPLETE.
 *   size / entry_price /
 *     unrealized_pnl /
 *     realized_pnl               each degrades to 0 + `*_error`.
 *   fundingRate (derived)        joined from `GET /funding` by market; absent when
 *                                 that market has no funding sample yet.
 *   maintMargin (aggregate)      no aggregate endpoint anywhere; summed from
 *                                 registry rates. Absent for any market missing
 *                                 from the registry.
 *
 * FILLS — `WireFill`, `GET /fills`, and WS fill events
 *   fee                     A.10 REST has it, the engine's `Fill` struct does not
 *                                 (fees are a settlement derivation), so a WS fill
 *                                 arrives without one → `fee_error`, fallback 0.
 *   taker_or_maker               unknown value → falls back `taker` +
 *                                 `taker_or_maker_error`. Affects the fee sign.
 *   price / size                 missing or unparseable → 0 + `*_error`.
 *
 * MARKET DATA
 *   last_trade_price             `number | null` on `/markets/summary` — null
 *                                 before the market's first ever trade.
 *                                 NO_TRADES, not `$0.00`.
 *   halt_reason / halted_at      null unless halted — emptiness.
 *   ticker: last, close,
 *     markPrice, indexPrice,
 *     bid, ask, high, low,
 *     open, percentage,
 *     baseVolume, quoteVolume    every CCXT field is nullable. `mark` falls back
 *                                 to `last`, so the mark can be *doubly* absent
 *                                 (no mark AND no last).
 *   bestBid / bestAsk / spread   null on an empty side of the book. A spread of
 *                                 `0` claims a locked market; absent is correct.
 *   candles                      malformed rows are DROPPED, so a series can have
 *                                 holes; and only `1s/1m/5m/1h` exist (A.17), so a
 *                                 4H/1D series is absent-by-assembly.
 *   mark_price (/mark-price)  A.8 route has no schema, only an `example`. Our
 *                                 `WireMarkPrice` is a transcription — a parse
 *                                 failure here means the shape moved.
 *   funding samples              `funding_rate`, `premium_index`, `mark_price`,
 *                                 `oracle_price` each degrade to 0 + `*_error`.
 *   is_stale                     the value IS present but is not fresh — see
 *                                 `Freshness` below. Staleness is not absence and
 *                                 must not render as `—`; it renders as the figure
 *                                 plus a marker.
 *
 * ACCOUNT
 *   balance, collateral,
 *     equity, available_margin   each → 0 + `*_error`. Never derive a health
 *                                 ratio from an absent equity.
 *   portfolio summary fields     same, plus `open_positions_count` /
 *                                 `open_orders_count` default to 0 — here 0 is
 *                                 usually the truth, so do not badge it.
 *   early_access_allowed         optional; absent ⇒ the gate is not active. That
 *                                 is information, not failure.
 *   equity (EquityPoint)    A.9  a JSON number on a native endpoint; `NaN` is
 *                                 reachable and must not plot as 0.
 *   preview:
 *     projected_post_trade_liquidation_price
 *                                nullable and legitimately null when the preview
 *                                leaves the account flat.
 *     expected_fill_vwap         nullable — a resting limit has no expected fill.
 *
 * NO API SURFACE AT ALL (A.14, A.15) — permanently absent for a live client
 *   maker_rebate_bps / taker_fee_bps, price_band_bps, funding_interval_s,
 *   funding_rate_cap, max_open_interest, liquidation_penalty_bps,
 *   isolated_margin_floor_ratio  — server config on `RegistryMarket.extra`.
 *   A live client CANNOT learn its own fee rate: the ticket's fee strip is
 *   fixture-only.
 *   fee schedule / volume tier / open interest — no endpoint exists. `oi` in
 *   `MarketStats` has no source of any kind.
 *   stats: last_event_ms (nullable), unique_traders_24h/7d/30d (optional).
 *
 * TRANSPORT — panel-level, not field-level; these produce `ErrorState`
 *   401  account and trading routes need HMAC → UNAUTHENTICATED.
 *   429  per-account rate limit on every route; `/account/rate-limit` reports
 *        headroom → RATE_LIMITED.
 *   5xx  upstream failure → UPSTREAM_ERROR.
 *   WS   `OrderBook.nonce` gap or a dropped socket → every live figure is stale,
 *        not absent: keep the last value and mark it.
 *
 * NOT ABSENCE (recorded so nobody "fixes" it): `name`, `glyph`, `cls`, `tier`,
 * `ref`, `chg24` have no API source but are ours to author, so they are always
 * present. Same for the book grouping ladder.
 */

import type { Parsed } from "./types";

// ─────────────────────────────────────────────────────────────────── the model

/**
 * Why a figure is missing. Coarse on purpose: the code drives *styling* and
 * grouping, the human `reason` string drives the tooltip. More than a dozen codes
 * and no panel would handle them all.
 */
export const ABSENCE_CODES = [
  /** The wire field was null, "" or omitted where a value was expected. */
  "missing",
  /** Present but not a finite number — `parseDecimal` recorded `*_error`. */
  "unparseable",
  /** The venue did not compute it. `liquidation_price === "0"` is this. */
  "not_computed",
  /** The engine knows it; the API does not mirror it (margin mode, leverage). */
  "not_mirrored",
  /** A composite figure is missing a leg, so the total would be wrong. */
  "incomplete",
  /** No endpoint exists, at any version. Permanent. */
  "no_api_surface",
  /** The value exists but this endpoint does not carry it (TIF on history). */
  "not_on_endpoint",
  /** Nothing has happened yet — no trade, no sample, no history. */
  "no_data_yet",
  /** An upstream `*_error` sibling field we pass through verbatim. */
  "upstream_error",
  /** 401 — the request needs HMAC credentials we do not have. */
  "unauthenticated",
  /** 429 — per-account rate limit; the figure is retriable. */
  "rate_limited",
] as const;

export type AbsenceCode = (typeof ABSENCE_CODES)[number];

/**
 * A value that is not available, and why.
 *
 * `absent: true` is a literal discriminant rather than a `Symbol` or a class so
 * the whole thing survives `JSON.stringify` — absence must be transportable
 * through a server component boundary, an SWR cache and a screenshot fixture.
 */
export type Absent = {
  readonly absent: true;
  /** Human sentence for the tooltip. Sentence case, no terminal period. */
  readonly reason: string;
  readonly code: AbsenceCode;
  /** The wire field name, when one is identifiable. Traceable back to the payload. */
  readonly field?: string;
};

/** `T`, or the documented reason there is no `T`. */
export type Maybe<T> = T | Absent;

/** Default human phrasing per code, used when a call site has nothing better. */
export const ABSENCE_REASONS: Readonly<Record<AbsenceCode, string>> = {
  missing: "Not sent by the venue",
  unparseable: "Value could not be read",
  not_computed: "Not computed by the venue",
  not_mirrored: "Not exposed by the API",
  incomplete: "Incomplete — a component is missing",
  no_api_surface: "No API source",
  not_on_endpoint: "Not returned by this endpoint",
  no_data_yet: "No data yet",
  upstream_error: "Upstream error",
  unauthenticated: "Sign in to view",
  rate_limited: "Rate limited — retry shortly",
};

/** Construct an `Absent`. `reason` defaults to the code's standard phrasing. */
export function absent(code: AbsenceCode, reason?: string, field?: string): Absent {
  return { absent: true, code, reason: reason ?? ABSENCE_REASONS[code], ...(field ? { field } : {}) };
}

/**
 * Narrow a `Maybe<T>` to `Absent`.
 *
 * The `typeof === "object"` guard is not ceremony: `Maybe<number>` is the common
 * case and `(0 as never).absent` would throw, while an unbranded object T with no
 * `absent` key must not be mistaken for absence.
 */
export function isAbsent<T>(v: Maybe<T>): v is Absent {
  return typeof v === "object" && v !== null && (v as { absent?: unknown }).absent === true;
}

/** Narrow a `Maybe<T>` to a present `T`. */
export function isPresent<T>(v: Maybe<T>): v is T {
  return !isAbsent(v);
}

// ───────────────────────────────────────────────────────────── combinators

/** Present → `f(value)`; absent → the same `Absent`, reason preserved. */
export function mapMaybe<T, U>(v: Maybe<T>, f: (t: T) => U): Maybe<U> {
  return isAbsent(v) ? v : f(v);
}

/**
 * Unwrap with an explicit fallback.
 *
 * Use ONLY where the fallback is defensible (a sum that treats absent as
 * "contributes nothing", a sort key). Never to feed a displayed figure — that is
 * how `0` gets shown for `—`, which is the whole bug this module exists to stop.
 */
export function unwrapOr<T>(v: Maybe<T>, fallback: T): T {
  return isAbsent(v) ? fallback : v;
}

/** First present value, else the last `Absent` — `mark ?? last`, with reasons. */
export function firstPresent<T>(...vs: Maybe<T>[]): Maybe<T> {
  let last: Absent = absent("missing", "No candidate value");
  for (const v of vs) {
    if (!isAbsent(v)) return v;
    last = v;
  }
  return last;
}

/**
 * Absent if ANY input is absent, else `f(values)`.
 *
 * The guard for derived figures: notional needs size AND mark, a health ratio
 * needs equity AND maintenance margin. Propagating the first reason is what keeps
 * "Margin ratio —" explainable instead of merely blank.
 */
export function allPresent<T extends readonly unknown[], U>(
  vs: { [K in keyof T]: Maybe<T[K]> },
  f: (...args: T) => U,
): Maybe<U> {
  for (const v of vs) if (isAbsent(v)) return v;
  return f(...(vs as unknown as T));
}

// ───────────────────────────────────────── lifting the real API's failure shapes

/** `null | undefined | ""` → absent; anything else present. */
export function fromNullable<T>(v: T | null | undefined, field: string, code: AbsenceCode = "missing"): Maybe<T> {
  if (v === null || v === undefined || (v as unknown) === "") return absent(code, ABSENCE_REASONS[code], field);
  return v;
}

/** A number that must be finite. `NaN`/`Infinity` are absence, not values. */
export function finiteOrAbsent(v: number | null | undefined, field: string): Maybe<number> {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return absent(v === null || v === undefined ? "missing" : "unparseable", undefined, field);
  }
  return v;
}

/**
 * The adapter's error bag → absence.
 *
 * `Parsed<T>.errors` is keyed by `<wire_field>_error`, so a parsed entry already
 * carries everything needed: if the key is present the sibling value is a
 * fallback, not a figure. This is the single most-used lift in the file — it turns
 * the existing tolerant-parse contract into a renderable one with no changes to
 * `adapter.ts`.
 */
export function fromParsed<T extends object, K extends keyof T>(
  entry: Parsed<T>,
  key: K,
  wireField: string = String(key),
): Maybe<T[K]> {
  const message = entry.errors?.[`${wireField}_error`];
  if (message !== undefined) {
    // "missing" is the adapter's own word for a null/empty field; anything else
    // is a parse complaint. Keep its text — it names the offending value.
    return absent(message === "missing" ? "missing" : "unparseable", humanize(message), wireField);
  }
  const v = entry[key];
  if (v === null || v === undefined) return absent("missing", undefined, wireField);
  return v;
}

/**
 * A sibling `*_error` string on a raw wire object (`leverage_error`,
 * `fee_pnl_error`, `balance_error`, …) — the live API's own per-field failure
 * convention, distinct from the bag our parsers build.
 */
export function fromErrorSibling<T>(
  value: T | null | undefined,
  errorString: string | null | undefined,
  field: string,
): Maybe<T> {
  if (errorString) return absent(codeForErrorString(errorString), humanize(errorString), field);
  return fromNullable(value, field);
}

/** Map a few known upstream error strings onto sharper codes. */
function codeForErrorString(s: string): AbsenceCode {
  const k = s.toLowerCase();
  if (k.includes("not_mirrored") || k.includes("margin_state")) return "not_mirrored";
  if (k.includes("unauthor") || k.includes("401")) return "unauthenticated";
  if (k.includes("rate") && k.includes("limit")) return "rate_limited";
  if (k === "missing") return "missing";
  return "upstream_error";
}

/** `snake_case_code` → "Snake case code", for a tooltip a trader can read. */
function humanize(s: string): string {
  const spaced = s.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ─────────────────────────────────────────── the named cases, one per divergence

/**
 * `liquidation_price` (A.6).
 *
 * The live `/positions` path hardcodes `"0"`. `"0"` is therefore NOT a price — a
 * position that liquidates at zero cannot exist for a long and is meaningless for
 * a short. `parsePosition` already collapses 0 → null; this attaches the reason so
 * the blotter's LIQ. column can say why it is empty.
 *
 * Our fixtures DO carry real values (`Position.liqIsSynthetic` in
 * `lib/account.ts`), so they return present — the mock deliberately shows a
 * populated column. `LIQ_SYNTHETIC_NOTE` is the tooltip to hang on those, so a
 * screenshot never implies the live venue computed it.
 */
export function liquidationPrice(liq: number | null): Maybe<number> {
  if (liq === null || liq === 0) {
    return absent("not_computed", "The venue does not return a liquidation price yet", "liquidation_price");
  }
  return liq;
}

/** Tooltip for a fixture-computed liquidation price. */
export const LIQ_SYNTHETIC_NOTE = "Computed locally — the live API returns 0 for this field";

/**
 * Position leverage (A.13).
 *
 * There is no `leverage` field on any request or response. Live, the margin
 * mirror answers `leverage: null` with
 * `leverage_error: "margin_state_not_mirrored"`. The only honest substitute is
 * `1 / initial_margin_rate`, which is the market's MAXIMUM, not this position's
 * effective leverage — so it is offered separately and must be labelled as a cap.
 */
export function positionLeverage(
  leverage: number | null,
  leverageError: string | null = null,
): Maybe<number> {
  if (leverageError) {
    return absent(
      codeForErrorString(leverageError),
      leverageError === "margin_state_not_mirrored"
        ? "Margin state is not mirrored by the API"
        : humanize(leverageError),
      "leverage",
    );
  }
  return finiteOrAbsent(leverage, "leverage");
}

/** `1 / initial_margin_rate` — the market cap, never the position's own figure. */
export function maxLeverageFromImr(initialMarginRate: number | null): Maybe<number> {
  if (initialMarginRate === null || !Number.isFinite(initialMarginRate) || initialMarginRate <= 0) {
    return absent("missing", "No initial margin rate for this market", "initial_margin_rate");
  }
  return Math.floor(1 / initialMarginRate);
}

/**
 * Margin mode (A.12). Always absent: the engine has Cross/Isolated, the API's
 * `Position` exposes neither it nor `allocated_margin`, and no response to
 * `POST /account/margin` reports which mode a position ended up in.
 */
export function marginMode(): Absent {
  return absent("not_mirrored", "Margin mode is not exposed by the API", "margin_mode");
}

/**
 * Total PnL when the fee leg is missing.
 *
 * `total_pnl_complete: false` with `fee_pnl: null` means realized + unrealized is
 * all we have. Rendering that as "Total PnL" overstates the trader's result by
 * every fee they paid, so the *total* is absent even though its parts are present.
 * Show the parts, not the sum.
 */
export function totalPnl(
  realized: number,
  unrealized: number,
  feePnl: number | null,
  totalPnlComplete: boolean,
): Maybe<number> {
  if (!totalPnlComplete || feePnl === null) {
    return absent("incomplete", "Fee PnL is not returned, so the total would be understated", "fee_pnl");
  }
  return realized + unrealized + feePnl;
}

/** `fee_pnl` itself — engine-side only, so absent whenever the flag is false. */
export function feePnl(value: number | null, totalPnlComplete: boolean): Maybe<number> {
  if (value === null || !totalPnlComplete) {
    return absent("not_mirrored", "Fee PnL is not on the API's position", "fee_pnl");
  }
  return value;
}

/**
 * `last_trade_price` — `number | null` on `/markets/summary`.
 *
 * Null means the market has never traded, which is real for a freshly listed
 * market. That is "no data yet", not a failure, and it must not print `$0.00`.
 */
export function lastTradePrice(v: number | null): Maybe<number> {
  if (v === null || !Number.isFinite(v)) {
    return absent("no_data_yet", "No trades in this market yet", "last_trade_price");
  }
  return v;
}

/** A fill's fee (A.10). Absent when the engine event omitted it. */
export function fillFee(fee: number | null, feeError: string | null = null): Maybe<number> {
  if (feeError) return absent("not_on_endpoint", "Fee is not on the engine's fill event", "fee");
  return finiteOrAbsent(fee, "fee");
}

/** Book spread — absent when either side of the book is empty. */
export function spread(bestBid: number | null, bestAsk: number | null): Maybe<number> {
  if (bestBid === null || bestAsk === null) {
    return absent("no_data_yet", "One side of the book is empty", "spread");
  }
  return bestAsk - bestBid;
}

/** Anything with no endpoint at all (A.14, A.15) — open interest, fee tier, … */
export function noApiSurface(field: string, what: string): Absent {
  return absent("no_api_surface", `${what} has no API source`, field);
}

// ────────────────────────────────────────────────────────────────── staleness

/**
 * Staleness is NOT absence.
 *
 * The oracle or mark going stale is a real venue condition the API reports with
 * `is_stale`, and the last known value is still the best information available —
 * far better than `—`. So a stale figure renders normally with a marker beside
 * it, and `Freshness` is a sidecar rather than a `Maybe`.
 *
 * `nowMs` is a parameter, never a wall-clock read: this module is imported by
 * deterministic render paths, and the floor check forbids reading the clock
 * inside `lib/` at all (hydration safety — the server and first client render
 * must agree).
 */
export type Freshness = {
  readonly isStale: boolean;
  /** When the value was produced, if known. */
  readonly asOfMs: number | null;
  /** Age in ms, when both `asOfMs` and a reference `nowMs` are available. */
  readonly ageMs: number | null;
  /** Sentence for the badge's tooltip. */
  readonly reason: string | null;
};

export const FRESH: Freshness = { isStale: false, asOfMs: null, ageMs: null, reason: null };

/**
 * Build a `Freshness` from the wire's `is_stale` plus an optional age check.
 *
 * Both inputs matter: the venue's own flag is authoritative when present, and an
 * age threshold catches the case the flag cannot — our socket died, so nothing is
 * updating the flag either.
 */
export function freshness(opts: {
  isStale?: boolean | null;
  asOfMs?: number | null;
  nowMs?: number | null;
  /** Age past which we call it stale ourselves. */
  staleAfterMs?: number;
}): Freshness {
  const asOfMs = opts.asOfMs ?? null;
  const ageMs = asOfMs !== null && opts.nowMs != null ? Math.max(0, opts.nowMs - asOfMs) : null;
  const tooOld = ageMs !== null && opts.staleAfterMs !== undefined && ageMs > opts.staleAfterMs;
  const flagged = opts.isStale === true;
  if (!flagged && !tooOld) return { isStale: false, asOfMs, ageMs, reason: null };
  return {
    isStale: true,
    asOfMs,
    ageMs,
    reason: flagged ? "The venue reports this price as stale" : "No update received recently",
  };
}

// ───────────────────────────────────────────────────────── the formatter contract

/** The placeholder for an absent figure. One em dash, never "0", "N/A" or "-". */
export const ABSENT_GLYPH = "—";

/**
 * What a panel needs in order to render a `Maybe<T>` without knowing anything
 * about absence: the string to draw, the tooltip to attach, and whether it should
 * be styled as a value or as a placeholder.
 *
 * Returning this rather than a ReactNode keeps the contract usable from a
 * non-React caller (a CSV export, an aria-label, the audit's DOM extractor).
 */
export type Rendered = {
  readonly text: string;
  /** `title` attribute — the reason, on hover. Empty string when present. */
  readonly title: string;
  readonly isAbsent: boolean;
  readonly code: AbsenceCode | null;
};

/** How a present value becomes a string. Reuse `lib/format.ts` formatters here. */
export type Formatter<T> = (value: T) => string;

/**
 * `Maybe<T>` → `Rendered`.
 *
 * The formatter is only ever called on a present value, which is the point: a
 * formatter written for `number` can never be handed an `Absent` and can never
 * produce `NaN` or `$0.00` from one.
 */
export function render<T>(v: Maybe<T>, format: Formatter<T>, placeholder = ABSENT_GLYPH): Rendered {
  if (isAbsent(v)) {
    return {
      text: placeholder,
      title: v.field ? `${v.reason} (${v.field})` : v.reason,
      isAbsent: true,
      code: v.code,
    };
  }
  return { text: format(v), title: "", isAbsent: false, code: null };
}

/** Text-only convenience for aria-labels and exports. */
export const renderText = <T,>(v: Maybe<T>, format: Formatter<T>): string => render(v, format).text;
