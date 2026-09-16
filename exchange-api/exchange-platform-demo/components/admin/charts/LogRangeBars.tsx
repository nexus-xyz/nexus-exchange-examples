/*
 * The Deposits pane's rail-timing chart, extracted.
 *
 * It lived inline in `app/admin/funding/page.tsx` as ~55 lines of positioned
 * spans. That was survivable while the pane was one long scroll; it is not
 * survivable now the pane is four sub-panes whose sections each have to be
 * readable on their own. Nothing about the mark changed in the move.
 */

import { DIM, FAINT, L1, MUT, TXT, monoLabel } from "@/lib/theme";
import { SIZE, data as dataType } from "../type";
import { seriesColor } from "../charts";

/**
 * A rail-style pair of bars on a log track — median in front, p90 behind.
 *
 * EXTRACTED, NOT INVENTED: this was ~55 lines inline in the Deposits pane, and
 * the pane is now four sub-panes that each have to stay readable. The reading it
 * supports is unusual enough to be worth naming: the values it plots span four
 * orders of magnitude (a chain deposit lands in seconds, a bank transfer in
 * days), so a linear track draws three of the four rails as nothing. The log
 * track is the only one on which all four are visible at once, and the GAP
 * between the pale p90 bar and the solid median bar is the actual reading —
 * that gap is the tail somebody answers support tickets about.
 */
export function LogRangeBars({
  rows,
  ceilingSeconds = 400_000,
  formatValue,
}: {
  rows: { key: string; label: string; median: number; p90: number; colorIndex: number }[];
  /** The value a full track means. Slower than the slowest rail, by design. */
  ceilingSeconds?: number;
  formatValue: (seconds: number) => string;
}) {
  const scale = (sec: number) =>
    Math.min(1, Math.log10(Math.max(1, sec)) / Math.log10(ceilingSeconds));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...monoLabel(SIZE.micro), color: MUT, flex: 1, minWidth: 0 }}>{r.label}</span>
            <span style={{ ...dataType(SIZE.note), color: TXT }}>{formatValue(r.median)}</span>
            <span style={{ ...monoLabel(SIZE.micro), color: FAINT, width: 78, textAlign: "right" }}>
              p90 {formatValue(r.p90)}
            </span>
          </div>
          <span
            title={`${r.label} — median ${formatValue(r.median)}, p90 ${formatValue(r.p90)}`}
            style={{ display: "block", height: 5, background: L1, borderRadius: 3, position: "relative" }}
          >
            <span
              style={{
                position: "absolute",
                inset: 0,
                width: `${scale(r.p90) * 100}%`,
                background: `${seriesColor(r.colorIndex)}44`,
                borderRadius: 3,
              }}
            />
            <span
              style={{
                position: "absolute",
                inset: 0,
                width: `${scale(r.median) * 100}%`,
                background: seriesColor(r.colorIndex),
                borderRadius: 3,
              }}
            />
          </span>
        </div>
      ))}
      <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>SOLID = MEDIAN · PALE = p90 · LOG TRACK</span>
    </div>
  );
}
