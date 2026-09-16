"use client";

/*
 * The chart pane: view tabs, a readout row, and the plot.
 *
 * The readout row is the pane's only label surface — the charts themselves carry
 * no titles or legends, so switching views swaps both the plot and the line of
 * figures that explains it (OHLC for price, current/predicted for funding,
 * mid/spread for depth).
 */

import type { Feed } from "@/lib/feed";
import { Market, fmtPrice } from "@/lib/markets";
import { pct } from "@/lib/format";
import { GREEN, RED, MONO, L1, MUT, FAINT, monoLabel } from "@/lib/theme";
import { usePhase } from "@/lib/dataphase";
import { TableState } from "./states";
import { Tabs, Segmented, TabDef } from "./primitives";
import { TvCandleChart } from "../charts/TvCandleChart";
import { FundingChart } from "../charts/FundingChart";
import { DepthChart } from "../charts/DepthChart";
import { decimalsFor } from "@/lib/markets";

export type ChartView = "price" | "funding" | "depth";
export const TIMEFRAMES = ["1s", "1m", "5m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const VIEWS: readonly TabDef<ChartView>[] = [
  { id: "price", label: "Price" },
  { id: "funding", label: "Funding" },
  { id: "depth", label: "Depth" },
];

export function ChartPanel({
  market,
  feed,
  view,
  onView,
  tf,
  onTf,
  grouping,
  compact = false,
  height,
}: {
  market: Market;
  feed: Feed;
  view: ChartView;
  onView: (v: ChartView) => void;
  tf: Timeframe;
  onTf: (t: Timeframe) => void;
  grouping: number;
  compact?: boolean;
  height?: number;
}) {
  const c = feed.candles[feed.candles.length - 1];
  const { phase, loading, error } = usePhase("/v1/candles");
  const tabH = compact ? 36 : 38;
  const current = feed.funding[feed.funding.length - 1];
  const predicted = current * 0.93;

  return (
    <>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: tabH,
          padding: "0 14px",
          borderBottom: `1px solid ${L1}`,
        }}
      >
        <Tabs tabs={VIEWS} active={view} onSelect={onView} height={tabH} gap={compact ? 16 : 18} />
        {view === "price" ? (
          <Segmented options={compact ? (["1m", "5m", "1h"] as const) : TIMEFRAMES} active={tf} onSelect={onTf} />
        ) : (
          <span style={monoLabel(10, "0.1em")}>{view === "funding" ? `${Math.round(market.fundingIntervalS / 3600)}H INTERVAL` : `${grouping} GROUPING`}</span>
        )}
      </div>

      {!compact && (
        <div style={{ flex: "0 0 auto", padding: "7px 14px 4px", fontFamily: MONO, fontSize: 11.5, color: MUT }}>
          {phase === "ready" && view === "price" && (
            <>
              <span style={{ color: FAINT }}>O</span> {fmtPrice(market, c.o)}
              <span style={{ color: FAINT, marginLeft: 10 }}>H</span> {fmtPrice(market, c.h)}
              <span style={{ color: FAINT, marginLeft: 10 }}>L</span> {fmtPrice(market, c.l)}
              <span style={{ color: FAINT, marginLeft: 10 }}>C</span>{" "}
              <span style={{ color: c.c >= c.o ? GREEN : RED }}>{fmtPrice(market, c.c)}</span>
              <span style={{ color: FAINT, marginLeft: 10 }}>TF</span> {tf}
            </>
          )}
          {view === "funding" && (
            <>
              {/* Read from the plotted series, not the stats fixture — the readout
                  and the last bar have to be the same number. */}
              <span style={{ color: FAINT }}>CURRENT</span>{" "}
              <span style={{ color: current >= 0 ? GREEN : RED }}>{pct(current, 4)}</span>
              <span style={{ color: FAINT, marginLeft: 12 }}>PREDICTED</span>{" "}
              <span style={{ color: predicted >= 0 ? GREEN : RED }}>{pct(predicted, 4)}</span>
              <span style={{ color: FAINT, marginLeft: 12 }}>NEXT</span> 02:14:33
            </>
          )}
          {view === "depth" && (
            <>
              <span style={{ color: FAINT }}>MID</span> {fmtPrice(market, feed.last)}
              <span style={{ color: FAINT, marginLeft: 12 }}>SPREAD</span> {feed.spreadBps.toFixed(1)}bp
              <span style={{ color: FAINT, marginLeft: 12 }}>DEPTH</span> cumulative · {market.base}
            </>
          )}
        </div>
      )}

      <div
        key={view}
        className="nx-swap"
        style={{ flex: height ? "0 0 auto" : "1 1 auto", height, minHeight: 0, position: "relative" }}
      >
        {/* A chart is the loudest claim on the screen — 200 candles painted during a
            cold start assert a price history that has not arrived. The plot keeps its
            box so nothing reflows when it does. */}
        {phase !== "ready" && (
          <TableState count={0} surface="candles" loading={loading} error={error} minHeight={height ?? 180} />
        )}
        {/* Price is TradingView's own open-source engine; depth and funding stay
            ours, because neither is candlestick data and the library is the wrong
            tool for either. */}
        {phase === "ready" && view === "price" && (
          <TvCandleChart candles={feed.candles} last={feed.last} decimals={decimalsFor(market)} />
        )}
        {phase === "ready" && view === "funding" && <FundingChart bars={feed.funding} intervalH={market.fundingIntervalS / 3600} compact={compact} />}
        {phase === "ready" && view === "depth" && <DepthChart bids={feed.bids} asks={feed.asks} mid={fmtPrice(market, feed.last)} />}
      </div>
    </>
  );
}
