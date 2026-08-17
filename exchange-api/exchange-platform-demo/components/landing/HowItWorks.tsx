/*
 * How it works — the config, the division of labour, and the honest caveat.
 *
 * THE DIAGRAM IS GONE, and its absence is the point. The hero now animates exactly
 * the claim that diagram was drawing — four sources fanning into one book — and
 * repeating it as a static SVG two screens later was the page telling the same joke
 * twice, in the worse medium. What is left is the part the picture was bad at: what
 * sits on which side of the line, and what each side is answerable for.
 *
 * So this section is a LEDGER. Two columns, yours and ours, one rule between them,
 * every row a concern with an owner. It is the shape the argument actually has, and
 * it is a different texture from every other band on the page.
 */

import { DIM, FAINT, HI, L1, L2, MONO, MUT, PANEL, SUNK, TXT } from "@/lib/theme";

import { Band, Head, Prose, Strong, css as s, annotation, eyebrow } from "./primitives";
import { ConfigToVenue } from "./ConfigToVenue";


/** Every concern a perpetuals venue has, and which side of the line it falls on. */
const LEDGER: { concern: string; mine: boolean; detail: string }[] = [
  { concern: "Brand, domain, customer", mine: true, detail: "Yours, and never routed through us" },
  { concern: "The interface", mine: true, detail: "Our template, your repository, your hosting" },
  { concern: "The fee on top", mine: true, detail: "You set it and you keep it, up to 10 bps" },
  /* This row used to sit in the Yours column and read "your proxy holds the key; a
     browser never does". The credential moved: the trader holds a delegated key in
     their own browser that can trade and cannot withdraw, so the venue holds nothing
     and runs no server in the order path. The row changed columns because the burden
     did. */
  { concern: "Credentials and signing", mine: false, detail: "The trader's delegated key, in their own browser" },
  { concern: "Order book and matching", mine: false, detail: "One central CLOB per market" },
  { concern: "Risk, margin, funding, liquidation", mine: false, detail: "Ours to run and to answer for" },
  /* The ONE place on this page that names the settlement layer. Positioning limits it
     to a single mention, and this ledger is the right one — a row about who owns
     settlement is where a reader is actually asking. The FAQ and the comparison
     table both used to repeat it; they now say "the exchange". */
  { concern: "Collateral and settlement", mine: false, detail: "On the Exchange blockchain" },
  { concern: "Market making", mine: false, detail: "Exchange-owned, behind the same book" },
];

export function HowItWorks() {
  return (
    <Band id="how" tone="raised">
      <Head
        eyebrow="How it works"
        title="How a config file becomes a live venue."
        /* The blurb argued the shared book, and then the Prose twenty lines below argued it
           again at length and better. Two statements of one thing inside one section. */
        /* The blurb used to open "A file you commit, and the venue it produces", which is
           now what the title says. */
        blurb="Every branded frontend is a client of one API in front of one book per market."
      />


      {/* ASSETS FIRST. This section used to open with a table and three prose steps
          and reach the demonstration last — so a reader met the explanation of a loop
          three times before seeing it happen once. The file and the venue it built now
          come immediately after the headline, and everything below them is a caption
          on something already shown. */}
      <div className={s.reveal} style={{ marginTop: 30 }}>
        <ConfigToVenue />
      </div>

      {/* The counter to the category's standard answer. This is the one paragraph
          rescued from a "the problem" section that was cut: a builder who has
          decided to deploy an exchange does not need to be told where venues fail,
          but they do need to know why a pool of their own is the wrong prize. It
          belongs here, beside the thing it is arguing for. */}
      <Prose style={{ marginTop: 26 }}>
        The usual offer — <Strong>&ldquo;we&rsquo;ll give you your own liquidity pool&rdquo;</Strong> — is
        fragmentation with extra steps. Ten venues on ten pools have a tenth of the depth each, and the trader
        pays for it in slippage. The only structure that escapes that is one book every venue shares, and it has
        to be the <span style={{ color: HI }}>same book</span> — not a routed aggregate of ten thin ones.
      </Prose>

      <div className={s.reveal} style={{ marginTop: "clamp(30px, 4vw, 48px)" }}>
        {/* The ledger. Ownership is the argument, so ownership is the layout. */}
        <div style={{ background: SUNK, border: `1px solid ${L2}`, borderRadius: 8, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 12,
              padding: "11px 16px",
              borderBottom: `1px solid ${L2}`,
              background: PANEL,
              ...eyebrow(),
            }}
          >
            <span>Concern</span>
            <span>Owner</span>
          </div>
          {LEDGER.map((row) => (
            <div
              key={row.concern}
              className={s.rowHover}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 14,
                alignItems: "center",
                padding: "12px 16px",
                borderTop: `1px solid ${L1}`,
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: TXT }}>{row.concern}</span>
                <span style={{ ...annotation(FAINT, 10.5), display: "block", marginTop: 4 }}>{row.detail}</span>
              </span>
              <span
                style={{
                  ...eyebrow(row.mine ? TXT : DIM),
                  fontSize: 9.5,
                  padding: "4px 8px",
                  borderRadius: 3,
                  border: `1px solid ${L2}`,
                  background: row.mine ? PANEL : "transparent",
                  whiteSpace: "nowrap",
                }}
              >
                {row.mine ? "Yours" : "Ours"}
              </span>
            </div>
          ))}
          {/* A green footer strip here said "your fee is added on top of ours, never carved
              out of it" — four rows under the ledger row that already says "You set it and
              you keep it." Same component, same claim, twice. */}
        </div>
      </div>

      {/* A "Two caveats" note stood here. Both caveats were literal duplicates of FAQ
          entries — the testnet one shares its exact phrasing, and the sub-accounts one is
          said better there ("verified in the code, not assumed"). The honesty survives in
          the accordion, which is the surface a reader searches. */}
    </Band>
  );
}
