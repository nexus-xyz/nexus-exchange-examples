"use client";

/*
 * Scrolling market strip in the top bar.
 *
 * Two jobs: it makes the venue's breadth visible from any screen (a terminal showing
 * one market looks like a chart widget), and it's the fastest path to another market —
 * every entry is clickable.
 *
 * The marquee is a duplicated track translated by -50%, so the loop is seamless
 * without measuring anything. Duplicating the list is what makes 50% exact.
 */

import { MARKETS } from "@/lib/markets";
import { MONO, GREEN, RED, FAINT, DIM } from "@/lib/theme";

export function MarketTicker({ onSelect, active }: { onSelect: (sym: string) => void; active: string }) {
  const track = [...MARKETS, ...MARKETS];
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        overflow: "hidden",
        maskImage: "linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)",
        WebkitMaskImage: "linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)",
      }}
    >
      <div style={{ display: "flex", width: "max-content", animation: "nxticker 90s linear infinite" }}>
        {track.map((m, i) => {
          const up = m.chg24 >= 0;
          const on = m.sym === active;
          return (
            <button
              key={`${m.sym}-${i}`}
              onClick={() => onSelect(m.sym)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "0 11px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 10.5,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: FAINT }}>[</span>
              <span style={{ color: on ? "#f3f3f3" : DIM }}>{m.base}</span>
              <span style={{ color: FAINT }}>]</span>
              <span style={{ color: up ? GREEN : RED }}>
                {up ? "+" : ""}
                {m.chg24.toFixed(2)}%
              </span>
              <span style={{ color: up ? GREEN : RED, fontSize: 8 }}>{up ? "▲" : "▼"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
