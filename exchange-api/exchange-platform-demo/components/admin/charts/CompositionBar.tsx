/*
 * One bar, several parts, one whole.
 *
 * WHY THIS EXISTS, and it is a replacement rather than an addition. The device
 * mix on Analytics was three `Gauge`s stacked vertically — three rings, three
 * percentages, 220px of panel — and a gauge is the wrong mark for this question
 * twice over. A ring encodes ONE proportion against its own empty space, so
 * three rings ask the reader to compare three separate wholes and then
 * remember that the three wholes are actually the same whole; and the number
 * inside each ring is the whole reading, which makes the ring itself the
 * decoration that WORKSTREAMS §3d names. Three charts became one, and the one
 * says something the three could not: 71% desktop is *nearly three quarters of
 * the bar*, which you see before you read a digit.
 *
 * It is a share-of-one-total mark and nothing else. If the parts do not sum to
 * a known total — counts, magnitudes, anything with an axis — the honest chart
 * is `RankedBars`, which has a scale. This one deliberately has no axis, because
 * its axis is always 100%.
 *
 * FOUR PARTS MAXIMUM, inherited from the palette (charts.tsx: four categorical
 * hues is the hard ceiling on a dark surface that still clears the colour-vision
 * floor). A caller with more categories owes the reader an explicit "Other", not
 * a fifth hue.
 */

import { L1, MUT, R_XS, TXT, monoLabel } from "@/lib/theme";
import { SIZE, data as dataType } from "../type";
import { seriesColor } from "../charts";

export function CompositionBar({
  parts,
  format,
  height = 12,
}: {
  /** In the order they should read. `fraction` is of the whole, 0..1. */
  parts: { label: string; fraction: number; colorIndex?: number }[];
  /** How the fraction is written beside its label. Usually a percentage. */
  format: (fraction: number) => string;
  height?: number;
}) {
  /* Normalised rather than trusted. A caller passing shares that sum to 0.99
     because of rounding would otherwise leave a sliver of track showing at the
     right-hand end, which reads as a fifth, unlabelled category. */
  const total = parts.reduce((s, p) => s + p.fraction, 0) || 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div
        style={{
          display: "flex",
          height,
          background: L1,
          borderRadius: R_XS,
          overflow: "hidden",
          /* The segments are separated by the panel ground, not by a border:
             a 1px rule per segment on a 12px bar is a fifth of the ink. */
          gap: 2,
        }}
        role="img"
        aria-label={parts.map((p) => `${p.label} ${format(p.fraction)}`).join(", ")}
      >
        {parts.map((p, i) => (
          <div
            key={p.label}
            title={`${p.label} — ${format(p.fraction)}`}
            style={{
              /* `flexGrow` on a zero basis, so the segments divide the track by
                 their share and no rounding gap opens at either end. */
              flex: `${(p.fraction / total) * 100} 0 0%`,
              background: seriesColor(p.colorIndex ?? i),
              /* A sliver still has to be visible: a 1% category at 300px is 3px
                 wide, and below about 2px it disappears into the gaps. */
              minWidth: 3,
            }}
          />
        ))}
      </div>

      {/*
        * The legend carries the VALUE, which is what lets the swatch stay small.
        * A legend that only maps colour to name makes the reader look back at the
        * bar and estimate; a legend that states the number makes the bar do the
        * job it is good at — proportion — and the text do the job it is good at.
        */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {parts.map((p, i) => (
          <div key={p.label} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: seriesColor(p.colorIndex ?? i),
                flexShrink: 0,
              }}
            />
            <span
              style={{
                ...monoLabel(SIZE.micro),
                color: MUT,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.label}
            </span>
            <span style={{ ...dataType(), color: TXT }}>{format(p.fraction)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
