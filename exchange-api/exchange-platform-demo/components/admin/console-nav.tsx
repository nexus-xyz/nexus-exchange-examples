"use client";

/*
 * The sidebar, and the only part of the console that has to run in the browser.
 *
 * WHY THIS FILE EXISTS AT ALL. The shell moved into `app/admin/layout.tsx` so
 * that a navigation replaces the content column and not the whole console — the
 * sidebar now persists across a route change instead of being unmounted and
 * rebuilt by every page and by the loading boundary in between. But an App
 * Router layout is handed only `children` and `params`. It is NOT handed
 * `searchParams`, and this console's environment lives in `?env=live`. Probed
 * empirically, not assumed: a layout that tries to read the query gets nothing.
 *
 * So the two things that genuinely depend on the URL — which row is current,
 * and which network you are on — read it from the client, where `usePathname`
 * and `useSearchParams` exist. Everything else in the sidebar is static text
 * (the wordmark, the section headings, the operator's legal entity) and stays on
 * the server: `head` and `foot` arrive as already-rendered ReactNode props from
 * the server layout, which a client component may render but never re-executes.
 *
 * The client surface is therefore exactly: the nav link list, the environment
 * switcher, and the `data-env` attribute the narrow-width CSS keys off. That
 * last one is why the `<aside>` itself is here rather than in the server
 * component — the amber live edge and the mobile layout branch are properties of
 * this element, and moving them out would mean either a second element to carry
 * the flag or a `:has()` rule in globals.css to infer it from a descendant.
 *
 * The bundle cost is close to zero. `error.tsx` is a client component that
 * imports the shell, so this module's tokens and type scale were already being
 * shipped; what is new is one `useEffect` and two hooks.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  AMBER,
  CHROME,
  DIM,
  FAINT,
  GREEN,
  HI,
  L1,
  L2,
  MUT,
  ON_RED,
  R_SM,
  R_XS,
  SEL,
  SUNK,
  TAP_CONTROL,
  TAP_PRIMARY,
  monoLabel,
  titleLabel,
} from "@/lib/theme";
import { SIZE, body } from "./type";
import { Dot } from "./parts";
/* TYPE-ONLY, so this stays acyclic at runtime: shell.tsx imports this file's
   component, and TypeScript erases this import entirely. Same one-direction rule
   parts.tsx and subpane.tsx follow. */
import type { NavItem } from "./shell";

export interface NavGroup {
  section: string;
  items: NavItem[];
}

export function ConsoleSidebar({
  groups,
  head,
  foot,
}: {
  groups: NavGroup[];
  /** The wordmark block. Server-rendered by the layout and passed through. */
  head: ReactNode;
  /** "Operated by", the entity, the way back to the terminal. Also server-rendered. */
  foot: ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  /* Anything that is not exactly "live" is test — the same resolution
     `resolveEnv` does on the server, erring the same way. */
  const env: "test" | "live" = search.get("env") === "live" ? "live" : "test";
  const live = env === "live";

  /*
   * THE ENVIRONMENT SWITCH NOW KEEPS THE WHOLE QUERY, which it could not do
   * before. Every page used to hand the shell its own `envHref`, and the five
   * tabbed panes each had to remember to thread `?tab=` (and Analytics `?range=`)
   * through it by hand — five copies of one rule, each of which was one edit away
   * from silently dropping a tab on an environment switch. Reading the live
   * query here makes the rule structural: flip `env`, keep everything else.
   */
  const envHref = (next: "test" | "live") => {
    const params = new URLSearchParams(search.toString());
    if (next === "live") params.set("env", "live");
    else params.delete("env");
    const q = params.toString();
    return q ? `${pathname}?${q}` : pathname;
  };

  return (
    <aside
      className="nx-sidebar"
      /* The environment is on the element rather than only in the render, so
         the narrow-width rules can keep the LIVE warning prose and drop the
         TEST reassurance without either one being duplicated in CSS. */
      data-env={env}
      style={{
        width: 232,
        flexShrink: 0,
        borderRight: `1px solid ${L2}`,
        background: CHROME,
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 0,
        height: "100dvh",
        overflowY: "auto",
        /*
         * WHERE LIVE IS FELT RATHER THAN LABELLED.
         *
         * Test and live were two words in a control that looked like a toggle and
         * behaved like a caption, and nothing else on the screen changed between
         * them. On this platform the difference is play money versus real money,
         * so it has to be a property of the room, not a field in it: on live the
         * whole chrome edge carries the warning colour, so an operator cannot be
         * looking at any part of this console without it being in frame.
         *
         * One edge, not a wash. A tinted console would fight every status colour
         * on the page and would stop being noticed within an hour, which is the
         * failure mode of every "environment banner" ever shipped.
         */
        boxShadow: live ? `inset 3px 0 0 ${AMBER}` : "none",
      }}
    >
      {head}
      <EnvSwitcher env={env} envHref={envHref} />
      <ConsoleNav groups={groups} pathname={pathname} live={live} />
      {foot}
    </aside>
  );
}

/**
 * Is this nav entry the one you are on?
 *
 * Exact for `/admin`, prefix for everything else — otherwise Overview would be
 * current on every page in the console, since its href is a prefix of them all.
 * The prefix half is what makes `/admin/markets/BTC-USDX-PERP` light up Markets:
 * a drill-down is inside its index, and before the index existed that pathname
 * matched nothing and the strip claimed you were nowhere.
 */
function isCurrent(href: string, pathname: string): boolean {
  return pathname === href || (href !== "/admin" && pathname.startsWith(`${href}/`));
}

function ConsoleNav({ groups, pathname, live }: { groups: NavGroup[]; pathname: string; live: boolean }) {
  const strip = useRef<HTMLElement | null>(null);

  /*
   * BELOW 860px THIS LIST IS THE PHONE'S NAV STRIP — one horizontal scroller
   * holding eleven destinations (globals.css turns the column into a row). The
   * scroller opens at scrollLeft 0, so on `/admin/keys` at 375 the current entry
   * sat off-screen right and the console opened looking like Overview: the one
   * job navigation has, saying where you are, failed on the width where it
   * matters most.
   *
   * This was deferred once because the shell was a server component and the fix
   * needed either a client boundary or reordering the strip per page — and a nav
   * whose order changes between pages is a nav you cannot build muscle memory
   * for, which is a worse defect than the one it fixes. The layout refactor
   * bought the client boundary, so the honest fix is now four lines.
   *
   * scrollLeft, NOT scrollIntoView. `scrollIntoView` walks every scrollable
   * ancestor including the document, so on a page taller than the viewport it
   * would also scroll the operator down to the strip. This touches one axis of
   * one element, and only when that element actually scrolls — on desktop the
   * guard is false and nothing happens.
   */
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth) return;
    const current = el.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!current) return;
    /* Centre it where there is room, clamped to the ends — an item scrolled
       flush to the left edge reads as the first item in the list. */
    const target = current.offsetLeft - (el.clientWidth - current.offsetWidth) / 2;
    el.scrollLeft = Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth));
  }, [pathname]);

  return (
    <nav
      ref={strip}
      className="nx-sidenav"
      style={{ padding: "6px 8px 14px", display: "flex", flexDirection: "column", gap: 12, flex: 1 }}
    >
      {groups.map((group) => (
        <div key={group.section} className="nx-navgroup" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="nx-navsection" style={{ ...monoLabel(SIZE.micro), color: FAINT, padding: "8px 8px 3px" }}>
            {group.section.toUpperCase()}
          </span>
          {group.items.map((item) => {
            const on = isCurrent(item.href, pathname);
            /*
             * THE ENVIRONMENT TRAVELS WITH THE CLICK.
             *
             * Measured, not theorised: from live Overview, clicking Analytics
             * landed on TEST Analytics, because the nav href was a bare
             * pathname and every page defaults to test. Silent, one click
             * deep, and on the one distinction this console spends its whole
             * warning budget on — an operator checking a live number was
             * being shown a testnet one with no cue that anything had
             * changed, except an amber edge disappearing that they had no
             * reason to be watching.
             *
             * Only `env` travels, never the rest of the query: `?tab=` and
             * `?range=` belong to the pane you are leaving, and carrying them
             * across would land you on another pane's tab that does not exist.
             * The environment switcher above keeps them, because it is the one
             * control that changes the network without changing the question.
             */
            const href = live ? `${item.href}?env=live` : item.href;
            return (
              <Link
                key={item.href}
                href={href}
                /* The active row was marked twice visually and zero times
                   semantically — a screen reader heard eight identical
                   links. The env switcher has carried aria-current since it
                   was built; the primary navigation should not be the one
                   place that does not. */
                aria-current={on ? "page" : undefined}
                className={on ? undefined : "nx-nav"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "7px 9px",
                  /*
                   * THE CONSOLE'S PRIMARY NAVIGATION, so it carries the 44px
                   * budget — this project's tap-target floor spends the whole
                   * nav tier here. Below
                   * 860px this same list IS the phone's nav strip (globals.css
                   * turns it horizontal), and 7px of padding around 14px of type
                   * left a 28px row: a destination you aim a thumb at, sized like
                   * a caption. The height is stated rather than left to the
                   * padding so it cannot drift when the type scale moves.
                   */
                  minHeight: TAP_PRIMARY,
                  borderRadius: R_SM,
                  background: on ? SUNK : "transparent",
                  /*
                   * Still marked twice — fill AND an edge — so the active row
                   * survives a low-contrast display. The edge is a full hairline
                   * ring in the neutral line colour, not a 2px accent stripe down
                   * the left.
                   *
                   * The stripe was the single most generic thing in this console.
                   * A coloured left rail on the selected nav item is the default
                   * every template ships with, it fights the tenant palette (on a
                   * cyan venue it read as a random cyan tick), and it spent the
                   * brand accent on "you are here" — which the fill and the ink
                   * weight already say. An inset ring costs no layout and reads as
                   * a selected surface rather than as a decoration applied to one.
                   */
                  boxShadow: on ? `inset 0 0 0 1px ${L2}` : "none",
                  textDecoration: "none",
                  ...titleLabel(SIZE.body, on ? 600 : 500),
                  color: on ? HI : MUT,
                }}
              >
                <span>{item.label}</span>
                {item.badge && <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>{item.badge}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * Test versus live.
 *
 * WHAT CHANGED AND WHY. This was two `<span>`s. It had the fill, the border and the
 * inset of a segmented control, so it read as the loudest control on the screen —
 * and it was not a control at all, because every page passed `env="test"` and
 * nothing was clickable. A dead switch on the one distinction that separates play
 * money from real money is worse than no switch: an operator who has learned that
 * this control does nothing has learned to ignore the only place the console tells
 * them which network they are on.
 *
 * So the selected side is now a SOLID plate with dark ink on it, not a 13%-alpha
 * tint. Two reasons. It is the strongest available statement of "you are here" at
 * this size, and the ink flip means the two states cannot be confused at a glance
 * across a room — a tinted TEST and a tinted LIVE differ only in hue, which is the
 * one cue a colour-blind operator does not have.
 *
 * The unselected side stays a plain link. It is a destination, not a peer state.
 */
function EnvSwitcher({
  env,
  envHref,
}: {
  env: "test" | "live";
  envHref: (env: "test" | "live") => string;
}) {
  const live = env === "live";
  return (
    <div
      className="nx-envswitch"
      style={{
        padding: "12px 12px 11px",
        borderBottom: `1px solid ${L1}`,
        background: live ? `${AMBER}0a` : "transparent",
      }}
    >
      <span className="nx-envlabel" style={{ ...monoLabel(SIZE.micro), color: FAINT, display: "block", marginBottom: 7 }}>
        ENVIRONMENT
      </span>
      <div style={{ display: "flex", gap: 3, background: SUNK, padding: 3, borderRadius: R_SM, border: `1px solid ${L2}` }}>
        {(["test", "live"] as const).map((e) => {
          const on = e === env;
          /*
           * THE TWO SELECTED STATES ARE NOT SYMMETRICAL, and the first attempt at
           * this got it backwards. Giving both sides a solid plate made TEST a bright
           * green slab — the calm state shouting and the dangerous one merely tinted.
           * Loudness has to track consequence: selected TEST is a quiet raised plate
           * with a green dot, selected LIVE is a solid amber slab with dark ink on it.
           * A screenshot of the console tells you which network it was taken on
           * without anybody having to read a word.
           */
          const solid = on && e === "live";
          const style: CSSProperties = {
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            padding: "6px 0",
            /* A segmented control, so it sits in this project's 36–40px
               tap-target band rather than at the 24px its type alone produced.
               This one decides play
               money versus real money — it is the last control on the console
               that should be hard to hit on a phone. */
            minHeight: TAP_CONTROL,
            borderRadius: R_XS,
            background: solid ? AMBER : on ? SEL : "transparent",
            ...monoLabel(SIZE.micro),
            /* Near-black ink on the fill: white on our amber measures under 4.5:1,
               and ON_RED is the token that clears it (lib/theme.ts). */
            color: solid ? ON_RED : on ? HI : DIM,
            textDecoration: "none",
            cursor: on ? "default" : "pointer",
          };
          const label = e.toUpperCase();
          const inner = (
            <>
              {on && !solid && <Dot color={GREEN} />}
              {label}
            </>
          );
          return !on ? (
            <Link key={e} href={envHref(e)} style={style}>
              {inner}
            </Link>
          ) : (
            <span key={e} aria-current="true" style={style}>
              {inner}
            </span>
          );
        })}
      </div>
      {/* WHICH BOOK YOU ARE POINTED AT, in one line. On a phone this paragraph is
          three lines above the fold and the TEST line is the one a narrow viewport
          can afford to lose — the two environments keep separate balances and
          separate keys, so on LIVE the line stays (globals.css, keyed off the
          sidebar's data-env). */}
      <p className="nx-envnote" style={{ ...body(SIZE.note, 1.5), color: FAINT, margin: "8px 0 0" }}>
        {live ? (
          <span style={{ color: AMBER }}>Mainnet. Orders route to the live book and settle against real collateral.</span>
        ) : (
          "Testnet — test USDX, its own balances and its own keys."
        )}
      </p>
    </div>
  );
}
