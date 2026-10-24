/*
 * Hourly peak throughput against a fixed ceiling.
 *
 * WHY THIS IS NOT ONE OF THE EXISTING CHARTS. Every chart in `charts.tsx` scales
 * to its own data — that is the right default, and it is exactly wrong here. A
 * rate limit is an external constant, so the reading an operator needs is
 * "how close to the rule", and a series normalised to its own maximum answers
 * "how close to yourself", which is always 100%. The ceiling is drawn as a rule
 * and the bars are scaled to it; a chart of a key using 4% of its budget SHOULD
 * look nearly empty, because that is the fact.
 *
 * THE CLIPPED HOURS ARE A SEPARATE COLOUR because they are a different event. A
 * bar at the rule does not mean "busy", it means the limiter refused work — and
 * the refusal count is what the operator has to act on, so it is printed on the
 * bar's tooltip and totalled in the caption rather than left to be inferred from
 * a bar that looks like all the other tall ones.
 *
 * Amber, not red: a 429 is the system working as configured. Red in this console
 * is reserved for something being wrong.
 *
 * DIVS, NOT SVG, for the same reason `Histogram` uses them — percentage heights
 * reflow at any width with no viewBox to distort the stroke weights, and this
 * chart has to survive a 375px panel.
 */

import { AMBER, DIM, FAINT, L1, L2, MUT, R_XS, TXT, monoLabel } from "@/lib/theme";
import { SIZE, body } from "../type";
import { SERIES } from "../charts";

export function CeilingBars({
  labels,
  accepted,
  refused,
  ceiling,
  unit = "/s",
  height = 96,
}: {
  /** One per bar. Only the first and last are printed — 24 ticks is noise. */
  labels: string[];
  accepted: number[];
  refused: number[];
  ceiling: number;
  unit?: string;
  height?: number;
}) {
  /* Headroom above the rule so a clipped bar is visibly AT the rule rather than
     touching the top of the plot, where every full bar looks the same. */
  const top = ceiling * 1.18;
  const rulePct = (ceiling / top) * 100;
  const refusedTotal = refused.reduce((a, b) => a + b, 0);
  const clipped = refused.filter((r) => r > 0).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 9, alignItems: "stretch" }}>
        {/* The scale, stated once. Without it the rule is a decoration and the
            bars are proportions of nothing. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            ...monoLabel(SIZE.micro),
            color: FAINT,
            flexShrink: 0,
          }}
        >
          <span>{`${Math.round(top)}${unit}`}</span>
          <span>0</span>
        </div>

        <div
          role="img"
          aria-label={`Hourly peak throughput against a ceiling of ${ceiling}${unit}. ${clipped} of ${accepted.length} hours reached the ceiling; ${refusedTotal} requests refused.`}
          style={{ position: "relative", flex: 1, height, minWidth: 0, borderBottom: `1px solid ${L2}` }}
        >
          {/* THE RULE, drawn under the bars so a clipped bar sits on it rather
              than being cut by it. */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: `${rulePct}%`,
              borderTop: `1px dashed ${AMBER}`,
              opacity: 0.55,
            }}
          />
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: 2 }}>
            {accepted.map((value, i) => {
              const wasClipped = (refused[i] ?? 0) > 0;
              return (
                <div
                  key={labels[i] ?? i}
                  title={`${labels[i]} — peak ${value}${unit}${wasClipped ? ` · ${refused[i]} refused` : ""}`}
                  style={{
                    flex: 1,
                    minWidth: 2,
                    height: `${Math.max(1.5, (value / top) * 100)}%`,
                    background: wasClipped ? AMBER : SERIES[0],
                    opacity: wasClipped ? 1 : 0.34 + 0.5 * (value / ceiling),
                    borderRadius: `${R_XS}px ${R_XS}px 0 0`,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, ...monoLabel(SIZE.micro), color: FAINT }}>
        <span>{labels[0]}</span>
        <span style={{ color: DIM }}>{`CEILING ${ceiling}${unit}`}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>

      {/* The caption is the reading, not a legend. A legend would name two
          colours; this names the event and what it cost. */}
      <p style={{ ...body(SIZE.note, 1.55), color: MUT, margin: 0, borderTop: `1px solid ${L1}`, paddingTop: 8 }}>
        {clipped === 0 ? (
          <>The limiter did not engage in this window. Peak demand stayed under the ceiling in all {accepted.length} hours.</>
        ) : (
          <>
            The limiter engaged in{" "}
            <strong style={{ color: TXT }}>
              {clipped} of {accepted.length} hours
            </strong>
            , refusing <strong style={{ color: AMBER }}>{refusedTotal.toLocaleString("en-US")}</strong> requests. Demand
            above the rule is not in this series — it was never accepted.
          </>
        )}
      </p>
    </div>
  );
}
