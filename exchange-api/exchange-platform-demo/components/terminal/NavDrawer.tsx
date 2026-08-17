"use client";

/*
 * The mobile navigation drawer — behind the wordmark.
 *
 * From `audit/reference/shots/responsive/mobile.drawer.mobile.png`, captured from their
 * venue: tapping the logo on a phone does not go home, it opens a left drawer holding
 * the primary destinations, the venue's status dots, secondary links and the build
 * version. The rest of the screen dims.
 *
 * Two reasons this is worth having beyond parity.
 *
 * First, the wordmark on a phone was a link to `/` — a 71px target that reloads the app
 * and loses your market. That is not a destination, it is a way to lose your place.
 *
 * Second, it re-homes something we deleted. The `TESTNET · WEBSOCKET` strip was dropped
 * from mobile because it was 24px of permanent chrome saying something that never
 * changes — but "which network am I on" is not worthless, it is just not worth a
 * permanent row. Theirs puts exactly that here, one tap away and out of the way, which
 * is the right home for it. Support / Docs / Terms / Privacy likewise: our desktop keeps
 * them in a footer that mobile has no room for.
 */

import { useEffect, useRef, useState } from "react";
import { SCREENS, type Screen } from "./TopNav";
import {
  ARCHIVO,
  CHROME,
  DIM,
  FAINT,
  GREEN,
  HI,
  L1,
  L2,
  MONO,
  MUT,
  PANEL,
  RED,
  TXT,
  TAP_PRIMARY,
  H_NAV_COMPACT,
  monoLabel,
} from "@/lib/theme";
import type { Session } from "@/lib/session";

/** The venue's own state. Dots, because a word plus a colour reads faster than either. */
const STATUS = [
  { label: "Testnet", tone: GREEN },
  { label: "WebSocket", tone: GREEN },
] as const;

const LINKS = ["Support", "Docs", "Terms", "Privacy"] as const;

/** Must match `nx-drawer-out` in globals.css. Unmounting early cuts the slide off. */
const DRAWER_EXIT_MS = 190;

export function NavDrawer({
  open,
  onClose,
  screen,
  onScreen,
  session,
}: {
  open: boolean;
  onClose: () => void;
  screen: Screen;
  onScreen: (s: Screen) => void;
  session: Session;
}) {
  /*
   * `exiting` keeps the drawer mounted for the length of its own close.
   *
   * Without it React unmounts on the click and there is nothing left to animate — the
   * panel disappeared in one frame while its scrim went on fading for another 180ms,
   * so the two halves of a single dismissal came apart. Same flag, same reason, as the
   * market sheet in MarketSwitcher.
   *
   * `open` stays the logical state; this is presentation only. The timer is cleared on
   * unmount and on re-open, so tapping the wordmark again mid-close cancels the exit
   * rather than firing a stale hide behind the new drawer.
   */
  const [exiting, setExiting] = useState(false);
  const dismissRef = useRef<() => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    if (open) {
      clear();
      setExiting(false);
    }
    return clear;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Dismiss, then unmount. Reduced motion skips straight to the unmount, because the
     keyframes are neutralised globally and the wait would be a wait for nothing. */
  const dismiss = () => {
    if (reduced) {
      onClose();
      return;
    }
    if (exiting) return;
    setExiting(true);
    clear();
    timer.current = setTimeout(() => {
      setExiting(false);
      onClose();
    }, DRAWER_EXIT_MS);
  };

  /* Escape dismisses — a drawer covering most of the screen needs it, and it costs
     nothing to bind. Through a ref because `dismiss` is redefined every render and a
     listener rebound on every render is a listener that can miss a keypress between
     the remove and the add. */
  dismissRef.current = dismiss;

  if (!open && !exiting) return null;

  return (
    <>
      <div
        onClick={dismiss}
        aria-hidden="true"
        className={reduced ? undefined : exiting ? "nx-scrim-exit" : "nx-scrim"}
        style={{ position: "fixed", inset: 0, zIndex: 48, background: "rgba(0,0,0,0.6)" }}
      />
      <nav
        aria-label="Site"
        className={reduced ? undefined : exiting ? "nx-drawer-exit" : "nx-drawer"}
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          left: 0,
          /* Half the screen, as theirs. Wide enough for the destinations to be a list
             you read rather than a column you decipher; narrow enough that the app
             behind it is visibly still there. */
          width: "62%",
          maxWidth: 300,
          zIndex: 49,
          display: "flex",
          flexDirection: "column",
          background: PANEL,
          borderRight: `1px solid ${L2}`,
        }}
      >
        {/* The wordmark again, on a raised header — theirs does this, and it is what
            tells you the drawer belongs to the thing you tapped. */}
        <div
          style={{
            flex: "0 0 auto",
            height: H_NAV_COMPACT,
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            background: CHROME,
            borderBottom: `1px solid ${L2}`,
          }}
        >
          <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: 15, letterSpacing: "0.2em", color: HI }}>
            NEXUS
          </span>
        </div>

        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "18px 0" }}>
          {SCREENS.map((s) => {
            const on = s === screen;
            return (
              <button
                key={s}
                onClick={() => {
                  onScreen(s);
                  dismiss();
                }}
                aria-current={on ? "page" : undefined}
                style={{
                  display: "block",
                  width: "100%",
                  minHeight: TAP_PRIMARY,
                  padding: "0 18px",
                  border: "none",
                  background: "transparent",
                  /* Large and sentence case. These are places, and theirs sets them at
                     roughly 22px — a drawer is read at arm's length with a thumb over
                     half of it. */
                  fontFamily: ARCHIVO,
                  fontSize: 21,
                  fontWeight: on ? 600 : 400,
                  color: on ? GREEN : MUT,
                  textAlign: "left",
                  textTransform: "capitalize",
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                {s}
              </button>
            );
          })}
        </div>

        {/* The venue's state, re-homed. This is what the deleted mobile status bar
            said, one tap away instead of 24px of permanent chrome. */}
        <div style={{ flex: "0 0 auto", padding: "0 18px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
          {STATUS.map((s) => (
            <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.tone, boxShadow: `0 0 6px ${s.tone}` }} />
              <span style={{ fontFamily: ARCHIVO, fontSize: 12.5, color: MUT }}>{s.label}</span>
            </span>
          ))}
          <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: session === "in" ? GREEN : RED,
                boxShadow: `0 0 6px ${session === "in" ? GREEN : RED}`,
              }}
            />
            <span style={{ fontFamily: ARCHIVO, fontSize: 12.5, color: MUT }}>
              {session === "in" ? "Wallet connected" : "Wallet disconnected"}
            </span>
          </span>
        </div>

        <div style={{ flex: "0 0 auto", borderTop: `1px solid ${L1}`, padding: "12px 18px" }}>
          {LINKS.map((l) => (
            <button
              key={l}
              /* Inert, and honestly so: there is no Support desk or Docs site behind a
                 mock. A link that 404s is worse than one that says it is a placeholder,
                 so these carry the endpoint they would reach rather than pretending. */
              title={`${l} — external, not part of this mock`}
              style={{
                display: "block",
                width: "100%",
                /* 44, not the 36 a secondary link looks like it wants: these sit inside
                   a `nav`, so the tap-target floor grades them at the navigation tier —
                   and it is right to. A footer link in a drawer is still a thumb
                   target, and it has three neighbours 8px away. */
                minHeight: TAP_PRIMARY,
                padding: 0,
                border: "none",
                background: "transparent",
                fontFamily: ARCHIVO,
                fontSize: 13,
                color: DIM,
                textAlign: "left",
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {l}
            </button>
          ))}
        </div>

        <div style={{ flex: "0 0 auto", borderTop: `1px solid ${L1}`, padding: "11px 18px", ...monoLabel(9, "0.06em") }}>
          <span style={{ color: FAINT }}>BUILD</span> <span style={{ color: MUT, fontFamily: MONO }}>19d0b</span>
        </div>
      </nav>
    </>
  );
}
