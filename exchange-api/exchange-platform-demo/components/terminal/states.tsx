"use client";

/*
 * The state layer: empty, loading, error, stale, and absent-value.
 *
 * Every other panel in this terminal assumes populated data, because the mock
 * fixtures are non-empty by construction. That is the single biggest thing
 * standing between us and the live venue, whose account routes return per-field
 * `*_error` strings, a hardcoded `liquidation_price` of "0", and a null leverage
 * (see lib/api/README.md § Divergences and lib/api/absence.ts § THE ABSENCE
 * INVENTORY). Absence has to be *renderable* before it can be *fetched*.
 *
 * The geometry of the empty case is taken from the reference study
 * (audit/reference/findings.blotter.md §3), because it got it right:
 *
 *   • the caller renders the FULL header row at its final widths — the table's
 *     skeleton is the same object whether it has rows or not, so nothing
 *     re-negotiates width at populate time and nothing jumps;
 *   • beneath it, exactly ONE centred line of ~13px mid-grey text;
 *   • no icon, no illustration, no card, no border, no dashed outline, no
 *     skeleton rows, no zebra ghosts, no secondary line, no "learn more".
 *
 * What we do NOT take is their copy. "Connect wallet to view balances" describes
 * a gate, and every one of their captures was logged out, so their single case is
 * only the first of the three we actually have to draw: empty because you have
 * none, empty because we could not load it, and stale. Our copy names the real
 * condition — "No open positions" — and lives in EMPTY_COPY below.
 *
 * One deliberate departure, flagged in the same finding as their obvious miss:
 * their empty state has no affordance to resolve itself. `EmptyState` takes an
 * OPTIONAL single ghost action, used only where an action genuinely exists
 * (an empty watchlist can be filled; an empty fills table cannot).
 */

import { CSSProperties, ReactNode } from "react";
import {
  R_XS,
  ARCHIVO,
  MONO,
  AMBER,
  L1,
  L2,
  L3,
  TERM,
  TXT,
  MUT,
  DIM,
  FAINT,
  RED,
  R_SM,
  monoLabel,
} from "@/lib/theme";
import { ABSENT_GLYPH, isAbsent, render, type Formatter, type Freshness, type Maybe } from "@/lib/api/absence";

// ────────────────────────────────────────────────────────────────── empty

/**
 * Sizes for the one centred line. 13px regular sans, and FAINT rather than DIM
 * because the reference's line is "noticeably dimmer than the header labels" —
 * our header labels are `monoLabel()`, which is DIM.
 */
const EMPTY_SIZE = 13;

/**
 * The empty state: one centred line, nothing else.
 *
 * The caller renders the header row above this and gives this the remaining
 * height. `minHeight` exists because the blotter is a fixed-height region
 * (`H_BLOTTER`) while the portfolio tables grow — a table that flexes passes
 * nothing and lets `flex: 1` do the work.
 *
 * NOTE ON THE REFERENCE'S BUG we are not copying: on their two-level tabs the
 * message is pushed down by the sub-tab strip and gets clipped by the status bar.
 * Centring here is within the box the caller hands us, so a sub-strip shrinks the
 * box instead of displacing the text.
 */
export function EmptyState({
  message,
  minHeight,
  action,
  align = "center",
}: {
  /** Sentence case, no terminal period. Prefer a key from EMPTY_COPY. */
  message: string;
  minHeight?: number;
  /** Optional single ghost action — the affordance the reference omits. */
  action?: { label: string; onClick: () => void };
  /**
   * `center` centres in the box (the reference's geometry). `top` pins the line
   * just under the header row, for a short list region where vertical centring
   * would read as a layout accident.
   */
  align?: "center" | "top";
}) {
  return (
    <div
      // `status` (not `alert`): this is a steady-state description of the region,
      // not an interruption. Without a role the line is an orphan string to a
      // screen reader walking a grid of columnheaders with no rows.
      role="status"
      style={{
        flex: 1,
        minHeight,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: align === "center" ? "center" : "flex-start",
        gap: 10,
        padding: align === "center" ? "12px 16px" : "26px 16px",
        // No background, no border: the body stays uniform panel background edge
        // to edge. Anything else turns signage into a card.
      }}
    >
      <span style={{ fontFamily: ARCHIVO, fontSize: EMPTY_SIZE, fontWeight: 400, color: FAINT, textAlign: "center" }}>
        {message}
      </span>
      {action && <GhostButton label={action.label} onClick={action.onClick} />}
    </div>
  );
}

/**
 * Per-surface empty copy.
 *
 * Structure borrowed from the reference — one line, per-surface, sentence case,
 * no period, and a qualifier only where the surface has a history counterpart
 * ("open orders" vs "order history", their "active TWAP orders" rule). Words are
 * ours: these describe a genuinely empty account on a venue you are already
 * authenticated to, which is the state their logged-out captures could never show.
 */
/*
 * NO "YET".
 *
 * Four of these used to end in it — "No fills yet", "No order history yet". It reads
 * as reassurance and it is a promise the venue cannot make: "yet" asserts that a row
 * is coming. The reference never says it on any of its ten tabs, and the connected-
 * and-empty pass confirmed the whole set (findings.portfolio.md §4). Their nouns are
 * adopted with it: `No trades`, not `No fills`.
 */
export const EMPTY_COPY = {
  // blotter tabs
  positions: "No open positions",
  orders: "No open orders",
  fills: "No trades",
  // history surfaces (the counterparts that justify "open"/"working" above)
  orderHistory: "No order history",
  closedPositions: "No closed positions",
  fundingHistory: "No funding payments",
  twap: "No active TWAP orders",
  // account surfaces
  balances: "No balances",
  transfers: "No account activity",
  equityHistory: "No equity history",
  apiKeys: "No API keys",
  // market-data surfaces
  book: "No resting orders in this book",
  tape: "No trades",
  candles: "No price history for this timeframe",
  fundingCurve: "No funding samples",
  // navigation surfaces
  marketSearch: "No markets match this search",
  watchlist: "No markets in your watchlist",
  commandPalette: "No matching commands",
} as const;

export type EmptySurface = keyof typeof EMPTY_COPY;

/**
 * Copy lookup. `filter` names the active filter when one is narrowing the table.
 *
 * The reference does this on exactly the two tabs that carry a filter: "No open
 * orders matching All Orders." is a different message from "you have no orders", and
 * it is the one that stops a trader hunting for rows a filter is hiding. We shipped
 * the filters and not this.
 */
export const emptyCopy = (surface: EmptySurface, filter?: string): string =>
  filter ? `${EMPTY_COPY[surface]} matching ${filter}.` : EMPTY_COPY[surface];

// ───────────────────────────────────────────────────────────────── loading

/**
 * Table-level loading.
 *
 * Deliberately NOT skeleton rows. The reference bans ghost rows in the empty
 * state and the same reasoning applies harder here: fake rows at fake widths in a
 * numeric table read as data for the ~120ms before they are replaced, and a
 * trader who reads a fake number once stops trusting every real one. So: the same
 * single centred line as `EmptyState`, in the same position, pulsing gently via
 * the existing `nxpulse` keyframe (which `prefers-reduced-motion` already
 * neutralises globally in app/globals.css).
 *
 * Our fixtures are synchronous, so this is for the live path only.
 */
export function LoadingState({
  message = "Loading",
  minHeight,
}: {
  message?: string;
  minHeight?: number;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      style={{
        flex: 1,
        minHeight,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px 16px",
      }}
    >
      <span
        style={{
          ...monoLabel(10, "0.12em"),
          color: FAINT,
          animation: "nxpulse 1.8s ease-in-out infinite",
        }}
      >
        {message}
      </span>
    </div>
  );
}

/**
 * Single-figure loading — a flat bar sized in `ch`, for a stat cell or a header
 * figure while its first response is in flight.
 *
 * `ch` not px: the terminal's figures are mono, so a bar measured in characters
 * occupies exactly the width the number will, and the surrounding layout does not
 * shift when the value lands. That is the whole reason this is not a spinner.
 */
export function LoadingFigure({ chars = 6, height = 11 }: { chars?: number; height?: number }) {
  return (
    <span
      aria-busy="true"
      style={{
        display: "inline-block",
        width: `${chars}ch`,
        height,
        verticalAlign: "middle",
        borderRadius: R_XS,
        background: L1,
        animation: "nxpulse 1.8s ease-in-out infinite",
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────── error

/**
 * Panel-level failure.
 *
 * Three things, in this order: what failed in plain language, the endpoint and
 * status so it is reportable without a devtools session, and a retry. The
 * endpoint line is the difference between "something went wrong" and a bug report
 * — `GET /positions · 503` is actionable, a sad face is not.
 *
 * Field-level failures do NOT come here; they render as `<AbsentValue/>` in place,
 * because one bad row must degrade that row and not the panel
 * (lib/api/adapter.ts principle 1, repo AGENTS.md rule 9).
 */
export function ErrorState({
  message = "Could not load this panel",
  endpoint,
  status,
  onRetry,
  minHeight,
}: {
  message?: string;
  /** e.g. "GET /positions". Shown verbatim, mono. */
  endpoint?: string;
  /** HTTP status, when there was one. 429 and 5xx are the retriable ones. */
  status?: number;
  onRetry?: () => void;
  minHeight?: number;
}) {
  return (
    <div
      // `alert`: unlike empty and loading, this one is an interruption — the user
      // asked for data and did not get it.
      role="alert"
      style={{
        flex: 1,
        minHeight,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 9,
        padding: "12px 16px",
        textAlign: "center",
      }}
    >
      <span style={{ fontFamily: ARCHIVO, fontSize: EMPTY_SIZE, fontWeight: 400, color: MUT }}>{message}</span>
      {(endpoint || status !== undefined) && (
        <span style={{ ...monoLabel(10, "0.06em"), color: FAINT, textTransform: "none" }}>
          {[endpoint, status !== undefined ? String(status) : null].filter(Boolean).join(" · ")}
        </span>
      )}
      {onRetry && <GhostButton label="Retry" onClick={onRetry} />}
    </div>
  );
}

/**
 * The one shared button in this file: a mono micro-label in a hairline box.
 *
 * Not imported from primitives.tsx because there is no button primitive there —
 * every existing button is inline. This keeps the two we need identical, and it is
 * the same detailing as the blotter's CANCEL ALL (hairline L2, transparent fill,
 * 10px mono) so it reads as chrome rather than as a call to action.
 */
function GhostButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="nx-hover-border"
      style={{
        border: `1px solid ${L2}`,
        borderRadius: R_SM,
        background: "transparent",
        color: MUT,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding: "4px 10px",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────── stale

/**
 * Stale marker for a single figure.
 *
 * Staleness is a real venue condition, not an error: the API exposes `is_stale`,
 * and when the mark or oracle stops updating the LAST KNOWN price is still the
 * best information available — much better than `—`. So the figure renders
 * normally and this sits beside it.
 *
 * AMBER, matching the theme's "warning / degraded" semantic, and never RED: a
 * stale mark is degraded, not broken, and red in a trading UI already means
 * "short / down".
 */
export function StaleBadge({
  freshness,
  label = "STALE",
  showAge = false,
}: {
  freshness: Freshness;
  label?: string;
  /** Append the age in seconds — worth it on the mark, noise in a table cell. */
  showAge?: boolean;
}) {
  if (!freshness.isStale) return null;
  const age = freshness.ageMs === null ? null : Math.round(freshness.ageMs / 1000);
  return (
    <span
      title={freshness.reason ?? undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        marginLeft: 5,
        ...monoLabel(9, "0.1em"),
        color: AMBER,
        border: `1px solid ${L3}`,
        borderRadius: R_SM,
        padding: "0 4px",
        cursor: "help",
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      {label}
      {showAge && age !== null && <span style={{ color: DIM }}>{age}s</span>}
    </span>
  );
}

/**
 * Panel-wide stale strip — for when the whole feed is behind (socket dropped,
 * `OrderBook.nonce` gap) rather than one figure. Sits under a panel header.
 */
export function StaleBanner({ freshness, onRefresh }: { freshness: Freshness; onRefresh?: () => void }) {
  if (!freshness.isStale) return null;
  return (
    <div
      role="status"
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 14px",
        background: TERM,
        borderBottom: `1px solid ${L1}`,
        ...monoLabel(9.5, "0.1em"),
        color: AMBER,
      }}
    >
      <span>{freshness.reason ?? "Data is stale"}</span>
      <div style={{ flex: 1 }} />
      {onRefresh && <GhostButton label="Refresh" onClick={onRefresh} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── absent value

/**
 * A `Maybe<T>` in a cell: the formatted value, or `—` with the reason on hover.
 *
 * This is the component that makes the contract enforceable. A panel that renders
 * every venue-sourced figure through it cannot print `0` for a missing
 * `liquidation_price`, cannot print `$0.00` for a fee the engine never sent, and
 * cannot print `NaN` — because the formatter is only ever handed a present value
 * (`render()` in lib/api/absence.ts).
 *
 * `cursor: help` + `title` is the whole affordance, matching `StatCell`'s dotted
 * underline idiom for "there is a definition behind this". No popover: a tooltip
 * is readable at 12px in a dense table and a popover is not.
 */
export function AbsentValue<T>({
  value,
  format,
  color = MUT,
  absentColor = FAINT,
  placeholder = ABSENT_GLYPH,
  align,
  suffix,
  style,
}: {
  value: Maybe<T>;
  /** Only called on a present value. Reuse lib/format.ts. */
  format: Formatter<T>;
  /** Colour when present. Pass `sign(up)` output for signed figures. */
  color?: string;
  /** Colour of the placeholder. Dimmer than a value, on purpose. */
  absentColor?: string;
  placeholder?: string;
  align?: "left" | "right";
  /** Rendered only when the value is present — a unit never labels a dash. */
  suffix?: ReactNode;
  style?: CSSProperties;
}) {
  const r = render(value, format, placeholder);
  return (
    <span
      title={r.title || undefined}
      // The machine-readable half: the audit's DOM extractor and any future
      // assertion can find an absence without parsing the glyph out of text.
      data-absent={r.isAbsent ? r.code ?? true : undefined}
      style={{
        textAlign: align,
        color: r.isAbsent ? absentColor : color,
        cursor: r.isAbsent ? "help" : undefined,
        ...style,
      }}
    >
      {r.text}
      {!r.isAbsent && suffix}
    </span>
  );
}

/**
 * Absent-aware label for a figure that is present but *derived from* something
 * absent — e.g. a leverage read off `1 / initial_margin_rate` when the position's
 * own leverage is not mirrored. The value is real; the caveat is that it is a cap,
 * not a measurement. Renders the value with a dotted underline and the caveat on
 * hover, rather than hiding a true number behind a dash.
 */
export function CaveatValue({
  children,
  note,
  color = MUT,
}: {
  children: ReactNode;
  /** The caveat, e.g. "Market maximum — position leverage is not exposed". */
  note: string;
  color?: string;
}) {
  return (
    <span
      title={note}
      data-caveat={note}
      style={{ color, borderBottom: `1px dotted ${L2}`, cursor: "help" }}
    >
      {children}
    </span>
  );
}

/**
 * A row that failed to parse, inside an otherwise-good table.
 *
 * `Parsed<T>.errors` exists so one malformed entry degrades itself and not the
 * panel. Without something like this the only options are dropping the row —
 * which silently understates a trader's exposure — or rendering its zeros.
 * Spans the full row width; the caller supplies the grid template.
 */
export function BadRow({
  template,
  label,
  errors,
}: {
  template: string;
  /** Whatever identifies the row — market id, order id. */
  label: string;
  errors: Readonly<Record<string, string>>;
}) {
  const detail = Object.entries(errors)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return (
    <div
      role="row"
      title={detail}
      style={{
        display: "grid",
        gridTemplateColumns: template,
        columnGap: 10,
        padding: "9px 16px",
        borderBottom: `1px solid ${L1}`,
        fontFamily: MONO,
        fontSize: 12,
        alignItems: "center",
        cursor: "help",
      }}
    >
      <span style={{ color: TXT }}>{label}</span>
      <span style={{ gridColumn: "2 / -1", color: RED, fontSize: 11 }}>
        Could not read this row — {Object.keys(errors).length} field
        {Object.keys(errors).length === 1 ? "" : "s"} unavailable
      </span>
    </div>
  );
}

/**
 * The one-call dispatcher for a table body's four possible states.
 *
 * Panels currently branch on `rows.length` and nothing else. Routing through this
 * means the ordering is decided once — error beats loading beats empty — instead
 * of each panel inventing its own precedence and one of them showing "No open
 * positions" during a 503, which reads as "you have no positions" and is a lie.
 *
 * Returns `null` when there is data, so the caller renders its rows as usual.
 */
export function TableState({
  loading,
  error,
  count,
  surface,
  minHeight,
  onRetry,
  action,
  filter,
}: {
  loading?: boolean;
  error?: { message?: string; endpoint?: string; status?: number } | null;
  /** Number of rows the caller is about to render. */
  count: number;
  surface: EmptySurface;
  minHeight?: number;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void };
  /** Active filter label, when one is narrowing the rows away. */
  filter?: string;
}): ReactNode {
  if (error) {
    return (
      <ErrorState
        message={error.message}
        endpoint={error.endpoint}
        status={error.status}
        onRetry={onRetry}
        minHeight={minHeight}
      />
    );
  }
  // Loading is checked after error but before empty, and only matters on a first
  // load: a re-fetch that already has rows should keep showing them (stale-while-
  // revalidate) rather than blanking a table the trader is reading.
  if (loading && count === 0) return <LoadingState minHeight={minHeight} />;
  if (count === 0) return <EmptyState message={emptyCopy(surface, filter)} minHeight={minHeight} action={action} />;
  return null;
}

/** Re-exported so a panel needs one import to render absence. */
export { isAbsent, ABSENT_GLYPH };
export type { Maybe, Freshness };
