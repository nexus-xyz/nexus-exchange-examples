/*
 * Analytics for the Seasons programme. Account-scoped only: the chart here
 * answers a question about YOUR history that the rest of the /competitions
 * screen cannot. Venue-wide statistics (dilution, pool concentration) belong to
 * the programme's own reporting, not to a trader's account view.
 *
 *   ShareBySeason — how much of each pool you took, season over season. The one
 *                   series that is yours alone and trends.
 *
 * All hand-rolled SVG, matching the other charts in this directory. `viewBox`
 * with `preserveAspectRatio="xMidYMid meet"` keeps the geometry square so SVG
 * text is safe — unlike CandleChart, which stretches and therefore has to put its
 * labels in an HTML overlay.
 */

import { FAINT, GREEN, L1, MONO, MUT, TXT } from "@/lib/theme";

export type SeasonPoint = {
  id: string;
  label: string;
  share: number;
  open: boolean;
};

function Frame({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", color: TXT }}>
          {title.toUpperCase()}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: "0.04em" }}>
          {hint}
        </span>
      </div>
      {children}
    </div>
  );
}

/* ----------------------------------------------------------- share by season */

export function ShareBySeason({ seasons }: { seasons: SeasonPoint[] }) {
  const W = 320;
  const H = 150;
  const pad = { l: 34, r: 8, t: 10, b: 20 };
  const max = Math.max(...seasons.map((s) => s.share), 0.0001);
  const bw = (W - pad.l - pad.r) / seasons.length;

  return (
    <Frame
      title="Your share of pool"
      hint="Share of each season's pool that settled to you. The open season is lighter — it is still moving."
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: 220 }}
        role="img"
        aria-label="Your share of each season's pool"
      >
        {[0, 0.5, 1].map((t) => {
          const y = pad.t + (1 - t) * (H - pad.t - pad.b);
          return (
            <g key={t}>
              <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke={L1} strokeWidth={0.6} />
              <text
                x={pad.l - 5}
                y={y + 3}
                textAnchor="end"
                style={{ fontFamily: MONO, fontSize: 7.5, fill: FAINT }}
              >
                {(max * t * 100).toFixed(2)}%
              </text>
            </g>
          );
        })}
        {seasons.map((s, i) => {
          const h = (s.share / max) * (H - pad.t - pad.b);
          const x = pad.l + i * bw;
          return (
            <g key={s.id}>
              <rect
                x={x + bw * 0.18}
                y={H - pad.b - h}
                width={bw * 0.64}
                height={Math.max(h, 1)}
                fill={GREEN}
                fillOpacity={s.open ? 0.35 : 0.85}
              />
              <text
                x={x + bw / 2}
                y={H - pad.b + 11}
                textAnchor="middle"
                style={{ fontFamily: MONO, fontSize: 7.5, fill: MUT }}
              >
                {s.id}
              </text>
            </g>
          );
        })}
      </svg>
    </Frame>
  );
}
