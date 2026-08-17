"use client";

/*
 * The blotter — positions, working orders, and fills across the bottom of the
 * Trade screen.
 *
 * Positions are marked against the live feed of *their own* market, not the
 * market on screen, so PnL keeps moving on the two rows you aren't looking at.
 */

import { useMemo, useRef, useState } from "react";
import { ACCOUNT, ACCOUNT_FUNDING, POSITIONS, positionPnl, type Position } from "@/lib/account";
import { ACCOUNT_ACTIVITY } from "@/lib/activity";
import { ACTIVITY_VIEWS, type ActivityKind, type ActivityView } from "@/lib/api/activity";
import { useAccountSnapshot } from "./AccountPanel";
import { bracketFor, type LedgerFill, type TwapView } from "@/lib/lifecycle";
import type { UiAccountFunding, UiOrder } from "@/lib/api/adapter";
import { getMarket, fmtPrice, fmtSize } from "@/lib/markets";
import { hms, TICK_MS, type Feed } from "@/lib/feed";
import { comma, usd, pct } from "@/lib/format";
import {
  R_XS,
  R_SM, MONO, GREEN, RED, GREEN_CHIP, RED_CHIP, AMBER, L1, L2, TXT, NUM, MUT, DIM, FAINT, sign } from "@/lib/theme";
import { OverflowTabs, HeadRow, Row, Num, TabDef, Table, RowGroup } from "./primitives";
import { ActionButton as RowAction, BlotterTable, EditableNum, type ColumnSet, type Density } from "./BlotterTable";
import { TableState } from "./states";
import { useDataPhase } from "@/lib/dataphase";

/*
 * The empty / loading / error state is NOT a row, so it must sit outside the
 * rowgroup: a role="rowgroup" whose child is not a row is aria-required-children.
 * Named distinctly so the placement reads as deliberate.
 */
const TableStateOutside = TableState;

/** Small inline action for a table row. Sized to the control tap tier. */
function ActionButton({
  label,
  title,
  onClick,
  tone = "neutral",
}: {
  label: string;
  title: string;
  onClick: () => void;
  tone?: "neutral" | "red";
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${L2}`,
        borderRadius: R_SM,
        background: "transparent",
        color: tone === "red" ? RED : MUT,
        fontFamily: MONO,
        fontSize: 9.5,
        padding: "2px 6px",
        cursor: "pointer",
        lineHeight: 1.3,
      }}
    >
      {label}
    </button>
  );
}

/** A checkbox sized for the tab strip. Label included, because an unlabelled box in a
 *  toolbar is a puzzle. */
function StripCheckbox({
  label,
  title,
  on,
  onToggle,
}: {
  label: string;
  title: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={title}
      role="checkbox"
      aria-checked={on}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        border: "none",
        background: "transparent",
        color: on ? TXT : FAINT,
        fontFamily: MONO,
        fontSize: 10,
        cursor: "pointer",
        padding: "3px 2px",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 11,
          height: 11,
          borderRadius: R_XS,
          border: `1px solid ${on ? GREEN : L2}`,
          background: on ? GREEN : "transparent",
        }}
      />
      {label}
    </button>
  );
}

/** Which tabs carry a filter, and the noun their "All …" option uses. */
const FILTERED_TABS: Partial<Record<BlotterTab, string>> = {
  positions: "positions",
  orders: "orders",
  fills: "trades",
  funding: "funding",
};

/** The scope × side dropdown. One control, four tables. */
function ScopeSideFilter({
  noun,
  sym,
  value,
  onChange,
}: {
  noun: string;
  sym: string;
  value: TableFilter;
  onChange: (f: TableFilter) => void;
}) {
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  /*
   * Fixed and flipped, for the reason OverflowTabs is: this control lives in the
   * blotter strip, which sits at the bottom of the screen, so a menu that always
   * drops downward runs off the viewport. Measured before the fix: top 797, bottom
   * 961 against a 950px viewport, with the bottom half unhittable.
   */
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const W = 214;
    const estimated = FILTER_SCOPES.length * FILTER_SIDES.length * 26 + 8;
    const up = r.bottom + estimated > window.innerHeight - 8;
    setOpen({
      top: up ? Math.max(8, r.top - estimated - 4) : r.bottom + 4,
      left: Math.min(Math.max(8, r.right - W), window.innerWidth - W - 8),
    });
  };
  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btn}
        onClick={() => (open ? setOpen(null) : place())}
        aria-haspopup="menu"
        aria-expanded={!!open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          border: `1px solid ${L2}`,
          borderRadius: 5,
          background: "transparent",
          color: DIM,
          fontFamily: MONO,
          fontSize: 10,
          padding: "3px 8px",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {filterLabel(value, noun, sym)}
        <span style={{ fontSize: 8 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div
            role="menu"
            style={{
              position: "fixed",
              top: open.top,
              left: open.left,
              minWidth: 214,
              maxHeight: "60vh",
              overflowY: "auto",
              zIndex: 61,
              background: "#0d0d0d",
              border: `1px solid ${L2}`,
              borderRadius: 7,
              boxShadow: "0 18px 44px rgba(0,0,0,0.8)",
              overflow: "hidden",
              padding: "3px 0",
            }}
          >
            {FILTER_SCOPES.flatMap((scope) =>
              FILTER_SIDES.map((side) => {
                const on = scope === value.scope && side === value.side;
                return (
                  <button
                    key={`${scope}:${side}`}
                    role="menuitem"
                    onClick={() => {
                      onChange({ scope, side });
                      setOpen(null);
                    }}
                    className="nx-row"
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 11px",
                      border: "none",
                      background: on ? "rgba(14,203,129,0.08)" : "transparent",
                      color: on ? GREEN : TXT,
                      fontFamily: MONO,
                      fontSize: 10.5,
                      cursor: "pointer",
                    }}
                  >
                    {filterLabel({ scope, side }, noun, sym)}
                  </button>
                );
              }),
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Prose for each movement kind. The wire carries an enum; the table shows English. */
const ACTIVITY_ACTION: Record<ActivityKind, string> = {
  deposit: "Deposit",
  withdrawal: "Withdraw",
  account_transfer: "Transfer",
  spot_transfer: "Spot transfer",
  internal_transfer: "Internal transfer",
  unknown: "—",
};

/** Truncate only what looks like an address; balance names pass through whole. */
const shortish = (v: string): string =>
  v.startsWith("0x") && v.length > 16 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;

/** Seconds as `12m 30s` / `45s`. Terse enough for a right-aligned numeric column. */
const fmtDuration = (sec: number): string => {
  if (sec <= 0) return "0s";
  const m = Math.floor(sec / 60);
  const rest = sec % 60;
  return m > 0 ? `${m}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
};

/**
 * TWAP sub-views. Deliberately NOT in the URL — which is a copy of the reference's
 * behaviour and, unusually, one worth copying only halfway: theirs is lossy one level
 * down and ours will be too until the whole blotter's sub-state is addressable. Noted
 * rather than fixed, because doing it here alone would make TWAP the only tab whose
 * second level survives a reload.
 */
const TWAP_VIEWS = [
  { id: "active", label: "ACTIVE" },
  { id: "history", label: "HISTORY" },
  { id: "fills", label: "FILL HISTORY" },
] as const;
type TwapView_ = (typeof TWAP_VIEWS)[number]["id"];

export type BlotterTab =
  | "positions"
  | "orders"
  | "history"
  | "fills"
  | "twap"
  | "funding"
  | "balances"
  | "activity";

/**
 * The funding filter, as scope × side.
 *
 * That grammar is the reference's — the one dropdown the capture opened reads
 * All / Current Market / Long / Short / Long on Current Market / Short on Current
 * Market, which is exactly the product of the two axes. Their seventh option,
 * `HIP-3 Funding`, is the single string in the whole blotter that cannot cross over:
 * HIP-3 is Hyperliquid's permissionless perp-deployer standard, and naming it here
 * would be describing someone else's infrastructure.
 */
const FILTER_SCOPES = ["all", "market"] as const;
const FILTER_SIDES = ["all", "long", "short"] as const;
export type FilterScope = (typeof FILTER_SCOPES)[number];
export type FilterSide = (typeof FILTER_SIDES)[number];
export type TableFilter = { scope: FilterScope; side: FilterSide };
const NO_FILTER: TableFilter = { scope: "all", side: "all" };

/**
 * One filter for four tables.
 *
 * Their strip carries `All Positions`, `All Orders`, `All Trades` and `All Funding` —
 * four differently-named dropdowns whose only opened example turned out to be scope ×
 * side. Four names for one grammar is four things to learn; the noun changes, the
 * question does not. So the label takes the noun and the options are generated.
 */
const filterLabel = (f: TableFilter, noun: string, sym: string): string => {
  const side = f.side === "all" ? `All ${noun}` : f.side === "long" ? "Long" : "Short";
  return f.scope === "all" ? side : `${side} on ${sym}`;
};

/**
 * Every tab, as data. The URL restore in Terminal.tsx used to test three string
 * literals by hand and had silently stopped covering `history` — deep-linking
 * ?blotter=history fell back to Positions. A list the tabs are derived from cannot
 * drift from the tabs.
 */
/*
 * Order follows the reference's, minus the three tabs we do not build: Balances,
 * Positions, Open Orders, TWAP, Trade History, Funding History, Order History,
 * Account Activity. Ours had drifted into the order the tabs happened to be BUILT
 * in, which is not a sequence anybody reads in.
 */
export const BLOTTER_TABS: readonly BlotterTab[] = [
  "balances",
  "positions",
  "orders",
  "twap",
  "fills",
  "funding",
  "history",
  "activity",
];
export const isBlotterTab = (v: unknown): v is BlotterTab =>
  typeof v === "string" && (BLOTTER_TABS as readonly string[]).includes(v);

/*
 * Trade History.
 *
 * `VALUE` and `CLOSED PNL` are the two the reference has and we did not, and the
 * second is the column a fills table is actually read for — what the trade made.
 * Both were already in the ledger: `LedgerFill` has carried `closedPnl` and
 * `typeLabel` since settlement was built, and nothing rendered either. That is the
 * same defect as the slippage figure the ticket computed and threw away.
 */
const FILL_COLS = "1.1fr 0.55fr 0.9fr 0.7fr 0.85fr 0.95fr 0.7fr 0.7fr 0.65fr 0.8fr";

export function Blotter({
  tab,
  onTab,
  tick,
  onSelectMarket,
  onApiKeys,
  orders,
  onCancelOrder,
  onCancelAll,
  positions,
  onClosePosition,
  onFlattenAll,
  onAmendOrder,
  fills,
  history,
  twaps,
  onCancelTwap,
  editingId,
  onEdit,
  density = "wide",
  marks,
  marketSym,
  sub,
  onSub,
  onDeposit,
  collapsed = false,
  onToggleCollapsed,
}: {
  tab: BlotterTab;
  onTab: (t: BlotterTab) => void;
  tick: number;
  onSelectMarket: (sym: string) => void;
  onApiKeys: () => void;
  /** Live working orders, owned by Terminal — not the fixture constant. */
  orders: UiOrder[];
  onCancelOrder: (id: string) => void;
  onCancelAll: () => void;
  /** Live positions, owned by Terminal — closing one has to remove it. */
  positions: Position[];
  onClosePosition: (sym: string, fraction?: number) => void;
  onFlattenAll: () => void;
  onAmendOrder: (id: string, patch: { price?: number; size?: number }) => void;
  /** Client-side algo runs, derived in Terminal from the same ledger the fills come from. */
  twaps: TwapView[];
  onCancelTwap: (id: string) => void;
  /** The market on screen — the "current market" half of the funding filter. */
  marketSym: string;
  /**
   * The active tab's sub-view, as one addressable string. Owned by Terminal for the
   * same reason the tab is: it belongs in the URL, and a component that owns its own
   * tab state cannot put it there.
   */
  sub: string;
  onSub: (v: string) => void;
  /** Opens the shared deposit modal, which Terminal owns — see AccountPanel. */
  onDeposit: () => void;
  /**
   * Strip only, no table. The short-viewport state: the tabs stay reachable and the
   * body gives its height back to the chart. Selecting a tab expands.
   */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * Live fills, owned by Terminal. This read the `FILLS` fixture constant until
   * settlement existed — so a fill produced by an order the user placed was invisible
   * here, which made "nothing ever fills" look like a rendering bug rather than the
   * missing engine it was.
   */
  fills: LedgerFill[];
  /**
   * Which order row is in inline-edit mode. Lives in TradeState, not here — the shell
   * owns all state, and one field is not worth carving an exception into that rule.
   */
  editingId: string | null;
  onEdit: (id: string | null) => void;
  density?: Density;
  /**
   * One feed per market with exposure, built by the shell.
   *
   * The blotter used to derive these itself, which meant two panels on one screen could
   * disagree about the price of the same market — and settlement matched against a
   * different ladder than the one shown. The shell owns the clock, so it owns the marks.
   */
  marks: Map<string, Feed>;
  /**
   * Terminal-status orders, newest first.
   *
   * This needed no new fixture and no new endpoint — cancel used to DELETE the row
   * from state, so the history simply did not exist. It now retires orders with a
   * `cancellationReason` the wire model already had a field for.
   */
  history: UiOrder[];
}) {
  /*
   * Config O — the order-shaped column set.
   *
   * Declared here rather than at module scope because the cells close over the row
   * actions and the edit state. TIME and ORIGINAL SIZE are new: `createdAt` was
   * required on `UiOrder` and never set, so a time column would have rendered `NaN`
   * until settlement started stamping it from the tick.
   */
  const orderSet: ColumnSet<UiOrder> = {
    label: "Working orders",
    surface: "orders",
    endpoint: "/v1/orders",
    key: (o) => o.id,
    columns: [
      {
        id: "time",
        label: "TIME (UTC)",
        sortBy: (o: UiOrder) => o.createdAt,
        align: "left",
        width: 0.8,
        priority: 2,
        cell: (o) => <Num color={FAINT}>{hms(o.createdAt)}</Num>,
      },
      {
        id: "market",
        label: "MARKET",
        align: "left",
        width: 0.9,
        priority: 1,
        cell: (o) => <span style={{ color: TXT }}>{o.sym.replace("-USDX-PERP", "")}</span>,
      },
      {
        id: "side",
        label: "SIDE",
        align: "left",
        width: 0.5,
        priority: 1,
        cell: (o) => <span style={{ color: sign(o.side === "BUY") }}>{o.side}</span>,
      },
      {
        id: "type",
        label: "TYPE",
        align: "left",
        width: 1,
        priority: 2,
        cell: (o) => (
          <span style={{ color: o.triggerPrice != null ? AMBER : MUT }}>{o.typeLabel}</span>
        ),
      },
      {
        id: "price",
        label: "PRICE",
        width: 0.95,
        priority: 1,
        cell: (o) => (
          <EditableNum
            value={o.price}
            editing={editingId === o.id}
            ariaLabel={`Price for order ${o.id}`}
            onChange={(v) => {
              onAmendOrder(o.id, { price: v });
              onEdit(null);
            }}
          >
            <Num color={o.price == null ? FAINT : NUM}>
              {o.price == null ? "mkt" : fmtPrice(getMarket(o.sym), o.price)}
            </Num>
          </EditableNum>
        ),
      },
      {
        id: "trigger",
        label: "TRIGGER",
        width: 0.9,
        priority: 2,
        /* The column whose absence made a stop order look like a limit. */
        cell: (o) => (
          <Num color={o.triggerPrice != null ? AMBER : FAINT}>
            {o.triggerPrice != null ? fmtPrice(getMarket(o.sym), o.triggerPrice) : "—"}
          </Num>
        ),
      },
      {
        id: "size",
        label: "SIZE",
        width: 0.7,
        priority: 1,
        cell: (o) => (
          <EditableNum
            value={o.remaining}
            editing={editingId === o.id}
            ariaLabel={`Size for order ${o.id}`}
            onChange={(v) => {
              onAmendOrder(o.id, { size: v });
              onEdit(null);
            }}
          >
            <Num color={NUM}>{o.remaining}</Num>
          </EditableNum>
        ),
      },
      {
        id: "origsize",
        label: "ORIGINAL",
        width: 0.65,
        priority: 3,
        /* Meaningless until orders could partially fill; now it is the denominator. */
        cell: (o) => <Num color={FAINT}>{o.quantity}</Num>,
      },
      {
        id: "filled",
        label: "FILLED",
        width: 0.55,
        priority: 2,
        cell: (o) => (
          <Num color={o.filledPct > 0 ? MUT : FAINT}>{Math.round(o.filledPct)}%</Num>
        ),
      },
      {
        id: "flags",
        label: "FLAGS",
        align: "left",
        width: 0.8,
        priority: 3,
        cell: (o) => (
          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: DIM }}>{o.tif}</span>
            {o.reduceOnly && (
              <span
                style={{
                  fontSize: 8.5,
                  color: GREEN,
                  border: `1px solid ${L2}`,
                  borderRadius: R_XS,
                  padding: "0 3px",
                }}
              >
                RO
              </span>
            )}
          </span>
        ),
      },
      {
        id: "actions",
        label: "",
        width: 0.55,
        priority: 1,
        cell: (o) => (
          <span style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}>
            <RowAction
              label={editingId === o.id ? "done" : "edit"}
              title={`Amend price or size · PATCH /v1/orders/${o.id}`}
              ariaLabel={editingId === o.id ? "Finish editing order" : "Amend order"}
              onClick={() => onEdit(editingId === o.id ? null : o.id)}
            />
            {/*
             * A <button>, not the <span> this used to be. The span had an onClick and no
             * keyboard path at all — the last unreachable action in the blotter, and it
             * sat four lines from a working button component.
             */}
            <RowAction
              label="✕"
              tone="red"
              title={`Cancel order · DELETE /v1/orders/${o.id}`}
              ariaLabel={`Cancel order ${o.id}`}
              onClick={() => onCancelOrder(o.id)}
            />
          </span>
        ),
      },
    ],
  };

  /** Mark for a position's own market, falling back to its entry if unfed. */
  const markOf = (p: Position) => marks.get(p.sym)?.last ?? p.entry;

  /*
   * Config O's history variant. Open Orders and Order History share ten of eleven
   * columns on the reference venue, which is the whole argument for a column SET rather
   * than a table per tab: the shared columns are declared once and the tail differs.
   */
  const historySet: ColumnSet<UiOrder> = {
    label: "Order history",
    surface: "orderHistory",
    endpoint: "/v1/orders/history",
    key: (o) => o.id,
    columns: [
      ...orderSet.columns.filter((c) => c.id !== "actions" && c.id !== "flags"),
      {
        id: "status",
        label: "STATUS",
        align: "left",
        width: 0.8,
        priority: 1,
        cell: (o) => (
          <span
            style={{
              color: o.status === "Filled" ? GREEN : o.status === "Cancelled" ? MUT : RED,
              fontSize: 9.5,
            }}
          >
            {o.status.toUpperCase()}
            {o.cancellationReason ? (
              <span style={{ color: FAINT }}> · {o.cancellationReason}</span>
            ) : null}
          </span>
        ),
      },
    ],
  };

  /* Config P — the position-shaped column set. */
  const positionSet: ColumnSet<Position> = {
    label: "Open positions",
    surface: "positions",
    endpoint: "/v1/positions",
    key: (p) => p.sym,
    columns: [
      {
        id: "market",
        label: "MARKET",
        align: "left",
        width: 1.3,
        priority: 1,
        cell: (p) => (
          /* `flexWrap` + a symbol that never breaks.
             A wire symbol is 13 characters and has two hyphens in it, so a cramped
             cell breaks it into `BTC- / USDX- / PERP` — three lines of an identifier
             that is meaningless in pieces. The symbol is nowrap and the side badge is
             allowed to fall underneath it instead, which costs a line only at the
             widths where there was never room for both. */
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 3 }}>
            <span style={{ width: 3, height: 20, borderRadius: R_XS, background: sign(p.side === "LONG") }} />
            <span style={{ color: TXT, whiteSpace: "nowrap" }}>{p.sym}</span>
            <span
              style={{
                fontSize: 9,
                color: sign(p.side === "LONG"),
                background: p.side === "LONG" ? GREEN_CHIP : RED_CHIP,
                borderRadius: R_XS,
                padding: "1.5px 5px",
              }}
            >
              {p.side} {p.lev}×
            </span>
          </span>
        ),
      },
      { id: "size", label: "SIZE", width: 0.7, priority: 1, cell: (p) => <Num color={NUM}>{p.size}</Num> },
      {
        id: "value",
        label: "VALUE",
        sortBy: (p: Position) => Math.abs(p.size) * markOf(p),
        width: 0.8,
        priority: 2,
        /* Notional at the mark — what the reference leads its balances table with. */
        cell: (p) => <Num color={MUT}>{usd(p.size * markOf(p))}</Num>,
      },
      /* Entry and mark are p2, not p1. On a phone the question a position list answers
         is "what do I hold and is it up" — market, size, unrealized. The two prices you
         compare to get there are a level of detail below that, and keeping them was the
         last 36px of horizontal overflow on any tab. */
      { id: "entry", label: "ENTRY", width: 0.85, priority: 2, cell: (p) => <Num>{fmtPrice(getMarket(p.sym), p.entry)}</Num> },
      { id: "mark", label: "MARK", width: 0.85, priority: 2, cell: (p) => <Num>{fmtPrice(getMarket(p.sym), markOf(p))}</Num> },
      {
        id: "liq",
        label: "LIQ. PRICE",
        width: 0.9,
        priority: 2,
        cell: (p) => <Num color={RED}>{fmtPrice(getMarket(p.sym), p.liq)}</Num>,
      },
      {
        id: "pnl",
        label: "UNREALIZED PNL",
        shortLabel: "PNL",
        width: 1,
        priority: 1,
        cell: (p) => {
          const { pnl, roe } = positionPnl(p, markOf(p));
          return (
            <span
              style={{
                textAlign: "right",
                color: sign(pnl >= 0),
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                lineHeight: 1.25,
              }}
            >
              {usd(pnl)}
              <span style={{ fontSize: 9.5 }}>{pct(roe, 1)}</span>
            </span>
          );
        },
      },
      {
        id: "margin",
        label: "MARGIN",
        width: 0.7,
        priority: 3,
        /* Already computed by positionPnl and thrown away until now. */
        cell: (p) => <Num color={FAINT}>{usd(positionPnl(p, markOf(p)).margin)}</Num>,
      },
      {
        id: "tpsl",
        label: "TP/SL",
        width: 1,
        priority: 2,
        /*
         * DERIVED, not modelled. The API has no bracket field — a bracket already IS two
         * reduce-only trigger orders on the opposite side, so joining them back to the
         * position needs no new wire field and no fixture change. We shipped TP/SL and
         * stop triggers with no surface that could show or amend either; this is it.
         */
        cell: (p) => {
          const { tp, sl } = bracketFor(orders, p.sym, p.entry, p.side === "LONG" ? 1 : -1);
          const m = getMarket(p.sym);
          if (!tp && !sl) return <Num color={FAINT}>—</Num>;
          return (
            <span style={{ textAlign: "right", fontSize: 9.5, display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.3 }}>
              <span style={{ color: tp ? GREEN : FAINT }}>
                {tp ? `TP ${fmtPrice(m, tp.triggerPrice as number)}` : "TP —"}
              </span>
              <span style={{ color: sl ? RED : FAINT }}>
                {sl ? `SL ${fmtPrice(m, sl.triggerPrice as number)}` : "SL —"}
              </span>
            </span>
          );
        },
      },
      {
        id: "funding",
        label: "FUNDING /1H",
        width: 0.75,
        priority: 3,
        /*
         * Labelled with its unit. The reference's own `Funding` header is ambiguous
         * between a rate and cumulative paid, and the captures cannot settle which —
         * `funding_interval_s` is 3600 on every market, so the unit is knowable and
         * stating it beats copying an ambiguous header.
         */
        cell: (p) => <Num color={FAINT}>{pct(p.fundingRate * 100, 4)}</Num>,
      },
      {
        id: "actions",
        label: "ACTIONS",
        width: 1,
        priority: 1,
        /* Close is a reduce-only market order on the opposite side. */
        cell: (p) => (
          <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
            <RowAction
              label="25%"
              title="Reduce 25% · reduce-only market order"
              ariaLabel={`Reduce ${p.sym} by 25 percent`}
              onClick={() => onClosePosition(p.sym, 0.25)}
            />
            <RowAction
              label="Close"
              tone="red"
              title="Close at mark · reduce-only market order"
              ariaLabel={`Close ${p.sym} position`}
              onClick={() => onClosePosition(p.sym)}
            />
          </span>
        ),
      },
    ],
  };

  /*
   * TWAP.
   *
   * The columns are the reference's, and they are the generic algo-progress set —
   * Executed, Average Price, Started At, Duration, Time Remaining, Progress — which
   * transfers unchanged to any future scheduled order type.
   *
   * Everything numeric here is DERIVED from the slice fills (`twapViews`), never
   * stored on the run. A stored "executed" is a second copy of a number the Fills tab
   * already holds, and the two drift the moment a slice is cancelled.
   */
  const twapSet: ColumnSet<TwapView> = {
    label: "TWAP runs",
    surface: "twap",
    endpoint: "/v1/twap",
    key: (t) => t.id,
    columns: [
      {
        id: "asset",
        label: "MARKET",
        align: "left",
        width: 1.2,
        priority: 1,
        cell: (t) => (
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ color: TXT }}>{t.sym}</span>
            <span style={{ color: sign(t.side === "BUY"), fontSize: 10 }}>{t.side}</span>
          </span>
        ),
      },
      {
        id: "size",
        label: "SIZE",
        width: 0.7,
        priority: 1,
        sortBy: (t) => t.size,
        cell: (t) => <Num color={NUM}>{fmtSize(getMarket(t.sym), t.size)}</Num>,
      },
      {
        id: "executed",
        label: "EXECUTED",
        width: 0.8,
        priority: 1,
        cell: (t) => (
          <Num color={t.executed > 0 ? GREEN : FAINT}>{fmtSize(getMarket(t.sym), t.executed)}</Num>
        ),
      },
      {
        id: "avg",
        label: "AVERAGE PRICE",
        shortLabel: "AVG",
        width: 1,
        priority: 2,
        // Absent, not zero: before the first slice fills there is no average to state.
        cell: (t) =>
          t.avgPrice === null ? (
            <Num color={FAINT}>—</Num>
          ) : (
            <Num>{fmtPrice(getMarket(t.sym), t.avgPrice)}</Num>
          ),
      },
      {
        id: "started",
        label: "STARTED AT",
        width: 0.9,
        priority: 3,
        cell: (t) => <Num color={MUT}>{hms(t.startedAt)}</Num>,
      },
      {
        id: "duration",
        label: "DURATION",
        width: 0.8,
        priority: 3,
        /* Slices × interval, stated as the runtime the ticket asked for. */
        cell: (t) => (
          <Num color={MUT}>
            {Math.round((t.slices * t.frequencyTicks * TICK_MS) / 60000)}m
          </Num>
        ),
      },
      {
        id: "remaining",
        label: "TIME REMAINING",
        shortLabel: "LEFT",
        width: 0.95,
        priority: 2,
        cell: (t) =>
          t.status === "active" ? (
            <Num color={AMBER}>{fmtDuration(t.secondsRemaining)}</Num>
          ) : (
            <Num color={FAINT}>—</Num>
          ),
      },
      {
        id: "progress",
        label: "PROGRESS",
        width: 1.1,
        priority: 1,
        /*
         * A bar and the slice count, not a percentage alone. "38%" of a TWAP does not
         * tell you whether one slice of three has gone or nineteen of fifty, and those
         * are different situations for anybody deciding whether to cancel.
         */
        cell: (t) => (
          <span style={{ display: "flex", alignItems: "center", gap: 7, justifyContent: "flex-end" }}>
            <span
              aria-hidden="true"
              style={{ position: "relative", width: 46, height: 3, borderRadius: R_XS, background: L2 }}
            >
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${Math.round(t.progress * 100)}%`,
                  background: t.status === "cancelled" ? MUT : GREEN,
                  borderRadius: R_XS,
                }}
              />
            </span>
            <Num color={MUT}>
              {t.released}/{t.slices}
            </Num>
          </span>
        ),
      },
      {
        id: "actions",
        label: "ACTIONS",
        width: 0.8,
        priority: 1,
        cell: (t) =>
          t.status === "active" ? (
            <span style={{ display: "flex", justifyContent: "flex-end" }}>
              <RowAction
                label="Cancel"
                tone="red"
                title="Stop the schedule · slices already filled are unaffected"
                ariaLabel={`Cancel TWAP on ${t.sym}`}
                onClick={() => onCancelTwap(t.id)}
              />
            </span>
          ) : (
            <Num color={FAINT}>{t.status === "completed" ? "DONE" : "CANCELLED"}</Num>
          ),
      },
    ],
  };


  const [filters, setFilters] = useState<Partial<Record<BlotterTab, TableFilter>>>({});

  /*
   * Row selection, per table. Keyed by the same `set.key` the rows are, so a
   * selection survives a re-sort and dies with the row it pointed at — a Set of row
   * INDEXES would silently re-target the moment anything sorted or filled.
   */
  const twapView: TwapView_ = TWAP_VIEWS.some((v) => v.id === sub) ? (sub as TwapView_) : "active";
  const setTwapView = (v: TwapView_) => onSub(v);
  const activityView: ActivityView = ACTIVITY_VIEWS.some((v) => v.id === sub)
    ? (sub as ActivityView)
    : "all";
  const setActivityView = (v: ActivityView) => onSub(v);

  const [selectedOrders, setSelectedOrders] = useState<ReadonlySet<string>>(new Set());
  const [selectedTwaps, setSelectedTwaps] = useState<ReadonlySet<string>>(new Set());
  const toggleIn = (set: ReadonlySet<string>, k: string) => {
    const next = new Set(set);
    if (!next.delete(k)) next.add(k);
    return next;
  };
  const toggleAllIn = (set: ReadonlySet<string>, keys: string[]) =>
    keys.every((k) => set.has(k)) ? new Set<string>() : new Set(keys);

  const [aggregateBalances, setAggregateBalances] = useState(false);
  const [hideSmall, setHideSmall] = useState(false);
  const acct = useAccountSnapshot(tick);

  /*
   * One fills table, two callers. Fill History under TWAP is not a fourth table —
   * it is these columns filtered to the slices the runs released, which is what
   * `sliceIds` is for. Rendering it twice from one function is what keeps the two
   * from drifting apart a column at a time.
   */
  /*
   * Trade history — the one tab that was still a hand-rolled table.
   *
   * It predated the ColumnSet abstraction and never got migrated, so it had no
   * `priority` on any column and therefore NO density behaviour: ten columns at 1920
   * and ten columns at 390, where it overflowed by 83px. Every other tab had been
   * dropping columns for weeks. That is exactly the drift this file's header comment
   * says the abstraction exists to prevent, sitting in the same file as the comment.
   *
   * Priorities: what a trader scanning a fill list on a phone needs is which market,
   * which way, at what price, how much. Fee, role, type and the realized figure are
   * why-did-that-cost-that questions, asked after the fact and at a desk.
   */
  const fillsSet = (surface: "fills" | "twapFills"): ColumnSet<LedgerFill> => ({
    endpoint: "/v1/fills",
    label: surface === "fills" ? "Trade history" : "TWAP fills",
    surface: surface === "fills" ? "fills" : "twap",
    key: (f) => `${f.time}-${f.sym}-${f.price}-${f.size}`,
    columns: [
      {
        id: "market",
        label: "MARKET",
        width: 1.1,
        priority: 1,
        cell: (f) => <span style={{ color: TXT, whiteSpace: "nowrap" }}>{f.sym}</span>,
      },
      {
        id: "side",
        label: "SIDE",
        width: 0.55,
        priority: 1,
        cell: (f) => <span style={{ color: sign(f.side === "BUY") }}>{f.side}</span>,
      },
      { id: "price", label: "PRICE", width: 0.9, priority: 1, cell: (f) => <Num color={NUM}>{fmtPrice(getMarket(f.sym), f.price)}</Num> },
      { id: "size", label: "SIZE", width: 0.7, priority: 1, cell: (f) => <Num>{f.size}</Num> },
      { id: "value", label: "VALUE", width: 0.85, priority: 2, cell: (f) => <Num color={NUM}>{"$" + comma(f.price * f.size, 2)}</Num> },
      {
        id: "closed",
        label: "CLOSED PNL",
        width: 0.95,
        priority: 2,
        /* Absent, not zero. A fill that opened or added to a position closed nothing,
           so there is no realized figure to state — printing $0.00 would claim it
           broke even. */
        cell: (f) =>
          f.closedPnl === null ? (
            <Num color={FAINT}>—</Num>
          ) : (
            <Num color={f.closedPnl >= 0 ? GREEN : RED}>{usd(f.closedPnl)}</Num>
          ),
      },
      {
        id: "fee",
        label: "FEE",
        width: 0.7,
        priority: 2,
        cell: (f) => (
          <Num color={f.fee < 0 ? GREEN : MUT}>{(f.fee < 0 ? "-$" : "$") + comma(Math.abs(f.fee), 2)}</Num>
        ),
      },
      { id: "type", label: "TYPE", width: 0.7, priority: 3, cell: (f) => <Num color={FAINT}>{f.typeLabel || "—"}</Num> },
      { id: "role", label: "ROLE", width: 0.65, priority: 3, cell: (f) => <Num color={FAINT}>{f.role}</Num> },
      { id: "time", label: "TIME", width: 0.8, priority: 2, cell: (f) => <Num color={FAINT}>{f.time}</Num> },
    ],
  });

  /*
   * Funding.
   *
   * `Payment` is signed and coloured, and `Direction` states paid/received in words
   * even though the sign already says it — that redundancy is the wire's own (the
   * type calls `direction` authoritative), and on a table people scan for "what did
   * this cost me" the word is faster than the sign.
   */
  const fundingSet: ColumnSet<UiAccountFunding> = {
    label: "Funding payments",
    surface: "fundingHistory",
    endpoint: "/v1/funding/history",
    defaultSort: { id: "time", dir: "desc" },
    key: (f) => `${f.sym}:${f.ts}`,
    columns: [
      {
        id: "time",
        label: "TIME (UTC)",
        align: "left",
        width: 1,
        priority: 1,
        sortBy: (f) => f.ts,
        cell: (f) => <span style={{ color: MUT }}>{hms(f.ts)}</span>,
      },
      {
        id: "market",
        label: "MARKET",
        align: "left",
        width: 1.2,
        priority: 1,
        cell: (f) => <span style={{ color: TXT }}>{f.sym}</span>,
      },
      {
        id: "size",
        label: "POSITION",
        width: 0.9,
        priority: 2,
        cell: (f) => (
          <Num color={f.positionSize >= 0 ? GREEN : RED}>
            {f.positionSize > 0 ? "+" : ""}
            {fmtSize(getMarket(f.sym), f.positionSize)}
          </Num>
        ),
      },
      {
        id: "direction",
        label: "DIRECTION",
        width: 0.8,
        priority: 2,
        cell: (f) => (
          <Num color={f.direction === "received" ? GREEN : MUT}>{f.direction.toUpperCase()}</Num>
        ),
      },
      {
        id: "payment",
        label: "PAYMENT",
        width: 0.9,
        priority: 1,
        sortBy: (f) => f.amount,
        cell: (f) => <Num color={f.amount >= 0 ? GREEN : RED}>{usd(f.amount)}</Num>,
      },
      {
        id: "rate",
        label: "RATE /1H",
        width: 0.8,
        priority: 1,
        /* Labelled with its interval for the same reason the positions column is:
           funding_interval_s is 3600 on every market, so the unit is knowable. */
        cell: (f) => <Num color={FAINT}>{pct(f.ratePct, 4)}</Num>,
      },
    ],
  };

  /*
   * One predicate for every filtered table. `side` is read off whatever that table's
   * rows call direction — a position is LONG/SHORT, an order and a fill are BUY/SELL,
   * a funding row is the sign of the position it was charged on — so the mapping
   * happens once here rather than in four filters.
   */
  /*
   * The filter's own label, but only when it is actually narrowing anything. An
   * empty state that says "matching All positions" is worse than one that says
   * nothing — it blames a filter that is not filtering.
   */
  const activeFilterLabel = (tab_: BlotterTab): string | undefined => {
    const f = filters[tab_];
    if (!f || (f.scope === "all" && f.side === "all")) return undefined;
    return filterLabel(f, FILTERED_TABS[tab_] ?? "rows", marketSym);
  };

  const passes = (tab_: BlotterTab, sym: string, long: boolean) => {
    const f = filters[tab_] ?? NO_FILTER;
    if (f.scope === "market" && sym !== marketSym) return false;
    if (f.side === "long" && !long) return false;
    if (f.side === "short" && long) return false;
    return true;
  };

  const filteredPositions = useMemo(
    () => positions.filter((p) => passes("positions", p.sym, p.side === "LONG")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positions, filters.positions, marketSym],
  );
  const filteredOrders = useMemo(
    () => orders.filter((o) => passes("orders", o.sym, o.side === "BUY")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orders, filters.orders, marketSym],
  );
  const filteredFills = useMemo(
    () => fills.filter((f) => passes("fills", f.sym, f.side === "BUY")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fills, filters.fills, marketSym],
  );

  const fundingRows = useMemo(
    () => ACCOUNT_FUNDING.filter((f) => passes("funding", f.sym, f.positionSize > 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters.funding, marketSym],
  );

  /*
   * Balances.
   *
   * Two rows, not one: the same collateral asset held on the spot side and posted
   * against perps. That split is what makes the reference's `Aggregate Balances`
   * checkbox mean anything — theirs exists because they carry both, and ours would be
   * a decorative switch over a single row without it. Checked, the two collapse into
   * one USDX line, which is also how the Settings-level preference is worded.
   *
   * `Hide Small Balances` uses the venue's own floor rather than a made-up one: a
   * balance below one lot of the cheapest thing you could buy with it is dust.
   */
  const balanceRows = useMemo(() => {
    const spot = { asset: "USDX", venue: "Spot", total: acct.spot, available: acct.spot, pnl: null as number | null };
    const perps = {
      asset: "USDX",
      venue: "Perps",
      total: acct.perps,
      available: ACCOUNT.buyingPower,
      pnl: acct.unrealized,
    };
    const rows = aggregateBalances
      ? [
          {
            asset: "USDX",
            venue: "Spot + Perps",
            total: spot.total + perps.total,
            available: spot.available + perps.available,
            pnl: acct.unrealized,
          },
        ]
      : [spot, perps];
    return hideSmall ? rows.filter((r) => r.total >= 1) : rows;
  }, [acct, aggregateBalances, hideSmall]);

  const balanceSet: ColumnSet<(typeof balanceRows)[number]> = {
    label: "Balances",
    surface: "balances",
    endpoint: "/v1/balances",
    key: (b) => `${b.asset}:${b.venue}`,
    columns: [
      {
        id: "asset",
        label: "ASSET",
        align: "left",
        width: 1.2,
        priority: 1,
        cell: (b) => (
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ color: TXT }}>{b.asset}</span>
            <span style={{ color: FAINT, fontSize: 9.5 }}>{b.venue}</span>
          </span>
        ),
      },
      {
        id: "total",
        label: "TOTAL BALANCE",
        width: 1,
        priority: 2,
        cell: (b) => <Num color={NUM}>{comma(b.total, 2)}</Num>,
      },
      {
        id: "available",
        label: "AVAILABLE BALANCE",
        width: 1.1,
        priority: 2,
        cell: (b) => <Num color={NUM}>{comma(b.available, 2)}</Num>,
      },
      {
        id: "value",
        label: "VALUE (USD)",
        width: 0.9,
        priority: 1,
        /* USDX is the unit of account here, so value is the balance. Stated rather
           than hidden: the column exists for the day a second collateral asset does. */
        cell: (b) => <Num color={NUM}>{"$" + comma(b.total, 2)}</Num>,
      },
      {
        id: "pnl",
        label: "PNL (ROE %)",
        width: 1,
        priority: 2,
        cell: (b) =>
          b.pnl === null ? (
            <Num color={FAINT}>—</Num>
          ) : (
            <span style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.3 }}>
              <span style={{ color: b.pnl >= 0 ? GREEN : RED, fontFamily: MONO, fontSize: 11.5 }}>
                {usd(b.pnl)}
              </span>
              <span style={{ color: FAINT, fontFamily: MONO, fontSize: 9.5 }}>
                {pct(b.total > 0 ? (b.pnl / b.total) * 100 : 0, 2)}
              </span>
            </span>
          ),
      },
      {
        id: "actions",
        label: "ACTIONS",
        width: 0.8,
        priority: 2,
        cell: () => (
          <span style={{ display: "flex", justifyContent: "flex-end" }}>
            <RowAction label="Deposit" title="Add collateral" ariaLabel="Deposit" onClick={onDeposit} />
          </span>
        ),
      },
    ],
  };

  /*
   * Account activity.
   *
   * One column set behind five sub-tabs, which is the reference's own arrangement:
   * all nine of theirs render the same ten headers and filter rows only. So this is a
   * filter over one table rather than five tables, and a sixth movement kind later is
   * a row in ACTIVITY_VIEWS rather than a component.
   */
  const activityRows = useMemo(() => {
    const kinds = ACTIVITY_VIEWS.find((v) => v.id === activityView)?.kinds;
    return kinds
      ? ACCOUNT_ACTIVITY.filter((a) => (kinds as readonly string[]).includes(a.kind))
      : ACCOUNT_ACTIVITY;
  }, [activityView]);

  const activitySet: ColumnSet<(typeof ACCOUNT_ACTIVITY)[number]> = {
    label: "Account activity",
    surface: "transfers",
    endpoint: "/v1/activity",
    defaultSort: { id: "time", dir: "desc" },
    key: (a) => a.id,
    columns: [
      { id: "time", label: "TIME (UTC)", align: "left", width: 0.95, priority: 1,
        sortBy: (a) => a.ts,
        cell: (a) => <span style={{ color: MUT }}>{hms(a.ts)}</span> },
      { id: "status", label: "STATUS", align: "left", width: 0.8, priority: 1,
        cell: (a) => (
          <span style={{ color: a.status === "completed" ? GREEN : a.status === "pending" ? AMBER : RED, fontFamily: MONO, fontSize: 10 }}>
            {a.status.toUpperCase()}
          </span>
        ) },
      { id: "asset", label: "ASSET", align: "left", width: 0.6, priority: 1,
        cell: (a) => <span style={{ color: TXT }}>{a.asset}</span> },
      /* Their `Action` is prose, and prose is right: "Deposit" is what a user scans
         this table for, not an enum member. */
      { id: "action", label: "ACTION", align: "left", width: 1.15, priority: 1,
        cell: (a) => <span style={{ color: NUM }}>{ACTIVITY_ACTION[a.kind]}</span> },
      { id: "from", label: "FROM", align: "left", width: 0.85, priority: 2,
        cell: (a) => <span style={{ color: MUT }}>{shortish(a.from)}</span> },
      { id: "to", label: "TO", align: "left", width: 0.85, priority: 2,
        cell: (a) => <span style={{ color: MUT }}>{shortish(a.to)}</span> },
      /* Null is not "". A transfer between two of your own balances HAS no
         destination, which is a different fact from one that went unreported. */
      { id: "destination", label: "DESTINATION", align: "left", width: 1, priority: 3,
        cell: (a) =>
          a.destination === null ? (
            <span style={{ color: FAINT }}>—</span>
          ) : (
            <span title={a.destination} style={{ color: FAINT, cursor: "help" }}>{shortish(a.destination)}</span>
          ) },
      { id: "change", label: "ACCOUNT CHANGE",
        shortLabel: "CHANGE", width: 1, priority: 1,
        cell: (a) => (
          <Num color={a.amount > 0 ? GREEN : a.amount < 0 ? RED : FAINT}>
            {a.amount > 0 ? "+" : ""}
            {comma(a.amount, 2)}
          </Num>
        ) },
      { id: "usd", label: "USD VALUE", width: 0.85, priority: 2,
        cell: (a) => <Num color={NUM}>{"$" + comma(a.usdValue, 2)}</Num> },
      { id: "fee", label: "FEE", width: 0.6, priority: 3,
        cell: (a) => <Num color={a.fee > 0 ? MUT : FAINT}>{a.fee > 0 ? "$" + comma(a.fee, 2) : "—"}</Num> },
    ],
  };

  /* Active vs everything finished — the reference's Active / History split. */
  /*
   * At narrow density the strip is TABS ONLY, which is both what the reference shows
   * on a phone and what the tap-target floor requires: FLATTEN ALL, the filter, the
   * collapse chevron and API Keys measured 16–21px tall there, well under the 32px
   * a control with no tier signal has to clear. They are desktop affordances that
   * arrived on mobile with the inline blotter, not decisions anybody made.
   */
  /* "not the desktop table" — both reduced tiers hide the same strip furniture. */
  const narrow = density !== "wide";

  const activeTwaps = twaps.filter((t) => t.status === "active");
  const pastTwaps = twaps.filter((t) => t.status !== "active");
  /* Every fill produced by a slice of any run, newest first (fills already are). */
  const twapSliceIds = useMemo(
    () => new Set(twaps.flatMap((t) => t.sliceIds)),
    [twaps],
  );
  const twapFills = useMemo(
    () => fills.filter((f) => twapSliceIds.has(f.orderId)),
    [fills, twapSliceIds],
  );

  /*
   * Labels are the reference's too. Ours read "History" and "Fills" — which was
   * ambiguous the moment a second history tab existed, and actively misleading next
   * to Funding History. Their names say which history: Order History is the record of
   * orders, Trade History the record of fills.
   */
  /* The tab counts are account figures — Positions (3), Open Orders (4) — so they
     follow the account region, not the market one. Under `?load=public` the blotter
     is the panel that has not arrived while the book beside it is live. */
  const phase = useDataPhase("account");
  /* The counts come off the tabs until the response lands. `Positions (3)` above a
     table that says "Loading" is the strip contradicting the panel it labels — and
     the count is the one thing on the tab that is data rather than structure. */
  const n = (v: number) => (phase === "ready" ? v : "");
  const tabs: readonly TabDef<BlotterTab>[] = [
    { id: "balances", label: "Balances", badge: "" },
    { id: "positions", label: "Positions", badge: n(positions.length) },
    { id: "orders", label: "Open Orders", badge: n(orders.length) },
    { id: "twap", label: "TWAP", badge: n(activeTwaps.length) },
    { id: "fills", label: "Trade History", badge: n(fills.length) },
    { id: "funding", label: "Funding History", badge: "" },
    { id: "history", label: "Order History", badge: n(history.length) },
    { id: "activity", label: "Account Activity", badge: "" },
  ];

  return (
    <>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 20,
          height: 36,
          padding: "0 16px",
          borderBottom: `1px solid ${L1}`,
        }}
      >
        {/* `reserve` is the width the strip has to leave for what shares the row:
            the API Keys link plus, on two tabs, a bulk action. Passing it in beats
            measuring the siblings — the bulk buttons mount and unmount with the
            active tab, so a measured value would flap as you switch tabs. */}
        <OverflowTabs
          tabs={tabs}
          active={tab}
          onSelect={(t) => {
            // Choosing a tab while collapsed means "show me this", not "switch the
            // tab I cannot see".
            if (collapsed) onToggleCollapsed?.();
            onTab(t);
          }}
          height={36}
          gap={20}
          size={12}
          reserve={tab === "positions" || tab === "orders" ? 190 : 96}
          /* Scroll at narrow, overflow into a menu at desktop. Theirs scrolls on a
             phone and CLIPS at 1440; we take the first and not the second. */
          scroll={narrow}
        />
        {!narrow && tab === "positions" && positions.length > 0 && (
          <button
            onClick={onFlattenAll}
            title="Close every position · reduce-only market orders"
            style={{
              border: `1px solid ${L2}`,
              borderRadius: 5,
              background: "transparent",
              color: RED,
              fontFamily: MONO,
              fontSize: 10,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            FLATTEN ALL
          </button>
        )}
        {!narrow && tab === "orders" && orders.length > 0 && (
          <button
            onClick={() => {
              if (selectedOrders.size === 0) return onCancelAll();
              // One id at a time: DELETE /v1/orders/{id} is the endpoint that exists.
              // A "cancel these five" call does not, and pretending otherwise here is
              // the kind of thing the request preview was built to make visible.
              for (const id of selectedOrders) onCancelOrder(id);
              setSelectedOrders(new Set());
            }}
            title={
              selectedOrders.size === 0
                ? "Cancel every working order · DELETE /v1/orders"
                : `Cancel ${selectedOrders.size} selected · DELETE /v1/orders/{id} each`
            }
            style={{
              border: `1px solid ${L2}`,
              borderRadius: 5,
              background: "transparent",
              color: RED,
              fontFamily: MONO,
              fontSize: 10,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            {selectedOrders.size === 0 ? "CANCEL ALL" : `CANCEL ${selectedOrders.size}`}
          </button>
        )}
        {!narrow && tab === "twap" && twapView === "active" && activeTwaps.length > 0 && (
          <button
            onClick={() => {
              const ids = selectedTwaps.size ? [...selectedTwaps] : activeTwaps.map((t) => t.id);
              for (const id of ids) onCancelTwap(id);
              setSelectedTwaps(new Set());
            }}
            title="Stop the schedule · slices already filled are unaffected"
            style={{
              border: `1px solid ${L2}`,
              borderRadius: 5,
              background: "transparent",
              color: RED,
              fontFamily: MONO,
              fontSize: 10,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            {selectedTwaps.size === 0 ? "CANCEL ALL" : `CANCEL ${selectedTwaps.size}`}
          </button>
        )}
        {/* The reference puts these two in the tab strip, at the point of use, and
            the same preferences also live in its Settings → Activity Tables group.
            Two entry points to one setting is a good pattern and a state-sync trap;
            noted in findings.blotter.md §5 for when Settings exists here. */}
        {!narrow && tab === "balances" && (
          <>
            <StripCheckbox
              label="Aggregate"
              title="Collapse the Spot and Perps rows into one balance per asset"
              on={aggregateBalances}
              onToggle={() => setAggregateBalances((v) => !v)}
            />
            <StripCheckbox
              label="Hide small"
              title="Hide balances under 1 USDX"
              on={hideSmall}
              onToggle={() => setHideSmall((v) => !v)}
            />
          </>
        )}
        {!narrow && FILTERED_TABS[tab] && (
          <ScopeSideFilter
            noun={FILTERED_TABS[tab] as string}
            sym={marketSym}
            value={filters[tab] ?? NO_FILTER}
            onChange={(f) => setFilters((prev) => ({ ...prev, [tab]: f }))}
          />
        )}
        {!narrow && onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand the blotter" : "Collapse the blotter"}
            title={collapsed ? "Expand" : "Collapse — give the height to the chart"}
            style={{
              border: "none",
              background: "transparent",
              color: FAINT,
              cursor: "pointer",
              fontSize: 9,
              padding: "6px 8px",
              lineHeight: 1,
            }}
          >
            <span
              aria-hidden="true"
              style={{ display: "inline-block", transform: collapsed ? "rotate(180deg)" : undefined }}
            >
              ▾
            </span>
          </button>
        )}
        {!narrow && (
        <button
          onClick={onApiKeys}
          style={{ border: "none", background: "transparent", color: FAINT, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
        >
          API Keys →
        </button>
        )}
      </div>

      {!collapsed && tab === "positions" && (
        <BlotterTable
          set={positionSet}
          rows={filteredPositions}
          density={density}
          filter={activeFilterLabel("positions")}
        />
      )}


      {!collapsed && tab === "orders" && (
        <BlotterTable
          set={orderSet}
          rows={filteredOrders}
          density={density}
          filter={activeFilterLabel("orders")}
          selection={{
            selected: selectedOrders,
            onToggle: (k) => setSelectedOrders((s) => toggleIn(s, k)),
            onToggleAll: (keys) => setSelectedOrders((s) => toggleAllIn(s, keys)),
          }}
        />
      )}

      {!collapsed && tab === "history" && <BlotterTable set={historySet} rows={history} density={density} />}

      {/*
       * TWAP sub-tabs. The reference has three — Active / History / Fill History —
       * and the doc's warning about them is a LAYOUT one: their sub-tab strip costs
       * 36px the blotter does not have, which pushes the empty-state message under the
       * status bar and clips it. Ours is 28px and the table below it is a flex child
       * that shrinks, so the message stays inside the region.
       *
       * Fill History is not a fourth table: it is the Fills columns filtered to the
       * slices these runs released, which is the whole reason `sliceIds` exists.
       */}
      {!collapsed && tab === "twap" && (
        <>
          <div
            role="tablist"
            aria-label="TWAP views"
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 16,
              height: 28,
              padding: "0 16px",
              borderBottom: `1px solid ${L1}`,
            }}
          >
            {TWAP_VIEWS.map((v) => {
              const on = twapView === v.id;
              return (
                <button
                  key={v.id}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setTwapView(v.id)}
                  className="nx-subtab"
                  style={{
                    height: 28,
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    cursor: "pointer",
                    color: on ? TXT : FAINT,
                    borderBottom: `2px solid ${on ? GREEN : "transparent"}`,
                    fontFamily: MONO,
                    fontSize: 10.5,
                    letterSpacing: "0.06em",
                  }}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
          {twapView === "active" && (
            <BlotterTable
              set={twapSet}
              rows={activeTwaps}
              density={density}
              selection={{
                selected: selectedTwaps,
                onToggle: (k) => setSelectedTwaps((s) => toggleIn(s, k)),
                onToggleAll: (keys) => setSelectedTwaps((s) => toggleAllIn(s, keys)),
              }}
            />
          )}
          {twapView === "history" && (
            <BlotterTable set={twapSet} rows={pastTwaps} density={density} />
          )}
          {twapView === "fills" && <BlotterTable set={fillsSet("twapFills")} rows={twapFills} density={density} />}
        </>
      )}

      {!collapsed && tab === "balances" && <BlotterTable set={balanceSet} rows={balanceRows} density={density} />}

      {/* Five sub-tabs, one table. Same 28px strip as TWAP's, for the same reason:
          theirs is 36px and pushes its own empty state under the status bar. */}
      {!collapsed && tab === "activity" && (
        <>
          <div
            role="tablist"
            aria-label="Account activity views"
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 16,
              height: 28,
              padding: "0 16px",
              borderBottom: `1px solid ${L1}`,
              overflowX: "auto",
            }}
          >
            {ACTIVITY_VIEWS.map((v) => {
              const on = activityView === v.id;
              return (
                <button
                  key={v.id}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setActivityView(v.id)}
                  className="nx-subtab"
                  style={{
                    height: 28,
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    cursor: "pointer",
                    color: on ? TXT : FAINT,
                    borderBottom: `2px solid ${on ? GREEN : "transparent"}`,
                    fontFamily: MONO,
                    fontSize: 10.5,
                    letterSpacing: "0.06em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {v.label.toUpperCase()}
                </button>
              );
            })}
          </div>
          <BlotterTable set={activitySet} rows={activityRows} density={density} />
        </>
      )}

      {!collapsed && tab === "funding" && (
        <BlotterTable
          set={fundingSet}
          rows={fundingRows}
          density={density}
          filter={activeFilterLabel("funding")}
        />
      )}

      {!collapsed && tab === "fills" && (
        <BlotterTable set={fillsSet("fills")} rows={filteredFills} density={density} filter={activeFilterLabel("fills")} />
      )}
    </>
  );
}

/** Condensed positions list for the mobile layout. */
export function BlotterCompact({
  onSelectMarket,
  orderCount,
  positions = POSITIONS,
  marks,
}: {
  onSelectMarket: (sym: string) => void;
  orderCount: number;
  positions?: Position[];
  /** Same shell-owned feeds as the full blotter — never derived here. */
  marks: Map<string, Feed>;
  /**
   * Terminal-status orders, newest first.
   *
   * This needed no new fixture and no new endpoint — cancel used to DELETE the row
   * from state, so the history simply did not exist. It now retires orders with a
   * `cancellationReason` the wire model already had a field for.
   */
  history: UiOrder[];
}) {
  return (
    <div style={{ borderTop: `1px solid ${L2}`, background: "#060606" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          height: 36,
          padding: "0 14px",
          borderBottom: `1px solid ${L1}`,
          fontSize: 12,
        }}
      >
        <span style={{ color: TXT, borderBottom: `2px solid ${GREEN}`, height: 36, display: "flex", alignItems: "center" }}>
          Positions <span style={{ fontFamily: MONO, color: FAINT, marginLeft: 6 }}>{positions.length}</span>
        </span>
        <span style={{ color: FAINT }}>
          Orders <span style={{ fontFamily: MONO }}>{orderCount}</span>
        </span>
      </div>
      {positions.map((p) => {
        const m = getMarket(p.sym);
        const mark = marks.get(p.sym)?.last ?? p.entry;
        const { pnl, roe } = positionPnl(p, mark);
        const up = pnl >= 0;
        return (
          <div
            key={p.sym}
            onClick={() => onSelectMarket(p.sym)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "11px 14px",
              borderBottom: "1px solid #111",
              fontFamily: MONO,
              fontSize: 12,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 3, height: 26, borderRadius: R_XS, background: sign(p.side === "LONG") }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ color: TXT }}>
                  {p.sym}{" "}
                  <span style={{ fontSize: 9, color: sign(p.side === "LONG") }}>
                    {p.side} {p.lev}×
                  </span>
                </span>
                <span style={{ fontSize: 10, color: FAINT }}>
                  {p.size} @ {fmtPrice(m, p.entry)}
                </span>
              </span>
            </span>
            <span style={{ textAlign: "right", color: sign(up), display: "flex", flexDirection: "column" }}>
              {usd(pnl)}
              <span style={{ fontSize: 10 }}>{pct(roe, 1)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export { DIM };
