/*
 * Engine activity bars. The rightmost bars are lit and the tail is dim, so the
 * mark reads as a feed scrolling left — the terminal's one piece of pure
 * ambient motion, standing in for "the matching engine is alive".
 */

import { heartbeat } from "@/lib/feed";
import { GREEN } from "@/lib/theme";

export function Heartbeat({ tick, w = 62, h = 22 }: { tick: number; w?: number; h?: number }) {
  const bars = heartbeat(tick);
  const step = w / bars.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" aria-hidden>
      {bars.map((v, i) => (
        <rect
          key={i}
          x={i * step}
          y={h - v * h}
          width={step * 0.55}
          height={v * h}
          fill={i > bars.length - 4 ? GREEN : "#283028"}
        />
      ))}
    </svg>
  );
}
