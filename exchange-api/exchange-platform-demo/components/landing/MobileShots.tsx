/*
 * The same venue on a phone.
 *
 * WHY IT EARNS A BLOCK. A reader who has just seen a dense desktop terminal
 * assumes one of two things: that the phone case does not exist, or that it is the
 * desktop squeezed. Both are the normal outcome, and both would be a reason not to
 * ship. The app has a real phone layout — a bottom tab bar owns navigation, the
 * four-region shell becomes one pane behind a tab strip, and the blotter scrolls —
 * so the honest move is to show it rather than claim responsiveness in a feature
 * list where nobody believes it.
 *
 * SAME TICK AS THE DESKTOP FRAMES. The captures are the same tenant at the same
 * frozen clock as the desktop pair above, so this is one moment rendered at two
 * widths rather than two sessions that happen to look similar. The BTC mark and the
 * open position agree across all of them, which a reader can check.
 *
 * THE THREE FRAMES ARE THE TRADER'S, NOT THE OPERATOR'S. The console used to be the
 * third of these, which was a category error: this row exists to show a prospective
 * partner what THEIR USERS will see, and an operator screen in it answers a question
 * nobody asked at this point on the page. Markets, Trade, Portfolio is also the order
 * a trader meets them in — find an instrument, take a position, watch it.
 *
 * NOT A DEVICE MOCKUP. No notch, no speaker grille, no hand holding a phone. Those
 * say "marketing asset"; this is the same panel-and-caption treatment every other
 * capture on the page gets, at a phone aspect with a phone's corner radius. The
 * frame communicates the form factor without pretending to be a photograph.
 *
 * A ROW ON A DESKTOP, A CAROUSEL ON A PHONE. Three 390x844 captures stacked at phone
 * width are three near-full screens spent making one point, and the first frame has
 * already made it. Below 700px the row becomes a scroll-snap carousel — one frame at
 * a time, dots underneath, no state and no client component. The geometry and the
 * reasoning both live in `landing.module.css` under "the phone-shot carousel"; this
 * file only names the parts.
 */

import Image from "next/image";

import { FAINT, HI, L1, L2, MONO, MUT, PANEL } from "@/lib/theme";

import { css as cx, eyebrow } from "./primitives";

const SHOTS: { src: string; alt: string; label: string; note: string }[] = [
  {
    src: "/product/mobile-markets.png",
    label: "Markets",
    note: "what your venue lists",
    alt: "The market list on a phone: a search field, asset-class filters for crypto, index, FX and commodity, and thirty-two markets with price, 24-hour change, open interest and annualised funding.",
  },
  {
    src: "/product/mobile-trade.png",
    label: "Trade",
    note: "one pane, tab strip, bottom nav",
    alt: "The venue's trading screen on a phone: the market header, a candle chart, a tab strip for chart, order book and trades, the positions blotter beneath it, and a bottom tab bar for navigation.",
  },
  {
    src: "/product/mobile-portfolio.png",
    label: "Portfolio",
    note: "equity, allocation, positions",
    alt: "The portfolio screen on a phone: total equity with its change, an allocation split, and open positions with unrealised profit and loss.",
  },
];

export function MobileShots() {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className={cx.shotCarousel} style={{ display: "grid", gap: 14 }}>
        <div className={cx.shots}>
          {SHOTS.map((shot) => (
            <div key={shot.src} className={cx.shotSlide}>
              {/* The 260px cap moved into `.shotFigure` so the phone branch can widen it.
                  An inline max-width is not overridable from the stylesheet, and the
                  carousel needs a different frame size than the desktop row does. */}
              <figure className={cx.shotFigure}>
                <div
                  style={{
                    /* A phone's corner radius and a hairline, not a device illustration. */
                    border: `1px solid ${L2}`,
                    borderRadius: 20,
                    overflow: "hidden",
                    background: PANEL,
                    /* 390x844 — the captures' own aspect, so nothing is letterboxed. */
                    aspectRatio: "390 / 844",
                  }}
                >
                  <Image
                    src={shot.src}
                    alt={shot.alt}
                    width={780}
                    height={1688}
                    sizes="(min-width: 1220px) 260px, 60vw"
                    loading="lazy"
                    style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
                  />
                </div>
                <figcaption
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    marginTop: 10,
                    paddingTop: 9,
                    borderTop: `1px solid ${L1}`,
                  }}
                >
                  <span style={{ ...eyebrow(MUT) }}>{shot.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, marginLeft: "auto" }}>{shot.note}</span>
                </figcaption>
              </figure>
            </div>
          ))}
        </div>

        {/* Indicators, not controls. The gesture is the interaction and the labelled
            caption under each frame already says which screen it is, so a tap target
            here would be a second way to do what a thumb already does — and three new
            controls on the page to maintain. `aria-hidden` because a screen reader is
            walking the three figures themselves, in order, and does not need a
            decorative count of them. */}
        <div className={cx.shotDots} aria-hidden="true">
          {SHOTS.map((shot) => (
            <span key={shot.src} className={cx.shotDot} />
          ))}
          <span className={cx.shotDotMark} />
        </div>
      </div>

      <p style={{ fontFamily: MONO, fontSize: 10.5, lineHeight: 1.7, color: MUT, margin: 0, maxWidth: "80ch" }}>
        One build, both form factors.{" "}
        <span style={{ color: HI }}>There is no separate mobile app and no second codebase to keep in step</span> — the
        same template you deploy serves the phone, and the operator console adapts with it too.
      </p>
    </div>
  );
}
