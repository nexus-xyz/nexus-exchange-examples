/*
 * Charts for the consoles. Hand-rolled SVG, no dependency.
 *
 * THE PALETTE IS COMPUTED, NOT CHOSEN. The four categorical hues below were
 * selected by search against the six checks — lightness band, chroma floor,
 * colour-vision separation, normal-vision floor, and contrast against this
 * app's near-black surface — not by eye. Measured: worst all-pairs ΔE 18.1
 * under deuteranopia, protanopia and tritanopia, every slot ≥ 3:1 on #070707.
 *
 * FOUR, AND NOT MORE. Six categorical hues cannot clear the colour-vision floor
 * on a dark surface at usable chroma; the search says so and the honest response
 * is fewer series, not a prettier failure. Beyond four the answer is a facet, a
 * small multiple, or an explicit "Other" — never a fifth generated hue and never
 * a cycled one, because a colour that means Acme in one chart and Kestrel in the
 * next is worse than no colour at all.
 *
 * Red, amber and green stay reserved for STATUS. A series never wears them, so
 * "red" always means bad and never means "the third venue".
 */

import type { ReactNode } from "react";

import { AMBER, CHROME, DIM, FAINT, L0, L1, L2, MONO, MUT, PANEL, TXT, monoLabel } from "@/lib/theme";
import { SIZE, data as dataType, body } from "./type";

/** Categorical series colours, in fixed assignment order. Never cycled. */
export const SERIES = ["#00a1ca", "#b88a10", "#5449d0", "#b60356"] as const;
/** Sequential ramp for magnitude — one hue, light→dark, for heatmap cells. */
export const RAMP = ["#04212a", "#06384a", "#08566f", "#0a7a9c", "#00a1ca"] as const;

export const seriesColor = (i: number): string => SERIES[i % SERIES.length] ?? SERIES[0];

/*
 * The two literals above are the only hexes that belong in a component in this app,
 * because they ARE the palette rather than a use of one: they are the output of the
 * colour search documented at the top of this file and there is nowhere upstream to
 * put them. Everything else here now comes from the token layer. The four that were
 * removed were doing real damage:
 *
 *   #141414 grid       — a fifth line value beside the L0..L3 scale.
 *   #070707 bubble ring — a hardcoded copy of PANEL, which is tenant-owned, so on a
 *                         re-skinned venue the rings would have been the wrong ground.
 *   #e0b23c histogram   — a fifth hue, and a near-miss of the AMBER it meant.
 *   #001016 cohort ink  — a hand-mixed dark for text on the ramp's light end.
 */
const GRID = L0;
/** Dark ink for text sitting on the ramp's light end. */
const ON_RAMP = CHROME;

/** Axis / grid furniture, deliberately recessive. */
function Grid({ w, h, rows = 4 }: { w: number; h: number; rows?: number }) {
  return (
    <g>
      {Array.from({ length: rows + 1 }, (_, i) => (
        <line
          key={i}
          x1={0}
          x2={w}
          y1={(h / rows) * i}
          y2={(h / rows) * i}
          stroke={GRID}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      {items.map((s) => (
        <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
          {/* Identity is never colour alone — the label rides beside the swatch,
              and it wears text ink rather than the series colour. */}
          <span style={{ ...monoLabel(SIZE.micro), color: MUT }}>{s.label}</span>
        </span>
      ))}
    </div>
  );
}

export interface Series {
  label: string;
  values: number[];
}

/**
 * Stacked area over time. The composition question — who is routing the flow —
 * answered as magnitude, which is what stacking is for.
 */
export function StackedArea({
  series,
  labels,
  height = 170,
  format,
}: {
  series: Series[];
  labels: string[];
  height?: number;
  format: (n: number) => string;
}) {
  const n = labels.length;

  /*
   * A TIME SERIES NEEDS TWO POINTS, and the console shipped a page that broke this.
   *
   * Analytics defaults to a 24-hour window, which slices the daily flow ledger to
   * one point. One point produces a zero-width path, so the flagship chart on the
   * default view of the Analytics page was a 170px empty box with the same date
   * printed at both ends of its x-axis. It was not an error and it was not a real
   * empty state; it was a chart that had quietly become furniture.
   *
   * This says what happened instead. A caller with a better answer for one point —
   * the Flow panel shows a composition bar instead — is welcome to branch before
   * reaching this, but no caller should be able to render a blank plot by accident.
   */
  if (n < 2) {
    return (
      <div
        style={{
          height,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          border: `1px dashed ${L2}`,
          borderRadius: 4,
        }}
      >
        <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>NOT ENOUGH HISTORY TO PLOT</span>
        <span style={{ ...body(SIZE.note, 1.5), color: FAINT, textAlign: "center", maxWidth: 320 }}>
          {n === 0
            ? "This series has no points yet."
            : `One point (${labels[0]}). A trend needs two — widen the window.`}
        </span>
      </div>
    );
  }

  const w = Math.max(n * 12, 320);
  const totals = labels.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const x = (i: number) => (i / Math.max(1, n - 1)) * w;
  const y = (v: number) => height - (v / max) * height;

  /* Running offsets, so each band sits on the one below it. */
  const offsets = labels.map(() => 0);
  const bands = series.map((ser, si) => {
    const top: [number, number][] = [];
    const bottom: [number, number][] = [];
    ser.values.forEach((v, i) => {
      const base = offsets[i] ?? 0;
      bottom.push([x(i), y(base)]);
      offsets[i] = base + v;
      top.push([x(i), y(base + v)]);
    });
    const d = `M ${top.map(([px, py]) => `${px},${py}`).join(" L ")} L ${bottom
      .reverse()
      .map(([px, py]) => `${px},${py}`)
      .join(" L ")} Z`;
    return { d, color: seriesColor(si), label: ser.label };
  });

  /*
   * A y-axis, because "peak $1.13M" in a footnote is not a scale — it names one
   * point and leaves every other height unreadable. Three gridline labels are
   * enough to let someone estimate a value off the chart, which is the whole
   * job of an axis on a magnitude plot.
   */
  const ticks = [1, 0.5, 0].map((f) => ({ f, label: format(max * f) }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            height,
            ...monoLabel(SIZE.micro),
            color: FAINT,
            textAlign: "right",
            flexShrink: 0,
            minWidth: 34,
          }}
        >
          {ticks.map((t) => (
            <span key={t.f} style={{ lineHeight: 1 }}>
              {t.f === 0 ? "" : t.label}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${w} ${height}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height, display: "block" }}
          role="img"
          aria-label={`Stacked area, ${series.length} series, peak ${format(max)}`}
        >
          <Grid w={w} h={height} rows={2} />
          {bands.map((b) => (
            <path key={b.label} d={b.d} fill={b.color} opacity={0.62} stroke={b.color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", ...monoLabel(SIZE.micro), color: FAINT, paddingLeft: 42 }}>
        <span>{labels[0]}</span>
        <span>{labels[n - 1]}</span>
      </div>
      {/* One series needs no legend — the panel title already names it, and a
          one-item legend is just a swatch asking to be read twice. */}
      {bands.length > 1 && <Legend items={bands.map((b) => ({ label: b.label, color: b.color }))} />}
    </div>
  );
}

/**
 * Magnitude across two categorical axes — market × hour, venue × day. One hue,
 * light→dark: a heatmap is a sequential job and a rainbow would invent order
 * that is not in the data.
 */
export function Heatmap({
  rows,
  cols,
  value,
  format,
  cell = 15,
}: {
  rows: string[];
  cols: string[];
  value: (r: number, c: number) => number;
  format: (n: number) => string;
  cell?: number;
}) {
  let max = 0;
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < cols.length; c++) max = Math.max(max, value(r, c));
  const step = (v: number) => {
    const t = max > 0 ? v / max : 0;
    const i = Math.min(RAMP.length - 1, Math.floor(t * RAMP.length));
    return RAMP[i] ?? RAMP[0];
  };

  /*
   * HOW MANY TICK LABELS FIT, computed rather than assumed.
   *
   * This printed every third column, unconditionally. On the deposits chart that
   * meant an hour-of-day axis reading 00 · 03 · 06 over hourly cells — a reader
   * counting three cells along to find 14:00 on a chart that has a slot for it. On
   * the weekday chart it was worse: seven columns labelled Mon, Thu, Sun, with the
   * four days in between anonymous. Every third is the right answer for a 30-day
   * axis and the wrong one for both charts this component actually has.
   *
   * So ask the geometry. A column occupies `cell` plus the table's 2px border
   * spacing; a label of n characters occupies roughly n × 0.72em — 0.6em of mono
   * advance plus the 0.12em `monoLabel` tracks with — at the micro size, and 4px is
   * added so two neighbours never touch. Print every k-th column where k is the
   * smallest count of slots that fits the widest label. Two-character hours in a
   * 19px slot come out as every hour; three-letter weekdays in 24px as every day; a
   * 30-day axis of `Aug 04` still thins itself out, which is what the old constant
   * was groping for.
   *
   * See type.ts: "heatmap tick labels are handled by printing fewer ticks, not
   * smaller ones". This is that rule with a real denominator under it.
   */
  const SPACING = 2;
  const widestLabel = Math.max(1, ...cols.map((c) => c.length)) * SIZE.micro * 0.72 + 4;
  const every = Math.max(1, Math.ceil(widestLabel / (cell + SPACING)));

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: SPACING }}>
        <tbody>
          {rows.map((rowLabel, r) => (
            <tr key={rowLabel}>
              <td style={{ ...monoLabel(SIZE.micro), color: DIM, paddingRight: 8, whiteSpace: "nowrap", textAlign: "right" }}>
                {rowLabel}
              </td>
              {cols.map((colLabel, c) => (
                <td key={colLabel} style={{ padding: 0 }}>
                  <div
                    title={`${rowLabel} · ${colLabel} — ${format(value(r, c))}`}
                    style={{
                      width: cell,
                      height: cell,
                      borderRadius: 2,
                      background: step(value(r, c)),
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td />
            {cols.map((c, i) => (
              /*
               * The label is absolutely positioned inside a box the width of one
               * cell, so it cannot widen its own column. A label sitting directly in
               * the `td` sets that column's min-content width, which would push the
               * whole table wider the moment a label out-measured a cell — and this
               * table is the thing that must not start scrolling on a desktop where
               * it fits today. Out-of-flow text has no such say, and by construction
               * the slots it can spill into are the unlabelled ones.
               */
              <td key={c} style={{ padding: 0, verticalAlign: "top" }}>
                <div style={{ position: "relative", width: cell, height: SIZE.micro + 5 }}>
                  {i % every === 0 ? (
                    <span
                      style={{
                        ...monoLabel(SIZE.micro),
                        color: FAINT,
                        position: "absolute",
                        top: 3,
                        left: "50%",
                        transform: "translateX(-50%)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c}
                    </span>
                  ) : null}
                </div>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Three dimensions at once — x, y, and area. Area, not radius: doubling the
 * radius quadruples the ink, and readers judge area.
 */
export function BubbleScatter({
  points,
  xLabel,
  yLabel,
  height = 220,
  formatX,
  formatY,
}: {
  points: { label: string; x: number; y: number; size: number; colorIndex: number }[];
  xLabel: string;
  yLabel: string;
  height?: number;
  formatX: (n: number) => string;
  formatY: (n: number) => string;
}) {
  /*
   * IT USED TO BE 480 USER UNITS WIDE AND IT IS NOW THE WIDTH OF ITS PANEL.
   *
   * The old form was an SVG with `viewBox="0 0 480 220"`, `width: 100%` and no
   * `preserveAspectRatio` — which means the default, `xMidYMid meet`: scale
   * uniformly to fit, then centre. Fitting 480x220 into 1120x220 scales by 1, so on
   * the analytics page the whole plot sat in the middle third with 320px of dead
   * ground either side, and eight endpoints crowded into 480px that had 1120 to
   * spread across.
   *
   * `preserveAspectRatio="none"` is how `StackedArea` on this file solves the same
   * problem, and it is right there because a stacked band is a path: stretching it
   * horizontally is the plot getting wider. It is wrong here. Non-uniform scale
   * turns a circle into an ellipse, and this chart's whole premise — stated at the
   * top of it — is that a reader judges AREA. A 2.3:1 ellipse is a mark whose size
   * is a function of the browser window.
   *
   * So the marks leave the SVG. Positions become percentages of the plot box, which
   * is exactly what a fraction of the axis maximum is anyway, and radii stay in
   * pixels — which is the combination `calc()` exists for. The bubbles are the same
   * arithmetic drawn as CSS circles, and they stay circles at every width. What
   * remains in SVG is the gridline furniture, where stretching IS the right answer
   * and `preserveAspectRatio="none"` is used deliberately: a horizontal rule has no
   * aspect to preserve. This is also how `Histogram` and `RankedBars` below are
   * built — CSS-positioned marks, no viewBox to be trapped inside.
   */
  /*
   * Padding is sized to the largest bubble, not to a constant. With a fixed 6px
   * inset the biggest marks ran off the bottom edge — most endpoints have a
   * near-zero error rate, so they pile onto the y origin and their radius has
   * nowhere to go. The plot area is inset by the maximum radius instead.
   */
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const maxY = Math.max(1, ...points.map((p) => p.y));
  const maxS = Math.max(1, ...points.map((p) => p.size));
  const pr = (v: number) => 6 + Math.sqrt(v / maxS) * 18;
  const inset = pr(maxS) + 4;

  /** Where a value sits along its axis, 0 at the origin and 1 at the maximum. */
  const fx = (v: number) => v / maxX;
  const fy = (v: number) => v / maxY;
  /** The same, as CSS: inset from both edges, then a fraction of what is left. */
  const left = (v: number) => `calc(${inset}px + ${fx(v).toFixed(4)} * (100% - ${inset * 2}px))`;
  const top = (v: number) => `calc(100% - ${inset}px - ${fy(v).toFixed(4)} * (100% - ${inset * 2}px))`;

  /*
   * Selective direct labels. Every point labelled produced an unreadable pile
   * along the bottom axis, which is the failure mode a scatter is most prone to.
   * So: label the four largest by area, and drop any label that would land on
   * one already placed. The rest carry a hover title — the data is not lost, it
   * is just not shouted.
   *
   * The overlap test is in FRACTIONS of the plot width now, because the plot no
   * longer has a width at render time. A path label runs about 74px; the narrowest
   * panel this console gives the chart is roughly 330px of plot, so 74/330 is the
   * widest fraction a label can occupy and therefore the safe threshold. It is
   * conservative at 1440 — it will drop a label that would in fact have cleared its
   * neighbour — and conservative is the right direction: a dropped label still has
   * its hover title, an overlapping pair is unreadable for both.
   */
  const LABEL_FRAC = 74 / 330;
  const byArea = [...points].sort((a, b) => b.size - a.size).slice(0, 4);
  const placed: { x: number; y: number }[] = [];
  const labelled = new Set<string>();
  for (const p of byArea) {
    const ly = (1 - fy(p.y)) * height - pr(p.size) - 6;
    if (placed.some((q) => Math.abs(q.x - fx(p.x)) < LABEL_FRAC && Math.abs(q.y - ly) < 13)) continue;
    placed.push({ x: fx(p.x), y: ly });
    labelled.add(p.label);
  }
  /** One line of micro mono, the box a direct label is laid out in. */
  const LABEL_H = 11;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div
        style={{ position: "relative", width: "100%", height, overflow: "hidden" }}
        role="img"
        aria-label={`Bubble chart of ${xLabel} against ${yLabel}, ${points.length} points`}
      >
        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
          aria-hidden="true"
        >
          <Grid w={100} h={height} />
        </svg>
        {/* Largest first, so a big mark cannot bury a small one. */}
        {[...points]
          .sort((a, b) => b.size - a.size)
          .map((p, i) => {
            const r = pr(p.size);
            return (
              /* Keyed by position as well as label because a label is not unique:
                 the analytics page plots endpoints by path, and `DELETE /orders/{id}`
                 and `PATCH /orders/{id}` are two points with one name. That was a
                 real duplicate-key error in the console on every load of
                 /admin/analytics — a hard floor — and the name on the chart is the
                 caller's to choose, so the key stops depending on it. */
              <div key={`${p.label}-${i}`}>
                <div
                  title={`${p.label} — ${xLabel} ${formatX(p.x)}, ${yLabel} ${formatY(p.y)}`}
                  style={{
                    position: "absolute",
                    left: left(p.x),
                    top: top(p.y),
                    width: r * 2,
                    height: r * 2,
                    marginLeft: -r,
                    marginTop: -r,
                    borderRadius: "50%",
                    background: seriesColor(p.colorIndex),
                    opacity: 0.45,
                    /* A 2px surface ring keeps overlapping bubbles legible. A shadow
                       and not a border: a border would grow the box and move the
                       mark off the value it stands for. */
                    boxShadow: `0 0 0 2px ${PANEL}`,
                  }}
                />
                {/* The centre, at full strength — the bubble is translucent, so the
                    exact coordinate needs a mark of its own. */}
                <div
                  style={{
                    position: "absolute",
                    left: left(p.x),
                    top: top(p.y),
                    width: 3.6,
                    height: 3.6,
                    marginLeft: -1.8,
                    marginTop: -1.8,
                    borderRadius: "50%",
                    background: seriesColor(p.colorIndex),
                    pointerEvents: "none",
                  }}
                />
                {labelled.has(p.label) && (
                  <span
                    style={{
                      position: "absolute",
                      left: left(p.x),
                      /* Clamped to the top edge. In the SVG version this was a
                         baseline that could go negative, and the topmost bubble on
                         the analytics page had its label sliced in half by the
                         viewport edge. `max()` costs nothing and the label is never
                         cut. */
                      top: `max(0px, calc(${top(p.y)} - ${r + 6 + LABEL_H}px))`,
                      transform: "translateX(-50%)",
                      fontFamily: MONO,
                      fontSize: SIZE.micro,
                      lineHeight: `${LABEL_H}px`,
                      color: MUT,
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                    }}
                  >
                    {p.label}
                  </span>
                )}
              </div>
            );
          })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", ...monoLabel(SIZE.micro), color: FAINT }}>
        <span>↑ {yLabel}</span>
        <span>hover for the rest</span>
        <span>→ {xLabel}</span>
      </div>
    </div>
  );
}

/**
 * Retention by weekly cohort. The grid IS the chart — no decoration needed.
 *
 * NO CALLER RIGHT NOW. Its only one was Analytics → Branded UI, deleted with
 * EP-010, and the cohort series it draws is still authored in
 * `lib/venue/product-analytics.ts`. Left standing rather than deleted alongside
 * a model it does not own: whoever removes those fields removes this with them.
 */
export function CohortGrid({
  cohorts,
}: {
  cohorts: { label: string; size: number; retention: number[] }[];
}) {
  const weeks = Math.max(...cohorts.map((c) => c.retention.length));
  const cellFor = (v: number) => {
    const i = Math.min(RAMP.length - 1, Math.floor(v * RAMP.length));
    return RAMP[i] ?? RAMP[0];
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 2, minWidth: 420 }}>
        <thead>
          <tr>
            <th style={{ ...monoLabel(SIZE.micro), color: DIM, textAlign: "left", paddingRight: 8 }}>COHORT</th>
            <th style={{ ...monoLabel(SIZE.micro), color: DIM, textAlign: "right", paddingRight: 8 }}>N</th>
            {Array.from({ length: weeks }, (_, i) => (
              <th key={i} style={{ ...monoLabel(SIZE.micro), color: DIM, width: 34 }}>
                W{i}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.label}>
              <td style={{ ...monoLabel(SIZE.micro), color: MUT, whiteSpace: "nowrap", paddingRight: 8 }}>{c.label}</td>
              <td style={{ ...dataType(SIZE.micro), color: DIM, textAlign: "right", paddingRight: 8 }}>{c.size}</td>
              {Array.from({ length: weeks }, (_, i) => {
                const v = c.retention[i];
                return (
                  <td key={i} style={{ padding: 0 }}>
                    {v === undefined ? (
                      <div style={{ height: 20 }} />
                    ) : (
                      <div
                        title={`${c.label} week ${i} — ${(v * 100).toFixed(0)}% retained`}
                        style={{
                          height: 20,
                          borderRadius: 2,
                          background: cellFor(v),
                          display: "grid",
                          placeItems: "center",
                          fontFamily: MONO,
                          fontSize: SIZE.micro,
                          color: v > 0.55 ? ON_RAMP : MUT,
                        }}
                      >
                        {(v * 100).toFixed(0)}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A latency distribution, with the percentile that matters marked. */
export function Histogram({
  bins,
  markerIndex,
  markerLabel,
  color = SERIES[0],
}: {
  bins: { label: string; value: number }[];
  markerIndex?: number;
  markerLabel?: string;
  color?: string;
}) {
  const max = Math.max(1, ...bins.map((b) => b.value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 90 }}>
        {bins.map((b, i) => (
          <div
            key={b.label}
            title={`${b.label} — ${b.value}`}
            style={{
              flex: 1,
              height: `${Math.max(2, (b.value / max) * 100)}%`,
              background: i === markerIndex ? AMBER : color,
              opacity: i === markerIndex ? 1 : 0.42 + 0.5 * (b.value / max),
              borderRadius: "3px 3px 0 0",
              minWidth: 3,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", ...monoLabel(SIZE.micro), color: FAINT }}>
        <span>{bins[0]?.label}</span>
        {markerLabel && <span style={{ color: AMBER }}>{markerLabel}</span>}
        <span>{bins[bins.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** An inline trend, for table rows. No axes — it is a shape, not a reading. */
export function Sparkline({
  values,
  width = 68,
  height = 18,
  color = SERIES[0],
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - ((v - min) / span) * height}`);
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(values.length - 1) / (values.length - 1) * width} cy={height - ((values[values.length - 1]! - min) / span) * height} r={2} fill={color} />
    </svg>
  );
}

/** A single proportion, read at a glance. */
export function Gauge({ fraction, label, color = SERIES[0] }: { fraction: number; label: string; color?: string }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const size = 74;
  const r = 30;
  const circ = 2 * Math.PI * r;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={L1} strokeWidth={6} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${circ * clamped} ${circ}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x={size / 2} y={size / 2 + 4} textAnchor="middle" style={{ fontFamily: MONO, fontSize: SIZE.title, fill: TXT }}>
          {(clamped * 100).toFixed(0)}%
        </text>
      </svg>
      <span style={{ ...monoLabel(SIZE.micro), color: DIM, maxWidth: 120 }}>{label}</span>
    </div>
  );
}

/** A horizontal ranked bar list — the readable answer for "top N by X". */
export function RankedBars({
  items,
  format,
  scaleTo,
}: {
  items: { label: string; value: number; colorIndex?: number }[];
  format: (n: number) => string;
  /**
   * The value a full bar means. Defaults to the largest item, which is right for
   * counts and WRONG for shares.
   *
   * The Client mix panel was the tell: four SDK shares summing to 100%, the largest
   * 58%, and because the bars normalised to the largest item the 58% bar ran the
   * full width of its track. A full bar reads as "all of it". An operator glancing
   * at that panel would have concluded one SDK accounted for their whole traffic.
   * Any list whose values are shares of a known total passes `scaleTo={100}`.
   */
  scaleTo?: number;
}) {
  const max = scaleTo ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item, i) => (
        /*
         * THE LABEL TRACK TAKES A SHARE OF THE PANEL, NOT A FIXED 90px.
         *
         * With a flat 90px minimum the bar's 3fr won every narrow layout, so on a
         * phone every label in the funnel and the client mix ellipsised to about
         * eleven characters — "Placed first ord…", "Returned within…". A truncated
         * category name is a chart with no categories in it, and the bar it was
         * protecting is the part that stays readable when it shrinks: a proportion
         * reads fine at 120px, a word does not read at all when it is cut.
         *
         * `min()` rather than a breakpoint: 48% of the panel is the right answer at
         * every width, capped at the 170px that fits the longest label this console
         * produces (`RESTRICTED_JURISDICTION`, on the market drill-down).
         */
        <div key={item.label} style={{ display: "grid", gridTemplateColumns: "minmax(min(170px, 48%), 1.2fr) minmax(0, 3fr) auto", gap: 10, alignItems: "center" }}>
          <span style={{ ...monoLabel(SIZE.micro), color: MUT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.label}
          </span>
          <div style={{ height: 7, background: L1, borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.max(1.5, (item.value / max) * 100)}%`,
                background: seriesColor(item.colorIndex ?? i),
                borderRadius: 3,
              }}
            />
          </div>
          <span style={{ ...dataType(), color: TXT }}>
            {format(item.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Wraps a chart with its title and an optional right-hand slot. */
export function ChartFrame({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderBottom: `1px solid ${L2}`, paddingBottom: 7 }}>
        <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}
