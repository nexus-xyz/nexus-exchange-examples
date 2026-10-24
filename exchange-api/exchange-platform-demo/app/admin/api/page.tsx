/*
 * API reference — the two surfaces a venue deals with, told apart.
 *
 * Generated from the capability catalogue rather than written prose, so a
 * capability cannot appear here without a state beside it. The state pill is the
 * point of the page: LIVE and GATED call for different integration work, and a
 * developer who learns that from a 401 has been misled by documentation.
 *
 * WHY SUB-PANES. This was one page carrying a quick start, the whole signing
 * contract, and two catalogues totalling ~60 rows — about seven screens on a
 * phone, and the two catalogues are the part a developer returns to daily while
 * the signing contract is the part they read once. Four tabs put each at its own
 * address, which also means a colleague can be sent to the *exchange* catalogue
 * rather than to the top of a page with an instruction to scroll.
 *
 * WHAT ARRIVED FROM KEYS: the shell reproduction of a signature. It was on the
 * credentials pane, two panels away from the canonical string it reproduces —
 * the only piece of reference documentation on that page, and the one thing a
 * developer with a 401 wants next to the rules.
 *
 * WHAT IS DELIBERATELY NOT HERE: per-endpoint call volumes from your own
 * traffic. It is tempting — the data exists — and it would put a chart on a
 * reference page whose job is to say what exists and in what state, not how much
 * you used it. That question has a pane: Logs.
 */

import Link from "next/link";

import { ACTIVE_TENANT } from "@/lib/tenant";
import { envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import {
  EXCHANGE_API,
  STATE_LABEL,
  VENUE_ADMIN_API,
  countByState,
  type CapabilityGroup,
} from "@/lib/venue/api-catalog";
import { Code, CodeBlock, Grid, Note, PageHead, Panel, Pill } from "@/components/admin/shell";
import { SubPane, resolveSubPane, subPaneHref } from "@/components/admin/subpane";
import { SIZE, body, data as dataType } from "@/components/admin/type";
import { DIM, FAINT, L1, MUT, TXT, monoLabel } from "@/lib/theme";

export const dynamic = "force-dynamic";

const TONE = { live: "good", gated: "warn" } as const;

const PANES = [
  { id: "start", label: "Quick start" },
  { id: "signing", label: "Signing" },
  { id: "exchange", label: "Exchange API" },
  { id: "admin", label: "Venue admin API" },
] as const;

export default async function ApiPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string; tab?: string }>;
}) {
  const { env: rawEnv, tab } = await searchParams;
  const env = resolveEnv(rawEnv);
  const pane = resolveSubPane(PANES, tab);

  const exchange = countByState(EXCHANGE_API);
  const admin = countByState(VENUE_ADMIN_API);
  const prefix = ACTIVE_TENANT.id === "nexus" ? "nx" : ACTIVE_TENANT.id;

  const hrefFor = (id: string) =>
    subPaneHref("/admin/api", id, { env: env === "live" ? "live" : undefined });

  return (
    <>
      {/* CUT: the page blurb. The two surfaces are two named tabs, and each
          catalogue row carries its own state pill. */}
      <PageHead
        eyebrow="BUILD · TWO SURFACES"
        title="API reference"
        right={
          <div style={{ display: "flex", gap: 6 }}>
            <Pill tone="good">{exchange.live + admin.live} live</Pill>
            {/* GATED is only worth a header count when there is one to show —
                a zero pill beside the live count reads as a missing feature. */}
            {exchange.gated + admin.gated > 0 && (
              <Pill tone="warn">{exchange.gated + admin.gated} gated</Pill>
            )}
          </div>
        }
      />

      <SubPane
        panes={PANES}
        active={pane}
        hrefFor={hrefFor}
        title={
          pane === "start"
            ? "Quick start"
            : pane === "signing"
              ? "Request signing"
              : pane === "exchange"
                ? "Exchange API"
                : "Venue admin API"
        }
        /* Kept only where the subtitle carries a fact the title cannot: the 401
           consequence, and the spec version and operation count. */
        blurb={
          pane === "signing"
            ? "Three details, each a 401 if wrong."
            : pane === "exchange"
              ? "openapi.json 0.8.1 · 96 operations"
              : undefined
        }
      >
        {pane === "start" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Grid min={300}>
              <Panel title="Public reads" blurb="No key, no rate-limit budget spent.">
                <CodeBlock label="TYPESCRIPT">{`import { Client } from "@nexus-xyz/exchange-ts";

const client = new Client();          // public reads, no key
const markets = await client.fetchMarketSummaries();
const book = await client.fetchOrderBook("BTC-USDX-PERP");`}</CodeBlock>
              </Panel>

              <Panel title="Signed calls" blurb="The venue proxy holds the secret; the browser never does.">
                <CodeBlock label="TYPESCRIPT">{`const client = new Client({
  network: Network.Testnet,           // play funds
  apiKey: process.env.NEXUS_API_KEY_ID,
  apiSecret: process.env.NEXUS_API_SECRET,
});

const { order } = await client.placeOrder({
  market_id: "BTC-USDX-PERP",
  side: "Buy", order_type: "Limit",
  price: "65000", quantity: "0.1",
  time_in_force: "GTC",
});`}</CodeBlock>
              </Panel>
            </Grid>

            {/* Kept: the secret-shown-once claim and the two next destinations. */}
            <Note tone="info" label="NEXT">
              Mint the key on{" "}
              <Link href={envHrefFor("/admin/keys", env)} style={{ color: TXT }}>
                Keys
              </Link>{" "}
              — the secret is shown once. A 401 is one of the three rules under Signing;{" "}
              <Link href={envHrefFor("/admin/logs", env)} style={{ color: TXT }}>
                Logs
              </Link>{" "}
              shows whether the call arrived at all.
            </Note>
          </div>
        )}

        {pane === "signing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <CodeBlock label="CANONICAL STRING">{`<timestamp_ms>\\n<METHOD>\\n<path>\\n<query>\\n<sha256hex(body)>`}</CodeBlock>
            <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                <>
                  <Code>path</Code> is the <strong>full</strong> path the server sees, prefix included — sign{" "}
                  <Code>/api/v1/orders</Code>, not <Code>/orders</Code>.
                </>,
                <>
                  The secret is hex. Decode it to 32 bytes first; signing the hex <em>text</em> produces a
                  well-formed signature that is always rejected.
                </>,
                <>
                  An empty body still contributes <Code>sha256hex(&quot;&quot;)</Code>, and an empty query is an
                  empty line. Neither line is omitted.
                </>,
                <>
                  Keys are network-scoped; signatures are not. The same signed request is byte-identical on both
                  networks — never replay across them.
                </>,
              ].map((item, i) => (
                <li key={i} style={{ ...body(SIZE.body, 1.65), color: MUT }}>
                  {item}
                </li>
              ))}
            </ul>
            <CodeBlock label="HEADERS">{`x-api-key:    ${prefix}_test_a1b2c3…
x-timestamp:  1760000000000        // within 30s of server time
x-signature:  hex(hmac_sha256(secret, canonical))`}</CodeBlock>

            {/* Moved from /admin/keys. A developer holding a 401 wants to
                reproduce the server's check from a shell, and the place to do
                that is beside the canonical string it rebuilds — not two panels
                below a table of credentials. */}
            <CodeBlock label="BASH">{`TS=$(date +%s000)
BODY='{"market_id":"BTC-USDX-PERP","side":"Buy"}'
HASH=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
CANON=$(printf '%s\\nPOST\\n/api/v1/orders\\n\\n%s' "$TS" "$HASH")
SIG=$(printf '%s' "$CANON" | openssl dgst -sha256 -mac HMAC \\
  -macopt hexkey:$NEXUS_API_SECRET | cut -d' ' -f2)`}</CodeBlock>

            {/* Kept: what a 401 means and the order to check it in. The reason the
                response is deliberately opaque is a comment, not a screenful. */}
            <Note tone="warn" label="THE 401">
              The response never says which of the three it was — signature, timestamp or unknown key. Check
              them in that order.
            </Note>
          </div>
        )}

        {pane === "exchange" && <Catalog groups={EXCHANGE_API} />}
        {pane === "admin" && <Catalog groups={VENUE_ADMIN_API} />}
      </SubPane>
    </>
  );
}

/**
 * A catalogue, with its legend.
 *
 * The legend moved INSIDE the catalogue tabs rather than staying a panel of its
 * own at the bottom of the page: it explains the pills in these two views and
 * nothing else, and a legend a reader has to scroll past three catalogues to
 * find is a legend that gets guessed at instead.
 */
function Catalog({ groups }: { groups: CapabilityGroup[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {groups.map((group) => (
        <section key={group.title} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>{group.title.toUpperCase()}</span>
            <span style={{ ...body(SIZE.note, 1.6), color: FAINT }}>{group.blurb}</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            {group.items.map((item) => (
              <div
                key={`${item.method} ${item.path}`}
                /*
                 * FOUR COLUMNS THAT BECOME TWO LINES, not four columns that
                 * overflow. The grid's minimums summed to more than a phone is
                 * wide, so on every row the state pill — the one thing this page
                 * exists to show — was pushed past the panel edge and clipped.
                 * A wrapping flex row keeps the desktop reading (method, path,
                 * summary, state, on one line) and folds the summary and its
                 * pill onto a second line when the width is not there.
                 */
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 11,
                  alignItems: "baseline",
                  padding: "9px 0",
                  borderBottom: `1px solid ${L1}`,
                }}
              >
                <span style={{ ...monoLabel(SIZE.micro), color: item.method === "—" ? FAINT : MUT, flex: "0 0 52px" }}>
                  {item.method}
                </span>
                <span style={{ ...dataType(), color: TXT, wordBreak: "break-all", flex: "1 1 180px", minWidth: 0 }}>
                  {item.path}
                </span>
                <span style={{ ...body(SIZE.body, 1.65), color: MUT, flex: "1 1 220px", minWidth: 0 }}>
                  {item.summary}
                  {item.note && (
                    <span style={{ display: "block", color: FAINT, fontSize: SIZE.note, marginTop: 3 }}>{item.note}</span>
                  )}
                </span>
                {/* Pushed to the row's right edge on one line, and to the end of
                    the wrapped line otherwise — either way it never leaves the panel. */}
                <span style={{ marginLeft: "auto" }}>
                  <Pill tone={TONE[item.state]}>{STATE_LABEL[item.state].label}</Pill>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>LEGEND</span>
        {(["live", "gated"] as const).map((state) => (
          <div key={state} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Pill tone={TONE[state]}>{STATE_LABEL[state].label}</Pill>
            <span style={{ ...body(SIZE.body, 1.65), color: MUT }}>{STATE_LABEL[state].hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
