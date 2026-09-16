/*
 * Dashboard parts.
 *
 * Built from the terminal's own tokens rather than a second design language, so
 * the operator surface reads as the same product as the trading surface. Same
 * mono for numbers, same panel treatment, same hairlines.
 *
 * The one thing these parts add that the trading UI has no need for is the
 * PROVENANCE badge. Every figure on an operator dashboard is either measured or
 * projected, and the badge is not decoration — it is the difference between a
 * number you can reconcile against and one you can only forecast with.
 */

import { Children, type CSSProperties, type ReactNode } from "react";

import {
  AMBER,
  ARCHIVO,
  CHROME,
  DIM,
  FAINT,
  GREEN,
  HI,
  L1,
  L2,
  L3,
  MONO,
  MUT,
  NUM,
  PANEL,
  R_MD,
  R_SM,
  RED,
  SUNK,
  TXT,
  monoLabel,
  titleLabel,
} from "@/lib/theme";
import { SIZE, body, data as dataType } from "./type";

/*
 * TWO VALUES, because there are only two honest answers to "where did this number
 * come from" on a venue console: the venue measured it, or the venue projected it.
 * A measurement can be reconciled against the ledger; a projection moves when the
 * inputs move, and an operator who forecasts against one needs to know which is
 * which before they quote it to anyone.
 */
export type Provenance = "live" | "estimate";

const PROVENANCE_STYLE: Record<Provenance, { color: string; label: string; hint: string }> = {
  live: { color: GREEN, label: "LIVE", hint: "read from the venue just now" },
  estimate: { color: MUT, label: "EST", hint: "modelled — accrues against the fee schedule, settles at period close" },
};

/**
 * THE CONSOLE'S MOST-REPEATED MARK, and the reason it is a dot and not a chip.
 *
 * Provenance rides on nearly every figure on every page — six to a metric row, one
 * per chart frame, one per panel header. As a tinted chip with its own border and
 * fill that is forty painted boxes per screen, and a chip beside a value competes
 * with the value: the loudest thing in a metric tile was its footnote.
 *
 * So the badge loses the box and keeps the information. A 3px square in the
 * provenance hue, then the three letters in label ink. The letters carry identity,
 * which is the accessibility requirement — colour is the second cue, never the only
 * one — and the whole mark now costs about as much attention as a comma.
 *
 * The same 3px square is the leading mark on Note, so "where this came from" is one
 * repeated shape across the console rather than several competing treatments.
 */
export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const s = PROVENANCE_STYLE[provenance];
  return (
    <span
      title={s.hint}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        ...monoLabel(SIZE.micro, "0.1em"),
        color: DIM,
        whiteSpace: "nowrap",
      }}
    >
      <Dot color={s.color} />
      {s.label}
    </span>
  );
}

/** The 3px square. Exported so a caller can mark a heading with the same shape. */
export function Dot({ color, size = 3 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, background: color, flexShrink: 0, borderRadius: 1 }}
    />
  );
}

export function Card({
  title,
  right,
  children,
  style,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        background: PANEL,
        border: `1px solid ${L2}`,
        borderRadius: R_MD,
        overflow: "hidden",
        minWidth: 0,
        ...style,
      }}
    >
      {title && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "9px 12px",
            borderBottom: `1px solid ${L1}`,
            background: CHROME,
          }}
        >
          <span style={{ ...titleLabel(SIZE.title, 600), color: TXT }}>{title}</span>
          {right}
        </header>
      )}
      <div style={{ padding: 12 }}>{children}</div>
    </section>
  );
}

/** A headline figure. `null` renders as an em dash — absence is not zero. */
export function Metric({
  label,
  value,
  provenance,
  hint,
  color = HI,
}: {
  label: string;
  value: string | null;
  provenance: Provenance;
  hint?: string;
  color?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>{label}</span>
        <ProvenanceBadge provenance={provenance} />
      </div>
      <span
        style={{
          ...dataType(SIZE.figure),
          fontWeight: 500,
          color: value === null ? FAINT : color,
          letterSpacing: "-0.015em",
        }}
      >
        {value ?? "—"}
      </span>
      {/* The hint line is always rendered, empty or not. Without it the tiles in
          a row ended on different baselines and the panel bottom went ragged —
          a reserved line is cheaper than a grid rewrite and reads calmer. */}
      <span style={{ ...body(SIZE.note, 1.3), color: FAINT, minHeight: 15 }}>{hint ?? ""}</span>
    </div>
  );
}

/**
 * A row of figures, separated by hairlines rather than by air.
 *
 * `divided` is the default treatment on this console and the reason is measurable:
 * six tiles spread across 1180px of panel put 90px of empty page between a label and
 * the next label, so the row read as six unrelated things and the eye had to re-find
 * the pattern at every tile. Air is the weakest possible grouping device at that
 * distance. A 1px rule between fields is the trading-terminal answer — it says
 * "these are the same kind of thing, and this one ends here" in one pixel, and it
 * lets the tiles stay wide instead of forcing a narrower grid.
 *
 * The rule is drawn by wrapping each child rather than by a gap-and-background
 * trick, because the wrapper can drop the rule on the first column of each row and
 * a background cannot.
 */
export function MetricGrid({
  children,
  min = 150,
  divided = false,
}: {
  children: ReactNode;
  min?: number;
  divided?: boolean;
}) {
  if (!divided) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
          gap: 18,
        }}
      >
        {children}
      </div>
    );
  }

  const items = Children.toArray(children);
  return (
    <div
      className="nx-metrics"
      /*
       * ONE ROW, EXPLICITLY. `auto-fit` was tempting and wrong here: a rule belongs
       * on every tile except the first of each row, and CSS cannot tell which tile
       * that is once the grid has wrapped — so an auto-fit divided row grows a
       * stray rule against the panel's left padding the moment it reflows. A fixed
       * column count cannot wrap, so the first tile is the only tile without a
       * rule, always. The narrow layouts are handled in one place instead
       * (globals.css `.nx-metrics`), where the rules are traded for a stacked list.
       */
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
        columnGap: 0,
        rowGap: 18,
      }}
    >
      {items.map((child, i) => (
        <div
          key={i}
          className={i === 0 ? undefined : "nx-metric-divided"}
          /* Colour stays here rather than in globals.css: the line tokens are
             tenant-owned, and a hex in the stylesheet would not re-skin. The
             stylesheet only removes the rule at narrow widths, which needs none. */
          style={
            i === 0
              ? { paddingRight: 15, minWidth: 0 }
              /* L2, not L1. L1 is the hairline between rows in a list, where the rows
                 themselves supply the structure; this rule IS the structure, and at
                 #161616 on a #070707 panel it measured as a smudge rather than a
                 line. L2 is the token for a structural division and reads as one. */
              : { borderLeft: `1px solid ${L2}`, paddingLeft: 15, paddingRight: 15, minWidth: 0 }
          }
        >
          {child}
        </div>
      ))}
    </div>
  );
}

/**
 * A stacked-area-free, deliberately plain column chart.
 *
 * SVG and no dependency: the trading UI already carries a chart library for
 * candles, and a dashboard bar chart does not justify pulling it onto an
 * operator route that would otherwise ship almost no JavaScript.
 */
export function ColumnChart({
  series,
  height = 120,
  color = GREEN,
  format,
}: {
  series: { label: string; value: number }[];
  height?: number;
  color?: string;
  format: (n: number) => string;
}) {
  const max = Math.max(1, ...series.map((s) => s.value));
  const gap = 2;
  const width = Math.max(series.length * 8, 240);
  const barWidth = (width - gap * (series.length - 1)) / series.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block" }}
        role="img"
        aria-label={`Column chart, ${series.length} points, peak ${format(max)}`}
      >
        {series.map((point, i) => {
          const h = Math.max(1, (point.value / max) * (height - 2));
          return (
            <rect
              key={point.label}
              x={i * (barWidth + gap)}
              y={height - h}
              width={barWidth}
              height={h}
              fill={color}
              opacity={0.28 + 0.72 * (point.value / max)}
            >
              <title>{`${point.label} · ${format(point.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", ...monoLabel(8.5), color: FAINT }}>
        <span>{series[0]?.label}</span>
        <span>peak {format(max)}</span>
        <span>{series[series.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** A share-of-total bar, for ranking venues against each other. */
export function ShareBar({ fraction, color = GREEN }: { fraction: number; color?: string }) {
  return (
    <div style={{ height: 4, background: L1, borderRadius: 2, overflow: "hidden", minWidth: 48 }}>
      <div
        style={{
          height: "100%",
          width: `${Math.max(1, Math.min(100, fraction * 100))}%`,
          background: color,
          opacity: 0.75,
        }}
      />
    </div>
  );
}

/**
 * A column header. A bare string keeps the old default — first column left,
 * the rest right — and the object form states the alignment explicitly.
 *
 * The object form exists because the default was silently wrong: a header is
 * aligned by its INDEX while its cells are aligned by their own prop, so any
 * left-aligned text column past the first (a label, a scope list, an actor)
 * pushed its header to the far right of the data it named. Visible on the keys
 * and audit tables, and the sort of misalignment that reads as sloppiness
 * rather than as a bug.
 */
export type HeadCell = string | { label: string; align: "left" | "right" };

/**
 * COLUMN WIDTH IS DERIVED FROM ALIGNMENT, and that one rule fixes every table here.
 *
 * A `width: 100%` table divides its width evenly, so the Markets table put 200px of
 * empty page between MARK and 24H VOLUME and an operator's eye had to travel the
 * width of the panel to read one row. Numbers do not want to be spread out; they
 * want to sit in a tight block that can be scanned straight down.
 *
 * A right-aligned column is a number, so it shrinks to its content (`width: 1%` is
 * the old, reliable way of saying "as narrow as you can"). A left-aligned column is
 * a name or a sentence, so it absorbs the slack. No new prop, no per-table tuning —
 * the alignment already encoded the intent and nobody had read it.
 */
export const colWidth = (align: "left" | "right"): string | undefined =>
  align === "right" ? "1%" : undefined;

export function DataTable({ head, children }: { head: HeadCell[]; children: ReactNode }) {
  /*
   * THE MINIMUM SCALES WITH THE COLUMN COUNT, and a flat 560 was wrong for the
   * narrow ones. The market drill-down's FIELD/VALUE table has two columns and
   * inherited the same 560px floor as a seven-column blotter, so on a phone the
   * VALUE column — the entire content of the table — sat outside the scroller
   * with nothing on screen to say it was there. 112px a column is the width the
   * widest label in these tables needs; the 560 cap keeps the wide tables where
   * they were, scrolling inside themselves rather than dragging the page.
   */
  const minWidth = Math.min(560, head.length * 112);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth }}>
        <thead>
          <tr>
            {head.map((h, i) => {
              const label = typeof h === "string" ? h : h.label;
              const align = typeof h === "string" ? (i === 0 ? "left" : "right") : h.align;
              return (
                <th
                  key={label || i}
                  style={{
                    ...monoLabel(SIZE.micro),
                    color: DIM,
                    textAlign: align,
                    width: colWidth(align),
                    padding: "0 12px 8px",
                    borderBottom: `1px solid ${L1}`,
                    whiteSpace: "nowrap",
                    fontWeight: 400,
                  }}
                >
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({
  children,
  align = "right",
  color = NUM,
  mono = true,
}: {
  children: ReactNode;
  align?: "left" | "right";
  color?: string;
  mono?: boolean;
}) {
  return (
    <td
      style={{
        ...(mono ? dataType() : body(SIZE.body, 1.5)),
        color,
        textAlign: align,
        padding: "8px 12px",
        borderBottom: `1px solid ${L1}`,
        /* Numbers never wrap; a sentence in a left-aligned cell must, or a single
           long "meaning" column drags the whole table into a horizontal scroll. */
        whiteSpace: mono ? "nowrap" : "normal",
      }}
    >
      {children}
    </td>
  );
}

/* ClaimsBanner removed. It existed to draw a line between the figures the console
   measured and the ones it stood in for; the console measures them now, so the
   line has nothing to separate and the banner was the same paragraph on nine
   pages. Per-figure provenance badges carry what is left of the distinction. */

export function DashHeader({
  eyebrow,
  title,
  right,
}: {
  eyebrow: string;
  title: string;
  right?: ReactNode;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>{eyebrow}</span>
        <h1 style={{ ...titleLabel(SIZE.page, 700), color: HI, margin: 0, letterSpacing: "-0.015em" }}>{title}</h1>
      </div>
      {right}
    </header>
  );
}

export const fmt = {
  usd(n: number | null, dp = 0): string | null {
    if (n === null) return null;
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
    return `$${n.toFixed(dp)}`;
  },
  usdExact(n: number | null): string | null {
    return n === null ? null : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  },
  int(n: number | null): string | null {
    return n === null ? null : n.toLocaleString("en-US");
  },
  /**
   * A price, at a FIXED two decimals.
   *
   * `toLocaleString` was being used for mark prices and it drops trailing zeros, so
   * a column read 1,875.02 / 75.558 / 63,017.6 — right-aligned, tabular, and with
   * the decimal point in three different places. Right alignment only aligns
   * numbers when they carry the same number of decimals; otherwise it aligns the
   * last digit, which is the one place nobody looks. Two decimals everywhere puts
   * the point on a column.
   */
  price(n: number | null): string | null {
    return n === null ? null : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  pct(n: number | null, dp = 2): string | null {
    return n === null ? null : `${(n * 100).toFixed(dp)}%`;
  },
  bps(n: number | null, dp = 2): string | null {
    return n === null ? null : `${n.toFixed(dp)} bps`;
  },
  day(ms: number): string {
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  },
  /** A duration in seconds, read the way an operator says it out loud. */
  duration(seconds: number | null): string | null {
    if (seconds === null) return null;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3_600)}h ${Math.round((seconds % 3_600) / 60)}m`;
  },
};

// ── the states nobody builds ─────────────────────────────────────────────────
/*
 * A console is mostly written against the happy path and then shipped to a venue
 * on its first day, which has none of it. These three cover the difference.
 *
 * The distinction that matters is EMPTY vs BROKEN. "No deposits yet" and "we
 * could not read deposits" look identical if both render as a blank panel, and
 * they call for opposite actions — one says keep going, the other says page
 * someone. So they are different components with different colour, and neither
 * ever renders a confident zero.
 */

export function EmptyState({
  title,
  blurb,
  action,
}: {
  title: string;
  blurb: string;
  /** The one thing to do next. Omitted when there is genuinely nothing to do. */
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "30px 18px",
        border: `1px dashed ${L2}`,
        borderRadius: R_SM,
        background: SUNK,
        textAlign: "center",
      }}
    >
      <span style={{ ...titleLabel(SIZE.title, 600), color: MUT }}>{title}</span>
      <span style={{ ...body(SIZE.note, 1.6), color: FAINT, maxWidth: 420 }}>{blurb}</span>
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ title, detail, retry }: { title: string; detail: string; retry?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "13px 14px",
        border: `1px solid ${RED}33`,
        background: `${RED}0d`,
        borderRadius: R_SM,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          ...monoLabel(SIZE.micro),
          color: RED,
          paddingTop: 3,
          whiteSpace: "nowrap",
        }}
      >
        <Dot color={RED} />
        FAILED
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
        <span style={{ ...titleLabel(SIZE.title, 600), color: TXT }}>{title}</span>
        <span style={{ fontFamily: MONO, fontSize: SIZE.note, color: MUT, wordBreak: "break-word" }}>{detail}</span>
      </div>
      {retry}
    </div>
  );
}

/**
 * A loading placeholder that is the SHAPE of the thing being loaded.
 *
 * A spinner tells you to wait; a skeleton tells you what you are waiting for, and
 * it stops the layout jumping when the data lands. The console's pages are
 * server-rendered against a live testnet read with an eight-second timeout, so
 * this is a real state, not a decorative one.
 */
export function Skeleton({ height = 14, width = "100%" }: { height?: number; width?: number | string }) {
  return (
    <span
      aria-hidden="true"
      className="nx-skeleton"
      style={{ display: "block", height, width, borderRadius: R_SM, background: L1 }}
    />
  );
}

export function SkeletonMetrics({ count = 4 }: { count?: number }) {
  return (
    <MetricGrid min={132}>
      {Array.from({ length: count }, (_, i) => (
        /* The skeleton is the SHAPE of a Metric, so its three bars have to be the
           heights of a Metric's three lines — micro label, figure, note. When the
           type scale moved and these did not, the layout jumped on every load. */
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Skeleton height={SIZE.micro} width={62} />
          <Skeleton height={SIZE.figure} width={100} />
          <Skeleton height={SIZE.micro} width={78} />
        </div>
      ))}
    </MetricGrid>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        /* Widths taper down the list so it reads as a table rather than a stack
           of identical bars — the eye needs the raggedness to see rows. */
        <Skeleton key={i} height={12} width={`${94 - i * 7}%`} />
      ))}
    </div>
  );
}

/* CapabilityPill removed. It answered "does the thing this panel describes exist
   yet" — a question about the build, not about the venue. Every panel that carried
   one describes a capability the operator can use, so the pill only ever said
   SHIPPED and the header it sat in reads cleaner without it. */

export { GREEN, RED, AMBER, MUT, TXT, HI, DIM, FAINT, L1, L2, L3, SUNK, MONO, ARCHIVO, PANEL, CHROME };
