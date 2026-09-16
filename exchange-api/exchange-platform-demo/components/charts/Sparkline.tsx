/*
 * Inline trend mark — the 7D column in the markets table, and the per-key trend
 * in the API-keys panel. Deliberately axis-less and label-less: it reads as a
 * glyph in a table cell, not as a chart.
 */

import { useMemo } from "react";
import { rng } from "@/lib/format";

export function Sparkline({
  seed,
  color,
  w = 78,
  h = 26,
  fill = false,
}: {
  seed: number;
  color: string;
  w?: number;
  h?: number;
  fill?: boolean;
}) {
  const { line, area } = useMemo(() => {
    const R = rng(seed);
    const n = 28;
    const vals: number[] = [];
    let v = 0.5;
    for (let i = 0; i < n; i++) {
      v += (R() - 0.5) * 0.28;
      v = Math.max(0.05, Math.min(0.95, v));
      vals.push(v);
    }
    const step = w / (n - 1);
    const pts = vals.map((y, i) => `${i * step},${h - y * (h - 4) - 2}`);
    return { line: "M " + pts.join(" L "), area: `M 0,${h} L ${pts.join(" L ")} L ${w},${h} Z` };
  }, [seed, w, h]);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" aria-hidden>
      {fill && <path d={area} fill={color} opacity={0.08} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.3} opacity={0.85} />
    </svg>
  );
}
