"use client";

/*
 * The liquidity column — the order book and the trades tape behind one tab strip.
 *
 * They share a column because they answer the same question from two sides: what
 * is on offer, and what actually traded. Stacking them (the earlier layout) meant
 * neither got enough rows, and it pushed the order ticket off the bottom of the
 * viewport. Tabbing them gives the full column height to whichever the trader is
 * reading, and frees a dedicated column for the ticket.
 */

import { Market } from "@/lib/markets";
import type { Feed } from "@/lib/feed";
import { GREEN, L1, TXT, MUT, FAINT, monoLabel } from "@/lib/theme";
import { Segmented } from "./primitives";
import { OrderBook } from "./OrderBook";
import { TradesTape } from "./TradesTape";

export type LiquidityTab = "book" | "trades";

const TABS: { id: LiquidityTab; label: string }[] = [
  { id: "book", label: "ORDER BOOK" },
  { id: "trades", label: "TRADES" },
];

export function LiquidityPanel({
  market,
  feed,
  tab,
  onTab,
  grouping,
  onGrouping,
  onPickPrice,
}: {
  market: Market;
  feed: Feed;
  tab: LiquidityTab;
  onTab: (t: LiquidityTab) => void;
  grouping: number;
  onGrouping: (g: number) => void;
  onPickPrice: (px: number) => void;
}) {
  return (
    <>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 14,
          height: 34,
          padding: "0 10px 0 14px",
          borderBottom: `1px solid ${L1}`,
          ...monoLabel(10, "0.12em"),
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            style={{
              height: 34,
              padding: 0,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              borderBottom: `2px solid ${tab === t.id ? GREEN : "transparent"}`,
              ...monoLabel(10, "0.1em"),
              color: tab === t.id ? TXT : FAINT,
              whiteSpace: "nowrap",
              flex: "0 0 auto",
            }}
          >
            {t.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {tab === "book" ? (
          <Segmented options={market.groupings} active={grouping} onSelect={onGrouping} format={String} />
        ) : (
          <span style={{ color: MUT }}>LIVE</span>
        )}
      </div>

      {/*
       * Book ↔ Trades is the switch a trader makes most often here, and it was the
       * one with no transition at all.
       *
       * The wrapper is a real flex column, not `display: contents` — an element with
       * `contents` generates no box, so an animation on it does nothing. It reaches
       * around the CONTENT only: fading the tab strip along with it would blink the
       * whole column, and the strip is the thing you just clicked.
       */}
      <div
        key={tab}
        className="nx-swap"
        style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {tab === "book" ? (
          <OrderBook
            market={market}
            feed={feed}
            grouping={grouping}
            onGrouping={onGrouping}
            onPickPrice={onPickPrice}
          />
        ) : (
          <TradesTape feed={feed} />
        )}
      </div>
    </>
  );
}
