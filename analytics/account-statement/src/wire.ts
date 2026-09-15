// What the venue actually sends, and how to parse it honestly.
//
// Split out of `statement.ts` because this is the interesting half: every
// decision about *what a field means when it is missing, negative, or the
// wrong JSON type* lives here, and none of it is visible from the schema
// alone.
//
// Every monetary value crosses into this app through `decimal.fromWire`, and
// nothing here ever holds money in a `number`.

import {
  type Dec,
  type Fidelity,
  fromWire,
  isZero,
  sign,
} from "./decimal.js";

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function asString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TypeError(`${key}: expected a string, got ${typeof value}`);
  }
  return value;
}

/** An explicit `Z` or `±HH:MM` / `±HHMM` suffix. */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
/** `YYYY-MM-DD` with no time part, which ECMAScript already reads as UTC. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A whole number of milliseconds that arrived quoted. */
const EPOCH_DIGITS = /^[+-]?\d+$/;

/**
 * Read a wire timestamp, whatever shape it arrived in, **in UTC**.
 *
 * Returns `null` rather than throwing, so a caller that would rather drop one
 * row than lose the run can. `asTimestamp` is the throwing wrapper.
 *
 * THE ZONE IS THE WHOLE PROBLEM. `Date.parse` is specified to read a zone-less
 * date-TIME as the *operator's local time* (`2026-09-15T10:00:00` is 13:00Z on
 * a UTC-3 machine) while reading a date-ONLY string as UTC. Timestamps select
 * which rows fall inside the half-open period, and therefore what lands in the
 * derived side of the reconciliation — while the published side comes from the
 * portfolio series and does not move. So on a venue sending zone-less strings
 * the residual shifted by whoever happened to run the tool, with nothing in
 * the output naming the cause.
 *
 * A zone-less stamp is therefore read as UTC deliberately rather than by
 * accident, and the field is recorded so the run can say it did so.
 */
export function readTimestamp(
  watch: TypeWatch,
  record: Record<string, unknown>,
  key: string,
  field: string,
): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  // An ISO-8601 string where the contract promised a number. Hard-requiring
  // the number killed EVERY row on a venue that sent strings (@nvizble, #22) —
  // the same ENG-8439 divergence this app already tolerates for money, refused
  // here for no reason beyond which helper the field went through.
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;

  // Milliseconds that merely arrived quoted. `Date.parse` rejects these
  // outright, which is the same refusal-by-container ENG-8439 is about.
  if (EPOCH_DIGITS.test(text)) {
    const ms = Number(text);
    return Number.isFinite(ms) ? Math.trunc(ms) : null;
  }

  const zoned = HAS_ZONE.test(text) || DATE_ONLY.test(text);
  // `T` separator supplied when the venue used a space, since `Date.parse` is
  // only specified for the ISO form and the space form is implementation-defined.
  const normalised = zoned ? text : `${text.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalised);
  if (!Number.isFinite(parsed)) return null;
  if (!zoned) watch.observeZonelessTimestamp(field);
  return parsed;
}

function asTimestamp(
  watch: TypeWatch,
  record: Record<string, unknown>,
  key: string,
  field: string,
): number {
  const ms = readTimestamp(watch, record, key, field);
  if (ms === null) throw new TypeError(`${key}: expected a millisecond timestamp`);
  return ms;
}

/** A field whose wire type is being watched. Reported when it disagrees. */
export interface TypeObservation {
  readonly field: string;
  readonly fidelity: Fidelity;
}

/**
 * Records how each monetary field actually arrived.
 *
 * The spec says every one of them is a decimal string. One endpoint disagrees
 * in production (ENG-8439), and rather than hardcode which, this app *watches*
 * — so the README's claim about wire types is a measurement the tool re-takes
 * on every run rather than a note that goes stale.
 */
export class TypeWatch {
  private readonly seen = new Map<string, Set<Fidelity>>();
  private readonly zoneless = new Set<string>();

  /**
   * A timestamp field that arrived without a `Z` or offset, and was therefore
   * read as UTC by decision rather than by `Date.parse`'s local-time default.
   * Surfaced as a caveat: it is the difference between a residual that is the
   * same for everyone and one that depends on who ran the tool.
   */
  observeZonelessTimestamp(field: string): void {
    this.zoneless.add(field);
  }

  /** Timestamp fields that arrived without an explicit zone. */
  zonelessTimestamps(): readonly string[] {
    return [...this.zoneless].sort((a, b) => a.localeCompare(b));
  }

  observe(field: string, fidelity: Fidelity): void {
    const set = this.seen.get(field) ?? new Set<Fidelity>();
    set.add(fidelity);
    this.seen.set(field, set);
  }

  /** Fields that arrived as JSON numbers where the spec promised strings. */
  divergent(): readonly TypeObservation[] {
    const out: TypeObservation[] = [];
    for (const [field, fidelities] of this.seen) {
      if (fidelities.has("from-json-number")) {
        out.push({ field, fidelity: "from-json-number" });
      }
    }
    return out.sort((a, b) => a.field.localeCompare(b.field));
  }
}

function money(
  watch: TypeWatch,
  record: Record<string, unknown>,
  key: string,
  field: string,
): Dec {
  const parsed = fromWire(record[key], field);
  watch.observe(field, parsed.fidelity);
  return parsed.value;
}

/**
 * The same, for a field **this app never reads** — null instead of throwing.
 *
 * A statement whose thesis is degrading honestly was killing a whole run over
 * a malformed `position_size`, a number nothing here computes with. @nvizble
 * reproduced it on #22: three valid funding rows plus one missing
 * `position_size` discarded the three good rows and produced no statement at
 * all. The strictness was pointed at the wrong fields.
 *
 * Kept on the struct rather than deleted because it is real wire content and
 * `TypeWatch` still reports its fidelity when it parses — the app declines to
 * *depend* on it, which is different from declining to look. A field the
 * statement actually uses (`amount`, `realized_pnl`, `price`, `size` on a
 * fill) still goes through `money` and still refuses, because there a bad
 * value would silently change a number a reader acts on.
 */
function optionalMoney(
  watch: TypeWatch,
  record: Record<string, unknown>,
  key: string,
  field: string,
): Dec | null {
  try {
    const parsed = fromWire(record[key], field);
    watch.observe(field, parsed.fidelity);
    return parsed.value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export interface Fill {
  readonly marketId: string;
  readonly side: "buy" | "sell";
  readonly price: Dec;
  readonly size: Dec;
  /**
   * Null when the fill **stated no fee**, which is not a fee of zero.
   *
   * `"0"` means the venue charged nothing — a liquidation fill is exempt on
   * both legs. An absent key means it said nothing: a fill predating per-fill
   * fee emission, or a leg the engine did not stamp. Treating the second as
   * zero would put a number the venue never asserted into a total presented as
   * complete, so it is counted separately and named in the output.
   *
   * A *negative* fee is not an error either: it is a maker rebate, a credit.
   */
  readonly fee: Dec | null;
  readonly role: "taker" | "maker";
  readonly timestampMs: number;
  readonly isLiquidation: boolean;
}

export function parseFill(watch: TypeWatch, raw: unknown): Fill {
  const record = asRecord(raw);
  const side = asString(record, "side");
  const role = asString(record, "taker_or_maker");
  if (side !== "buy" && side !== "sell") {
    throw new TypeError(`fills: unknown side ${side}`);
  }
  if (role !== "taker" && role !== "maker") {
    throw new TypeError(`fills: unknown taker_or_maker ${role}`);
  }
  const feeRaw = record["fee"];
  return {
    marketId: asString(record, "market_id"),
    side,
    price: money(watch, record, "price", "Fill.price"),
    size: money(watch, record, "size", "Fill.size"),
    fee: feeRaw === undefined || feeRaw === null
      ? null
      : money(watch, record, "fee", "Fill.fee"),
    role,
    timestampMs: asTimestamp(watch, record, "timestamp", "Fill.timestamp"),
    isLiquidation: record["is_liquidation"] === true,
  };
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

export interface FundingRow {
  readonly marketId: string;
  /**
   * The **signed** settlement amount. Negative is paid, positive is received.
   *
   * This is the sign convention `/funding` publishes and the one this app
   * sums. `direction` states the same fact in words; `directionAgrees` records
   * whether the two agreed on this row, because a statement that trusts one
   * and ignores the other cannot tell you when they part company.
   */
  readonly amount: Dec;
  readonly direction: "paid" | "received";
  readonly directionAgrees: boolean;
  /** Null when the row stated it unusably — nothing here reads it. */
  readonly fundingRate: Dec | null;
  /** Null when the row stated it unusably — nothing here reads it. */
  readonly positionSize: Dec | null;
  readonly timestampMs: number;
}

export function parseFunding(watch: TypeWatch, raw: unknown): FundingRow {
  const record = asRecord(raw);
  const direction = asString(record, "direction");
  if (direction !== "paid" && direction !== "received") {
    throw new TypeError(`funding: unknown direction ${direction}`);
  }
  const amount = money(watch, record, "amount", "AccountFunding.amount");
  // A zero amount has no sign to disagree with; the venue does not emit those
  // rows, but a row that is zero is not evidence of a contradiction.
  const agrees =
    isZero(amount) ||
    (direction === "paid" ? sign(amount) < 0 : sign(amount) > 0);
  return {
    marketId: asString(record, "market_id"),
    amount,
    direction,
    directionAgrees: agrees,
    fundingRate: optionalMoney(watch, record, "funding_rate", "AccountFunding.funding_rate"),
    positionSize: optionalMoney(watch, record, "position_size", "AccountFunding.position_size"),
    timestampMs: asTimestamp(watch, record, "timestamp", "AccountFunding.timestamp"),
  };
}

/** What `/funding` could and could not reach, from its two depth headers. */
export interface FundingDepth {
  /** `true` / `false` from the header; null when it was absent — unknown. */
  readonly truncated: boolean | null;
  /** Oldest window the answer could reach; null when absent — unknown. */
  readonly oldestMs: number | null;
}

// ---------------------------------------------------------------------------
// Closed positions
// ---------------------------------------------------------------------------

export interface ClosedPosition {
  readonly marketId: string;
  readonly side: "Long" | "Short";
  /** The next three are null when unusable — nothing here reads them. */
  readonly size: Dec | null;
  readonly entryPrice: Dec | null;
  readonly exitPrice: Dec | null;
  readonly realizedPnl: Dec;
  readonly closedAtMs: number;
}

export function parseClosed(watch: TypeWatch, raw: unknown): ClosedPosition {
  const record = asRecord(raw);
  const side = asString(record, "side");
  if (side !== "Long" && side !== "Short") {
    throw new TypeError(`positions/closed: unknown side ${side}`);
  }
  return {
    marketId: asString(record, "market_id"),
    side,
    size: optionalMoney(watch, record, "size", "ClosedPosition.size"),
    entryPrice: optionalMoney(watch, record, "entry_price", "ClosedPosition.entry_price"),
    exitPrice: optionalMoney(watch, record, "exit_price", "ClosedPosition.exit_price"),
    realizedPnl: money(watch, record, "realized_pnl", "ClosedPosition.realized_pnl"),
    closedAtMs: asTimestamp(watch, record, "closed_at_ms", "ClosedPosition.closed_at_ms"),
  };
}

// ---------------------------------------------------------------------------
// Portfolio history
// ---------------------------------------------------------------------------

export interface PortfolioPoint {
  readonly timestampMs: number;
  readonly equity: Dec;
  readonly pnl: Dec;
  readonly volume: Dec;
}

export interface PortfolioSeries {
  readonly window: string;
  readonly cadenceMs: number;
  readonly points: readonly PortfolioPoint[];
  /** What the app asked for, kept so the clamp can be reported. */
  readonly requestedLimit: number;
}

export function parsePortfolio(
  watch: TypeWatch,
  raw: unknown,
  requestedLimit: number,
): PortfolioSeries {
  const record = asRecord(raw);
  const rawPoints = record["points"];
  if (!Array.isArray(rawPoints)) {
    throw new TypeError("portfolio-history: `points` is not an array");
  }
  const cadence = record["cadence_ms"];
  return {
    window: typeof record["window"] === "string" ? record["window"] : "unknown",
    cadenceMs: typeof cadence === "number" ? Math.trunc(cadence) : 0,
    points: rawPoints.map((point): PortfolioPoint => {
      const entry = asRecord(point);
      return {
        timestampMs: asTimestamp(watch, entry, "timestamp_ms", "PortfolioPoint.timestamp_ms"),
        equity: money(watch, entry, "equity", "PortfolioPoint.equity"),
        pnl: money(watch, entry, "pnl", "PortfolioPoint.pnl"),
        volume: money(watch, entry, "volume", "PortfolioPoint.volume"),
      };
    }),
    requestedLimit,
  };
}

// ---------------------------------------------------------------------------
// Fee schedule
// ---------------------------------------------------------------------------

export interface FeeSchedule {
  readonly makerBps: number;
  readonly takerBps: number;
  readonly tier: string;
  readonly schedule: string;
  readonly volume30d: Dec;
  /** `true` when `volume_30d` may undercount — the fill buffer was at capacity. */
  readonly volume30dEstimated: boolean;
}

export function parseFees(watch: TypeWatch, raw: unknown): FeeSchedule {
  const record = asRecord(raw);
  const maker = record["maker_fee_bps"];
  const taker = record["taker_fee_bps"];
  if (typeof maker !== "number" || typeof taker !== "number") {
    throw new TypeError("account/fees: maker_fee_bps/taker_fee_bps must be integers");
  }
  return {
    // A negative maker fee is a rebate, not a parse error.
    makerBps: Math.trunc(maker),
    takerBps: Math.trunc(taker),
    tier: asString(record, "tier"),
    schedule: asString(record, "schedule"),
    volume30d: money(watch, record, "volume_30d", "AccountFees.volume_30d"),
    volume30dEstimated: record["volume_30d_estimated"] === true,
  };
}
