"use client";

import { useEffect, useState } from "react";

/**
 * Matches a media query, defaulting to `false` before mount so SSR and the first
 * client paint agree. The terminal has genuinely different layouts rather than one
 * reflowing one, so this drives layout choice in JS rather than trying to express
 * it in CSS.
 */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/**
 * Three layouts, not two.
 *
 * The old signal was a single boolean breaking at 820, and that was a defect, not
 * a simplification: an 834px tablet fell on the desktop side and got the fixed
 * three-column shell, which at that width leaves `834 − 264 (book) − 300 (rail)`
 * = 270px for the chart column. Measured consequence (UX-PATHS.md "Mobile path
 * integrity"): a **174px price plot**, a market-header stat strip at
 * `clientWidth 0 / scrollWidth 793` — oracle, funding, volume, OI, high and low
 * all in the DOM and unreachable at zero width — a symbol wrapping to three lines
 * and a mark price colliding with the book column. 834 was worse than 390.
 *
 * ┌──────────────┬────────────────────────────────────────────────────────────┐
 * │ mobile       │ `< 640`         one-viewport IA: bottom nav, view toggle,   │
 * │              │                 ticket and positions as sheets             │
 * │ tablet       │ `640 – 1023`    the same IA at tablet proportions — wider   │
 * │              │                 stat grid, side sheet instead of full-screen│
 * │ desktop      │ `≥ 1024`        the fixed three-column shell               │
 * └──────────────┴────────────────────────────────────────────────────────────┘
 *
 * Why 1024 and not 834. The reference treats 834 as *desktop chrome with one
 * substitution* — it keeps the top nav, rail, status bar and footer, and folds the
 * book column into a `Chart | Order Book | Trades` toggle
 * (findings.responsive.md §6). That is the better tablet design and it is the
 * intended end state. But the substitution has to be made in TradeScreen's desktop
 * branch, which is owned elsewhere right now, so this change routes 640–1023 to
 * the mobile IA instead: adapted for the width, and unambiguously better than a
 * 174px chart with an unreachable stat strip. Once the desktop branch can drop the
 * book column on `layout === "tablet"`, move `BP_DESKTOP` down to 768 and the
 * tablet case becomes theirs.
 */
export type LayoutMode = "mobile" | "tablet" | "desktop";

/** Below this, the phone IA. */
export const BP_TABLET = 640;
/** At or above this, the fixed three-column desktop shell. */
export const BP_DESKTOP = 1024;

/**
 * A viewport too short to give the chart and the blotter their full heights.
 *
 * 780px is where the arithmetic runs out, not a round number: nav 54 + market
 * header 64 + chart tabs 38 + a chart worth looking at (~360) + blotter 168 +
 * status bar 28 = 712, and the first ~70px above that is the margin in which the
 * chart is merely cramped rather than unusable.
 *
 * Pre-mount this reads false, so the first paint is the tall layout on both server
 * and client and the collapse happens after mount — same contract as
 * `useLayoutMode`, and the reason no hydration mismatch appears.
 */
export function useShortViewport(): boolean {
  return useMediaQuery("(max-height:780px)");
}

export function useLayoutMode(): LayoutMode {
  const phone = useMediaQuery(`(max-width:${BP_TABLET - 1}px)`);
  const desktop = useMediaQuery(`(min-width:${BP_DESKTOP}px)`);
  // Pre-mount both read false, which lands on "tablet". That is deliberate: it is
  // the middle case, so a first paint at either extreme is one step wrong rather
  // than two, and the mobile IA it belongs to is the one that cannot overflow.
  if (phone) return "mobile";
  return desktop ? "desktop" : "tablet";
}

/**
 * "Not the desktop shell" — the boolean the shell and the three screens still take.
 * Kept working on purpose: everything that consumed `mobile` wanted "is this the
 * alternative IA", and the answer for a 834px tablet is now yes.
 *
 * New code should prefer `useLayoutMode()`, which can tell 390 from 834.
 */
export const useIsMobile = (bp = BP_DESKTOP - 1) => useMediaQuery(`(max-width:${bp}px)`);
