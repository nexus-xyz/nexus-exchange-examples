"use client";

/*
 * The Portfolio chart: account value, PNL or perps PNL over the selected window.
 *
 * IT HAS AXES NOW. The old comment here said it did not need them "since the value and
 * delta are stated in the panel header directly above it" — which was true of a hero
 * that no longer exists. Portfolio went to parity and the header became three cards
 * and a row of figures; nothing above the plot states its range any more, so a reader
 * had a shape with no magnitude. Theirs labels the axis (visible in
 * `shots/responsive/mobile.modal.volume.mobile.png`, behind the sheet), and a curve
 * whose y-axis you cannot read is decoration.
 *
 * Two consequences for how it is built:
 *
 *   · The series carries VALUES, not a normalised 0–1 walk. The old version threw the
 *     domain away in the same expression that fitted the line to the panel, so there
 *     was nothing left to label an axis with.
 *   · Geometry is SVG with `preserveAspectRatio="none"`; the labels are HTML overlays
 *     positioned in percentages. Text inside a non-uniformly scaled SVG is stretched
 *     with the plot — the same rule CandleChart follows.
 */

import { useMemo } from "react";
import { rng } from "@/lib/format";
import { GREEN, RED, FAINT, L1, MONO } from "@/lib/theme";

/** Compact money for an axis tick: $1.2k, $84.5k, $1.3m. */
function axisMoney(n: number) {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(0)}`;
}

/**
 * Round a span up to something a person would choose — 1, 2 or 5 × a power of ten.
 * Axis ticks at 0, 3,847, 7,694 are arithmetically correct and unreadable.
 */
function niceStep(span: number, targetTicks: number) {
  const rough = span / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function EquityCurve({
  seed,
  points = 60,
  /** Where the series starts, in dollars. The walk is a percentage move from here. */
  base = 84_512,
  /** X-axis end labels, e.g. ["7d ago", "now"]. Omitted hides the time axis. */
  span,
  /** PNL series cross zero and should be drawn against it; account value should not. */
  signed = false,
}: {
  seed: number;
  points?: number;
  base?: number;
  span?: [string, string];
  signed?: boolean;
}) {
  const W = 640;
  const H = 150;
  const PAD_T = 8;
  const PAD_B = 8;

  const model = useMemo(() => {
    const R = rng(seed);
    const vals: number[] = [];
    let v = 0;
    for (let i = 0; i < points; i++) {
      // Bias upward — this is an account that made money over the window.
      v += (R() - 0.42) * 0.06;
      vals.push(v);
    }
    // Percentage walk → dollars. Signed series swing around zero; an account value
    // moves around its own level.
    const series = vals.map((x) => (signed ? x * base * 0.12 : base * (1 + x * 0.06)));

    let lo = Math.min(...series);
    let hi = Math.max(...series);
    if (signed) {
      // A PNL chart that does not show zero cannot tell you whether you are up.
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    const rawSpan = hi - lo || Math.abs(hi) || 1;
    const step = niceStep(rawSpan, 3);
    const niceLo = Math.floor(lo / step) * step;
    const niceHi = Math.ceil(hi / step) * step;
    const domain = niceHi - niceLo || 1;

    const y = (val: number) => H - PAD_B - ((val - niceLo) / domain) * (H - PAD_T - PAD_B);
    const dx = W / (points - 1);
    const pts = series.map((val, i) => `${(i * dx).toFixed(1)},${y(val).toFixed(1)}`);

    const ticks: { v: number; pct: number }[] = [];
    for (let t = niceLo; t <= niceHi + step * 0.001; t += step) {
      ticks.push({ v: t, pct: ((H - PAD_B - y(t)) / (H - PAD_T - PAD_B)) * 100 });
    }

    return {
      line: "M " + pts.join(" L "),
      area: `M 0,${H} L ${pts.join(" L ")} L ${W},${H} Z`,
      ticks,
      zeroY: signed && niceLo < 0 && niceHi > 0 ? y(0) : null,
      up: series[series.length - 1] >= series[0],
    };
  }, [seed, points, base, signed]);

  const gid = `eq-${seed}`;
  const stroke = model.up ? GREEN : RED;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 120 }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        aria-hidden
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.18} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* Gridlines at the labelled values, so a label points at something. */}
        {model.ticks.map((t, i) => {
          const yy = H - PAD_B - (t.pct / 100) * (H - PAD_T - PAD_B);
          return <line key={i} x1={0} x2={W} y1={yy} y2={yy} stroke={L1} strokeWidth={1} />;
        })}
        {/* Zero is drawn brighter than the other gridlines on a signed series: it is
            the line that separates made money from lost money. */}
        {model.zeroY !== null && (
          <line x1={0} x2={W} y1={model.zeroY} y2={model.zeroY} stroke={FAINT} strokeWidth={1} strokeDasharray="3 3" />
        )}
        <path d={model.area} fill={`url(#${gid})`} />
        <path d={model.line} fill="none" stroke={stroke} strokeWidth={1.5} />
      </svg>

      {/* Y labels. HTML, positioned in percentages — inside the SVG they would be
          stretched by `preserveAspectRatio="none"` along with the plot. */}
      {model.ticks.map((t, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            right: 2,
            bottom: `calc(${(PAD_B / H) * 100}% + ${t.pct}% * ${(H - PAD_T - PAD_B) / H})`,
            transform: "translateY(50%)",
            fontFamily: MONO,
            fontSize: 9,
            color: FAINT,
            background: "rgba(0,0,0,0.55)",
            padding: "0 3px",
            /* The lowest tick sits on the plot's bottom edge; nudge it up so it clears
               the time row that now lives under the box. */
            marginBottom: 1,
            borderRadius: 2,
            pointerEvents: "none",
          }}
        >
          {axisMoney(t.v)}
        </span>
      ))}

      {/* Time labels sit BELOW the plot box, not on it. Overlaid at `bottom: -2` they
          collided with the lowest value label — `-$1.0k` and `now` printed on top of
          each other in the bottom-right corner. The container reserves the row. */}
      {span && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -14,
            display: "flex",
            justifyContent: "space-between",
            fontFamily: MONO,
            fontSize: 9,
            color: FAINT,
            pointerEvents: "none",
          }}
        >
          <span>{span[0]}</span>
          <span>{span[1]}</span>
        </div>
      )}
    </div>
  );
}
