"use client";

/*
 * Persistent bottom tab bar — the mobile navigation model.
 *
 * We had none: at 390px the shell reused `TopNav` with `compact`, which drops the
 * search affordance and the ticker and leaves three 32px-tall text tabs at the top
 * of the screen. The reference venue instead ships a `390×79` bottom bar with five
 * `73×70` items (audit/reference/findings.responsive.md §1), and that one component
 * is where its entire 44px tap budget goes — 6 of its 26 mobile controls reach 44
 * and five of those six are these (§4). So a bottom bar buys the primary-navigation
 * tap tier for free, and it is the anchor the destination-based mobile IA needs.
 *
 * Two rules taken from their capture:
 *
 *   - Never lose the nav on a route. Their `/discovery-bounds` at 390px renders no
 *     bottom bar at all — no visible way back (§1, "Their bug"). This component is
 *     rendered once by the shell, as a sibling of the screen switch, so it cannot
 *     go missing on one screen.
 *   - It is chrome, not content. Fixed height, never scrolls, no overflow.
 *
 * Self-contained by design: it takes the current screen, a setter, and any extra
 * destinations the shell wants to append. It reads no market, account or feed state.
 * Render it as the last flex child of the shell column (below `StatusBar`), only
 * when the layout is not `desktop`.
 */

import type { ReactNode } from "react";
import { ARCHIVO, CHROME, FAINT, GREEN, HI, H_BOTTOM_NAV, L1, L2, L3, MONO, R_MD, TAP_PRIMARY, TXT } from "@/lib/theme";
import { useState } from "react";
import { SCREENS, type Screen } from "./TopNav";

/**
 * Minimum bar height. The rendered element adds `env(safe-area-inset-bottom)` on
 * top of this, which is 0 in a desktop browser and non-zero on a notched phone, so
 * anything reserving space for the bar should subtract at least this much.
 */
export { H_BOTTOM_NAV };
/** Alias, for callers that would rather not import a theme token by its H_ name. */
export const BOTTOM_NAV_HEIGHT = H_BOTTOM_NAV;

/** An extra destination appended after the three screens. */
export type BottomNavTab = {
  key: string;
  label: string;
  /** 20×20 line glyph. Defaults to a neutral dot. */
  glyph?: ReactNode;
  active?: boolean;
  onSelect: () => void;
  /** Small trailing count — working orders, open positions. */
  badge?: number;
};

/* Line glyphs, 20×20, `currentColor` so the active/inactive colour drives them.
   Deliberately geometric rather than pictorial: this is the same drawing language
   as the chart axes and the corner ticks. */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Markets — a list of instruments. */
const GLYPH_MARKETS = (
  <Svg>
    <path {...stroke} d="M3 5.5h14M3 10h14M3 14.5h9" />
  </Svg>
);

/** Trade — two candles with wicks. */
const GLYPH_TRADE = (
  <Svg>
    <path {...stroke} d="M6.5 3.5v13M13.5 3.5v13" />
    <rect {...stroke} x="4.5" y="6.5" width="4" height="6" rx="1" />
    <rect {...stroke} x="11.5" y="9" width="4" height="5" rx="1" />
  </Svg>
);

/** Portfolio — holdings. */
const GLYPH_PORTFOLIO = (
  <Svg>
    <rect {...stroke} x="3" y="6" width="14" height="9.5" rx="2" />
    <path {...stroke} d="M3 9.5h14M6 4.5h8" />
  </Svg>
);

/* Account — a wallet/card, which is the reference's glyph for the same slot and the
   one convention a trader will have seen on every other venue. Deliberately not a
   person: this is a balance sheet, not a profile. */
const GLYPH_ACCOUNT = (
  <Svg>
    <rect {...stroke} x="2.5" y="5" width="15" height="10" rx="2" />
    <path {...stroke} d="M2.5 8.5h15" />
    <circle {...stroke} cx="14" cy="11.75" r="1.15" />
  </Svg>
);

/** Ticket / order entry — used by the shell for the order destination if it wants one. */
export const GLYPH_TICKET = (
  <Svg>
    <path {...stroke} d="M10 4v12M4.5 9.5 10 4l5.5 5.5" />
  </Svg>
);

/* Three dots. Deliberately not a hamburger: a hamburger promises navigation for the
   whole app, and this is the tail of one bar. */
const GLYPH_MORE = (
  <Svg>
    <circle cx="5" cy="10.5" r="1.4" fill="currentColor" />
    <circle cx="10.5" cy="10.5" r="1.4" fill="currentColor" />
    <circle cx="16" cy="10.5" r="1.4" fill="currentColor" />
  </Svg>
);

const GLYPH_DEFAULT = (
  <Svg>
    <circle {...stroke} cx="10" cy="10" r="3.2" />
  </Svg>
);

/* Competitions: a podium. Reads as ranking rather than as another chart. */
const GLYPH_COMPETITIONS = (
  <Svg>
    <path {...stroke} d="M4 16.5h12M6.5 16.5v-4h3v4M10.5 16.5V6.5h3v10" />
  </Svg>
);

const SCREEN_GLYPH: Record<Screen, ReactNode> = {
  trade: GLYPH_TRADE,
  portfolio: GLYPH_PORTFOLIO,
  competitions: GLYPH_COMPETITIONS,
};

/*
 * THE MOBILE IA IS NOT THE DESKTOP ONE, and now follows the reference's.
 *
 * Theirs reads `Markets · Trade · Account · Portfolio · Earn`, and the two words do
 * not mean what a desktop reader expects:
 *
 *   Markets — the CHART screen. Book, tape, blotter: the thing you watch.
 *   Trade   — the ORDER TICKET, as a destination rather than a panel.
 *
 * That split is the whole point of a phone layout. There is room for one thing at a
 * time, so "look at the market" and "place an order" become two destinations instead
 * of two halves of one screen. Ours now does the same: `Markets` opens the trade
 * screen, `Trade` opens the ticket sheet over it.
 *
 *   Account — the account card and the blotter, as a destination of its own.
 *
 * `Account` is deliberately MOBILE-ONLY, which is also theirs: their desktop has no
 * Account nav item either, because at that width the account lives in the right rail
 * exactly as ours does. So it is a sheet on the trade screen rather than a fourth
 * `Screen`, and the top nav is unchanged.
 *
 * We have no `Earn`, and we do have `Competitions` — plus, presumably, more later. So
 * the fifth slot is `More`, a menu rather than a fixed destination. Five is the most
 * a 390px bar holds; a sixth product would otherwise cost the bar its labels.
 */
const ORDER: Screen[] = ["trade", "portfolio"];

export function BottomNav({
  screen,
  onScreen,
  ticketOpen = false,
  accountOpen = false,
  onOpenTicket,
  onOpenAccount,
  onCloseSheet,
}: {
  screen: Screen;
  onScreen: (s: Screen) => void;
  /** True while the order-ticket destination is over the trade screen. */
  ticketOpen?: boolean;
  /** True while the account destination is over the trade screen. */
  accountOpen?: boolean;
  onOpenTicket?: () => void;
  onOpenAccount?: () => void;
  onCloseSheet?: () => void;
}) {
  const [more, setMore] = useState(false);
  /* Everything not on the bar. One item today; the menu exists because a fifth
     product should cost a row in this array and not a redesign of the bar. */
  const overflow = SCREENS.filter((s) => !ORDER.includes(s));

  const tabs: BottomNavTab[] = [
    {
      key: "markets",
      // THEIR word for the chart screen, not ours for a market list. See ORDER.
      label: "markets",
      glyph: GLYPH_MARKETS,
      active: screen === "trade" && !ticketOpen && !accountOpen,
      onSelect: () => {
        onScreen("trade");
        onCloseSheet?.();
      },
    },
    {
      key: "trade",
      label: "trade",
      glyph: GLYPH_TRADE,
      active: ticketOpen,
      onSelect: () => {
        onScreen("trade");
        onOpenTicket?.();
      },
    },
    {
      key: "account",
      label: "account",
      glyph: GLYPH_ACCOUNT,
      active: accountOpen,
      onSelect: () => {
        onScreen("trade");
        onOpenAccount?.();
      },
    },
    {
      key: "portfolio",
      label: "portfolio",
      glyph: GLYPH_PORTFOLIO,
      active: screen === "portfolio",
      onSelect: () => onScreen("portfolio"),
    },
    {
      key: "more",
      label: "more",
      glyph: GLYPH_MORE,
      active: overflow.includes(screen) || more,
      onSelect: () => setMore((v) => !v),
    },
  ];

  return (
    <>
      {more && (
        <>
          <div onClick={() => setMore(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          {/* Anchored to the bar and opening UPWARD, because the bar is the bottom of
              the screen — the same flip the blotter's menus needed, and here it is not
              a fallback but the only direction available. */}
          <div
            role="menu"
            aria-label="More destinations"
            style={{
              position: "fixed",
              left: 8,
              right: 8,
              bottom: `calc(${H_BOTTOM_NAV}px + env(safe-area-inset-bottom, 0px) + 8px)`,
              zIndex: 61,
              background: "#0d0d0d",
              border: `1px solid ${L3}`,
              borderRadius: R_MD,
              boxShadow: "0 -18px 44px rgba(0,0,0,0.8)",
              overflow: "hidden",
              padding: "4px 0",
            }}
          >
            {overflow.map((s2) => (
              <button
                key={s2}
                role="menuitem"
                onClick={() => {
                  onScreen(s2);
                  setMore(false);
                }}
                className="nx-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  minHeight: TAP_PRIMARY,
                  padding: "0 14px",
                  border: "none",
                  background: "transparent",
                  color: screen === s2 ? GREEN : TXT,
                  fontFamily: MONO,
                  fontSize: 11.5,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                {SCREEN_GLYPH[s2] ?? GLYPH_DEFAULT}
                {s2}
              </button>
            ))}
          </div>
        </>
      )}
    <nav
      aria-label="Primary"
      style={{
        flex: "0 0 auto",
        /*
         * Sticky, not static.
         *
         * Measured: with a static bar, opening the Markets screen at 390px put the
         * nav's top at y=2915 — the shell's mobile branch makes the whole app a
         * scroller, the market list is ~2,900px of it, and the bar went with it. A
         * navigation you have to scroll to is the same failure as not having one, and
         * it is exactly the floor check §1 of the responsive findings asks for.
         *
         * `sticky` rather than `fixed` on purpose: it still occupies space at the end
         * of the shell column, so a long screen ends above it instead of underneath
         * it, and the fixed-height trade screen's `100dvh − chrome` reservation stays
         * true.
         */
        position: "sticky",
        bottom: 0,
        display: "flex",
        alignItems: "stretch",
        minHeight: H_BOTTOM_NAV,
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        borderTop: `1px solid ${L2}`,
        background: CHROME,
        // Above the market header (20) and the sheets, below the palette.
        zIndex: 45,
      }}
    >
      {tabs.map((t) => {
        const on = !!t.active;
        return (
          <button
            key={t.key}
            onClick={t.onSelect}
            aria-current={on ? "page" : undefined}
            style={{
              // Equal shares of the width. Theirs are 73px wide at 390; three
              // destinations gives us 130, so width is never the binding constraint —
              // height is, and it is TAP_PRIMARY at minimum.
              flex: "1 1 0",
              minWidth: 0,
              minHeight: TAP_PRIMARY,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "6px 4px",
              /*
               * The active mark is a FILLED TAB, not a rule on the top edge.
               *
               * The rule was borrowed from the desktop tab strips, where it is right:
               * those tabs sit under content and the underline reads as "this column".
               * A bottom bar is not a tab strip — its items are destinations, the bar
               * is the last thing above the home indicator, and a 2px line at the top
               * edge of the bar reads as a divider between the bar and the screen
               * rather than as a mark on one item. The reference fills the whole tab
               * instead, which is also what iOS and Android navigation bars do.
               */
              /* L1, not SUNK. SUNK is #060606 against a #040404 bar — two counts of
                 lightness, which is not a mark, it is a rounding error. The fill has to
                 read as a raised tab from across a room. */
              background: on ? L1 : "transparent",
              borderRadius: R_MD,
              border: "none",
              color: on ? HI : FAINT,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
              transition: "color .12s, background .12s",
            }}
          >
            {t.glyph ?? GLYPH_DEFAULT}
            <span
              style={{
                /*
                 * Sentence case in the UI face, not uppercase mono.
                 *
                 * Mono + 0.1em tracking + uppercase is this product's LABEL voice —
                 * it marks a thing as a field name for a value beside it. A nav
                 * destination is not a field name, it is a place, and theirs reads
                 * `Markets Trade Account Portfolio Earn` in sentence case for the same
                 * reason every phone in the world does.
                 */
                fontFamily: ARCHIVO,
                fontSize: 10.5,
                letterSpacing: "0.01em",
                textTransform: "capitalize",
                display: "flex",
                alignItems: "center",
                gap: 4,
                maxWidth: "100%",
                overflow: "hidden",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
              {t.badge !== undefined && t.badge > 0 && <span style={{ color: on ? GREEN : FAINT }}>{t.badge}</span>}
            </span>
          </button>
        );
      })}
    </nav>
    </>
  );
}
