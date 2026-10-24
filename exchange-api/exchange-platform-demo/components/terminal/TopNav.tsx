"use client";

/*
 * Application chrome: wordmark, screen tabs, the ⌘K affordance, network status,
 * and the account pill. Fixed height, never scrolls.
 */

import { MONO, ARCHIVO, GREEN, L2, DIM, MUT, HI, H_NAV, H_NAV_COMPACT, R_MD, monoLabel, titleLabel } from "@/lib/theme";
import { shortAddress, type Session } from "@/lib/session";
import { ACTIVE_TENANT } from "@/lib/tenant";

/** A nav destination outside the terminal's own screen switcher. */
function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 32,
        padding: "0 14px",
        ...titleLabel(12.5),
        color: "#8a8a8a",
        textDecoration: "none",
        borderRadius: R_MD,
      }}
    >
      {label}
    </a>
  );
}
import { StatusDot } from "./primitives";

export type Screen = "trade" | "portfolio" | "competitions";
/*
 * Trade, Portfolio, Competitions.
 *
 * `Markets` is gone as a screen. Browsing the universe is what MarketSwitcher does —
 * search, asset-class filters, the whole 32-market table in a modal a keystroke away —
 * and a second full-page copy of it existed only because the nav had a slot to fill.
 * Deleting it is what adopting the reference's mobile IA implied: there, the chart
 * screen IS the Markets destination, which leaves a standalone market list orphaned.
 *
 * Portfolio second because it is the destination a trader returns to, as theirs is.
 * The MOBILE order is deliberately different; see BottomNav.
 */
export const SCREENS: Screen[] = ["trade", "portfolio", "competitions"];

export function TopNav({
  screen,
  onScreen,
  onOpenPalette,
  compact,
  ticker,
  session,
  onAccount,
  onOpenDrawer,
}: {
  screen: Screen;
  onScreen: (s: Screen) => void;
  onOpenPalette: () => void;
  compact: boolean;
  /** Drives the pill: Connect Wallet when out, the address when in. */
  session: Session;
  /** Opens the wallet picker when out; the account menu when in. */
  onAccount: () => void;
  /** Mobile only: the wordmark opens the navigation drawer. */
  onOpenDrawer: () => void;
  /** The scrolling market strip. Passed in so TopNav stays free of market state. */
  ticker?: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: compact ? H_NAV_COMPACT : H_NAV,
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        gap: compact ? 8 : 20,
        padding: "0 16px",
        borderBottom: `1px solid ${L2}`,
        background: "#040404",
        zIndex: 40,
        position: compact ? "sticky" : "relative",
        top: 0,
      }}
    >
      {/* The wordmark is a link home, and a link is a target. Its box was the box of
          its own glyphs — 70×16 — so it read as a 16px-tall hit area on every capture
          the harness has ever taken. Stretching it to the header's height costs no
          pixels on screen and makes the target match what it looks like. */}
      {/*
       * On a phone the wordmark opens the DRAWER; at desktop it is still a link home.
       *
       * A 71px link to `/` on a phone reloads the app and loses your market — that is
       * not a destination, it is a way to lose your place. Theirs puts the navigation
       * behind it instead.
       */}
      {compact ? (
        <button
          onClick={onOpenDrawer}
          aria-label="Open navigation"
          aria-haspopup="menu"
          style={{
            display: "flex",
            alignItems: "center",
            alignSelf: "stretch",
            minHeight: 32,
            padding: 0,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
          }}
        >
        <span
          style={{
            fontFamily: ARCHIVO,
            fontWeight: 800,
            fontSize: 15,
            // 0.46em of tracking on six glyphs is ~40px of pure air; at 390 that is
            // width the nav does not have. Tightened at compact only.
            letterSpacing: compact ? "0.2em" : "0.46em",
            color: HI,
          }}
        >
          {ACTIVE_TENANT.wordmark}
        </span>
        </button>
      ) : (
        <a
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            alignSelf: "stretch",
            minHeight: 32,
            textDecoration: "none",
          }}
        >
          <span
            style={{
              fontFamily: ARCHIVO,
              fontWeight: 800,
              fontSize: 15,
              letterSpacing: "0.46em",
              color: HI,
            }}
          >
            {ACTIVE_TENANT.wordmark}
          </span>
        </a>
      )}
      {!compact && <span style={{ width: 1, height: 22, background: L2 }} />}

      {/* Screen tabs are DESKTOP ONLY. At mobile the bottom bar owns navigation, and
          rendering both duplicated it and overflowed the viewport: wordmark 71 + tabs
          252 + account 55 measured 426 in a 390px window.

          NOT RENDERED at compact, rather than `display: none`. It was three real
          buttons at width 0 sitting in the mobile DOM — invisible, and skipped by the
          floor only because zero-size elements are excluded from the tap-target and
          focus sweeps. A strip of live controls nothing grades is a focus trap waiting
          for someone to change how it is hidden. */}
      {!compact && (
      <div style={{ display: "flex", gap: 2 }}>
        {SCREENS.map((s) => (
          <button
            key={s}
            onClick={() => onScreen(s)}
            style={{
              height: 32,
              padding: "0 14px",
              border: "none",
              background: screen === s ? "#0e0e0e" : "transparent",
              /* Destinations, not field names. Same rule as the bottom nav, which
                 already reads `Markets Trade Account Portfolio More`. */
              ...titleLabel(12.5),
              color: screen === s ? HI : "#8a8a8a",
              cursor: "pointer",
              borderRadius: R_MD,
            }}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
        {/* Operator surfaces, not trader screens — so they are links to their own
            routes rather than screens in this client bundle. The platform console
            is rendered only by the Nexus build; a partner's build must not carry
            cross-tenant code at all. */}
        <NavLink href="/admin" label="Console" />
      </div>
      )}

      {/* The ticker takes the slack rather than a spacer — venue breadth is worth
          more here than empty space, and network state moved to the status bar. */}
      {!compact && ticker}
      {compact && <div style={{ flex: 1 }} />}

      {!compact && (
        <button
          onClick={onOpenPalette}
          className="nx-hover-border"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            height: 32,
            padding: "0 8px 0 11px",
            background: "#0a0a0a",
            border: `1px solid ${L2}`,
            borderRadius: R_MD,
            color: DIM,
            fontFamily: ARCHIVO,
            fontSize: 12.5,
            cursor: "pointer",
            flex: "0 0 auto",
          }}
        >
          <span>Search</span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10,
              background: "#141414",
              border: "1px solid #2a2a2a",
              borderRadius: 5,
              padding: "2px 6px",
              color: MUT,
            }}
          >
            ⌘K
          </span>
        </button>
      )}

      {/*
       * Connect, or the address. Reads the session rather than always rendering a
       * fixture pill — which is what it did, so a logged-out visitor saw an address.
       */}
      <button
        onClick={onAccount}
        className="nx-hover-border"
        aria-label={session === "in" ? `Account ${shortAddress()}` : "Connect wallet"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          /*
           * 44 when it says Connect Wallet on a touch surface.
           *
           * The old pill was 34 and passed the floor because its label was an address —
           * no primary-action word, so it graded at the default tier. Now it names the
           * one thing a logged-out visitor is here to do, the classifier reads it as a
           * submit, and it wants 44. It is right: for a disconnected reader this IS the
           * primary action of the whole product.
           *
           * Connected, it reverts to 34 — an address pill is chrome, not an action.
           */
          /*
           * The 44 is the HIT AREA, not the paint.
           *
           * Painting all 44 filled the 48px phone nav edge to edge with a green block —
           * the loudest thing on the screen by a wide margin, and louder than theirs,
           * whose pill is about 28 inside the same bar. But the floor is right that a
           * touch target for the product's primary action wants 44, so the two are
           * separated: the button keeps its 44 and paints nothing, and the pill inside
           * it is 30. Padding as target is the ordinary way to hold both.
           */
          height: session === "in" ? 34 : compact ? 44 : 36,
          padding: compact && session !== "in" ? "0 4px" : session === "in" ? "0 11px 0 9px" : "0 13px",
          background: compact && session !== "in" ? "transparent" : session === "in" ? "#0a0a0a" : GREEN,
          border: compact && session !== "in" ? "1px solid transparent" : `1px solid ${session === "in" ? L2 : GREEN}`,
          borderRadius: R_MD,
          cursor: "pointer",
        }}
      >
        {session === "in" ? (
          <>
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "radial-gradient(circle at 32% 28%, #2fe39b, #0a8f5b 72%)",
              }}
            />
            {!compact && <span style={{ fontFamily: MONO, fontSize: 12, color: "#c2c2c2" }}>{shortAddress()}</span>}
            <span style={{ color: DIM, fontSize: 9 }}>▾</span>
          </>
        ) : (
          <span
            style={{
              fontFamily: ARCHIVO,
              fontSize: 12.5,
              fontWeight: 600,
              color: "#04231a",
              ...(compact
                ? {
                    display: "flex",
                    alignItems: "center",
                    height: 30,
                    padding: "0 13px",
                    background: GREEN,
                    borderRadius: R_MD,
                  }
                : null),
            }}
          >
            {compact ? "Connect" : "Connect Wallet"}
          </span>
        )}
      </button>
    </div>
  );
}
