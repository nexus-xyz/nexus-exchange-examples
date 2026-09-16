/*
 * Price chart — candles, a last-price line, a volume histogram, and a price axis.
 *
 * Geometry is drawn in a non-uniformly scaled SVG so it fills any panel shape,
 * but every piece of *text* is an HTML overlay positioned in percentages. Text
 * inside a stretched SVG gets distorted with the plot; keeping labels in the DOM
 * is what makes the axis stay legible at any panel width.
 */

import { CSSProperties } from "react";
import type { Candle } from "@/lib/feed";
import { comma } from "@/lib/format";
import {
  R_XS, GREEN, RED, MONO, DIM, L0, ON_RED } from "@/lib/theme";

const GUTTER = 62;

export function CandleChart({
  candles,
  last,
  decimals = 1,
}: {
  candles: Candle[];
  last: number;
  decimals?: number;
}) {
  const W = 1000;
  const H = 440;
  const volH = H * 0.16;
  const plotH = H - volH - 10;
  const plotW = W;

  const lo = Math.min(...candles.map((c) => c.l));
  const hi = Math.max(...candles.map((c) => c.h));
  const pad = (hi - lo) * 0.08 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const y = (v: number) => plotH - ((v - min) / (max - min)) * plotH;

  const step = plotW / candles.length;
  const bw = step * 0.62;

  // Volume is not in the feed — derive it from candle range so the histogram
  // agrees with the bars above it (wide range = heavy print).
  const vols = candles.map((c) => c.h - c.l);
  const maxVol = Math.max(...vols) || 1;

  const lastFrac = y(last) / plotH;
  const ticks = [0.08, 0.3, 0.52, 0.74, 0.94];

  const axisText: CSSProperties = {
    position: "absolute",
    right: 8,
    fontFamily: MONO,
    fontSize: 10,
    color: DIM,
    transform: "translateY(-50%)",
    pointerEvents: "none",
  };

  return (
    <div style={{ position: "absolute", inset: 0, paddingRight: GUTTER }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        style={{ display: "block" }}
        aria-hidden
      >
        {ticks.map((g) => (
          <line key={g} x1={0} x2={plotW} y1={plotH * g} y2={plotH * g} stroke="#0f0f0f" strokeWidth={1} />
        ))}

        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const cx = i * step + step / 2;
          const col = up ? GREEN : RED;
          const yo = y(c.o);
          const yc = y(c.c);
          const vh = (vols[i] / maxVol) * volH;
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} opacity={0.85} />
              <rect
                x={cx - bw / 2}
                y={Math.min(yo, yc)}
                width={bw}
                height={Math.max(1.2, Math.abs(yc - yo))}
                fill={col}
                opacity={0.92}
              />
              <rect x={cx - bw / 2} y={H - vh} width={bw} height={vh} fill={col} opacity={0.22} />
            </g>
          );
        })}

        <line x1={0} x2={plotW} y1={H - volH - 5} y2={H - volH - 5} stroke={L0} strokeWidth={1} />
        <line
          x1={0}
          x2={plotW}
          y1={y(last)}
          y2={y(last)}
          stroke={RED}
          strokeWidth={1}
          strokeDasharray="3 4"
          opacity={0.8}
        />
      </svg>

      {/* price axis — HTML so it isn't stretched by the SVG scale */}
      <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: GUTTER }}>
        {ticks.map((f) => (
          <span key={f} style={{ ...axisText, top: `${f * (100 - 16) - 1}%` }}>
            {comma(max - f * (max - min), decimals)}
          </span>
        ))}
        <span
          style={{
            position: "absolute",
            top: `${lastFrac * (100 - 16)}%`,
            right: 0,
            width: GUTTER,
            transform: "translateY(-50%)",
            background: RED,
            // White on our red is 3.53:1 — under AA. Dark-on-red is 5.3:1, and it is
            // already how the Sell button treats this colour, so it is consistent
            // rather than a one-off.
            color: ON_RED,
            fontFamily: MONO,
            fontSize: 10.5,
            textAlign: "center",
            padding: "3px 0",
            borderRadius: R_XS,
          }}
        >
          {comma(last, decimals)}
        </span>
        <span style={{ ...axisText, bottom: 2, top: "auto", transform: "none", fontSize: 9, letterSpacing: "0.1em" }}>
          VOL
        </span>
      </div>
    </div>
  );
}
