/*
 * The first-run checklist.
 *
 * A venue's day one has no flow, no traders and no fee — which is exactly the
 * state the rest of this console has nothing to say about. The dashboards assume
 * data exists; this panel is what the operator reads before any does.
 *
 * Every item is DERIVED, never authored. It reads the same config, environment
 * and live snapshot the rest of the console reads, so it cannot drift into
 * congratulating an operator for something they have not done. That is the whole
 * difference between a checklist and a marketing panel.
 *
 * Ordered by dependency, not by importance: an item that unblocks three others
 * comes first even when a later one matters more. And every incomplete item names
 * the consequence of leaving it — "not set" is a state, not a reason.
 *
 * COLLAPSED BY DEFAULT, and that is a judgement about whose screen this is. Setup
 * is read closely once and then never again, while the Overview is the page an
 * operator leaves open — so a checklist that keeps its full height forever charges
 * every future visit for a task already finished. The summary line stays visible
 * because the count is the part that stays useful; the reasoning is one click away.
 *
 * `<details>` rather than state: it needs no JavaScript, it is keyboard-operable
 * and screen-reader-announced for free, and this file stays a server component.
 */

import type { ReactNode } from "react";

import { ARCHIVO, FAINT, GREEN, L1, L2, MUT, R_SM, SUNK, TXT, monoLabel } from "@/lib/theme";
import { SIZE, body } from "./type";

export interface ChecklistItem {
  label: string;
  /* Two states, and both are the operator's. A third state for "waiting on
     somebody else" used to live here; a row nobody on this side can clear is not
     a checklist item, and it taught the reader to stop clearing rows. */
  state: "done" | "todo";
  /** Why it matters, or what breaks without it. Never "recommended". */
  detail: string;
  /** Where to go. Omitted when there is nowhere useful to send them. */
  action?: ReactNode;
}

export function Checklist({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.state === "done").length;
  const actionable = items.filter((i) => i.state === "todo").length;

  /* Closed always, including when work remains. The count in the summary is the
     call to action — "2 to do" is the whole message, and auto-opening to
     restate it in eight rows would put the panel back to the height this change
     exists to remove. */
  const pct = (done / Math.max(1, items.length)) * 100;

  return (
    <details style={{ display: "block" }}>
      <summary
        className="nx-summary"
        style={{
          display: "flex",
          alignItems: "center",
          /* The three parts total 439px and the panel on a 375px phone offers 309,
             so the count and the DETAIL affordance were clipped off the right edge
             — the two pieces of this summary that carry the message. Wrapping is
             the right yield here: the bar is the only part that can lose width
             without losing meaning, and when even that is not enough the count
             drops to a second line rather than off the panel. */
          flexWrap: "wrap",
          gap: 12,
          cursor: "pointer",
          listStyle: "none",
          padding: "2px 0",
        }}
      >
        {/* The bar is 220px, not the panel's full 1,180. A progress bar is read as a
            proportion, and a proportion does not get more legible with width — at full
            panel width 2/8 was a short stub floating in a metre of track, with its own
            count stranded at the far right where nothing connects the two.
            220 is now a maximum rather than a fixed width, for the same reason: a
            proportion stays readable at 90px and does not survive being clipped. */}
        <div style={{ flex: "1 1 90px", maxWidth: 220, height: 5, background: L1, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: GREEN, opacity: 0.8 }} />
        </div>
        <span style={{ ...monoLabel(SIZE.micro), color: FAINT, whiteSpace: "nowrap" }}>
          {done}/{items.length} done
          {actionable > 0 ? ` · ${actionable} to do` : " · nothing waiting on you"}
        </span>
        <span aria-hidden="true" style={{ ...monoLabel(SIZE.micro), color: FAINT, marginLeft: "auto" }}>
          DETAIL
        </span>
      </summary>

      <div style={{ marginTop: 13 }}>
      {/*
       * DONE ITEMS COLLAPSE. Eight bordered cards, each carrying a two-line
       * rationale, filled the Overview's entire first screen — and half of them said
       * some version of "this is fine". A finished item does not need to argue; it
       * needs to be countable. So `done` prints one line and no detail, and the space
       * that frees goes to the items that still want a decision.
       *
       * One container with hairline rows, not eight cards. A card is a boundary
       * around something you might act on independently; a checklist is one thing
       * read top to bottom, and eight boxes made the eye re-enter at every row.
       */}
      <div style={{ border: `1px solid ${L2}`, borderRadius: R_SM, background: SUNK, overflow: "hidden" }}>
        {items.map((item, i) => (
          <div
            key={item.label}
            className="nx-row"
            /* The evidence behind a done item ("read in 488ms") is not deleted, only
               folded — every item here is derived, and an operator who wants to know
               WHY the console thinks something passed can still get the sentence. */
            title={item.state === "done" ? item.detail : undefined}
            style={{
              display: "grid",
              gridTemplateColumns: "16px 1fr auto",
              gap: 11,
              alignItems: item.state === "done" ? "center" : "start",
              padding: item.state === "done" ? "7px 12px" : "10px 12px",
              borderTop: i === 0 ? "none" : `1px solid ${L1}`,
            }}
          >
            {/* A glyph, not a colour — a tick and an empty box are legible on a
                monochrome display and to a colour-blind reader alike. */}
            <span
              aria-hidden="true"
              style={{
                fontFamily: "inherit",
                fontSize: SIZE.body,
                lineHeight: "17px",
                color: item.state === "done" ? GREEN : FAINT,
              }}
            >
              {item.state === "done" ? "✓" : "□"}
            </span>

            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <span
                style={{
                  fontFamily: ARCHIVO,
                  fontSize: SIZE.body,
                  fontWeight: 500,
                  color: item.state === "done" ? MUT : TXT,
                }}
              >
                {item.label}
              </span>
              {item.state !== "done" && (
                <span style={{ ...body(SIZE.note, 1.55), color: FAINT }}>{item.detail}</span>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {/* NOT YOURS pill removed with the blocked state. */}
              {item.state === "todo" && item.action}
            </div>
          </div>
        ))}
        </div>
      </div>
    </details>
  );
}
