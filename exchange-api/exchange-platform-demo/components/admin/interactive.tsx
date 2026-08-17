"use client";

/*
 * The console's client islands.
 *
 * Everything here exists because a console that cannot be *used* is a screenshot.
 * The rule for what earns a "use client" is narrow: an affordance where the
 * operator's own action is the point — copying a secret they will only see once,
 * filtering a table they are hunting through, confirming something with a
 * consequence. Charts, figures and layout stay on the server.
 *
 * Every action goes through the console's own admin API rather than mutating
 * local state, and what the operator reads back is the API's own account of what
 * changed. A control that reports success from the client, without hearing it
 * from the server, is worse than no control at all.
 */

import Link from "next/link";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import {
  AMBER,
  ARCHIVO,
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
  R_SM,
  RED,
  SUNK,
  TAP_FLOOR,
  TAP_PRIMARY,
  TERM,
  TXT,
  monoLabel,
} from "@/lib/theme";
import { buttonStyle, inputStyle, primaryButtonStyle } from "./shell";
import { EmptyState, colWidth } from "./parts";
import { SIZE, body, data as dataType } from "./type";

// ── copy ─────────────────────────────────────────────────────────────────────

/**
 * A value you are meant to take away.
 *
 * `mask` hides the value behind a reveal, for anything that would otherwise sit
 * on screen while someone is screen-sharing. The copy still works while masked —
 * you do not have to expose a secret in order to move it.
 */
export function CopyField({
  value,
  label,
  mask = false,
  wide = false,
}: {
  value: string;
  label?: string;
  mask?: boolean;
  wide?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!mask);

  const copy = () => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, width: wide ? "100%" : undefined }}>
      {label && <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>{label}</span>}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: TERM,
          border: `1px solid ${L2}`,
          borderRadius: R_SM,
          padding: "7px 8px",
          minWidth: 0,
        }}
      >
        <code
          style={{
            fontFamily: MONO,
            fontSize: SIZE.data,
            color: shown ? HI : DIM,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: shown ? undefined : "0.1em",
          }}
        >
          {shown ? value : "•".repeat(Math.min(44, value.length))}
        </code>
        {mask && (
          <button type="button" onClick={() => setShown((s) => !s)} style={{ ...buttonStyle, padding: "4px 7px" }}>
            {shown ? "HIDE" : "REVEAL"}
          </button>
        )}
        <button type="button" onClick={copy} style={{ ...buttonStyle, padding: "4px 7px", color: copied ? GREEN : TXT }}>
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>
    </div>
  );
}

// ── searchable, sortable table ───────────────────────────────────────────────

export interface TableCell {
  text: string;
  align?: "left" | "right";
  color?: string;
  mono?: boolean;
  /** What this cell sorts by, when the display text is not the right key. */
  sortValue?: number | string;
}

export interface TableRow {
  id: string;
  cells: TableCell[];
  /** Makes the whole row a destination. Drill-down is a row click, not a button. */
  href?: string;
}

/**
 * One table, with the two controls every operator table should have had.
 *
 * Sorting is on the CELL's `sortValue`, never on its rendered text, because the
 * text is formatted — "$1.2M" sorts before "$900k" as a string and an operator
 * ranking their markets by volume would get a silently wrong answer.
 */
export function SortableTable({
  head,
  rows,
  searchPlaceholder,
  emptyTitle = "Nothing here yet",
  emptyBlurb = "This table fills in as the venue does work.",
  initialSort,
  minWidth = 560,
  toolbar,
}: {
  head: { label: string; align?: "left" | "right"; sortable?: boolean }[];
  rows: TableRow[];
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyBlurb?: string;
  /** Column index to sort by on first paint, descending. */
  initialSort?: number;
  minWidth?: number;
  /**
   * An action that belongs to this table, rendered in its filter row.
   *
   * Optional and additive. It exists because "Create key" was sitting in a
   * full-width right-aligned band of its own above the table, which cost 40px of
   * empty console to say one thing and put the action as far from the list it
   * modifies as the layout allowed. A table's action belongs on the table's own
   * toolbar, beside the filter and the row count.
   */
  toolbar?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ index: number; desc: boolean } | null>(
    initialSort === undefined ? null : { index: initialSort, desc: true },
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q === "" ? rows : rows.filter((r) => r.cells.some((c) => c.text.toLowerCase().includes(q)));
    if (!sort) return matched;
    const key = (row: TableRow) => {
      const cell = row.cells[sort.index];
      return cell?.sortValue ?? cell?.text ?? "";
    };
    return [...matched].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.desc ? -cmp : cmp;
    });
  }, [query, rows, sort]);

  const toggle = (index: number) =>
    setSort((s) => (s && s.index === index ? { index, desc: !s.desc } : { index, desc: true }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(searchPlaceholder || toolbar) && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          {searchPlaceholder && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              style={{ ...inputStyle, flex: 1, minWidth: 200 }}
            />
          )}
          {searchPlaceholder && (
            <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>
              {filtered.length === rows.length ? `${rows.length} rows` : `${filtered.length} of ${rows.length}`}
            </span>
          )}
          {toolbar}
        </div>
      )}

      {filtered.length === 0 ? (
        query.trim() === "" ? (
          <EmptyState title={emptyTitle} blurb={emptyBlurb} />
        ) : (
          /* A filter that matched nothing is not the same as a table with nothing
             in it — the fix is to change the query, and the copy says so. */
          <EmptyState
            title="No match"
            blurb={`Nothing in these ${rows.length} rows matches “${query.trim()}”.`}
            action={
              <button type="button" style={buttonStyle} onClick={() => setQuery("")}>
                CLEAR FILTER
              </button>
            }
          />
        )
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth }}>
            <thead>
              <tr>
                {head.map((h, i) => {
                  const align = h.align ?? (i === 0 ? "left" : "right");
                  const on = sort?.index === i;
                  const sortable = h.sortable !== false;
                  return (
                    <th
                      key={h.label || i}
                      aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
                      style={{
                        ...monoLabel(SIZE.micro),
                        color: on ? TXT : DIM,
                        textAlign: align,
                        /* Numeric columns shrink to content, text columns absorb the
                           slack — see `colWidth` in parts.tsx for why this one rule
                           is what makes a wide table scannable. */
                        width: colWidth(align),
                        padding: "0 12px 4px",
                        borderBottom: `1px solid ${L1}`,
                        whiteSpace: "nowrap",
                        fontWeight: 400,
                      }}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => toggle(i)}
                          /*
                           * A 9px label with no padding is a 12px-tall button, and
                           * sorting is the only way to read a seven-column table on
                           * a phone. The label stays the size it was — the button
                           * grows to floor.json's 32px default tier around it, and
                           * the cell gives back 4px of its own padding so the header
                           * row ends up barely taller than before.
                           */
                          style={{
                            ...monoLabel(SIZE.micro),
                            color: "inherit",
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: align === "right" ? "flex-end" : "flex-start",
                            minHeight: TAP_FLOOR,
                          }}
                        >
                          {h.label}
                          {/* A glyph, not a colour — the sort state has to survive
                              a monochrome display and a colour-blind reader. */}
                          <span style={{ color: on ? TXT : "transparent", marginLeft: 4 }}>{sort?.desc ? "↓" : "↑"}</span>
                        </button>
                      ) : (
                        h.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  {row.cells.map((cell, i) => {
                    const align = cell.align ?? (i === 0 ? "left" : "right");
                    const mono = cell.mono ?? true;
                    /* Named `content`, not `body` — `body` is the type-scale helper
                       imported at the top of this file, and shadowing it here is how
                       a later edit in this block silently gets the wrong one. */
                    const content =
                      row.href && i === 0 ? (
                        /* The drill-down affordance, and the ONLY hit area in a row
                           the stylesheet gives a pointer cursor to. At the 15px of
                           its own line box it was the smallest target on the page;
                           it takes the default floor so the row is tappable where it
                           looks tappable. */
                        <Link href={row.href} style={{ color: "inherit", textDecoration: "none", display: "inline-flex", alignItems: "center", minHeight: TAP_FLOOR }}>
                          {cell.text} <span style={{ color: FAINT }}>›</span>
                        </Link>
                      ) : (
                        cell.text
                      );
                    return (
                      <td
                        key={i}
                        style={{
                          ...(mono ? dataType() : body(SIZE.body, 1.5)),
                          color: cell.color ?? NUM,
                          textAlign: align,
                          padding: "8px 12px",
                          borderBottom: `1px solid ${L1}`,
                          whiteSpace: mono ? "nowrap" : "normal",
                        }}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── actions with a consequence ───────────────────────────────────────────────

/**
 * A control that asks you to type the thing you are about to do.
 *
 * Not a modal, and not a two-click confirm. Both are dismissed by muscle memory,
 * which is precisely the failure this guards against — the operator who meant to
 * cancel one order and cancelled every open order on the venue. Typing the phrase
 * cannot be done by accident.
 */
export function ConfirmAction({
  label,
  phrase,
  danger = false,
  consequence,
  disabled,
  disabledReason,
  onConfirm,
}: {
  label: string;
  phrase: string;
  danger?: boolean;
  consequence: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  onConfirm: () => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const tone = danger ? RED : AMBER;

  if (disabled) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button type="button" disabled style={{ ...buttonStyle, color: FAINT, cursor: "not-allowed", opacity: 0.6 }}>
          {label}
        </button>
        {disabledReason && (
          <span style={{ ...body(SIZE.note, 1.55), color: FAINT }}>{disabledReason}</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ ...body(SIZE.body, 1.6), color: MUT }}>{consequence}</div>

      {result ? (
        <div
          style={{
            ...monoLabel(SIZE.micro),
            color: GREEN,
            border: `1px solid ${GREEN}33`,
            background: `${GREEN}0d`,
            borderRadius: R_SM,
            padding: "8px 10px",
            letterSpacing: "0.04em",
            textTransform: "none",
          }}
        >
          {result}
        </div>
      ) : open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ ...monoLabel(SIZE.micro), color: tone }}>
            TYPE {phrase} TO CONFIRM
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={typed}
              autoFocus
              onChange={(e) => setTyped(e.target.value)}
              placeholder={phrase}
              aria-label={`Type ${phrase} to confirm`}
              style={{ ...inputStyle, flex: 1, minWidth: 150 }}
            />
            <button
              type="button"
              disabled={typed.trim().toUpperCase() !== phrase || busy}
              onClick={async () => {
                setBusy(true);
                setResult(await onConfirm());
                setBusy(false);
                setOpen(false);
                setTyped("");
                /* The confirmation clears itself. A halt is followed by a resume
                   often enough that leaving the receipt on screen forever would
                   lock the operator out of the control they most need next. Long
                   enough to read, short enough not to strand them. */
                setTimeout(() => setResult(null), 8_000);
              }}
              style={{
                ...buttonStyle,
                color: typed.trim().toUpperCase() === phrase ? tone : FAINT,
                border: `1px solid ${typed.trim().toUpperCase() === phrase ? `${tone}66` : L3}`,
                background: typed.trim().toUpperCase() === phrase ? `${tone}14` : SUNK,
                cursor: typed.trim().toUpperCase() === phrase ? "pointer" : "not-allowed",
              }}
            >
              {busy ? "WORKING…" : label}
            </button>
            <button type="button" style={buttonStyle} onClick={() => { setOpen(false); setTyped(""); }}>
              CANCEL
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          /* Halting the venue and cancelling every open order are the isolated
             primary actions on this console, so they take the 44px tier rather
             than the default floor — floor.json's `submit` tier is exactly this
             case: the control you must not miss. */
          style={{ ...buttonStyle, color: tone, border: `1px solid ${tone}55`, background: `${tone}0d`, alignSelf: "flex-start", minHeight: TAP_PRIMARY }}
        >
          {label}
        </button>
      )}
    </div>
  );
}

/** A plain async button, for actions whose worst case is a wasted request. */
export function ActionButton({
  label,
  primary = false,
  onRun,
}: {
  label: string;
  primary?: boolean;
  onRun: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const base: CSSProperties = primary ? primaryButtonStyle : buttonStyle;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
      <button
        type="button"
        disabled={busy}
        style={{ ...base, opacity: busy ? 0.6 : 1 }}
        onClick={async () => {
          setBusy(true);
          setResult(await onRun());
          setBusy(false);
        }}
      >
        {busy ? "…" : label}
      </button>
      {result && <span style={{ ...body(SIZE.note, 1.6), color: MUT }}>{result}</span>}
    </div>
  );
}

/**
 * A CSV export that carries its provenance out of the console with it.
 *
 * PACKAGING.md §6 is specific about this: "every export carries the same labels,
 * so a number that leaves the console cannot lose its provenance on the way to a
 * spreadsheet." A bare CSV of figures is exactly how an estimate becomes a
 * forecast in someone else's model, so the header block is not optional and the
 * per-row provenance column is not decoration.
 */
export function ExportCsv({
  filename,
  header,
  rows,
  provenance,
  label = "EXPORT CSV",
}: {
  filename: string;
  header: string[];
  rows: (string | number)[][];
  /** One line per figure class, written into the file above the table. */
  provenance: string[];
  label?: string;
}) {
  const [done, setDone] = useState(false);

  const download = () => {
    const escape = (cell: string | number) => {
      const text = String(cell);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const body = [
      ...provenance.map((line) => `# ${line}`),
      `# exported ${new Date().toISOString()}`,
      header.join(","),
      ...rows.map((row) => row.map(escape).join(",")),
    ].join("\n");

    const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  };

  return (
    <button type="button" style={buttonStyle} onClick={download}>
      {done ? "DOWNLOADED" : label}
    </button>
  );
}

/** POST to the console's own admin API and turn the answer into one line. */
export async function postAdmin(path: string, body?: unknown): Promise<string> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await response.json()) as { message?: string; error?: string };
    if (!response.ok) return data.error ?? `failed with ${response.status}`;
    return data.message ?? "done";
  } catch (cause) {
    return cause instanceof Error ? cause.message : "the request could not be sent";
  }
}
