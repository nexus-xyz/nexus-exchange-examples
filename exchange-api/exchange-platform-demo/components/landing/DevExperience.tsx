/*
 * Testing — the four fidelity tiers and the client surface.
 *
 * IT IS THE TESTING SECTION NOW, and the rename is a sequencing decision rather than
 * a cosmetic one. This used to be "Developer experience", which competed with the
 * stack section immediately before it for the same reader and the same question. The
 * stack answers "what am I running"; this answers "how do I know it works before I
 * point it at real money" — and that is the last thing a technical buyer needs before
 * the FAQ, not a general-purpose developer pitch.
 *
 * The tier table leads because it is the part of this platform a serious
 * integrator evaluates first and the part competitors are thinnest on. A faucet
 * gives you fake money; only the middle tier gives you a liquidation you can
 * reproduce on demand, and that is the argument to make for it rather than
 * "another environment".
 *
 * THE TITLE SAYS "testing tiers" rather than "tiers" because the eyebrow above it is
 * 9px and the title is the first thing actually read. A title that needs its own
 * label to be understood has put the label in the wrong place.
 */

import { CHROME, DIM, L1, L2, MONO, MUT, SUNK, TXT } from "@/lib/theme";

import { CodeTabs } from "./CodeTabs";
import {
  Band,
  Head,
  css as s,
  annotation,
  body,
  display,
  eyebrow,
} from "./primitives";

const TIERS: { tier: string; cmd: string; data: string; money: string; note: string }[] = [
  {
    tier: "Local",
    cmd: "NEXUS_NETWORK=local",
    data: "mock data, no backend",
    money: "none",
    note: "The whole terminal on your machine, with no backend behind it.",
  },
  {
    tier: "Sandbox",
    cmd: "NEXUS_NETWORK=sandbox",
    data: "the real matching engine",
    money: "test funds",
    note: "One market, paced clock, and a liquidation you can trigger on demand.",
  },
  {
    tier: "Test",
    cmd: "NEXUS_NETWORK=testnet",
    data: "testnet, shared book",
    money: "synthetic USDX, faucet",
    note: "The real book with test funds — its own balances and its own keys.",
  },
  {
    tier: "Live",
    cmd: "NEXUS_NETWORK=mainnet",
    data: "mainnet, shared book",
    money: "real",
    note: "Mainnet, real collateral, real settlement. The same wire protocol as every tier above it.",
  },
];

const SDK = [
  '[dim]// npm i @nexus-xyz/exchange-ts',
  'import { ExchangeClient } from "@nexus-xyz/exchange-ts";',
  "",
  "const nexus = new ExchangeClient({",
  "  baseUrl: process.env.NEXUS_API_URL,",
  "  keyId:   process.env.NEXUS_API_KEY_ID,",
  "  secret:  process.env.NEXUS_API_SECRET,",
  "});",
  "",
  "await nexus.placeOrder({",
  '  market: "BTC-USDX-PERP",',
  '  side:   "buy",',
  '  type:   "limit",',
  '  price:  "64250.0",',
  '  size:   "0.25",',
  "});",
  "",
  "[dim]// Your builder fee is disclosed on the ticket and accrued against",
  "[dim]// the fee schedule in your nexus.json, up to the 10 bps ceiling.",
];

const HTTP = [
  "[dim]# public reads need no key at all",
  "$ curl https://api.nexus.xyz/v1/markets",
  "",
  "[dim]# authenticated calls carry exactly three headers. the string",
  "[dim]# that gets signed is fixed and documented:",
  "[dim]#   <ts_ms>\\n<METHOD>\\n<path>\\n<query>\\n<sha256hex(body)>",
  '$ curl -X POST "$NEXUS_API_URL/v1/orders" \\',
  '    -H "x-api-key:   $KEY_ID" \\',
  '    -H "x-timestamp: $TS" \\',
  '    -H "x-signature: $SIG" \\',
  "    -d '{\"market\":\"BTC-USDX-PERP\",\"side\":\"buy\",",
  '         "type":"limit","price":"64250.0","size":"0.25"}\'',
  "",
  "[dim]# in the terminal this is signed in the browser, by the trader's",
  "[dim]# own delegated key. it can place and cancel; it cannot withdraw",
  "[dim]# or transfer — which is why it is safe where it lives.",
];

const AGENT = [
  "[dim]# the same contract, for something that is not a browser",
  "$ curl https://api.nexus.xyz/llms.txt",
  "$ npx @nexus-xyz/exchange-mcp",
  "",
  "[dim]# hosted MCP endpoint",
  "  mcp.exchange.nexus.xyz",
  "",
  "[dim]# an agent gets delegated, trade-only keys — capped in number",
  "[dim]# and unable to withdraw. not a copy of your venue key.",
];


function TierRow({ t, last }: { t: (typeof TIERS)[number]; last: boolean }) {
  return (
    <div style={{ borderBottom: last ? undefined : `1px solid ${L1}`, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <span style={{ ...display.xs, fontSize: 14, minWidth: 76 }}>{t.tier}</span>
        <code style={{ fontFamily: MONO, fontSize: 11.5, color: TXT }}>{t.cmd}</code>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", marginTop: 8 }}>
        <span style={annotation(MUT, 11)}>{t.data}</span>
        <span style={annotation(DIM, 11)}>money: {t.money}</span>
      </div>
      <div style={{ ...body, fontSize: 13, marginTop: 8 }}>{t.note}</div>
    </div>
  );
}

export function DevExperience() {
  return (
    <Band id="dx">
      <Head
        eyebrow="Testing"
        title="Four testing tiers, and going live is a base-URL change."
        blurb="One environment variable picks the tier, and every tier speaks the same wire protocol as production — so nothing you write for one gets thrown away at the next."
      />

      <div
        className={s.reveal}
        style={{ background: SUNK, border: `1px solid ${L2}`, borderRadius: 8, overflow: "hidden" }}
      >
        <div style={{ padding: "11px 16px", borderBottom: `1px solid ${L1}`, background: CHROME, ...eyebrow() }}>
          Environments
        </div>
        {TIERS.map((t, i) => (
          <TierRow key={t.tier} t={t} last={i === TIERS.length - 1} />
        ))}
      </div>

      {/*
        The code tabs run full width now. Two cards used to sit beside them:

        "Reproducible on purpose" went in the concision pass — it was a paragraph
        explaining the tier table two inches above it.

        "The guardrail" went because it is not a landing-page argument. It is a good
        piece of engineering (network-scoped keys against non-scoped signatures, and a
        template that refuses to start when the declared network and the base URL
        disagree), but a reader deciding whether to build on this platform is not yet
        asking how key scoping fails. It belongs in the security docs, where the reader
        arrives already asking.
      */}
      <div className={s.reveal} style={{ marginTop: 22 }}>
        {/* One order, three clients, one tab strip: the argument is that they are the
            same contract, and three stacked blocks argue the opposite. */}
        <CodeTabs
          tabs={[
            { id: "ts", label: "TypeScript", lines: SDK, lang: "ts" },
            /* Both of these are a shell transcript rather than a wire dump — a `$`
               prompt, `#` comments and curl — so they take the bash grammar and not
               the http one, which is for a request as it appears on the wire. */
            { id: "http", label: "HTTP", lines: HTTP, lang: "bash" },
            { id: "agent", label: "Agent", lines: AGENT, lang: "bash" },
          ]}
        />
      </div>

      {/* An SDKs / MCP / llms.txt strip stood here, and was triply stated: the Agent code
          tab immediately to its left literally renders `curl api.nexus.xyz/llms.txt` and
          `npx @nexus-xyz/exchange-mcp`, Capabilities has the same three as cells with links,
          and the hero rail says "plus Rust, Python, CLI, MCP." */}

      {/*
        The quality floor — eight cells naming the checks that block a merge — stood
        here, and it goes for the same reason as the guardrail: it is a good answer to
        a question this reader has not asked yet. Our CI gates are our problem, and a
        venue operator evaluating the platform is buying the OUTCOME of them, which the
        tier table above already demonstrates.

        NOTE, because it went with the block rather than being decided on its own: the
        floor's trailing paragraph carried the page's only statement that the app ships
        in English and formats currency-aware rather than locale-aware. That is a real
        limitation and it now appears nowhere. It wants a home in the FAQ.
      */}

      {/* A note on which CLI commands ship today stood here. It was our delivery
          status rather than a property of the product. */}
    </Band>
  );
}
