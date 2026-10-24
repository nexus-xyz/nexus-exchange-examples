/*
 * Cumulative market depth, derived from the same book the ladder renders.
 *
 * Mid sits at the horizontal centre; each side's x-axis is scaled to its own
 * furthest level so both walls fill the panel even when the book is lopsided.
 */

import type { BookRow } from "@/lib/feed";
import { GREEN, RED, MONO, MUT, L3 } from "@/lib/theme";

export function DepthChart({ bids, asks, mid }: { bids: BookRow[]; asks: BookRow[]; mid: string }) {
  const W = 1000;
  const H = 440;
  const padB = 22;
  const plotH = H - padB;
  const cx = W / 2;
  const half = cx * 0.94;

  /**
   * Re-accumulate from the touch outward instead of reusing the ladder's `total`.
   * The feed can place two levels at the same or a non-monotonic price step, so a
   * cum computed in generation order and then re-sorted by price produces a curve
   * that jumps backwards. Cumulative depth must be monotonic by construction.
   */
  const parse = (rows: BookRow[], nearFirst: (a: number, b: number) => number) => {
    const sorted = rows
      .map((r) => ({ px: r.px, sz: parseFloat(r.size.replace(/,/g, "")) }))
      .sort((a, b) => nearFirst(a.px, b.px));
    let cum = 0;
    return sorted.map((r) => {
      cum += r.sz;
      return { px: r.px, cum };
    });
  };
  const bb = parse(bids, (a, b) => b - a); // near mid → far (descending price)
  const aa = parse(asks, (a, b) => a - b); // near mid → far (ascending price)
  if (!bb.length || !aa.length) return null;

  const m = (bb[0].px + aa[0].px) / 2;
  const minP = bb[bb.length - 1].px;
  const maxP = aa[aa.length - 1].px;
  const maxCum = Math.max(bb[bb.length - 1].cum, aa[aa.length - 1].cum) || 1;

  const xL = (p: number) => cx - ((m - p) / (m - minP || 1)) * half;
  const xR = (p: number) => cx + ((p - m) / (maxP - m || 1)) * half;
  const Y = (c: number) => plotH - (c / maxCum) * plotH * 0.88;

  const bidLine = bb.map((d) => `${xL(d.px).toFixed(1)},${Y(d.cum).toFixed(1)}`);
  const askLine = aa.map((d) => `${xR(d.px).toFixed(1)},${Y(d.cum).toFixed(1)}`);
  const bidArea = `M ${cx},${plotH} L ${cx},${Y(0)} L ${bidLine.join(" L ")} L ${xL(minP).toFixed(1)},${plotH} Z`;
  const askArea = `M ${cx},${plotH} L ${cx},${Y(0)} L ${askLine.join(" L ")} L ${xR(maxP).toFixed(1)},${plotH} Z`;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: "block" }} aria-hidden>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={plotH * g} y2={plotH * g} stroke="#0f0f0f" strokeWidth={1} />
        ))}
        <path d={bidArea} fill="rgba(14,203,129,0.10)" />
        <path d={`M ${cx},${Y(0)} L ${bidLine.join(" L ")}`} fill="none" stroke={GREEN} strokeWidth={1.4} />
        <path d={askArea} fill="rgba(246,70,93,0.10)" />
        <path d={`M ${cx},${Y(0)} L ${askLine.join(" L ")}`} fill="none" stroke={RED} strokeWidth={1.4} />
        <line x1={cx} x2={cx} y1={20} y2={plotH} stroke={L3} strokeWidth={1} strokeDasharray="3 4" />
      </svg>
      <span
        style={{
          position: "absolute",
          top: 6,
          left: "50%",
          transform: "translateX(-50%)",
          fontFamily: MONO,
          fontSize: 11,
          color: MUT,
        }}
      >
        {mid}
      </span>
      <span style={{ position: "absolute", bottom: 4, left: 10, fontFamily: MONO, fontSize: 10, color: GREEN, opacity: 0.7 }}>
        BIDS
      </span>
      <span style={{ position: "absolute", bottom: 4, right: 10, fontFamily: MONO, fontSize: 10, color: RED, opacity: 0.7 }}>
        ASKS
      </span>
    </div>
  );
}
