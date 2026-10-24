/*
 * The config, and the venue it produced.
 *
 * WHY THIS IS THE PAGE'S BEST ARGUMENT. Everything else here either asserts the
 * loop ("write a config, get a venue") or shows one half of it. The config sample
 * and the product captures already existed — in different bands, three screenfuls
 * apart — so a reader never saw cause beside effect and had to take the connection
 * on trust. Trust is the one thing a landing page cannot ask for.
 *
 * THE TRACE LINES ARE THE WHOLE DEVICE. Four keys in that file are visible in the
 * capture beside it: the venue's name is the wordmark, the palette hex is the
 * accent on every mark and control, `feeBps: 2` is inside the maker/taker pair the
 * order ticket quotes, and the legal entity is what the disclosure names. Naming the
 * correspondence turns two adjacent images into a demonstration — without it a
 * reader sees a code block and a screenshot and has no reason to connect them.
 *
 * It also quietly proves the harder claim. If a value typed in a file reaches an
 * order ticket, then "one build, many brands" is not an architecture diagram; it is
 * the thing on screen.
 */

import { FAINT, HI, L1, L2, MONO, MUT, PANEL, TXT } from "@/lib/theme";

import { Code } from "./primitives";
import { Frame, Shot, type ShotSpec } from "./Frame";

const NEXUS_JSON = [
  "{",
  '  "name": "Acme Perps",',
  '  "domains": ["trade.acme.xyz"],',
  '  "markets": ["BTC", "ETH", "SOL", "GOLD"],',
  '  "brand": {',
  '    "wordmark": "./brand/acme.svg",',
  '    "palette": { "green": "#22d3ee", "bg": "#07070c" }',
  "  },",
  "[dim]  // additive, kept in full, your price to set",
  '  "builder": { "code": "bld_acme", "feeBps": 2 },',
  '  "legal": { "entity": "Acme Markets Ltd" }',
  "}",
];

/** Each key, and the thing it becomes. Both halves are on screen above. */
const TRACE: { key: string; became: string }[] = [
  { key: "name", became: "the wordmark, top left" },
  { key: "brand.palette", became: "every accent, mark and control" },
  { key: "builder.feeBps", became: "the fee on the ticket, all-in" },
  { key: "legal.entity", became: "the venue's own disclosure" },
];

const VENUE: ShotSpec = {
  src: "/product/terminal-acme.png",
  alt: "The Acme Perps trading terminal produced by the configuration file beside it: an ACME wordmark, a cyan accent throughout, an order book and candle chart, and an order ticket quoting a single maker and taker rate that already includes the venue's own fee.",
};

export function ConfigToVenue() {
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "grid",
          /* Deliberately not 50/50: the file is narrow and the venue is the payoff,
             so the capture takes the larger half and the config reads as its input. */
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
          gap: 20,
          alignItems: "start",
        }}
      >
        <Code title="nexus.json" lines={NEXUS_JSON} />
        <Frame label="Acme Perps · what that file built" meta="the running app">
          {/* Half-width in this pair, so the sizes hint stops the optimiser
              serving a full-bleed derivative nothing here displays. */}
          <Shot spec={VENUE} sizes="(min-width: 1220px) 560px, 96vw" />
        </Frame>
      </div>

      {/* The correspondence, stated. A rule and a row per key — the same margin-label
          geometry the rest of the page uses for a qualifier, because that is what
          this is: the qualifier that makes the two panels above mean something. */}
      <div style={{ borderTop: `1px solid ${L2}`, paddingTop: 14 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 1,
            background: L1,
            border: `1px solid ${L2}`,
          }}
        >
          {TRACE.map((t) => (
            <div
              key={t.key}
              style={{
                background: PANEL,
                padding: "12px 14px",
                display: "grid",
                gap: 5,
                minWidth: 0,
              }}
            >
              <code style={{ fontFamily: MONO, fontSize: 11.5, color: HI }}>{t.key}</code>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>
                <span aria-hidden="true">→ </span>
                {t.became}
              </span>
            </div>
          ))}
        </div>
        <p
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            lineHeight: 1.7,
            color: MUT,
            margin: "12px 0 0",
            maxWidth: "80ch",
          }}
        >
          No fork, no theme layer, no per-tenant branch. One token module reads the file, and every surface —
          terminal, order ticket, console, disclosure — follows it.{" "}
          <span style={{ color: TXT }}>Change the palette, redeploy, and the whole venue changes with it.</span>
        </p>
      </div>
    </div>
  );
}
