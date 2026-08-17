"use client";

/*
 * The order ticket.
 *
 * The design argument of the whole terminal lives here: the form and the request
 * body are the same object. Every control — side, type, price, size, leverage,
 * time-in-force, the execution flags — writes into one `Draft`, and the JSON
 * panel is a rendering of that draft rather than a decorative code sample. Change
 * a field and you watch the request change.
 *
 * Because of that, the ticket is a controlled component owned by the Trade screen:
 * clicking a level in the book writes `price`, and the draft survives a market
 * switch (re-priced, not reset).
 */

import { CSSProperties, ReactNode, useState } from "react";
import { Market, decimalsFor } from "@/lib/markets";
import { sizeDecimals } from "@/lib/feed";
import { comma } from "@/lib/format";
import type { OrderPlan } from "@/lib/orders";
import {
  R_XS,
  MONO,
  ARCHIVO,
  GREEN,
  RED,
  AMBER,
  L1,
  L2,
  L3,
  TERM,
  TXT,
  NUM,
  MUT,
  DIM,
  FAINT,
  GREEN_CHIP,
  RED_CHIP,
  GREEN_EDGE,
  RED_EDGE,
  R_MD,
  R_SM,
  monoLabel,
  field,
  ON_GREEN,
  ON_RED,
} from "@/lib/theme";
import { useDataPhase } from "@/lib/dataphase";
import { LoadingFigure } from "./states";
import { ABSENT_GLYPH } from "@/lib/api/absence";
import { ACTIVE_TENANT } from "@/lib/tenant";

export type OrderSide = "buy" | "sell";
/**
 * `limit` and `market` are the primary two; the rest sit behind the "Pro" group,
 * because exposing seven peer order types makes the common case harder to hit.
 */
export type OrderType = "limit" | "market" | "stop_limit" | "stop_market" | "scale" | "twap";
/**
 * The real engine's TimeInForce set (exchange-types/src/lib.rs). We had shipped
 * "ALO", which is a Hyperliquid term and not a value this venue accepts —
 * post-only is a TIF here, not a separate boolean flag.
 */
export type Tif = "GTC" | "IOC" | "FOK" | "PostOnly";
export type MarginMode = "cross" | "isolated";

/** Wire values are `PostOnly`; the rail shows the trader-facing abbreviation. */
export const TIF_LABEL: Record<Tif, string> = {
  GTC: "GTC",
  IOC: "IOC",
  FOK: "FOK",
  PostOnly: "POST",
};

export const PRO_TYPES: { id: OrderType; label: string }[] = [
  { id: "scale", label: "Scale" },
  { id: "twap", label: "TWAP" },
  { id: "stop_limit", label: "Stop Limit" },
  { id: "stop_market", label: "Stop Market" },
];

/** Order types that rest on the book, and so carry a price and a TIF. */
export const isResting = (t: OrderType) => t === "limit" || t === "stop_limit" || t === "scale";
/** Order types that need a trigger price. */
export const isTriggered = (t: OrderType) => t === "stop_limit" || t === "stop_market";

/**
 * The TIF this draft actually sends. A market-family order cannot be PostOnly —
 * the serializer rejects it, correctly — but the draft keeps whatever the trader
 * last chose so that flipping Market → Limit restores it rather than silently
 * resetting to GTC. The coercion happens here, at the one point both the preview
 * and the fee model read.
 */
export const effectiveTif = (draft: Draft): Tif =>
  isResting(draft.type) ? draft.tif : draft.tif === "PostOnly" ? "GTC" : draft.tif;

export type Draft = {
  side: OrderSide;
  type: OrderType;
  /** Null = follow the mid (market orders, or a limit the user hasn't touched). */
  price: number | null;
  /** Trigger price for stop orders. */
  trigger: number | null;
  /** Size in base units. */
  size: number;
  lev: number;
  margin: MarginMode;
  tif: Tif;
  reduceOnly: boolean;
  /** Take-profit / stop-loss bracket. */
  tpsl: boolean;
  tp: number | null;
  sl: number | null;

  /* Scale. Null start/end follow the current price and ±2% from it, so the ladder
   * is well-formed before the trader touches either field. */
  scaleStart: number | null;
  scaleEnd: number | null;
  scaleOrders: number;
  /** Size distribution across the ladder. 1 = even; >1 loads the far end. */
  scaleSkew: number;

  /* TWAP. Running time is entered, never the slice count — the count is derived
   * from it and the fixed frequency, which is the only honest direction: a venue
   * schedules on a clock, not on a number a trader picked. */
  twapHours: number;
  twapMinutes: number;
  twapRandomize: boolean;
};

export function initialDraft(market: Market): Draft {
  return {
    side: "buy",
    type: "limit",
    price: null,
    trigger: null,
    size: notionalToSize(market, 3200),
    lev: Math.min(10, market.maxLev),
    margin: "cross",
    // PostOnly rather than GTC + a flag. It is a TIF on this venue, and the maker
    // default is what the fee model assumes.
    tif: "PostOnly",
    reduceOnly: false,
    tpsl: false,
    tp: null,
    sl: null,
    scaleStart: null,
    scaleEnd: null,
    scaleOrders: 5,
    scaleSkew: 1,
    twapHours: 0,
    twapMinutes: 30,
    twapRandomize: false,
  };
}

/**
 * TWAP slices on a fixed clock. The trader sets how long it runs; the venue sets
 * how often it fires. A 30-minute TWAP is 61 orders because both endpoints fire.
 */
export const TWAP_FREQUENCY_S = 30;
export const TWAP_MIN_MINUTES = 5;
export const TWAP_MAX_MINUTES = 24 * 60;

export function twapSchedule(draft: Draft, minSize = 0) {
  const runtimeMin = Math.min(
    TWAP_MAX_MINUTES,
    Math.max(TWAP_MIN_MINUTES, draft.twapHours * 60 + draft.twapMinutes),
  );
  const runtimeS = runtimeMin * 60;
  const clockOrders = Math.floor(runtimeS / TWAP_FREQUENCY_S) + 1;
  /*
   * The clock wants a slice every 30 seconds, but a slice below the market's lot
   * size is not an order — it serializes to `"quantity": "0.000"` and the venue
   * rejects it. So the count is capped by what the size can actually pay for, and
   * the interval stretches to cover the same runtime. Slicing thinner than one lot
   * is not a smaller trade, it is no trade.
   */
  const affordable = minSize > 0 ? Math.floor(draft.size / minSize) : clockOrders;
  const orders = Math.max(1, Math.min(clockOrders, affordable));
  const stretched = orders < clockOrders;
  return {
    runtimeMin,
    orders,
    frequencyS: orders > 1 ? runtimeS / (orders - 1) : runtimeS,
    sizePer: draft.size / orders,
    /** True when the lot floor, not the clock, decided the count. */
    stretched,
  };
}

/**
 * The ladder a Scale draft implies. Rung prices interpolate start→end; rung sizes
 * are weighted `1 + (skew-1)·t`, so skew 1 is even and skew 3 puts three times the
 * size on the last rung as the first.
 */
export function scaleLadder(draft: Draft, last: number) {
  const n = Math.max(2, Math.round(draft.scaleOrders));
  const start = draft.scaleStart ?? draft.price ?? last;
  const end = draft.scaleEnd ?? start * (draft.side === "buy" ? 0.98 : 1.02);
  const skew = Math.max(0.1, draft.scaleSkew);
  const weights = Array.from({ length: n }, (_, i) => 1 + (skew - 1) * (i / (n - 1)));
  const total = weights.reduce((a, b) => a + b, 0);
  return {
    n,
    start,
    end,
    rungs: weights.map((w, i) => ({
      price: start + (end - start) * (i / (n - 1)),
      size: (draft.size * w) / total,
    })),
  };
}

/** A round-ish base size worth roughly `usd` at the market's reference price. */
export function notionalToSize(market: Market, usd: number): number {
  const raw = usd / market.ref;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return Math.max(mag, Math.round(raw / (mag / 10)) * (mag / 10));
}

/** Everything the ticket displays that isn't typed directly by the user. */
export function deriveOrder(draft: Draft, market: Market, last: number) {
  const px = isResting(draft.type) ? (draft.price ?? last) : last;
  const value = px * draft.size;
  const margin = value / draft.lev;
  // Simplified liquidation: the point where margin is exhausted, less a maintenance
  // buffer. Cross margin liquidates later because the whole account backs it.
  const dir = draft.side === "buy" ? 1 : -1;
  const buffer = draft.margin === "cross" ? 0.62 : 0.94;
  const liq = px * (1 - dir * (1 / draft.lev) * buffer);
  // Rates, not amounts. A rate is the number a trader can check against the fee
  // schedule; the dollar figure it implies changes with every size keystroke.
  const isMaker = effectiveTif(draft) === "PostOnly";
  const fee = value * (isMaker ? MAKER_RATE : TAKER_RATE);
  /*
   * The venue operator's fee, ADDITIVE on top of the schedule above and kept by
   * the operator in full — never carved out of the venue fee, which is what
   * makes it anti-Sybil (a builder self-dealing pays both). Clamped to the 10 bps
   * ceiling here, and bounded again by the maximum the trader approved when they
   * minted their delegated key for this venue — whichever is lower wins.
   */
  const builderFee = value * (normaliseBuilderBps(ACTIVE_TENANT.builder.feeBps) / 10_000);
  return {
    px,
    value,
    margin,
    liq,
    fee,
    builderFee,
    isMaker,
    slippage: isResting(draft.type) ? 0 : value * SLIPPAGE_EST,
  };
}

/** The hard ceiling on a venue fee. Mirrors venue-kit's `MAX_FEE_BPS`. */
export const MAX_BUILDER_BPS = 10;

/**
 * Normalise the venue's configured fee. Mirrors `venue-kit`'s `normaliseFeeBps`.
 *
 * THE CAP IS BACK, and it is worth saying why it left. It was removed on the
 * argument that a ceiling is the platform pricing its partners' product, and that
 * the fee sitting inside the quoted rate is protection enough. It is not:
 * disclosure is not consent, and this ticket is the proof — the trader reads one
 * blended maker/taker pair and never sees a fee to agree to. So the fee is now
 * bounded twice, once by this ceiling and once by an approval the trader signs
 * with their main wallet naming this venue and a maximum. See venue-kit's
 * `builder/fee.ts`.
 */
export function normaliseBuilderBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  if (bps < 0) return 0;
  if (bps > MAX_BUILDER_BPS) return MAX_BUILDER_BPS;
  /* Tenths, matching the kit — the recommended fee is 3.2 bps and an integer store
     would quietly charge 3. */
  return Math.round(bps * 10) / 10;
}

/**
 * The WHOLESALE schedule — what the venue is charged, not what its traders see.
 *
 * Maker is a rebate here, hence the sign. Both are fractions, not percents. Nothing
 * a trader looks at should read these directly; see VENUE_MAKER_RATE below.
 */
export const MAKER_RATE = -0.00005;
export const TAKER_RATE = 0.0002;

/**
 * The venue's own schedule, which is the only one a trader is ever shown.
 *
 * ONE FEE, NOT TWO. The ticket used to print the wholesale pair and then a second
 * `ACME Fee` row beneath it. That is the venue's internal accounting rendered on a
 * customer's screen: it tells a trader that the venue they are on is reselling
 * somebody else's exchange, invites them to wonder who the somebody is, and asks
 * them to add two numbers to learn the one figure they actually care about. No
 * exchange itemises its own cost of goods on an order ticket.
 *
 * So the builder fee is folded in, and what a trader sees is a single maker/taker
 * pair that is simply this venue's price. The disclosure obligation is met by that
 * number being complete and shown before submission — not by naming its parts. The
 * split stays visible exactly where it belongs, in the operator's own console, which
 * is the surface whose reader is entitled to it.
 *
 * Additive, so it lands on both sides: a 2 bp venue fee turns a −0.5 bp maker rebate
 * into a +1.5 bp maker charge, and that is the true thing to show.
 */
const VENUE_FEE_RATE = normaliseBuilderBps(ACTIVE_TENANT.builder.feeBps) / 10_000;
export const VENUE_MAKER_RATE = MAKER_RATE + VENUE_FEE_RATE;
export const VENUE_TAKER_RATE = TAKER_RATE + VENUE_FEE_RATE;
/** Estimated slippage on a marketable order, and the tolerance that rejects a fill. */
export const SLIPPAGE_EST = 0.0001;
export const SLIPPAGE_MAX = 0.08;

/*
 * `requestBody()` used to live here. It hand-built an object with `leverage`,
 * `margin_mode`, `post_only` and a nested `bracket` — none of which exist in the API —
 * using lowercase enums and JSON numbers where decimal strings are required. It has
 * been replaced by `planOrder()` in lib/orders.ts, which runs the draft through
 * `serializeOrderRequest` (lib/api/adapter.ts) and returns the request or requests the
 * draft really implies, plus the problems that block submission.
 */

// ---------------------------------------------------------------- sub-parts

function NumField({
  label,
  value,
  suffix,
  onChange,
  decimals = 2,
  disabled = false,
  accent,
  action,
  onSwapUnit,
}: {
  label: string;
  value: number;
  suffix?: string;
  onChange: (n: number) => void;
  decimals?: number;
  disabled?: boolean;
  accent?: string;
  /** Inline shortcut chip — MID on price, MAX on size. */
  action?: { label: string; onClick: () => void };
  /** Present when the field can be entered in either base or quote units. */
  onSwapUnit?: () => void;
}) {
  return (
    <label
      style={{
        display: "block",
        // A number input carries a wide default intrinsic size; without minWidth:0
        // it inflates its grid column and spills out of the ticket.
        minWidth: 0,
        background: TERM,
        border: `1px solid ${accent ?? L2}`,
        borderRadius: R_MD,
        padding: "6px 11px 7px",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "text",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <span style={{ ...monoLabel(9, "0.08em"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
        {action && !disabled && (
          <span
            onClick={(e) => {
              e.preventDefault();
              action.onClick();
            }}
            style={{
              fontFamily: MONO,
              fontSize: 8.5,
              letterSpacing: "0.06em",
              color: MUT,
              background: "#161616",
              border: `1px solid ${L3}`,
              borderRadius: R_XS,
              padding: "0 4px",
              cursor: "pointer",
              flex: "0 0 auto",
            }}
          >
            {action.label}
          </span>
        )}
      </span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <input
          type="number"
          disabled={disabled}
          value={Number(value.toFixed(decimals))}
          // Built as a string: Math.pow(10, -4) stringifies with float noise, and
          // server/client disagree on the rendered attribute.
          step={decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            outline: "none",
            padding: 0,
            color: NUM,
            fontFamily: MONO,
            fontSize: 13,
            // Native spinners fight the mono grid; the segmented % row covers stepping.
            appearance: "textfield",
            MozAppearance: "textfield",
          }}
        />
        {suffix && <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{suffix}</span>}
        {onSwapUnit && (
          <span
            onClick={(e) => {
              e.preventDefault();
              onSwapUnit();
            }}
            title="Switch between base and quote units"
            style={{ fontFamily: MONO, fontSize: 11, color: MUT, cursor: "pointer", flex: "0 0 auto" }}
          >
            ⇄
          </span>
        )}
      </span>
    </label>
  );
}

/** Toggleable execution flag. */
function Flag({ on, label, onToggle, disabled = false }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px 3px 6px",
        border: `1px solid ${on ? GREEN_EDGE : L2}`,
        borderRadius: R_SM,
        background: on ? GREEN_CHIP : "transparent",
        color: on ? GREEN : FAINT,
        fontFamily: MONO,
        fontSize: 10,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        letterSpacing: "0.04em",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: R_XS,
          border: `1px solid ${on ? GREEN : L3}`,
          background: on ? GREEN : "transparent",
        }}
      />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- ticket


export function OrderTicket({
  market,
  last,
  draft,
  onDraft,
  buyingPower,
  currentPosition = 0,
  plan,
  onSubmit,
  submitNote,
}: {
  market: Market;
  last: number;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  buyingPower: number;
  /** Signed base-unit position in this market, for the readout and reduce-only. */
  currentPosition?: number;
  /** The real requests this draft implies. Built by lib/orders.ts. */
  plan: OrderPlan;
  onSubmit: () => void;
  /** Result of the last submit, shown under the button. */
  submitNote?: { ok: boolean; text: string } | null;
}) {
  const [proOpen, setProOpen] = useState(false);
  const [tifOpen, setTifOpen] = useState(false);
  /** Amount entry unit — base units or quote notional. */
  const [amountUnit, setAmountUnit] = useState<"base" | "quote">("base");

  const d = decimalsFor(market);
  const o = deriveOrder(draft, market, last);
  const ladder = scaleLadder(draft, last);
  const twap = twapSchedule(draft, market.minOrderSize);
  const sizeDec = sizeDecimals(market);
  const maxSize = (buyingPower * draft.lev) / (draft.price ?? last);
  const pctUsed = Math.min(100, (draft.size / maxSize) * 100);
  const isBuy = draft.side === "buy";
  const proActive = PRO_TYPES.some((t) => t.id === draft.type);
  const proLabel = PRO_TYPES.find((t) => t.id === draft.type)?.label ?? "Pro";
  /* Buying power and current position are account figures. The ticket's PRICE fields
     are not — they follow the mid, which is market data — so the ticket is legitimately
     half-loaded under `?load=public`, and that is the state worth looking at: it is
     what stops an order being sized against a balance that has not arrived. */
  const ticketPhase = useDataPhase("account");
  const blocked = plan.problems.length > 0 || draft.size <= 0;

  /*
   * The consequences of this draft, as the rows that are actually knowable for
   * this order type. Fees are a maker/taker RATE pair with the side that applies
   * lit, because the rate is what a trader checks against the schedule — the
   * dollar figure moves with every size keystroke.
   */
  const pct = (x: number, dp = 4) => `${(x * 100).toFixed(dp)}%`;
  const feeCell = (
    <>
      {/* Green only when the venue's own maker rate is actually a rebate. A venue fee
          large enough to flip the sign must not keep the colour that means "you are
          being paid" — that is the one way folding the fees in could mislead. */}
      <span style={{ color: o.isMaker ? (VENUE_MAKER_RATE < 0 ? GREEN : TXT) : DIM }}>{pct(VENUE_MAKER_RATE)}</span>
      <span style={{ color: FAINT }}> / </span>
      <span style={{ color: o.isMaker ? DIM : TXT }}>{pct(VENUE_TAKER_RATE)}</span>
    </>
  );
  const money = (n: number) => "$" + comma(n, 2);
  const feeRow = { label: "Fees", value: feeCell, hint: "maker / taker — the side that applies is lit" };
  /*
   * The estimated cost of THIS order, in dollars, on the venue's own rate. It
   * replaces the old `ACME Fee` row: same position, but it answers "what will this
   * cost me" instead of "how is your margin composed". `o.fee` is signed, so a real
   * maker rebate still reads as a credit.
   */
  const estFee = o.value * (o.isMaker ? VENUE_MAKER_RATE : VENUE_TAKER_RATE);
  const estFeeRow = {
    label: "Est. Fee",
    value: (
      <span style={{ color: estFee < 0 ? GREEN : MUT }}>
        {estFee < 0 ? "+" : ""}
        {money(Math.abs(estFee))}
      </span>
    ),
    hint: "on this order at the rate above — moves with size",
  };
  const valueRow = { label: "Order Value", value: money(o.value) };
  const marginRow = { label: "Margin Required", value: money(o.margin) };
  const liqRow = { label: "Liquidation Price", value: comma(o.liq, d), color: RED };

  const summaryRows: { label: string; value: ReactNode; color?: string; hint?: string }[] =
    draft.type === "twap"
      ? [
          {
            label: "Frequency",
            value: `${Number(twap.frequencyS.toFixed(1))} seconds`,
            hint: twap.stretched
              ? `Stretched from ${TWAP_FREQUENCY_S}s — a ${TWAP_FREQUENCY_S}s cadence would slice below this market's ${market.minOrderSize} ${market.base} lot`
              : undefined,
            color: twap.stretched ? AMBER : undefined,
          },
          { label: "Runtime", value: `${twap.runtimeMin} minutes` },
          { label: "Number of Orders", value: comma(twap.orders, 0) },
          {
            label: "Size per Suborder",
            value: `${Number(twap.sizePer.toFixed(sizeDec))} ${market.base}`,
          },
          feeRow,
          estFeeRow,
        ]
      : draft.type === "scale"
        ? [
            { label: "Orders", value: `${ladder.n} orders` },
            valueRow,
            marginRow,
            liqRow,
            feeRow,
            estFeeRow,
          ]
        : isTriggered(draft.type)
          ? // No liquidation price and no slippage: neither exists until the
            // trigger fires and the order becomes live.
            [valueRow, marginRow, feeRow, estFeeRow]
          : [
              liqRow,
              valueRow,
              marginRow,
              ...(isResting(draft.type)
                ? []
                : [
                    {
                      label: "Slippage",
                      value: `Est: ${pct(SLIPPAGE_EST)} / Max: ${pct(SLIPPAGE_MAX, 2)}`,
                      hint: "Estimate, and the tolerance beyond which the fill is rejected",
                    },
                  ]),
              feeRow,
              estFeeRow,
            ];

  const sideBtn = (side: OrderSide, label: string): CSSProperties => {
    const on = draft.side === side;
    const c = side === "buy" ? GREEN : RED;
    return {
      flex: 1,
      padding: "5px 0",
      borderRadius: R_MD,
      cursor: "pointer",
      border: `1px solid ${on ? (side === "buy" ? GREEN_EDGE : RED_EDGE) : L2}`,
      background: on ? (side === "buy" ? GREEN_CHIP : RED_CHIP) : "transparent",
      color: on ? c : FAINT,
      fontFamily: MONO,
      fontSize: 11,
      /* Long/Short is the most-pressed control on the screen and it changed three
         properties instantaneously. Easing the border too is what stops the edge
         from popping a frame ahead of the fill. */
      transition: "background .14s ease-out, color .14s ease-out, border-color .14s ease-out",
    };
  };

  return (
    /* `nx-ticket` is a touch scope, not a style. Every control in here is sized for a
       mouse and matches the reference at desktop; on a phone the same fourteen
       controls were 14–27px against tiers of 32 and 36. Raising them one by one meant
       fourteen edits that each had to be kept away from the desktop layout, so the
       floor is stated once, scoped to the pointer that needs it. `min-height` beats a
       smaller inline `height`, which is why this works over the inline sizes. */
    <div className="nx-ticket" style={{ padding: "12px 14px 13px", background: "#060606" }}>
      {/* side */}
      <div style={{ display: "flex", gap: 6, marginBottom: 9 }}>
        <button onClick={() => onDraft({ side: "buy" })} style={sideBtn("buy", "Buy")}>
          Long
        </button>
        <button onClick={() => onDraft({ side: "sell" })} style={sideBtn("sell", "Sell")}>
          Short
        </button>
      </div>

      {/* order type — two primaries plus a Pro group */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 4, marginBottom: 9 }}>
        {(["market", "limit"] as OrderType[]).map((t) => {
          const on = draft.type === t;
          return (
            <button
              key={t}
              onClick={() => onDraft({ type: t })}
              style={{
                flex: 1,
                height: 27,
                border: `1px solid ${on ? L3 : L2}`,
                borderRadius: R_SM,
                background: on ? "#141414" : "transparent",
                color: on ? TXT : FAINT,
                fontFamily: ARCHIVO,
                fontSize: 12,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          );
        })}
        <div style={{ position: "relative", flex: 1 }}>
          <button
            onClick={() => setProOpen((p) => !p)}
            style={{
              width: "100%",
              height: 27,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              border: `1px solid ${proActive ? L3 : L2}`,
              borderRadius: R_SM,
              background: proActive ? "#141414" : "transparent",
              color: proActive ? TXT : FAINT,
              fontFamily: ARCHIVO,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {proLabel}
            <span style={{ fontSize: 8 }}>▾</span>
          </button>
          {proOpen && (
            <>
              <div onClick={() => setProOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
              <div
                role="menu"
                aria-label="Pro order types"
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  minWidth: 132,
                  zIndex: 21,
                  background: "#0d0d0d",
                  border: `1px solid ${L3}`,
                  borderRadius: 7,
                  boxShadow: "0 18px 44px rgba(0,0,0,0.8)",
                  overflow: "hidden",
                }}
              >
                {PRO_TYPES.map((t) => (
                  <button
                    key={t.id}
                    role="menuitem"
                    onClick={() => {
                      onDraft({ type: t.id });
                      setProOpen(false);
                    }}
                    className="nx-row"
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "7px 12px",
                      border: "none",
                      background: draft.type === t.id ? "rgba(14,203,129,0.08)" : "transparent",
                      color: draft.type === t.id ? GREEN : TXT,
                      fontFamily: ARCHIVO,
                      fontSize: 12,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* leverage + margin mode */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8, marginBottom: 9 }}>
        <div style={{ ...field(), padding: "5px 10px 6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={monoLabel(9, "0.08em")}>LEVERAGE</span>
            <span style={{ fontFamily: MONO, fontSize: 11.5, color: draft.lev > market.maxLev * 0.6 ? AMBER : GREEN }}>
              {draft.lev}×
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={market.maxLev}
            value={draft.lev}
            onChange={(e) => onDraft({ lev: Number(e.target.value) })}
            className="nx-range"
            aria-label={`Leverage, 1 to ${market.maxLev} times`}
            style={{ width: "100%", marginTop: 1 }}
          />
        </div>
        {/* Margin mode changes the liquidation model, so it sits beside leverage
            rather than in the flags row where it would read as a modifier. */}
        <div style={{ ...field(), padding: "5px 10px 6px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <span style={monoLabel(9, "0.08em")}>MARGIN</span>
          <div style={{ display: "flex", gap: 3, marginTop: 3 }}>
            {(["cross", "isolated"] as MarginMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onDraft({ margin: m })}
                style={{
                  flex: 1,
                  padding: "3px 0",
                  border: `1px solid ${draft.margin === m ? GREEN_EDGE : L2}`,
                  borderRadius: R_SM,
                  background: draft.margin === m ? GREEN_CHIP : "transparent",
                  color: draft.margin === m ? GREEN : FAINT,
                  fontFamily: MONO,
                  fontSize: 9.5,
                  cursor: "pointer",
                  textTransform: "uppercase",
                }}
              >
                {m === "cross" ? "Cross" : "Iso"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* what you have to work with — the two figures that bound every order */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 3,
          marginBottom: 9,
          fontFamily: MONO,
          fontSize: 10.5,
        }}
      >
        {/* Buying power and current position are the two numbers a trader sizes an
            order against. Showing either before the account has answered invites an
            order sized on a fiction, which is the one loading defect here with money
            behind it. */}
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: FAINT }}>Available to Trade</span>
          {ticketPhase === "ready" ? (
            <span style={{ color: NUM }}>{comma(buyingPower, 2)} USDX</span>
          ) : ticketPhase === "cold" ? (
            <LoadingFigure chars={12} height={9} />
          ) : (
            <span style={{ color: FAINT }}>{ABSENT_GLYPH}</span>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: FAINT }}>Current Position</span>
          {ticketPhase === "ready" ? (
            <span style={{ color: currentPosition === 0 ? DIM : currentPosition > 0 ? GREEN : RED }}>
              {currentPosition > 0 ? "+" : ""}
              {Number(currentPosition.toFixed(sizeDec))} {market.base}
            </span>
          ) : ticketPhase === "cold" ? (
            <LoadingFigure chars={8} height={9} />
          ) : (
            <span style={{ color: FAINT }}>{ABSENT_GLYPH}</span>
          )}
        </div>
      </div>

      {/* Price fields, stacked full-width and only the ones this order type has.
          A market order carries no price at all — the disabled PRICE · MKT field we
          used to show was a control that could not be operated, which is worse than
          an absent one. Stop price leads on triggered types: it is the condition,
          and the limit price below it is what happens once the condition is met. */}
      {isTriggered(draft.type) && (
        <div style={{ marginBottom: 8 }}>
          <NumField
            label="STOP PRICE"
            value={draft.trigger ?? last}
            decimals={d}
            accent={AMBER}
            onChange={(n) => onDraft({ trigger: n })}
            suffix="mark"
          />
        </div>
      )}

      {isResting(draft.type) && draft.type !== "scale" && (
        <div style={{ marginBottom: 8 }}>
          <NumField
            label="LIMIT PRICE"
            value={draft.price ?? last}
            decimals={d}
            onChange={(n) => onDraft({ price: n })}
            suffix="USDX"
            // MID snaps a resting order back to the current mid — the fastest way to
            // re-price after the market has moved away from a stale draft.
            action={{ label: "MID", onClick: () => onDraft({ price: null }) }}
          />
        </div>
      )}

      {/* Scale — the ladder's own parameters. Without these the type was a menu
          entry that silently placed five rungs nobody chose. */}
      {draft.type === "scale" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8, marginBottom: 8 }}>
          <NumField
            label="START PRICE"
            value={ladder.start}
            decimals={d}
            suffix="USDX"
            onChange={(n) => onDraft({ scaleStart: n })}
          />
          <NumField
            label="END PRICE"
            value={ladder.end}
            decimals={d}
            suffix="USDX"
            onChange={(n) => onDraft({ scaleEnd: n })}
          />
          <NumField
            label="ORDERS"
            value={ladder.n}
            decimals={0}
            onChange={(n) => onDraft({ scaleOrders: Math.min(50, Math.max(2, Math.round(n))) })}
          />
          <NumField
            label="SKEW"
            value={draft.scaleSkew}
            decimals={2}
            // 1 is even. Above it the far rungs carry more size, which is the whole
            // reason to ladder rather than place one resting order.
            onChange={(n) => onDraft({ scaleSkew: Math.min(10, Math.max(0.1, n)) })}
          />
        </div>
      )}

      {/* TWAP — running time, not slice count. The count is derived below. */}
      {draft.type === "twap" && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ ...monoLabel(9, "0.1em"), color: FAINT, marginBottom: 6 }}>
            RUNNING TIME (5M–24H)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
            <NumField
              label="HOURS"
              value={draft.twapHours}
              decimals={0}
              onChange={(n) => onDraft({ twapHours: Math.min(24, Math.max(0, Math.round(n))) })}
            />
            <NumField
              label="MINUTES"
              value={draft.twapMinutes}
              decimals={0}
              onChange={(n) => onDraft({ twapMinutes: Math.min(59, Math.max(0, Math.round(n))) })}
            />
          </div>
        </div>
      )}

      <div style={{ marginBottom: 8 }}>
        <NumField
          label={amountUnit === "base" ? "AMOUNT" : "AMOUNT · VALUE"}
          value={amountUnit === "base" ? draft.size : draft.size * (draft.price ?? last)}
          decimals={amountUnit === "base" ? sizeDec : 2}
          suffix={amountUnit === "base" ? market.base : "USDX"}
          onChange={(n) =>
            onDraft({ size: Math.max(0, amountUnit === "base" ? n : n / (draft.price ?? last)) })
          }
          action={{ label: "MAX", onClick: () => onDraft({ size: Number(maxSize.toFixed(sizeDec)) }) }}
          onSwapUnit={() => setAmountUnit((u) => (u === "base" ? "quote" : "base"))}
        />
      </div>

      {/* Size as a share of buying power. A draggable slider with a live percent
          box, not five preset chips: presets can only express five of the hundred
          positions the slider reaches, and the box lets you type the one you want.
          The chips looked tidier and were strictly less capable. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(pctUsed)}
          aria-label="Size as a percentage of buying power"
          onChange={(e) =>
            onDraft({ size: Number(((maxSize * Number(e.target.value)) / 100).toFixed(sizeDec)) })
          }
          style={{
            flex: 1,
            minWidth: 0,
            height: 3,
            appearance: "none",
            WebkitAppearance: "none",
            borderRadius: R_XS,
            outline: "none",
            cursor: "pointer",
            // The filled portion is painted with a gradient rather than a second
            // element, so the track stays one box for the thumb to ride.
            background: `linear-gradient(to right, ${isBuy ? GREEN : RED} 0%, ${isBuy ? GREEN : RED} ${pctUsed}%, ${L2} ${pctUsed}%, ${L2} 100%)`,
          }}
          className="nx-range"
        />
        <label
          style={{
            ...field,
            display: "flex",
            alignItems: "baseline",
            gap: 3,
            width: 66,
            flex: "0 0 auto",
            padding: "4px 8px",
          }}
        >
          <input
            value={Math.round(pctUsed)}
            inputMode="numeric"
            aria-label="Size percentage"
            onChange={(e) => {
              const n = Math.min(100, Math.max(0, Number(e.target.value.replace(/[^0-9]/g, "")) || 0));
              onDraft({ size: Number(((maxSize * n) / 100).toFixed(sizeDec)) });
            }}
            style={{
              width: "100%",
              minWidth: 0,
              border: "none",
              background: "transparent",
              color: TXT,
              fontFamily: MONO,
              fontSize: 12,
              textAlign: "right",
              outline: "none",
            }}
          />
          <span style={{ color: FAINT, fontFamily: MONO, fontSize: 10 }}>%</span>
        </label>
      </div>

      {/* Execution flags. TIF is a dropdown rather than a chip per value: it has
          four values, only one is ever set, and it only applies to resting types —
          a chip row spent a full line advertising three states you cannot pick.
          The POST-ONLY toggle that used to sit here is gone; post-only IS a TIF on
          this venue, and having both meant `isMaker` could disagree with the
          `time_in_force` the preview was about to send. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, marginBottom: 9 }}>
        <Flag on={draft.reduceOnly} label="REDUCE ONLY" onToggle={() => onDraft({ reduceOnly: !draft.reduceOnly })} />
        {draft.type === "twap" && (
          <Flag
            on={draft.twapRandomize}
            label="RANDOMIZE"
            onToggle={() => onDraft({ twapRandomize: !draft.twapRandomize })}
          />
        )}
        <div style={{ flex: 1 }} />
        {isResting(draft.type) && (
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setTifOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 8px",
                border: `1px solid ${L2}`,
                borderRadius: R_SM,
                background: "transparent",
                color: DIM,
                fontFamily: MONO,
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              <span style={{ color: FAINT }}>TIF</span>
              <span style={{ color: TXT }}>{TIF_LABEL[draft.tif]}</span>
              <span style={{ fontSize: 8 }}>▾</span>
            </button>
            {tifOpen && (
              <>
                <div onClick={() => setTifOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
                <div
                  role="menu"
                  aria-label="Time in force"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    right: 0,
                    minWidth: 116,
                    zIndex: 21,
                    background: "#0d0d0d",
                    border: `1px solid ${L3}`,
                    borderRadius: 7,
                    boxShadow: "0 18px 44px rgba(0,0,0,0.8)",
                    overflow: "hidden",
                  }}
                >
                  {(Object.keys(TIF_LABEL) as Tif[]).map((t) => (
                    <button
                      key={t}
                      role="menuitem"
                      onClick={() => {
                        onDraft({ tif: t });
                        setTifOpen(false);
                      }}
                      className="nx-row"
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "6px 11px",
                        textAlign: "left",
                        border: "none",
                        background: draft.tif === t ? "rgba(14,203,129,0.08)" : "transparent",
                        color: draft.tif === t ? GREEN : TXT,
                        fontFamily: MONO,
                        fontSize: 10.5,
                        cursor: "pointer",
                      }}
                    >
                      {TIF_LABEL[t]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* TP/SL bracket — attached to the entry, so it belongs to the same request
          rather than being two follow-up orders the trader has to remember. */}
      <div style={{ marginBottom: 10 }}>
        <Flag
          on={draft.tpsl}
          label="TAKE PROFIT / STOP LOSS"
          onToggle={() =>
            onDraft({
              tpsl: !draft.tpsl,
              // Seed sensible brackets on first open — ±5% from the entry, in the
              // direction the position actually profits and loses.
              tp: draft.tp ?? o.px * (isBuy ? 1.05 : 0.95),
              sl: draft.sl ?? o.px * (isBuy ? 0.95 : 1.05),
            })
          }
        />
        {draft.tpsl && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8, marginTop: 8 }}>
            <NumField
              label="TP PRICE"
              value={draft.tp ?? o.px}
              decimals={d}
              accent={GREEN_EDGE}
              onChange={(n) => onDraft({ tp: n })}
            />
            <NumField
              label="GAIN"
              value={(((draft.tp ?? o.px) - o.px) * draft.size * (isBuy ? 1 : -1))}
              decimals={2}
              suffix="USDX"
              onChange={(n) => onDraft({ tp: o.px + (n / draft.size) * (isBuy ? 1 : -1) })}
            />
            <NumField
              label="SL PRICE"
              value={draft.sl ?? o.px}
              decimals={d}
              accent={RED_EDGE}
              onChange={(n) => onDraft({ sl: n })}
            />
            <NumField
              label="LOSS"
              value={(((draft.sl ?? o.px) - o.px) * draft.size * (isBuy ? 1 : -1))}
              decimals={2}
              suffix="USDX"
              onChange={(n) => onDraft({ sl: o.px + (n / draft.size) * (isBuy ? 1 : -1) })}
            />
          </div>
        )}
      </div>

      {/* The JSON request preview used to sit here. It was the terminal's own idea,
          not the reference's, and this file is a specification for what the team
          builds — every element that has no counterpart on the venue we are matching
          is an element a reader has to decide about. If it comes back it belongs
          behind the API affordance in the blotter header, not in the ticket.

          What survives is the problem list, because it is not decoration: a draft
          that will not serialize must say so before the button is pressed. It is
          invisible whenever the draft is clean, which is the normal case. */}
      {plan.problems.length > 0 && (
        <div
          style={{
            marginBottom: 9,
            padding: "7px 10px",
            border: `1px solid ${RED_EDGE}`,
            borderRadius: R_MD,
            background: RED_CHIP,
            fontFamily: MONO,
            fontSize: 10,
          }}
        >
          {plan.problems.map((pr) => (
            <div key={pr} style={{ color: RED, display: "flex", gap: 6 }}>
              <span>✗</span>
              <span>{pr}</span>
            </div>
          ))}
        </div>
      )}

      {/* This button had no handler at all until now — the product's primary action
          was inert, which is why nothing downstream of it had a surface. */}
      <button
        onClick={onSubmit}
        disabled={blocked}
        /* 40px is the desktop figure and matches the reference. On a phone this is
           the one control on the screen where the touch floor outranks parity: it
           is the irreversible action, it is hit under time pressure, and 44px is
           the tier the floor grades a submit at. `nx-submit` raises it at ≤1023px
           only, so the desktop ticket is untouched. */
        className="nx-submit"
        style={{
          width: "100%",
          // Flat, not a gradient. A gradient is invisible to every contrast checker
          // (backgroundColor stays transparent), so neither axe nor our own harness
          // can grade the label on it — and a flat direction colour is closer to the
          // instrument aesthetic than a soft vertical fade.
          background: blocked ? L2 : isBuy ? GREEN : RED,
          color: blocked ? FAINT : isBuy ? ON_GREEN : ON_RED,
          border: "none",
          borderRadius: R_MD,
          fontFamily: ARCHIVO,
          fontWeight: 700,
          fontSize: 13,
          cursor: blocked ? "not-allowed" : "pointer",
          letterSpacing: "0.01em",
        }}
      >
        {blocked
          ? "Cannot submit — see problems"
          : `${isBuy ? "Buy" : "Sell"} ${Number(draft.size.toFixed(sizeDec))} ${market.base}${plan.requests.length > 1 ? ` · ${plan.requests.length} orders` : ""}`}
      </button>

      {/* The consequences block sits BELOW the button, which is where a venue that
          varies it by order type has to put it: TWAP shows five rows, a stop shows
          three, and above the button that difference walks the primary action up
          and down the rail every time the type changes.

          Which rows appear is not a space decision. A stop order has no liquidation
          price and no slippage estimate until it triggers, so printing either would
          be a claim the venue cannot make yet — they are dropped rather than shown
          as zero. */}
      <div
        style={{
          marginTop: 10,
          padding: "9px 11px",
          background: TERM,
          border: `1px solid ${L1}`,
          borderRadius: R_MD,
          fontFamily: MONO,
          fontSize: 10,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        {summaryRows.map((r) => (
          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
            <span
              title={r.hint}
              style={{
                color: FAINT,
                whiteSpace: "nowrap",
                cursor: r.hint ? "help" : undefined,
                borderBottom: r.hint ? `1px dotted ${L2}` : undefined,
              }}
            >
              {r.label}
            </span>
            <span style={{ color: r.color ?? NUM, whiteSpace: "nowrap", textAlign: "right" }}>{r.value}</span>
          </div>
        ))}
      </div>

      {submitNote && (
        <div
          style={{
            marginTop: 8,
            padding: "6px 9px",
            borderRadius: R_SM,
            border: `1px solid ${submitNote.ok ? GREEN_EDGE : RED_EDGE}`,
            background: submitNote.ok ? GREEN_CHIP : RED_CHIP,
            fontFamily: MONO,
            fontSize: 10,
            color: submitNote.ok ? GREEN : RED,
          }}
        >
          {submitNote.text}
        </div>
      )}

      {/* The attestation the reference carries under its CTA. It is the last thing
          between a draft and a position, and it belongs to the ticket rather than to
          a footer somewhere. */}
      <div
        style={{
          marginTop: 9,
          fontFamily: MONO,
          fontSize: 9,
          lineHeight: 1.5,
          color: FAINT,
          letterSpacing: "0.02em",
        }}
      >
        By submitting this trade, you agree to our{" "}
        <span style={{ color: DIM, textDecoration: "underline" }}>Terms of Use</span> and attest
        that you are not trading from a restricted territory.
      </div>
    </div>
  );
}
