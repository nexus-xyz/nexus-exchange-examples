"use client";

/*
 * One configurable table for every blotter tab.
 *
 * ## Why an abstraction and not three tables
 *
 * The blotter had three hardcoded grid templates and three duplicated
 * Table/HeadRow/TableState/RowGroup scaffolds — so adding Order History meant a fourth
 * copy of the same fifty lines, and a column added to Open Orders had to be remembered
 * in Order History by hand.
 *
 * The reference venue's ten tabs are really about three column configurations: Open
 * Orders and Order History share ten of eleven columns. So the unit of reuse is a
 * *column set*, not a table.
 *
 * ## Overflow is designed in, not discovered
 *
 * The reference's own ten-tab strip does not fit at 1440 — with a filter active the
 * tenth label truncates mid-word to "Account Activ", then "Acc", "Ac", "A", with no
 * overflow affordance at all. That is the failure mode this file is built to avoid, so
 * every column declares a `priority` and the table drops the low ones when it is told
 * it is narrow. Dropping a column is legible; a label truncated to "A" is not.
 *
 * The density decision is made by the SCREEN and passed in. A panel measuring its own
 * width would break the "panels are presentational" rule and, worse, would need a
 * layout effect that disagrees with the server render on first paint.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  R_XS,
  R_SM, FAINT, GREEN, L2, MONO, MUT, RED, TERM, TXT, field } from "@/lib/theme";
import { HeadRow, Row, RowGroup, Table } from "./primitives";
import { TableState, type EmptySurface } from "./states";
import { usePhase } from "@/lib/dataphase";

/**
 * Priority decides what survives a narrow blotter.
 *
 *   1 — never dropped. Without it the row is unreadable (market, side, size).
 *   2 — dropped when narrow. Useful, not load-bearing.
 *   3 — dropped first. Detail a trader can get elsewhere.
 */
export type ColPriority = 1 | 2 | 3;

export type Column<Row_> = {
  id: string;
  label: string;
  /**
   * A shorter label for the phone tier.
   *
   * `UNREALIZED PNL` and `ACCOUNT CHANGE` wrap to two lines in a phone-width column,
   * which ragged the header and cost a row of height on every table that had one.
   * Declared per column, like `priority`, so the decision sits with the column rather
   * than in a truncation rule that would eventually cut a word in half.
   */
  shortLabel?: string;
  align?: "left" | "right";
  /** Grid fraction. One number drives both the head and the body template. */
  width: number;
  priority: ColPriority;
  cell: (row: Row_) => ReactNode;
  /**
   * Present ⇒ the column sorts, by this value.
   *
   * Opt-in per column, because on the reference sortable headers are a SUBSET and
   * not the whole row — `Time (UTC)` on every history tab, `Size` on TWAP and Trade
   * History, `Position Value` on Positions. A chevron on a column nobody sorts by is
   * a control that costs a click to discover is pointless.
   */
  sortBy?: (row: Row_) => number | string;
};

export type ColumnSet<Row_> = {
  label: string;
  /** Which absence copy to show when there are no rows. */
  surface: EmptySurface;
  /**
   * The route this table's rows come from, named so the error state can say what
   * failed. `GET /positions · 503` is a bug report; "something went wrong" is not.
   */
  endpoint?: string;
  columns: Column<Row_>[];
  key: (row: Row_) => string;
  /** Column id + direction the table opens on. Omit to keep the caller's order. */
  defaultSort?: { id: string; dir: SortDir };
};

export type SortDir = "asc" | "desc";

/*
 * Three tiers, not two.
 *
 * `narrow` was doing two jobs — 834 and 390 — and it was tuned for the first, so it
 * kept priority 1 AND 2. Measured at 390 that is 6 to 10 columns and every tab
 * overflows: Balances by 44px, Working orders 52, Trade history 83, Positions **226**
 * — more than half a screen of data off the right edge behind a hairline scrollbar.
 * The reference shows TWO columns on a phone.
 *
 * Dropping a column is legible. A column you have to discover by swiping is not.
 */
export type Density = "wide" | "narrow" | "phone";

/**
 * The row checkbox, and the select-all in the header. Same control, two places.
 *
 * Wrapped in a `role="cell"` because a `role="row"` may contain only cells and
 * columnheaders — a bare `role="checkbox"` child is `aria-required-children`, which
 * is exactly how the overflow-menu button was caught two phases ago. The other cells
 * escape the rule by being `display: contents` spans with no role of their own; an
 * explicit role is what makes this one visible to axe.
 */
function SelectBox({
  on,
  label,
  onToggle,
  cell = true,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
  /**
   * False in the header, where HeadRow has already wrapped it in a columnheader.
   * A `cell` inside a `columnheader` is `aria-required-parent` — the same rule from
   * the other side, and the reason this is a prop rather than a constant.
   */
  cell?: boolean;
}) {
  const Wrap = cell ? "span" : "span";
  return (
    <Wrap
      {...(cell ? { role: "cell" as const } : {})}
      style={{ display: "flex", alignItems: "center" }}
    >
      <button
        role="checkbox"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
          height: "100%",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 11,
            height: 11,
            borderRadius: R_XS,
            border: `1px solid ${on ? GREEN : L2}`,
            background: on ? GREEN : "transparent",
          }}
        />
      </button>
    </Wrap>
  );
}

/** Columns this density admits, in declaration order. */
const visibleColumns = <Row_,>(set: ColumnSet<Row_>, density: Density): Column<Row_>[] =>
  set.columns.filter((c) => c.priority <= (density === "wide" ? 3 : density === "narrow" ? 2 : 1));

export function BlotterTable<Row_>({
  set,
  rows,
  density = "wide",
  selection: selectionProp,
  filter,
}: {
  set: ColumnSet<Row_>;
  rows: Row_[];
  density?: Density;
  /** Active filter label — named in the empty state when it is what hid the rows. */
  filter?: string;
  /**
   * Row selection, when the table has a bulk action. Controlled by the caller
   * because the action itself lives in the tab strip, not in the table — the
   * reference puts `Cancel` up there too.
   */
  selection?: {
    selected: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onToggleAll: (keys: string[]) => void;
  };
}) {
  /*
   * No row selection at narrow density. The bulk actions it feeds are already hidden
   * on a phone, so the checkboxes were 11px controls wired to nothing reachable —
   * and 11px is a third of the floor for a control with no tier signal.
   */
  const selection = density === "wide" ? selectionProp : undefined;
  const cols = visibleColumns(set, density);
  const [sort, setSort] = useState<{ id: string; dir: SortDir } | null>(set.defaultSort ?? null);
  const { phase, loading, error } = usePhase(set.endpoint);

  /*
   * Sorted here rather than by the caller so that every table sorts the same way and
   * a new tab gets it for free. Strings compare with localeCompare so symbols order
   * the way a reader expects; the comparator is stable because `slice()` keeps the
   * incoming order for equal keys — which matters on a fills table where several
   * rows share a timestamp.
   */
  const sorted = useMemo(() => {
    /* Nothing has arrived yet, or the request failed — so there are no rows, and the
       table says so rather than showing fixtures underneath a loading line. A panel
       that renders data DURING its own loading state is worse than one with no
       loading state at all: it teaches the reader that the indicator is decorative. */
    if (phase !== "ready") return [];
    if (!sort) return rows;
    const col = set.columns.find((c) => c.id === sort.id);
    if (!col?.sortBy) return rows;
    const by = col.sortBy;
    const dir = sort.dir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const x = by(a);
      const y = by(b);
      if (typeof x === "string" || typeof y === "string") {
        return String(x).localeCompare(String(y)) * dir;
      }
      return (x - y) * dir;
    });
  }, [rows, sort, set.columns, phase]);

  const onHeader = (id: string) => {
    const col = set.columns.find((c) => c.id === id);
    if (!col?.sortBy) return;
    setSort((s) =>
      // Third click clears rather than cycling forever back to ascending: returning
      // to the feed's own order is a state a trader wants and cannot otherwise reach.
      s?.id !== id ? { id, dir: "desc" } : s.dir === "desc" ? { id, dir: "asc" } : null,
    );
  };

  const keys = sorted.map((r) => set.key(r));
  const allSelected = selection ? keys.length > 0 && keys.every((k) => selection.selected.has(k)) : false;
  /*
   * At phone density the first column gets a floor.
   *
   * Pure `fr` tracks divide the width by the declared ratios, which is right when
   * there are nine of them and wrong when there are four: `MARKET` came out ~90px and
   * `BTC-USDX-PERP` broke at its hyphens onto THREE lines, which is how a row that no
   * longer scrolls sideways can still be unreadable. The identity column is the one
   * cell whose content has a hard minimum — a symbol is not summarisable — so it gets
   * `minmax(112px, …)` and the rest divide what is left.
   */
  const track = (c: (typeof cols)[number], i: number) =>
    density === "phone" && i === 0 ? `minmax(104px, ${c.width}fr)` : `${c.width}fr`;
  const template = (selection ? "28px " : "") + cols.map(track).join(" ");

  return (
    <>
    {/* The table itself also stops flexing at phone density — inside the trade
        screen's single scroller it must be its own height, not a share of a parent. */}
    <Table
      label={set.label}
      style={density === "phone" ? { flex: "0 0 auto", minHeight: 0 } : undefined}
    >
      <HeadRow
        template={template}
        lead={
          selection ? (
            <SelectBox
              cell={false}
              on={allSelected}
              label={allSelected ? `Deselect all ${set.label}` : `Select all ${set.label}`}
              onToggle={() => selection.onToggleAll(keys)}
            />
          ) : undefined
        }
        cols={cols.map((c) => ({
          label: density === "phone" ? (c.shortLabel ?? c.label) : c.label,
          align: c.align ?? "right",
          /* No sort buttons at narrow density. A 12px chevron inside a column header
             is not a tap target on a phone, and the floor is right to say so. */
          sortable: density === "wide" && !!c.sortBy,
          sortDir: sort?.id === c.id ? sort.dir : undefined,
          onSort: c.sortBy ? () => onHeader(c.id) : undefined,
        }))}
      />
      {/*
       * At phone density the row group does NOT scroll and does NOT flex.
       *
       * `RowGroup` defaults to `flex: 1 1 0` with its own scrollbar, which is right
       * inside a bounded panel and collapses to ZERO height inside a natural-height
       * one — which is exactly what the phone trade screen became when the pane and
       * the blotter merged into a single scrolling region. The table rendered its
       * header and no rows at all.
       */}
      <RowGroup
        label={`${set.label} rows`}
        style={density === "phone" ? { flex: "0 0 auto", overflowY: "visible" } : undefined}
      >
        {sorted.map((r) => {
          const k = set.key(r);
          return (
            <Row key={k} template={template}>
              {selection && (
                <SelectBox
                  on={selection.selected.has(k)}
                  label={`Select ${k}`}
                  onToggle={() => selection.onToggle(k)}
                />
              )}
              {cols.map((c) => (
                <span key={c.id} style={{ display: "contents" }}>
                  {c.cell(r)}
                </span>
              ))}
            </Row>
          );
        })}
      </RowGroup>
    </Table>
      {/*
       * OUTSIDE the table, not merely outside the row group.
       *
       * It was inside, and the empty case got away with it because `EmptyState`
       * carries no role. `LoadingState` is a `role="status"` and `ErrorState` a
       * `role="alert"`, and a `role="table"` may contain neither — six captures went
       * red the moment these two states could be reached at all.
       *
       * Sixth occurrence of aria-required-children on this project, and every one has
       * been a caller putting a non-row inside a table primitive. That is a fact about
       * the primitives, not about six call sites: `Table`, `RowGroup`, `HeadRow` and
       * `Row` should make it unsayable. Recorded as open in audit/README.
       */}
      <TableState
        count={sorted.length}
        surface={set.surface}
        filter={filter}
        loading={loading}
        error={error}
      />
    </>
  );
}

/**
 * A numeric cell that can be edited in place.
 *
 * This replaces the two canned amend gestures the blotter shipped with — a "±" button
 * that re-priced 0.1% better and a "½" that halved the size. Those were demos of the
 * endpoint, not uses of it: no trader wants to move a price by a fixed fraction, they
 * want to set it. Amending is the one order action where the value matters, so it needs
 * a field.
 */
export function EditableNum({
  value,
  editing,
  onChange,
  ariaLabel,
  children,
}: {
  value: number | null;
  editing: boolean;
  onChange: (v: number) => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  if (!editing || value === null) return <>{children}</>;
  return (
    <input
      type="number"
      defaultValue={value}
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v) && v > 0) onChange(v);
        }
      }}
      onBlur={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v > 0 && v !== value) onChange(v);
      }}
      style={{
        ...field(4),
        color: TXT,
        fontFamily: MONO,
        fontSize: 10.5,
        padding: "1px 4px",
        width: "100%",
        textAlign: "right",
        background: TERM,
        border: `1px solid ${L2}`,
      }}
    />
  );
}

/** Small inline row action, sized to the segmented tap tier. */
export function ActionButton({
  label,
  title,
  ariaLabel,
  onClick,
  tone = "neutral",
}: {
  label: string;
  title: string;
  ariaLabel?: string;
  onClick: () => void;
  tone?: "neutral" | "red" | "green";
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      /*
       * `nx-rowaction` is a media query, not a style: these are ~18px on a desktop
       * row, which is right there and under-tier the moment the blotter renders on a
       * phone. Two of them share a top edge in every Positions row, so the floor
       * grades them as a segmented group at 36px. Handled in CSS rather than by
       * threading `density` through every column's `cell` callback.
       */
      className="nx-rowaction"
      style={{
        border: `1px solid ${L2}`,
        borderRadius: R_SM,
        background: "transparent",
        color: tone === "red" ? RED : tone === "green" ? GREEN : MUT,
        fontFamily: MONO,
        fontSize: 9.5,
        padding: "2px 6px",
        cursor: "pointer",
        lineHeight: 1.3,
      }}
    >
      {label}
    </button>
  );
}
