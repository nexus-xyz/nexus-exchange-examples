"use client";

/*
 * The console tour.
 *
 * Four real captures of the venue console, switched by naming the screen you want.
 * The control is the section name because that is how a reader thinks about a
 * console — "show me analytics" — rather than "next slide".
 *
 * EVERY FRAME CARRIES ITS OWN STATUS AND ITS OWN CAVEAT, and this is not
 * decoration. The captures are of a real running console, so the screenshots
 * themselves need no apology, and each earns its own caption rather than a shared
 * one: the four screens answer different questions, and a single blurb under a
 * switcher would describe none of them. The caption is per-frame and moves with the
 * tab.
 *
 * All four frames stay mounted and stacked, and the inactive ones are faded to zero
 * opacity rather than given `hidden` — a `hidden` element cannot crossfade, and it
 * would also have to decode again on every switch. The box therefore keeps one height,
 * nothing flashes empty mid-gesture, and a reader who arrived from a search finds all
 * four captions in the document. Under `prefers-reduced-motion` the crossfade becomes
 * an instant swap; the tabs work identically either way.
 */

import { useState } from "react";

import { ARCHIVO, CHROME, DIM, FAINT, HI, L1, L2, MONO, SEL, TXT } from "@/lib/theme";

import { Frame, Shot } from "./Frame";
import { css as s } from "./primitives";

type Screen = {
  id: string;
  label: string;
  /** What the reader is looking at, and what it is not. */
  caption: string;
  meta?: string;
  src: string;
  alt: string;
};

const SCREENS: Screen[] = [
  {
    id: "overview",
    label: "Overview",
    caption:
      "Routed flow, accrued fees and venue health on one screen. Every figure is labelled live or estimate — the console will not show you a number without telling you where it came from.",
    meta: "venue console",
    src: "/product/console-overview.png",
    alt: "The venue console Overview screen: a left sidebar of console sections, headline tiles for routed volume and accrued builder fees, and a health panel listing venue status checks.",
  },
  {
    id: "analytics",
    label: "Analytics",
    caption:
      "Submit latency as a distribution rather than an average, a rejection taxonomy, attribution coverage, and your share of the market's total volume.",
    meta: "computed venue-side",
    src: "/product/console-analytics.png",
    alt: "The venue console Analytics screen: time-series charts of routed volume and fee accrual above a breakdown of submit latency percentiles and order rejection reasons.",
  },
  {
    id: "config",
    label: "Configuration",
    caption:
      "The same nexus.json the hero shows, edited in the console: markets, palette, wordmark, builder code and fee, domains, legal entity. It is a committed file, so this screen and your repository are looking at the same object.",
    meta: "nexus.json",
    src: "/product/console-config.png",
    alt: "The venue console Configuration screen: an editor showing the nexus.json venue config with market list, brand palette, builder code and fee, and legal entity fields.",
  },
  {
    id: "funding",
    label: "Funding",
    caption:
      "Where the money comes from, and what it cost you to get it. Deposit volume split by rail, the funnel from first deposit to first trade, and the per-account address every payment lands on.",
    src: "/product/console-funding.png",
    alt: "The venue console Funding screen: the deposit funnel from card, bank transfer, exchange withdrawal and token routes into a single deposit address, with simulated recent deposit rows beneath it.",
  },
];

export function ConsoleTour() {
  const [active, setActive] = useState(SCREENS[0].id);
  const current = SCREENS.find((x) => x.id === active) ?? SCREENS[0];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Venue console screens"
        style={{
          display: "flex",
          gap: 2,
          marginBottom: 14,
          /* Four labels do not fit 390px and must not wrap into the frame below. */
          overflowX: "auto",
          paddingBottom: 2,
        }}
      >
        {SCREENS.map((sc) => {
          const on = sc.id === active;
          return (
            <button
              key={sc.id}
              type="button"
              role="tab"
              id={`nx-tour-tab-${sc.id}`}
              aria-selected={on}
              aria-controls={`nx-tour-panel-${sc.id}`}
              onClick={() => setActive(sc.id)}
              style={{
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                minHeight: 38,
                padding: "0 14px",
                borderRadius: 6,
                border: `1px solid ${on ? L2 : "transparent"}`,
                background: on ? SEL : "transparent",
                color: on ? HI : DIM,
                fontFamily: ARCHIVO,
                fontWeight: 600,
                fontSize: 13,
                whiteSpace: "nowrap",
                cursor: "pointer",
                transition: "color 0.15s, background 0.15s, border-color 0.15s",
              }}
            >
              {sc.label}
            </button>
          );
        })}
      </div>

      <Frame label={`Console · ${current.label}`} meta={current.meta}>
        {SCREENS.map((sc) => (
          <div
            key={sc.id}
            role="tabpanel"
            id={`nx-tour-panel-${sc.id}`}
            aria-labelledby={`nx-tour-tab-${sc.id}`}
            className={s.tourLayer}
            style={{
              position: "absolute",
              inset: 0,
              opacity: sc.id === active ? 1 : 0,
              /* Not `hidden` on the wrapper: a hidden element cannot crossfade. The
                 inactive layers are inert to the pointer instead, and are behind. */
              pointerEvents: sc.id === active ? undefined : "none",
              zIndex: sc.id === active ? 1 : 0,
            }}
          >
            <Shot spec={{ src: sc.src, alt: sc.alt }} />
          </div>
        ))}
      </Frame>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          gap: 12,
          padding: "12px 14px",
          background: CHROME,
          border: `1px solid ${L2}`,
          borderTop: `1px solid ${L1}`,
          borderRadius: 6,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", color: FAINT, paddingTop: 2 }}>
          {current.label.toUpperCase()}
        </span>
        <p style={{ margin: 0, fontFamily: ARCHIVO, fontWeight: 500, fontSize: 13, lineHeight: 1.6, color: TXT, maxWidth: "62ch" }}>
          {current.caption}
        </p>
      </div>
    </div>
  );
}
