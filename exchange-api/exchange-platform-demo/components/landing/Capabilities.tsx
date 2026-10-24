/*
 * The capability grid — what the venue can actually do once it is standing.
 *
 * Deliberately short lines and no prose. By this point in the page a reader is
 * either checking for a specific feature or scanning for a dealbreaker, and both of
 * those are lookup tasks.
 *
 * SIXTEEN, AND THE COUNT IS LOAD-BEARING. Thirteen left Agents alone on the last row
 * of three, which reads as a card that failed to load rather than the end of a list.
 * Sixteen divides evenly at 2 and 4 columns, which are the counts this grid actually
 * renders at, so it closes cleanly at every width instead of only at the one it was
 * checked at. Exports folded into Console earlier for the same reason — the admin API
 * that serves the CSV is the same admin API the console runs on, so it was a
 * sub-feature filed as a peer.
 *
 * IT GREW BECAUSE IT MOVED. This section used to sit eleventh, two bands from the
 * FAQ, which is the wrong place for the list whose whole job is "look how much of
 * this you do not have to build". It is fifth now, immediately after the mechanism is
 * explained, and it absorbed the three cards from a "what a screenshot cannot show"
 * band that existed only to hold things that fit nowhere else — analytics, the
 * branded API and the sandbox are capabilities, and a section justifying its own
 * existence is a section to delete.
 *
 * WHAT THIS ABSORBED, AND WHAT IT DID NOT. There used to be a Receipts band after
 * this one — "nothing here asks you to take our word for it" — listing artifacts a
 * stranger could open and check. Three of its six rows were capabilities wearing a
 * credibility costume: a published SDK, a versioned public API contract and a hosted
 * MCP endpoint are things the venue HAS, and they belong in the list of things the
 * venue has. They are here now, stated flatly, with the link as the value rather
 * than as proof of anything.
 *
 * The other three are gone rather than moved. "58 tests", "this page is itself a
 * tenant" and the team's proving-network history are arguments about whether to
 * believe us, and a section whose whole posture is defensive invites the doubt it
 * answers. The honest version of that section is a claim about infrastructure proven
 * by a live Nexus venue carrying real flow — which is a claim to make when such a
 * venue exists, not before.
 */

import { DIM, L1, TXT } from "@/lib/theme";

import { Band, Cell, GroupTabs, Head, LinkOut, Slab, css as cx, annotation, body, eyebrow } from "./primitives";

type Item = {
  k: string;
  v: string;
  /** Where a reader can go and see it. Most rows have nowhere to send them. */
  href?: string;
  /** What the link says — a package name or a path, never "learn more". */
  check?: string;
  /** Which of `GROUPS` this cell belongs to, 1-indexed. Phone width only — see below. */
  g: 1 | 2 | 3 | 4;
};

/*
 * The phone grouping.
 *
 * WHY THE LIST IS STILL FLAT. Sixteen cells in DOM order are what the desktop 4x4
 * renders, and a reader scanning that grid is scanning a matrix, not four lists — so
 * the groups are a marker on each cell rather than four containers around them. That
 * also makes the desktop provably unchanged: nothing moved, nothing nested.
 *
 * WHY THESE FOUR. They are the four questions this section actually gets asked:
 * what can my traders do, what happens to the money, what do I build against, and
 * what do I run. `Analytics` sits in Money because the first half of what it reports
 * is fee accrual and volume share — the question is "what am I earning". `Keys` sits
 * in Operate rather than Build because issuing and revoking one is a console job done
 * beside Team, and the developer-facing half of it is already in SDK and API contract.
 * The groups are 4/3/5/4 rather than four fours: there is no 4x4 to close at phone
 * width, and padding a group to make the numbers pretty would be filing a capability
 * under the wrong question.
 */
const GROUPS = ["Trading", "Money", "Build", "Operate"] as const;

const ITEMS: Item[] = [
  { k: "Markets", v: "Perpetuals across crypto, FX, commodities and index, from the shared registry", g: 1 },
  { k: "Orders", v: "Market, limit, reduce-only, TWAP, with preview before submission", g: 1 },
  { k: "Margin", v: "Cross and isolated, per-position leverage, liquidation run by the engine", g: 1 },
  { k: "Streaming", v: "WebSocket for book, trades, fills and account state", g: 1 },
  { k: "Keys", v: "HMAC keys with per-key rate limits, plus delegated trade-only agent keys", g: 4 },
  { k: "Faucet", v: "Test USDX on demand, scoped to the test environment", g: 2 },
  { k: "Halt", v: "Cancel-all as a real halt, plus a kill switch that needs no redeploy", g: 4 },
  {
    k: "Console",
    v: "Flow, earnings and health — and an admin API that does everything the console does",
    g: 4,
  },
  // The Deposits section enumerates the seven rails with marks of their own.
  { k: "Deposits", v: "Every rail, card to any chain — all credited as USDX collateral", g: 2 },
  {
    k: "SDK",
    // "the stream" is the Streaming cell, three rows up.
    v: "Place, preview, amend, cancel, positions, fills, account summary — plus public market data",
    href: "https://www.npmjs.com/package/@nexus-xyz/exchange-ts",
    check: "npm i @nexus-xyz/exchange-ts",
    g: 3,
  },
  {
    k: "API contract",
    v: "OpenAPI 0.8.1, 96 operations, versioned in its own repository with generated clients beside it: Rust, Python, a CLI and a runnable examples repo",
    href: "https://github.com/nexus-xyz/nexus-exchange-api",
    check: "github.com/nexus-xyz/nexus-exchange-api",
    g: 3,
  },
  {
    k: "Agents",
    v: "A hosted MCP server exposes the exchange as callable tools, and an llms.txt quickstart gets an agent trading without an SDK at all",
    href: "https://docs.nexus.xyz",
    check: "mcp.exchange.nexus.xyz · api.nexus.xyz/llms.txt",
    g: 3,
  },
  {
    k: "Analytics",
    // The six-item list is the ConsoleTour caption plus the Product admin-API grid. The two
    // items dropped here are visible on the Analytics capture itself.
    v: "Routed volume, fee accrual, submit latency and rejections — computed from the flow your builder code produced, and yours to export",
    g: 2,
  },
  {
    k: "Branded API",
    v: "Your traders and bots hit your hostname with your key prefix, read a spec that says your name, and install your SDK — underneath, the same book",
    g: 3,
  },
  {
    k: "Sandbox",
    v: "The real matching engine behind the production API surface, with scenario injection — trigger a liquidation on demand",
    g: 3,
  },
  {
    k: "Team",
    v: "Members and roles, invitations, scoped keys whose secret is shown exactly once, and an audit trail of who changed what, when",
    g: 4,
  },
];

export function Capabilities() {
  return (
    <Band id="capabilities">
      <Head
        eyebrow="Capabilities"
        title="What the venue does out of the box."
        /* No blurb: it used to be twenty-seven words of prose whose content was "there is
           no prose here", and the grid demonstrates that in one glance. */
      />

      {/* `.seg` is the scope the switch's `:has()` rules are anchored on, so it has to
          wrap both the strip and the cells it governs. */}
      <div className={cx.seg}>
        <GroupTabs name="nx-capability-group" groups={GROUPS} />

        <Slab columns>
          {ITEMS.map((it) => (
            /* The group marker rides on the cell itself. It used to need a wrapper
               `div` — `Cell` took a style and not a class, and a class is what the
               switch selects on — which was sixteen elements carrying one attribute.
               The column layout moved with it: it has to be in `.capCell` rather than
               inline, because an inline `display: flex` outranks the switch's
               `display: none` and would leave all four groups on screen at once. */
            <Cell key={it.k} className={`${cx.capCell} ${cx[`segG${it.g}`]}`} style={{ padding: "16px 18px 18px" }}>
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 9 }}
              >
                <span style={{ ...eyebrow(TXT), fontSize: 9.5 }}>{it.k}</span>
              </div>
              <div style={{ ...body, fontSize: 13 }}>{it.v}</div>
              {/* The four rows that have somewhere to send a reader get a rule and a
                  path. `marginTop: auto` pins it to the bottom so those rules line up
                  across a row of cards of different heights. */}
              {it.href ? (
                <div
                  style={{
                    marginTop: "auto",
                    paddingTop: 12,
                    borderTop: `1px solid ${L1}`,
                    ...annotation(DIM, 11),
                    /* A registry path is the one string here that can exceed 390px. */
                    overflowWrap: "anywhere",
                  }}
                >
                  <LinkOut href={it.href}>{it.check}</LinkOut>
                </div>
              ) : null}
            </Cell>
          ))}
        </Slab>
      </div>
    </Band>
  );
}
