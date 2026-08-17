/*
 * Sub-panes: tabs INSIDE a pane.
 *
 * WHY THIS EXISTS. Analytics wants Flow / Markets / Rejections and Deposits
 * wants Methods / Funnel / Addresses. Without a primitive here, each of those
 * six becomes a sidebar entry, and a sidebar with fourteen items is a sidebar
 * nobody reads — the grouping stops doing the one job navigation has, which is
 * to make the next click obvious. A sub-pane keeps the sidebar at the altitude
 * of "which job am I doing" and puts "which slice of it" one level down, where
 * it belongs.
 *
 * It is also the console's mobile density mechanism (WORKSTREAMS §3f). A pane
 * that is four sections tall on a phone is four sections tall; the same pane
 * behind a tab strip is one, for free, with no layout branch and no second
 * markup path to keep in step.
 *
 * THE SELECTION LIVES IN THE URL, and that is the load-bearing decision rather
 * than a nicety. This codebase's rule — see hooks/useUrlState.ts — is that a
 * state you cannot address is a state nobody grades: the capture harness
 * enumerates states as URLs, so a tab implemented in `useState` is a tab that
 * every audit renders in its default position and reports as covered. It is
 * also what an operator does with a chart that looks wrong, which is paste the
 * link into a thread.
 *
 * NO CLIENT COMPONENT. These are `<Link>`s reading a `searchParams` prop, so
 * the pages that use them stay server components and the sections that are not
 * showing are not rendered — the work is skipped, not hidden with CSS. Every
 * one of the console's other switches (LinkTabs, the env switcher) is built the
 * same way, so there is one mental model for "a control that changes what this
 * page is about" and it survives a failed bundle.
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { DIM, FAINT, HI, L2, R_SM, R_XS, SEL, SUNK, TAP_CONTROL, monoLabel } from "@/lib/theme";
import { SIZE } from "./type";
/* One direction only: this file imports the shell, the shell does not import
   this file. Same acyclic rule parts.tsx follows. */
import { Panel } from "./shell";

export interface SubPaneDef {
  /** The `?tab=` value. Lowercase, no spaces — it is a URL, and it is public. */
  id: string;
  label: string;
  /** Right-aligned inside the tab — a count, or a state word. Use sparingly. */
  badge?: string;
}

/**
 * Which sub-pane the URL asked for, defaulted to the first.
 *
 * Total by construction: an unknown, absent or repeated `?tab=` resolves to the
 * first pane rather than rendering nothing. A console that shows a blank panel
 * because someone truncated a pasted link is a console that looks broken when
 * it is merely unaddressed.
 *
 * The return type is narrowed to the ids you passed, so `active === "flwo"` is
 * a compile error rather than a section that silently never renders — which is
 * the actual bug this signature is here to prevent.
 */
export function resolveSubPane<Id extends string>(
  panes: readonly { readonly id: Id }[],
  raw: string | string[] | undefined,
): Id {
  const want = Array.isArray(raw) ? raw[0] : raw;
  const hit = panes.find((p) => p.id === want);
  return hit ? hit.id : panes[0].id;
}

/**
 * A sub-pane URL, with the page's other query state carried along.
 *
 * `keep` is what stops the tabs from being a trapdoor. Every console page
 * already carries at least `?env=`, and Analytics carries `?range=` as well; a
 * tab link built as a bare `?tab=x` silently drops both, so an operator on live
 * looking at 30 days lands on test looking at 24 hours by clicking a tab. Empty
 * and undefined values are omitted, so defaults stay out of the URL.
 *
 * `tab` is always emitted, including for the first pane. It costs six
 * characters and it means every sub-pane state has one canonical address — the
 * default included — which is what the capture manifest enumerates.
 */
export function subPaneHref(
  pathname: string,
  id: string,
  keep?: Record<string, string | number | undefined | null>,
): string {
  const q = new URLSearchParams({ tab: id });
  for (const [k, v] of Object.entries(keep ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  return `${pathname}?${q.toString()}`;
}

/**
 * The tab strip on its own.
 *
 * Exported separately from `SubPane` because the strip sometimes belongs
 * somewhere the frame does not — in a `PageHead`'s `right` slot when the tabs
 * govern the whole page rather than one panel. Most callers want `SubPane`.
 */
export function SubPaneTabs({
  panes,
  active,
  hrefFor,
  label,
  /** Ties the strip to its panel for assistive tech. `SubPane` supplies it. */
  idPrefix,
}: {
  panes: readonly SubPaneDef[];
  active: string;
  hrefFor: (id: string) => string;
  /** A micro-label to the left, e.g. "VIEW". Omit when the tabs are obvious. */
  label?: string;
  idPrefix?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}>
      {label && <span style={{ ...monoLabel(SIZE.micro), color: FAINT, flexShrink: 0 }}>{label}</span>}
      <div
        /*
         * SCROLLS ITSELF rather than pushing the panel wide. Six tabs of
         * two-word labels is ~330px, which is more than a 375px phone has left
         * after the panel's padding — and Panel clips its overflow, so without
         * this the sixth tab would be unreachable AND invisible to a
         * document-scrollWidth check. The class carries the scroll and hides
         * the bar (globals.css); everything with a resting appearance stays
         * here in the token layer.
         */
        className="nx-subtabs"
        role="tablist"
        aria-label={label ? label.toLowerCase() : "sections"}
        style={{
          display: "flex",
          gap: 3,
          background: SUNK,
          padding: 3,
          borderRadius: R_SM,
          border: `1px solid ${L2}`,
          minWidth: 0,
        }}
      >
        {panes.map((pane) => {
          const on = pane.id === active;
          const style: CSSProperties = {
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            /* floor.json's segmented tier is a 36–40 band and TAP_CONTROL is
               38. A tab strip is the control most often aimed at with a thumb,
               and 9px type alone gives it a 24px box. */
            minHeight: TAP_CONTROL,
            padding: "6px 11px",
            borderRadius: R_XS,
            ...monoLabel(SIZE.micro),
            color: on ? HI : DIM,
            background: on ? SEL : "transparent",
            textDecoration: "none",
            whiteSpace: "nowrap",
            flexShrink: 0,
          };
          return (
            <Link
              key={pane.id}
              href={hrefFor(pane.id)}
              /*
               * role="tab" ON A LINK, and the trade is deliberate. The ARIA
               * authoring pattern expects a roving tabindex driven by arrow
               * keys, which needs JavaScript — and buying arrow keys here would
               * cost this page its server rendering and its no-bundle
               * fallback. What is left is better than the pattern on the axis
               * that matters: every tab is Tab-reachable (a roving tablist
               * exposes exactly one), Enter activates, and the role plus
               * aria-selected is what a screen reader announces. It is a link,
               * so it also opens in a new tab, which a scripted tablist does
               * not.
               */
              role="tab"
              aria-selected={on}
              aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}
              style={style}
            >
              {pane.label}
              {pane.badge && <span style={{ color: FAINT }}>{pane.badge}</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A panel whose header carries a tab strip, and whose body is the active tab.
 *
 * The caller renders only the active section — this component does not hold the
 * sections, it holds the frame. That is what keeps the page a server component
 * doing one section's worth of work instead of three and hiding two.
 *
 * ```tsx
 * const PANES = [
 *   { id: "flow", label: "Flow" },
 *   { id: "markets", label: "Markets" },
 *   { id: "rejections", label: "Rejections" },
 * ] as const;
 *
 * export default async function AnalyticsPage({ searchParams }: {
 *   searchParams: Promise<{ tab?: string; env?: string; range?: string }>;
 * }) {
 *   const { tab, env: rawEnv, range } = await searchParams;
 *   const env = resolveEnv(rawEnv);
 *   const pane = resolveSubPane(PANES, tab);   // typed: "flow" | "markets" | "rejections"
 *
 *   return (
 *     <SubPane
 *       title="Order flow"
 *       blurb="Routed notional, by market and by rejection reason."
 *       panes={PANES}
 *       active={pane}
 *       hrefFor={(id) => subPaneHref("/admin/analytics", id, { env: env === "live" ? "live" : undefined, range })}
 *     >
 *       {pane === "flow" && <FlowSection />}
 *       {pane === "markets" && <MarketsSection />}
 *       {pane === "rejections" && <RejectionsSection />}
 *     </SubPane>
 *   );
 * }
 * ```
 *
 * Two rules for consuming it, both learned the expensive way on this project:
 * pass `env` (and any other query state) through `subPaneHref`'s `keep`, or the
 * tabs quietly reset it; and give each pane a section that is worth a click —
 * a tab holding one figure is a tab that should have been a row.
 */
export function SubPane({
  panes,
  active,
  hrefFor,
  title,
  blurb,
  tabsLabel,
  /** Anything that belongs beside the tabs — a range picker, a provenance badge. */
  right,
  children,
}: {
  panes: readonly SubPaneDef[];
  active: string;
  hrefFor: (id: string) => string;
  title?: string;
  blurb?: string;
  tabsLabel?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  /* Stable across renders and unique per pane group, because it is derived from
     the ids rather than from a counter — a counter would differ between the
     server and the client render and trip the hydration floor check. */
  const idPrefix = `subpane-${panes.map((p) => p.id).join("-")}`;
  return (
    <Panel
      title={title}
      blurb={blurb}
      right={
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
          <SubPaneTabs panes={panes} active={active} hrefFor={hrefFor} label={tabsLabel} idPrefix={idPrefix} />
          {right}
        </div>
      }
    >
      {/*
        * `aria-labelledby` is deliberately absent: it would have to point at the
        * selected tab, and with no roving tabindex the tab that is selected is
        * not the tab that has focus. The panel's own heading is the honest
        * label, and the tabs already announce their own state.
        */}
      <div id={`${idPrefix}-panel`} role="tabpanel" style={{ minWidth: 0 }}>
        {children}
      </div>
    </Panel>
  );
}
