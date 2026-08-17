/*
 * Design tokens for the terminal.
 *
 * The terminal is styled with inline styles rather than a CSS framework (same
 * idiom as ../nexus-exchange-landing), so the token layer lives in TypeScript
 * and every component imports from here. Nothing below should be re-typed as a
 * literal inside a component.
 *
 * TENANTS. The semantic colors and the page background are no longer literals:
 * they come from `ACTIVE_TENANT.palette` (lib/tenant.ts), so a branded venue is
 * a config change and not an edit to any of the 32 files that import from here.
 * The exports and their names are unchanged, which is the whole point — a hex
 * inside a component is still a bug, because a palette is config, not a
 * component.
 */

import type { CSSProperties } from "react";

import { ACTIVE_TENANT } from "./tenant";

// ---- typography ----
export const MONO = "var(--font-geist-mono), ui-monospace, monospace";
export const ARCHIVO = "var(--font-archivo), system-ui, sans-serif";

// ---- semantic color (tenant-sourced) ----
/** Bid / long / positive. */
export const GREEN = ACTIVE_TENANT.palette.green;
/** Ask / short / negative. */
export const RED = ACTIVE_TENANT.palette.red;
/** Warning / degraded. */
export const AMBER = ACTIVE_TENANT.palette.amber;

// ---- surfaces, darkest → lightest ----
export const BG = ACTIVE_TENANT.palette.bg;
/** Nav / chrome, sits below the page. */
export const CHROME = "#040404";
/** Table + tape backgrounds. */
export const SUNK = "#060606";
/** Panels raised off the page. */
export const PANEL = "#070707";
/** Inset fields inside a panel. */
export const TERM = "#0b0b0c";
/** Selected nav / tab fill. */
export const SEL = "#0e0e0e";

// ---- lines, faintest → strongest ----
/** Hairline between rows in a table. */
export const L0 = "#111";
/** Divider inside a panel. */
export const L1 = "#161616";
/** Panel border, structural division. */
export const L2 = "#1c1c1c";
/** Corner ticks, active field border. */
export const L3 = "#2a2a2a";

// ---- text, brightest → faintest ----
/** Headings, emphasised numbers. */
export const HI = ACTIVE_TENANT.palette.hi;
/** Body text. */
export const TXT = "#e6e6e6";
/** Numeric values in tables. */
export const NUM = "#cfcfcf";
/** Secondary values. */
export const MUT = "#9a9a9a";
/**
 * Labels, tertiary values.
 *
 * RAISED IN ROUND 2. Was #5e5e5e, which measured 3.0-3.2:1 on our black
 * surfaces — below the WCAG AA 4.5:1 our own director puts in the hard floor.
 * The floor harness found 7,200 failing text nodes across 180 captures, and
 * ~92% of them were this token and FAINT below. Two values, not 7,200 fixes.
 * #858585 measures 5.69:1 on pure black. NOTE: pure black is the BEST case, not
 * the worst — for light-on-dark text a *lighter* surface reduces contrast, so
 * these tokens still fail on the raised surfaces (#141414 chips, #1c1c1c edges)
 * and on the tinted chip backgrounds. The audit reports ~40 remaining offenders
 * per desktop capture, down from ~1,800. Finishing this needs either another step
 * up on the label tier or darker chip fills; see audit/README.md.
 */
export const DIM = "#858585";
/**
 * Inactive tabs, placeholder text.
 *
 * #4a4a4a (2.31:1) -> #757575 -> #7a7a7a. The middle value measured 4.56:1 on pure
 * black and I called it done; the harness then found 120 offenders, all of them this
 * token on #040404 — the nav and status-bar background — at 4.45:1. Failing AA by
 * 0.05. A lighter surface REDUCES contrast for light-on-dark text, so pure black was
 * the best case and I had checked the wrong one. #7a7a7a measures 4.78:1 there.
 */
export const FAINT = "#7a7a7a";

// ---- translucent accents (depth bars, chips, glows) ----
export const GREEN_BAR = "rgba(14,203,129,0.09)";
export const RED_BAR = "rgba(246,70,93,0.10)";
export const GREEN_CHIP = "rgba(14,203,129,0.12)";
export const RED_CHIP = "rgba(246,70,93,0.12)";
export const GREEN_EDGE = "rgba(14,203,129,0.40)";
export const RED_EDGE = "rgba(246,70,93,0.40)";
export const GREEN_WASH = "rgba(14,203,129,0.05)";

/**
 * Text that sits ON a direction fill. White on our red measures 3.53:1 and fails AA;
 * these near-black inks measure 5.3:1 on red and 8.9:1 on green.
 */
export const ON_RED = "#2a0309";
export const ON_GREEN = "#04231a";

// ---- radii ----
/*
 * The corner scale.
 *
 * `R_XS` is new, and it exists because the codebase had already invented it 25 times:
 * an audit found border-radius literals at 1, 2, 3, 4, 6, 8 and 12px scattered across
 * the components, against a four-step scale of 5 / 7 / 11 / 13. Seven ad-hoc values
 * below the smallest scale step is not a scale, it is drift — and at these sizes the
 * difference between 2 and 3 is invisible in isolation and obvious in a row of chips.
 */
export const R_XS = 3;
export const R_SM = 5;
export const R_MD = 7;
export const R_LG = 11;
export const R_XL = 13;

// ---- fixed chrome heights (the terminal is a fixed-viewport app) ----
export const H_NAV = 54;
/**
 * The top bar on a phone.
 *
 * Measured off the reference at 390: its bar occupies y=8→40, so 32px of content in
 * an 8px gutter — 48px of chrome before the page begins, against our 54. Six pixels
 * is not much until you notice the top bar is the only chrome on that screen that
 * never earns its height back: it holds a wordmark, a ticker and an account chip,
 * none of which is what the screen is for.
 *
 * 48, not 32. Their 32px bar sits inside a gutter; ours runs edge to edge, so the
 * comparable number is the whole band. Going to 32 flush would put the account
 * control under the touch floor.
 */
export const H_NAV_COMPACT = 48;
/**
 * The mobile frame.
 *
 * Their phone layout is not edge-to-edge: the screen content is a rounded card inset
 * from the viewport, with the top bar above it and the bottom nav below it, both on
 * the page's black. Measured off `trade.mobile.png` at 390×844 — card left edge x=4,
 * right edge x=386, top y=48 (8px under a bar that ends at 40), bottom y=761 (4px
 * above a nav that starts at 765).
 *
 * It is worth copying for a reason that is not decoration: a card with an edge tells
 * you where the scrollable region ends. Edge-to-edge content that runs under a fixed
 * bar has to be understood, and on a phone that is the difference between a screen
 * that reads as one thing and a screen that reads as a stack.
 *
 * Two files have to agree on these numbers — the shell that draws the frame and the
 * trade screen that sizes itself to exactly one viewport minus the chrome — so they
 * are tokens rather than literals in both.
 */
export const M_FRAME_X = 4;
export const M_FRAME_TOP = 8;
export const M_FRAME_BOTTOM = 4;

export const H_MARKET_HEADER = 64;
export const H_TAB_STRIP = 38;
export const H_PANEL_HEADER = 34;
export const H_BLOTTER = 168;
/**
 * The chart band's fixed height — chart tabs, readout row and plot.
 *
 * Fixed, because the trade screen is RIGID: measured on the reference, its chart is
 * 556px and its blotter 254px at every viewport height from 700 to 1600. Nothing
 * grows, nothing shrinks.
 *
 * 710 = 64 (market header) + 38 (view tabs) + ~30 (OHLC readout) + 556 (plot), which
 * puts our plot on theirs. The whole stack is then 54 + 710 + 168 + 28 = 960 against
 * their ~985, so the height at which the blotter starts to clip is within 25px of
 * the reference's.
 */
export const H_CHART_BAND = 710;

/**
 * The mobile blotter band — tab strip plus a few rows.
 *
 * 168 would be the desktop height; 150 is what 844px has room for once the header,
 * the view toggle, a chart worth looking at, the action bar and the bottom nav have
 * been paid for. The reference's own mobile blotter measures ~150.
 */
export const H_MOBILE_BLOTTER = 150;
/**
 * The mobile chart band.
 *
 * A plot cannot size to its own content, so this is the one region on the phone trade
 * screen with a definite height. It is what the old fixed pane band measured, kept so
 * the chart is the same size it was before the pane and the blotter became one
 * scrolling region.
 */
export const H_MOBILE_PANE = 340;
export const W_BOOK = 264;
export const W_RAIL = 300;

// ---- mobile chrome (the mobile trade screen is a fixed-viewport app too) ----
/**
 * Bottom tab bar. The reference venue's is 390×79 with 73×70 items
 * (audit/reference/findings.responsive.md §1, §4) — a shipped venue spends its
 * whole 44px budget here and nowhere else. Ours is a touch tighter because our
 * status bar stays on at mobile; items still clear TAP_PRIMARY.
 *
 * Treat this as a MINIMUM: BottomNav adds `env(safe-area-inset-bottom)` on top,
 * which is 0 on desktop Chrome and non-zero on a notched phone.
 */
export const H_BOTTOM_NAV = 62;
/** StatusBar's fixed height. Was a literal inside StatusBar; the mobile trade
 *  screen has to subtract it to size itself to exactly one viewport. */
export const H_STATUS_BAR = 26;
/** Buy / Sell / Positions bar pinned under the mobile pane. */
export const H_ACTION_BAR = 58;
/** `Chart | Order Book | Trades` segmented control. Theirs measures 127×39. */
export const H_VIEW_TOGGLE = 40;

// ---- tap-target tiers ----
/**
 * Measured, not aspirational. The reference runs `min 15 · median 35 · max 70`
 * at mobile with 6 of 26 controls reaching 44, and **0 of 52 at tablet**
 * (findings.responsive.md §4). A flat ≥44 is a floor no comparable product
 * meets, and chasing it uniformly costs the density that makes a terminal a
 * terminal. So the target is tiered, not flat:
 *
 *   TAP_PRIMARY  · primary navigation and the submit action — the two things you
 *                  must not miss. This is where the 44px budget goes.
 *   TAP_CONTROL  · segmented controls, tabs, chips — the 36–40 band both we and
 *                  they already sit in (their view toggle 39, ours H_TAB_STRIP 38).
 *   TAP_FLOOR    · hard floor for genuine outliers. Still catches our own 16px
 *                  checkboxes and sub-20px inputs — the same class they get wrong.
 */
export const TAP_PRIMARY = 44;
export const TAP_CONTROL = 38;
export const TAP_FLOOR = 32;

// ---- helpers ----

/** Uppercase mono micro-label — the terminal's most-repeated text style. */
export function monoLabel(size = 9, ls = "0.12em"): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: size,
    letterSpacing: ls,
    color: DIM,
    textTransform: "uppercase",
  };
}

/**
 * The OTHER label voice: things that name a place, not a field.
 *
 * `monoLabel` above is uppercase tracked mono, and it is right for a field name sitting
 * above or beside its value — `MARKET`, `SIZE`, `LAST TRADE`. It marks the text as a
 * key for the number next to it.
 *
 * It was also being used for things that are not field names: the Portfolio page title,
 * card titles, panel titles, the top-nav destinations. Those name a PLACE or a THING,
 * and a place is not a key for anything — which is why the reference sets them in
 * sentence case and why `PORTFOLIO` reads like a column header for a page.
 *
 * One rule, stated once so new surfaces stop having to guess:
 *
 *   monoLabel   — a field name. Uppercase mono. Sits next to the value it names.
 *   titleLabel  — a place or a thing. Sentence case, UI face. Stands on its own.
 */
export function titleLabel(size = 12.5, weight: 500 | 600 | 700 = 600): CSSProperties {
  return {
    fontFamily: ARCHIVO,
    fontSize: size,
    fontWeight: weight,
    letterSpacing: "0.005em",
    color: TXT,
    textTransform: "none",
  };
}

/** Raised "machine" panel — pair with <CornerTicks/> for the ticked variant. */
export function panel(radius = R_LG): CSSProperties {
  return { position: "relative", background: PANEL, border: `1px solid ${L2}`, borderRadius: radius };
}

/** Inset field inside a panel (price boxes, JSON preview, summary rows). */
export function field(radius = R_MD): CSSProperties {
  return { background: TERM, border: `1px solid ${L2}`, borderRadius: radius };
}

/** Sunk table container — headers and rows draw their own hairlines. */
export function table(radius = 12): CSSProperties {
  return { background: SUNK, border: `1px solid ${L2}`, borderRadius: radius, overflow: "hidden" };
}

/** Directional color for a signed value. */
export const sign = (up: boolean) => (up ? GREEN : RED);
