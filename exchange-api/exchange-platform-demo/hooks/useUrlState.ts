"use client";

/*
 * URL as the terminal's state.
 *
 * Two reasons this exists, and the second is the load-bearing one:
 *
 *   1. A trader can link to, bookmark, and reload a specific market and layout.
 *   2. This project's build-time verification can only check states it can
 *      *address*. Click-scripted setup is fragile, non-reproducible, and
 *      silently drifts as the UI changes — so a manifest enumerates states as
 *      URLs, and every state in it has to be reachable by navigation alone.
 *      Before this hook, all 45 manifest states rendered the same default view
 *      and coverage was a fiction.
 *
 * Read-on-mount, not read-during-render. Reading `location.search` while
 * rendering would make the server and client disagree and trip the hydration
 * floor check. The cost is one frame of default state, which is invisible next to
 * the 400ms settle the capture harness already waits.
 *
 * Writes use replaceState rather than pushState: changing chart view should not
 * put an entry in the trader's back stack. Screen and market changes are the
 * exception and use pushState, because "back" should undo those.
 */

import { useCallback, useEffect, useRef } from "react";

/** Every piece of state the URL carries. All optional; absent means "default". */
export type UrlState = {
  screen?: string;
  market?: string;
  view?: string;
  tab?: string;
  blotter?: string;
  /** Chart timeframe. Addressable for the same reason the view is. */
  tf?: string;
  /**
   * MOBILE ONLY, and the last two pieces of trade-screen state that were not
   * addressable.
   *
   * `pane` is which of chart / book / trades the single mobile viewport is spending
   * itself on; `sheet` is the ticket or account destination over it. Both lived in
   * component state, which meant the capture harness could not reach them — and that
   * is exactly how a completely missing mobile blotter survived every audit until the
   * screen was driven by hand.
   *
   * `stats` is the market header's density toggle — collapsed to the two cells that
   * always fit, or expanded into the reference's paired grid. It was the last piece of
   * mobile state left in `useState`, so the expanded header had no address and no
   * capture graded it. Third time on this project that has been the shape of a bug.
   */
  pane?: string;
  sheet?: string;
  stats?: string;
  /** `quote` when sizes read in the quote asset. Absent means base, which is default. */
  units?: string;
  /**
   * `out` | `pending` | `in` — the session state machine. See lib/session.
   *
   * Addressable on purpose. Connection state used to be nothing at all: the nav pill
   * was a fixture address and the wallet-gated controls carried a hardcoded
   * `aria-disabled`, so "what a logged-out visitor sees" was a comment rather than a
   * state, and no capture could reach it. Three states, three captures.
   */
  session?: string;
  /**
   * The blotter's SECOND level — TWAP's Active/History/Fill History, Account
   * Activity's five views. One key rather than one per tab: only one blotter tab is
   * ever open, so only one sub-view is ever meaningful, and `?blotter=twap&sub=fills`
   * reads better than a key per tab that is null on six of eight.
   *
   * The reference does not do this — its sub-tab state is not in the URL at all, so
   * its deep links are lossy one level down. Not a case for copying.
   */
  sub?: string;
  /**
   * `cold` | `error` — the data phase. See lib/dataphase.
   *
   * Addressable for the reason `session` is. The whole loading and failure layer in
   * components/terminal/states.tsx had never rendered: fixtures are non-empty by
   * construction, so no panel could reach it and no capture could grade it. A layer
   * that exists in the repository and not in the app is a layer nobody knows is
   * broken. `ready` is the default and stays out of the URL.
   */
  load?: string;
  /**
   * The order ticket, as one compact segment — `order=sell:limit:0.5@61240:20x:IOC`.
   *
   * Twenty-two fields behind one key. See lib/draftUrl for the grammar and for why it
   * is one key rather than twenty-two: every key is a parse path and a chance to write
   * a value and never clear it, which is exactly the bug `sub` had.
   */
  order?: string;
  /**
   * `1` opens the deposit modal on arrival.
   *
   * The modal was the last surface in the terminal with no address: it opens from a
   * button on the account card and from the Balances tab, so reaching it meant
   * scripting two clicks, and nothing that cannot be navigated to can be captured or
   * graded. It is also the screen a venue's funding story is actually made of, which
   * is a second reason not to leave it behind a click.
   */
  deposit?: string;
  /**
   * `1` opens the market list on arrival.
   *
   * Same reasoning as `deposit`: it opened from a pill and from a keyboard chord and
   * from nowhere else, so the one screen that shows what a venue LISTS could not be
   * captured or graded. On a phone it is the closest thing this app has to a markets
   * tab, which is the third reason it needed an address.
   */
  markets?: string;
  /** Freezes the clock at this tick. The factory pins it so captures are comparable. */
  tick?: number;
};

const KEYS = ["screen", "market", "view", "tab", "blotter", "sub", "tf", "pane", "sheet", "stats", "units", "session", "load", "order", "deposit", "markets", "tick"] as const;

/** Parse the current query string. Returns {} on the server. */
export function readUrlState(): UrlState {
  if (typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  const out: UrlState = {};
  for (const k of KEYS) {
    const v = q.get(k);
    if (v === null || v === "") continue;
    if (k === "tick") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out.tick = Math.floor(n);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Calls `onRestore` once after mount with whatever the URL specified, then
 * returns a writer that keeps the URL in step with state as it changes.
 */
export function useUrlState(onRestore: (s: UrlState) => void) {
  /*
   * The writer must not run until the restore has been applied.
   *
   * Both live in effects on the same commit: the restore SCHEDULES state updates,
   * and the writer then runs with the state from the render that scheduled it — i.e.
   * the pre-restore defaults — and writes those back over the URL. The symptom was a
   * URL reading `blotter=orders` next to a Positions tab, because the write of
   * `positions` won and the restored value was overwritten before it rendered.
   */
  const restored = useRef(false);
  // A ref so the effect below never re-runs when the caller re-creates the
  // callback — restoring twice would clobber a user's first interaction.
  const restore = useRef(onRestore);
  restore.current = onRestore;

  useEffect(() => {
    const initial = readUrlState();
    if (Object.keys(initial).length > 0) restore.current(initial);
    restored.current = true;

    // Browser back/forward has to re-apply, or navigation silently does nothing.
    const onPop = () => restore.current(readUrlState());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return useCallback((next: UrlState, { push = false }: { push?: boolean } = {}) => {
    if (typeof window === "undefined") return;
    if (!restored.current) return;
    const q = new URLSearchParams(window.location.search);
    for (const k of KEYS) {
      const v = next[k];
      // Undefined means "leave alone"; null-ish or empty means "remove".
      if (v === undefined) continue;
      if (v === "" || v === null) q.delete(k);
      else q.set(k, String(v));
    }
    const url = `${window.location.pathname}?${q.toString()}`;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, []);
}
