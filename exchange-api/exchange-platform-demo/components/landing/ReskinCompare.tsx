"use client";

/*
 * The re-skin proof.
 *
 * This is the second signature moment on the page and it earns the title for one
 * reason: the two captures are the SAME screen at the SAME frozen tick, and the
 * only difference between them is the palette in a config file. "Your brand, our
 * terminal" is a claim the page can otherwise only assert; here the reader
 * operates it themselves and the claim proves itself in one gesture, with no copy
 * required to explain what they are looking at.
 *
 * A WIPE, NOT A CROSSFADE. A crossfade dissolves one picture into another and reads
 * as two pictures. A wipe holds every pixel of structure locked in place and moves
 * only the colour across it — which is exactly the thing being claimed: same build,
 * same layout, same tick, different config. The transition is the argument.
 *
 * BOTH FRAMES ARE ALWAYS IN THE DOM, stacked, and the top one is revealed by
 * `clip-path`. Nothing unmounts, so neither image ever has to decode mid-gesture
 * and the control cannot flash an empty box on first press.
 *
 * The control is two real buttons in a radio group: arrow keys and tab both reach
 * it, `aria-checked` says which is on, and the venue names are the labels because
 * the venue names are the point. Under `prefers-reduced-motion` the stylesheet
 * lays the two frames out side by side and the wipe never happens — the comparison
 * is still made, statically, with nothing to miss.
 */

import { useState } from "react";

import { ARCHIVO, CHROME, DIM, FAINT, HI, L2, L3, MONO, SEL, TXT } from "@/lib/theme";
import { ACME, NEXUS } from "@/lib/tenant";

import { Frame, Shot } from "./Frame";
import { css as s } from "./primitives";

/* The two tenants this app actually ships, read from the config rather than
   restated — the labels and the swatches are then correct by construction. */
const VENUES = [
  {
    id: NEXUS.id,
    name: NEXUS.name,
    swatch: NEXUS.palette.green,
    spec: {
      src: "/product/terminal-nexus.png",
      alt: "The Nexus Exchange trading terminal: market header, candlestick chart, order book and recent trades on the right, order ticket below them, and a positions blotter across the bottom. Bids and the buy control are green.",
    },
  },
  {
    id: ACME.id,
    name: ACME.name,
    swatch: ACME.palette.green,
    spec: {
      src: "/product/terminal-acme.png",
      alt: "The identical terminal screen, rendered under the Acme Perps palette: the same chart, book, ticket and blotter, with bids and the buy control in cyan and a higher maker/taker pair on the order ticket, because the Acme config adds its own fee inside it.",
    },
  },
] as const;

export function ReskinCompare() {
  const [active, setActive] = useState<string>(VENUES[0].id);

  return (
    <div>
      {/* Plain toggle buttons with `aria-pressed`, not a radio group. A radio group
          promises arrow-key navigation that native buttons do not implement, and a
          promise in an ARIA role is a promise a keyboard user tests. Tab and Enter
          reach both of these without any of that. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {VENUES.map((v) => {
          const on = v.id === active;
          return (
            <button
              key={v.id}
              type="button"
              aria-pressed={on}
              onClick={() => setActive(v.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                /* The control tier from lib/theme's tap scale — this is the one
                   thing on the section a reader is meant to press. */
                minHeight: 38,
                padding: "0 14px",
                borderRadius: 6,
                border: `1px solid ${on ? L3 : L2}`,
                background: on ? SEL : "transparent",
                color: on ? HI : DIM,
                fontFamily: ARCHIVO,
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
                transition: "color 0.15s, background 0.15s, border-color 0.15s",
              }}
            >
              <span
                aria-hidden
                style={{ width: 8, height: 8, borderRadius: 2, background: v.swatch, flex: "0 0 auto" }}
              />
              {v.name}
            </button>
          );
        })}
        <span
          style={{
            marginLeft: "auto",
            alignSelf: "center",
            fontFamily: MONO,
            fontSize: 10.5,
            letterSpacing: "0.1em",
            color: FAINT,
          }}
        >
          same build · same tick
        </span>
      </div>

      <Frame label="Terminal" meta="one config, two brands" shotClass={s.shotCompare}>
        <div className={s.compare}>
          {VENUES.map((v, i) => (
            <div
              key={v.id}
              /* The first frame is the ground and is never clipped; the second is
                 the one that wipes over it. Clipping both would let a gap open at
                 the seam during the transition. */
              className={i === 0 ? s.compareLayer : `${s.compareLayer} ${v.id === active ? "" : s.compareOff}`}
            >
              <Shot spec={v.spec} sizes="(min-width: 1220px) 1140px, 96vw" />
              <span className={s.compareCaption}>
                <span
                  aria-hidden
                  style={{ width: 7, height: 7, borderRadius: 2, background: v.swatch, flex: "0 0 auto" }}
                />
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", color: TXT }}>
                  {v.name.toUpperCase()}
                </span>
              </span>
            </div>
          ))}
        </div>
      </Frame>

      <div
        style={{
          marginTop: 12,
          fontFamily: MONO,
          fontSize: 11,
          lineHeight: 1.6,
          color: DIM,
          background: CHROME,
          padding: "10px 12px",
          borderRadius: 6,
          border: `1px solid ${L2}`,
        }}
      >
        Two captures of one build, one screen. Nothing between them changed but{" "}
        <span style={{ color: TXT }}>palette</span>, <span style={{ color: TXT }}>wordmark</span> and the{" "}
        <span style={{ color: TXT }}>fee the Acme config folds into the ticket&rsquo;s rate</span>.
      </div>
    </div>
  );
}
