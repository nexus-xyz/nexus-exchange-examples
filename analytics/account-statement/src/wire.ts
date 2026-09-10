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

function asTimestamp(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${key}: expected a millisecond timestamp`);
  }
  return Math.trunc(value);
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
    timestampMs: asTimestamp(record, "timestamp"),
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
  readonly fundingRate: Dec;
  readonly positionSize: Dec;
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
    fundingRate: money(watch, record, "funding_rate", "AccountFunding.funding_rate"),
    positionSize: money(watch, record, "position_size", "AccountFunding.position_size"),
    timestampMs: asTimestamp(record, "timestamp"),
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
  readonly size: Dec;
  readonly entryPrice: Dec;
  readonly exitPrice: Dec;
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
    size: money(watch, record, "size", "ClosedPosition.size"),
    entryPrice: money(watch, record, "entry_price", "ClosedPosition.entry_price"),
    exitPrice: money(watch, record, "exit_price", "ClosedPosition.exit_price"),
    realizedPnl: money(watch, record, "realized_pnl", "ClosedPosition.realized_pnl"),
    closedAtMs: asTimestamp(record, "closed_at_ms"),
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
        timestampMs: asTimestamp(entry, "timestamp_ms"),
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
