"use client";

/*
 * A code block with tabs.
 *
 * The three ways to place an order — typed SDK, raw HTTP, agent tool call — are the
 * same contract, and stacking all three costs a screenfull to say so. Tabs say it in
 * one: the reader picks their language and the block that answers is the same height
 * as the one before it.
 *
 * The tab strip IS the block's title bar rather than a control above it, so the frame
 * matches every other code sample on the page and the tabs cannot read as page
 * navigation.
 *
 * Every panel is rendered and the inactive ones are hidden with `hidden`, not
 * unmounted. Two reasons, and neither is performance: the block keeps one height as
 * you switch, and a reader who lands here from a search finds text that is actually
 * in the document.
 */

import { useState } from "react";

import { ARCHIVO, CHROME, DIM, HI, L1, L2, SEL, SUNK } from "@/lib/theme";

import type { Lang } from "@/lib/highlight";

import { CodeBody } from "./primitives";

/**
 * `lang` is per tab because the whole point of the strip is that the tabs are
 * DIFFERENT clients — TypeScript beside curl beside an agent invocation. It used to
 * be absent, so every tab rendered plain: the one component on the page whose
 * content is most obviously code was the one piece of code with no colour in it.
 */
export type CodeTab = { id: string; label: string; lines: string[]; lang?: Lang };

export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(tabs[0].id);

  return (
    <div style={{ background: SUNK, border: `1px solid ${L2}`, borderRadius: 8, overflow: "hidden", minWidth: 0 }}>
      <div
        role="tablist"
        aria-label="Place an order"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "6px 8px",
          borderBottom: `1px solid ${L1}`,
          background: CHROME,
          /* Four labels at 390px: scroll the strip rather than wrap the frame. */
          overflowX: "auto",
        }}
      >
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`nx-code-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`nx-code-panel-${t.id}`}
              onClick={() => setActive(t.id)}
              /* The height comes from `.nx-segmented` and must NOT be repeated inline.
                 It was `minHeight: 30` here, which is the exact failure globals.css
                 documents against that class: an inline value outranks the media query
                 that raises the segmented tier to 36px on a touch surface, so these
                 tabs stayed 30px on a phone against a 36px floor. */
              className="nx-segmented"
              style={{
                flex: "0 0 auto",
                padding: "0 12px",
                border: `1px solid ${on ? L2 : "transparent"}`,
                borderRadius: 5,
                background: on ? SEL : "transparent",
                color: on ? HI : DIM,
                fontFamily: ARCHIVO,
                fontWeight: 600,
                fontSize: 12.5,
                whiteSpace: "nowrap",
                cursor: "pointer",
                transition: "color 0.15s, background 0.15s, border-color 0.15s",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`nx-code-panel-${t.id}`}
          aria-labelledby={`nx-code-tab-${t.id}`}
          hidden={t.id !== active}
          style={{ minWidth: 0 }}
        >
          <CodeBody lines={t.lines} lang={t.lang} />
        </div>
      ))}
    </div>
  );
}
