"use client";

/*
 * Funding-rate history. Two series, two axes, and a legend.
 *
 * Rebuilt against their `Funding Rate History` panel (Daniel's screenshot, recorded in
 * decisions.json). What theirs has that a bar chart cannot:
 *
 *   · A CUMULATIVE line on its own right-hand axis. The per-interval rate answers "what
 *     is it now"; the cumulative answers "what has holding this position actually cost
 *     me", which is the question a funding chart exists for and which no amount of
 *     staring at 60 bars will produce. They are on separate axes because they are
 *     different quantities in different units of magnitude — a shared axis flattens one
 *     of them into a line at zero.
 *   · Signed AREA rather than bars. The rate is a continuous quantity sampled hourly,
 *     not 60 discrete events, and an area reads as a regime — "it has been positive all
 *     week" — where bars read as a list.
 *   · Both axes labelled, and the x-axis carrying time.
 *
 * Geometry is SVG with `preserveAspectRatio="none"`; every label is an HTML overlay
 * positioned in percentages, because text inside a non-uniformly scaled SVG stretches
 * with the plot. Same rule as CandleChart and EquityCurve.
 */

import { useMemo } from "react";
import { GREEN, RED, MONO, MUT, DIM, FAINT, L1, L2, TXT } from "@/lib/theme";

/** 0.0013% — funding is small, and rounding it to two places renders every bar as 0%. */
const rate = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(4) + "%";
/** The cumulative axis runs an order of magnitude larger, so it needs fewer places. */
const cum = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

/** 1, 2 or 5 × a power of ten. Ticks at 0.00073% are correct and unreadable. */
function niceStep(span: number, target: number) {
  const rough = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  const n = rough / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function ticksFor(lo: number, hi: number, target: number) {
  const step = niceStep(hi - lo || Math.abs(hi) || 1, target);
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let t = a; t <= b + step * 0.001; t += step) out.push(t);
  return { ticks: out, lo: a, hi: b };
}

export function FundingChart({
  bars,
  /** Hours per interval, for the x-axis labels. The registry says 1h. */
  intervalH = 1,
  /** Tighter type and fewer ticks at phone width. */
  compact = false,
}: {
  bars: number[];
  intervalH?: number;
  compact?: boolean;
}) {
  const W = 1000;
  const H = 440;
  const PAD_T = 14;
  const PAD_B = 14;

  const model = useMemo(() => {
    /* The cumulative series is the running sum — the actual cost of holding, which is
       the number a trader is trying to recover from this panel. */
    let run = 0;
    const cumSeries = bars.map((b) => (run += b));

    const rt = ticksFor(Math.min(...bars, 0), Math.max(...bars, 0), compact ? 2 : 3);
    const ct = ticksFor(Math.min(...cumSeries, 0), Math.max(...cumSeries, 0), compact ? 2 : 3);

    const plot = H - PAD_T - PAD_B;
    const yR = (v: number) => PAD_T + ((rt.hi - v) / (rt.hi - rt.lo || 1)) * plot;
    const yC = (v: number) => PAD_T + ((ct.hi - v) / (ct.hi - ct.lo || 1)) * plot;
    const dx = W / Math.max(1, bars.length - 1);
    const x = (i: number) => i * dx;

    /* The area is split at zero so the fill can be green above and red below — one path
       with a single fill would colour a sign change the same on both sides, which is the
       one thing this chart must never do. */
    const zero = yR(0);
    const line = bars.map((b, i) => `${x(i).toFixed(1)},${yR(b).toFixed(1)}`);
    const area = `M ${x(0)},${zero} L ${line.join(" L ")} L ${x(bars.length - 1)},${zero} Z`;
    const cumLine = cumSeries.map((v, i) => `${x(i).toFixed(1)},${yC(v).toFixed(1)}`);

    return {
      area,
      line: "M " + line.join(" L "),
      cumPath: "M " + cumLine.join(" L "),
      zero,
      rateTicks: rt.ticks.map((v) => ({ v, y: yR(v) })),
      cumTicks: ct.ticks.map((v) => ({ v, y: yC(v) })),
      last: bars[bars.length - 1] ?? 0,
      total: cumSeries[cumSeries.length - 1] ?? 0,
    };
  }, [bars, compact]);

  const pctY = (y: number) => (y / H) * 100;
  const tick = compact ? 8.5 : 9.5;

  return (
    /*
     * Two boxes, not one with padding.
     *
     * The labels are absolutely positioned, and an absolutely positioned child resolves
     * against the PADDING box — so `paddingBottom` on a single container did not keep
     * the lowest tick off the legend, it just moved the plot. At 390 that printed
     * `-0.0200%` on top of the x-axis label and `-0.20%` on top of `now`. The plot gets
     * its own positioning context and the legend is a sibling underneath it.
     */
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        style={{ display: "block" }}
        aria-hidden
      >
        <defs>
          <linearGradient id="fund-up" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GREEN} stopOpacity={0.34} />
            <stop offset="100%" stopColor={GREEN} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fund-dn" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={RED} stopOpacity={0.34} />
            <stop offset="100%" stopColor={RED} stopOpacity={0.02} />
          </linearGradient>
          {/* Two clips split the same area path at the zero line, so one geometry can be
              filled green above and red below without computing crossings by hand. */}
          <clipPath id="fund-above">
            <rect x={0} y={0} width={W} height={model.zero} />
          </clipPath>
          <clipPath id="fund-below">
            <rect x={0} y={model.zero} width={W} height={H - model.zero} />
          </clipPath>
        </defs>

        {/* Dashed gridlines, as theirs — solid rules at this density read as data. */}
        {model.rateTicks.map((t, i) => (
          <line key={i} x1={0} x2={W} y1={t.y} y2={t.y} stroke={L1} strokeWidth={1} strokeDasharray="4 5" />
        ))}

        <path d={model.area} fill="url(#fund-up)" clipPath="url(#fund-above)" />
        <path d={model.area} fill="url(#fund-dn)" clipPath="url(#fund-below)" />
        <path d={model.line} fill="none" stroke={GREEN} strokeWidth={1.6} clipPath="url(#fund-above)" />
        <path d={model.line} fill="none" stroke={RED} strokeWidth={1.6} clipPath="url(#fund-below)" />

        {/* Zero, brighter than the grid: it is the line that separates paying from
            being paid, and it is the only one on this chart with a meaning. */}
        <line x1={0} x2={W} y1={model.zero} y2={model.zero} stroke={L2} strokeWidth={1.5} />

        {/* Cumulative, on its own scale. Neutral colour on purpose — it is a different
            quantity, and giving it a direction colour would imply it shares the axis. */}
        <path d={model.cumPath} fill="none" stroke={MUT} strokeWidth={1.4} opacity={0.9} />
      </svg>

      {/* ── left axis: the per-interval rate ── */}
      {model.rateTicks.map((t, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            left: 2,
            top: `${pctY(t.y)}%`,
            transform: "translateY(-50%)",
            fontFamily: MONO,
            fontSize: tick,
            color: t.v === 0 ? DIM : FAINT,
            background: "rgba(0,0,0,0.55)",
            padding: "0 3px",
            borderRadius: 2,
            pointerEvents: "none",
          }}
        >
          {rate(t.v)}
        </span>
      ))}

      {/* ── right axis: cumulative ── */}
      {model.cumTicks.map((t, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            right: 2,
            top: `${pctY(t.y)}%`,
            transform: "translateY(-50%)",
            fontFamily: MONO,
            fontSize: tick,
            color: FAINT,
            background: "rgba(0,0,0,0.55)",
            padding: "0 3px",
            borderRadius: 2,
            pointerEvents: "none",
          }}
        >
          {cum(t.v)}
        </span>
      ))}

      </div>

      {/* ── x axis + legend, on one row under the plot ── */}
      <div
        style={{
          flex: "0 0 auto",
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          fontFamily: MONO,
          fontSize: compact ? 8.5 : 9,
          color: FAINT,
        }}
      >
        <span>−{Math.round((bars.length * intervalH) / 24)}d</span>
        <span style={{ display: "flex", alignItems: "center", gap: compact ? 8 : 14 }}>
          <Key tone={GREEN} label={compact ? "Rate" : "Funding rate"} value={rate(model.last)} />
          <Key tone={MUT} label={compact ? "Cum." : "Cumulative"} value={cum(model.total)} />
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

/** A legend entry that also carries the series' current value — a swatch alone names a
 *  colour; a swatch with a number tells you where the series ended up. */
function Key({ tone, label, value }: { tone: string; label: string; value: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: tone, flex: "0 0 auto" }} />
      <span style={{ color: FAINT }}>{label}</span>
      <span style={{ color: TXT }}>{value}</span>
    </span>
  );
}
