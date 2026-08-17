/*
 * Deposits — how a trader gets money onto the venue.
 *
 * THE OPERATOR INTEGRATES NONE OF THIS, and the page is built around that fact
 * rather than around the plumbing. Deposits arrive through the Nexus API: the
 * onramp, the cross-chain routing and the bridge are all upstream of the venue.
 * What the venue owns is the reading — which rails its traders use, how long the
 * money takes to land, where deposits fall out, and the per-account deposit
 * address, which identifies an account on-chain before a single order is signed.
 *
 * METHODS AND RAILS ARE DIFFERENT FACTS, and the pane shows both. A trader picks
 * "Apple Pay"; the rail that settles it is `card`. A four-row rail table cannot tell
 * an operator whether their card volume is people typing a card number or people
 * using a wallet — and those differ in support cost, in fraud profile and in
 * conversion. So the method table sits above the rail table, carries the same brand
 * chips the deposit screen shows a trader, and reconciles to the rail totals by
 * construction rather than by coincidence.
 *
 * ── WHAT CHANGED IN THE SUB-PANE PASS ───────────────────────────────────────
 *
 * THE SHAPE OF THE MONEY IS NOW THE FIRST THING ON THE PAGE. This pane opened
 * with a seven-row table: an operator arriving here had to read twenty-eight
 * cells before seeing whether deposits were growing, shrinking or flat. The six
 * figures and the thirty-day stacked area now sit above the tabs, unswitchable,
 * because they are the answer to "how is funding doing" and every tab below is a
 * different way of asking "why".
 *
 * FOUR TABS, AND THE PLAN ASKED FOR THREE. WORKSTREAMS §3b proposed Methods /
 * Funnel / Addresses. Built as Methods / Timing / Funnel / Addresses, because
 * timing is a different operator question from fallout and folding them together
 * made one tab that was half the pane: "how long does a bank transfer take" is a
 * question you answer for a trader on a support ticket, and "where do deposits
 * fall out" is one you answer for yourself on a Monday. Each of the four holds at
 * least two substantive components — the primitive's rule is that a tab holding
 * one figure should have been a row.
 */

import { resolveEnv } from "@/lib/venue/config-model";
import {
  FUNDING_RAILS,
  RAIL_LABEL,
  fundingAnalytics,
  type FundingRailKind,
} from "@/lib/venue/product-analytics";
import { Grid, Note, PageHead, Panel, Pill, Row } from "@/components/admin/shell";
import { SubPane, resolveSubPane, subPaneHref } from "@/components/admin/subpane";
import { ChartFrame, Heatmap, Histogram, RankedBars, SERIES, StackedArea, seriesColor } from "@/components/admin/charts";
import { LogRangeBars } from "@/components/admin/charts/LogRangeBars";
import { BrandStack, type BrandId } from "@/components/BrandMarks";
import {
  Cell,
  DataTable,
  Metric,
  MetricGrid,
  ProvenanceBadge,
  fmt,
  AMBER,
  FAINT,
  GREEN,
  L1,
  MUT,
  SUNK,
  TXT,
} from "@/components/admin/parts";
import { SIZE, body, data as dataType } from "@/components/admin/type";
import { SortableTable } from "@/components/admin/interactive";
import { monoLabel } from "@/lib/theme";

export const dynamic = "force-dynamic";

/* Fixed assignment order for the four origin rails. Four categorical hues is the
   palette's hard ceiling, and there are exactly four rails — so no rail ever
   borrows another's colour and no fifth hue has to be invented. */
/*
 * The chips each method shows, and they are the SAME set the deposit screen shows a
 * trader — components/BrandMarks.tsx, one source. An operator looking at "Debit or
 * credit card" here and a depositor looking at it in the product should be looking at
 * the same row; two lists that drift are how a console stops being trustworthy.
 */
const METHOD_LOGOS: Record<string, BrandId[]> = {
  stable: ["usdc", "usdt", "usdx"],
  crypto: ["btc", "eth", "sol"],
  cex: ["binance", "coinbase", "bybit"],
  card: ["visa", "mastercard"],
  wallet: ["applepay", "googlepay"],
  bank: ["chase", "mercury"],
  wire: [],
};

const RAIL_COLOR_INDEX: Record<FundingRailKind, number> = { card: 0, bank: 1, chain: 2, cex: 3 };
const RAIL_KINDS = Object.keys(RAIL_COLOR_INDEX) as FundingRailKind[];

const PANES = [
  { id: "methods", label: "Methods" },
  { id: "timing", label: "Timing" },
  { id: "funnel", label: "Funnel" },
  { id: "addresses", label: "Addresses" },
] as const;

const PANE_HEAD: Record<(typeof PANES)[number]["id"], { title: string; blurb?: string }> = {
  /* Blurb cut: it counted the rows of the two tables underneath it. */
  methods: { title: "What traders pick" },
  /* Blurbs cut from `timing` and `funnel`: both restated their own titles. */
  timing: { title: "How long it takes, and when it lands" },
  funnel: { title: "Where deposits fall out" },
  addresses: {
    title: "Per-account deposit addresses",
    blurb: "One address per account, derived by Nexus and passed per payment as destination_address.",
  },
};

export default async function FundingPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string; tab?: string }>;
}) {
  const { env: rawEnv, tab } = await searchParams;
  const env = resolveEnv(rawEnv);
  const pane = resolveSubPane(PANES, tab);
  const f = fundingAnalytics();
  const settleRate = f.depositsSettled / f.depositsStarted;

  /* Every link out of this page goes through here, so none of them can be built
     as a bare pathname and quietly drop `env=live`. */
  const linkTo = (id: string, e: "test" | "live" = env) =>
    subPaneHref("/admin/funding", id, { env: e === "live" ? "live" : undefined });

  return (
    <>
      <PageHead
        eyebrow="VENUE · HOW MONEY ARRIVES"
        title="Deposits"
        /* Blurb cut to its one operable clause: the rest described the tabs
           immediately below it. "You integrate none of it" is the fact that
           changes what an operator does, so it survives. */
        blurb="You integrate none of it — deposits come from the Nexus API."
        /* The ROADMAP pill and the "rails partial" count are gone with the
           capability labelling they carried; what is left is how many origins a
           trader can arrive through, which is a fact about the venue. */
        right={<Pill tone="mute">{FUNDING_RAILS.length} rails</Pill>}
      />

      {/*
        * ── the shape of the money, above the tabs ────────────────────────────
        *
        * Unswitchable on purpose. Whichever question brought an operator here,
        * the first thing they need is whether deposits are growing, and how much
        * of the total each rail carries — one figure row and one time series.
        * Putting it inside a tab would mean three of the four tabs open with no
        * context at all.
        */}
      <Panel
        title="Deposit flow"
        blurb="Thirty days."
        right={
          <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>
            POLLED EVERY {f.pollIntervalS}s · NOT A STREAM
          </span>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <MetricGrid min={140} divided>
            <Metric label="GROSS DEPOSITED" value={fmt.usd(f.grossDeposited)} provenance="live" />
            <Metric label="DEPOSITS STARTED" value={fmt.int(f.depositsStarted)} provenance="live" />
            <Metric
              label="SETTLED"
              value={fmt.pct(settleRate, 1)}
              provenance="live"
              color={settleRate < 0.8 ? AMBER : undefined}
              hint="reached the address"
            />
            <Metric
              label="MEDIAN SETTLE"
              value={fmt.duration(f.medianSettleS)}
              provenance="live"
              hint="start to credited"
            />
            <Metric
              label="→ FIRST TRADE"
              value={fmt.pct(f.conversionToFirstTrade, 1)}
              provenance="live"
              color={GREEN}
              hint="the only funding number that ranks"
            />
            <Metric
              label="MEDIAN TO TRADE"
              value={fmt.duration(f.medianStartToFirstTradeS)}
              provenance="live"
            />
          </MetricGrid>

          <ChartFrame title="DEPOSIT VOLUME BY ORIGIN RAIL" right={<ProvenanceBadge provenance="live" />}>
            <StackedArea
              labels={f.daily.map((d) => fmt.day(d.dayMs))}
              series={RAIL_KINDS.map((kind) => ({
                label: RAIL_LABEL[kind],
                values: f.daily.map((d) => d.byKind[kind]),
              }))}
              format={(n) => fmt.usd(n) ?? "—"}
            />
          </ChartFrame>
        </div>
      </Panel>

      <SubPane
        panes={PANES}
        active={pane}
        hrefFor={(id) => linkTo(id)}
        tabsLabel="ASKING"
        title={PANE_HEAD[pane].title}
        blurb={PANE_HEAD[pane].blurb}
        right={<ProvenanceBadge provenance="live" />}
      >
        {/* ── what traders actually pick ─────────────────────────────────── */}
        {pane === "methods" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            {/* The composition charts come first and the seven-row table second.
                "Which rail carries my money and in what ticket size" is read by
                comparison, and a table is the slowest possible way to make a
                comparison of four things. */}
            <Grid min={300}>
              <ChartFrame title="GROSS BY RAIL">
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <RankedBars
                    items={f.bySource.map((s) => ({
                      label: s.label,
                      value: s.value,
                      colorIndex: RAIL_COLOR_INDEX[s.kind],
                    }))}
                    format={(n) => fmt.usd(n) ?? "—"}
                  />
                  <div style={{ borderTop: `1px solid ${L1}`, paddingTop: 12 }}>
                    <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>MEDIAN TICKET</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                      {f.bySource.map((s) => (
                        <div key={s.kind} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={{ ...monoLabel(SIZE.micro), color: MUT, flex: 1, minWidth: 0 }}>{s.label}</span>
                          <span style={{ ...dataType(), color: TXT }}>
                            {fmt.usdExact(s.value / Math.max(1, s.count))}
                          </span>
                          <span style={{ ...monoLabel(SIZE.micro), color: FAINT, width: 74, textAlign: "right" }}>
                            {fmt.int(s.count)} deposits
                          </span>
                        </div>
                      ))}
                    </div>
                    {/* Ticket size, not gross, is what decides which rail is worth
                        the operator's attention — a rail that moves the same money
                        in ten times as many payments costs ten times the support.
                        That was two sentences of prose under the figures; it is the
                        reason the MEDIAN TICKET block exists, not a reading of it. */}
                  </div>
                </div>
              </ChartFrame>

              <ChartFrame title="TICKET SIZE, ALL RAILS">
                <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                  <Histogram
                    bins={f.ticketBins.map((b) => ({ label: b.label, value: b.value }))}
                    markerIndex={f.ticketBins.findIndex((b) => b.upperUsd >= f.medianFirstDeposit)}
                    markerLabel={`median first deposit ${fmt.usdExact(f.medianFirstDeposit)}`}
                  />
                  {/* Kept the scale, cut the argument for it — a card deposit and a
                      wire being three orders of magnitude apart is what the axis
                      shows, so it does not also need saying. */}
                  <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>LOG-SPACED BINS · ALL RAILS, ONE AXIS</span>
                </div>
              </ChartFrame>
            </Grid>

            <ChartFrame title="METHODS — WHAT A DEPOSITOR CHOOSES">
              <DataTable
                head={[
                  { label: "METHOD", align: "left" },
                  { label: "ACCEPTS", align: "left" },
                  "SETTLES ON",
                  "DEPOSITS",
                  "GROSS",
                  "MEDIAN TICKET",
                  { label: "SHARE", align: "left" },
                ]}
              >
                {[...f.methods].sort((a, b) => b.gross - a.gross).map((m) => {
                  const share = m.gross / Math.max(1, f.grossDeposited);
                  return (
                    <tr key={m.id}>
                      <Cell align="left" color={TXT}>
                        {m.label}
                      </Cell>
                      <Cell align="left">
                        {METHOD_LOGOS[m.id]?.length ? (
                          <BrandStack ids={METHOD_LOGOS[m.id]!} size={16} ring={SUNK} />
                        ) : (
                          <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>ANY BANK</span>
                        )}
                      </Cell>
                      <Cell>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: seriesColor(RAIL_COLOR_INDEX[m.kind]),
                            marginRight: 7,
                          }}
                        />
                        <span style={{ color: MUT }}>{RAIL_LABEL[m.kind]}</span>
                      </Cell>
                      <Cell color={MUT}>{fmt.int(m.count)}</Cell>
                      <Cell color={TXT}>{fmt.usd(m.gross)}</Cell>
                      <Cell color={MUT}>{fmt.usdExact(m.gross / Math.max(1, m.count))}</Cell>
                      <Cell align="left">
                        {/* A bar in the row rather than a number beside it: share is the one
                            column here that is read by comparison rather than by value. */}
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ display: "block", width: 74, height: 4, background: L1, borderRadius: 2 }}>
                            <span
                              style={{
                                display: "block",
                                width: `${Math.max(2, share * 100)}%`,
                                height: "100%",
                                background: seriesColor(RAIL_COLOR_INDEX[m.kind]),
                                borderRadius: 2,
                              }}
                            />
                          </span>
                          <span style={{ ...dataType(SIZE.note), color: FAINT }}>{fmt.pct(share, 0)}</span>
                        </span>
                      </Cell>
                    </tr>
                  );
                })}
              </DataTable>
              {/* Cut: method totals reconciling to the rail totals by construction,
                  and why wire shows no brand chips. Both explain how the table was
                  built rather than what it says. */}
            </ChartFrame>

            {/* STATUS and BLOCKED BY columns removed: both described delivery
                state rather than the rail, and what an operator reads off this
                table is which rail is which. */}
            <ChartFrame title="ORIGIN RAILS — WHERE THE MONEY STARTS">
              <DataTable
                head={[
                  { label: "RAIL", align: "left" },
                  { label: "WHAT IT IS", align: "left" },
                ]}
              >
                {FUNDING_RAILS.map((rail) => (
                  <tr key={rail.kind}>
                    <Cell align="left" color={TXT}>
                      <span
                        style={{
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: seriesColor(RAIL_COLOR_INDEX[rail.kind]),
                          marginRight: 8,
                        }}
                      />
                      {rail.label}
                    </Cell>
                    <Cell align="left" color={MUT} mono={false}>
                      {rail.detail}
                    </Cell>
                  </tr>
                ))}
              </DataTable>
            </ChartFrame>
          </div>
        )}

        {/* ── how long it takes, and when ────────────────────────────────── */}
        {pane === "timing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <ChartFrame title="TIME TO CREDIT, BY RAIL">
              <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                <LogRangeBars
                  rows={[...f.settle]
                    .sort((a, b) => a.medianS - b.medianS)
                    .map((r) => ({
                      key: r.kind,
                      label: RAIL_LABEL[r.kind],
                      median: r.medianS,
                      p90: r.p90S,
                      colorIndex: RAIL_COLOR_INDEX[r.kind],
                    }))}
                  formatValue={(s) => fmt.duration(s) ?? "—"}
                />
                {/* Whole paragraph cut. It explained the scale and named the pale
                    bar as p90 — LogRangeBars already prints its own legend,
                    "SOLID = MEDIAN · PALE = P90 · LOG TRACK", directly above. */}
              </div>
            </ChartFrame>

            <ChartFrame
              title="WHEN DEPOSITS LAND — COUNT BY HOUR OF UTC DAY"
              right={<span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>darker = busier</span>}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Heatmap
                  rows={RAIL_KINDS.map((k) => RAIL_LABEL[k])}
                  cols={f.hourly.map((h) => String(h.hour).padStart(2, "0"))}
                  value={(r, c) => f.hourly[c]!.byKind[RAIL_KINDS[r]!]}
                  format={(n) => `${fmt.int(n)} deposits`}
                  cell={17}
                />
                {/* Cut: four sentences reading the heatmap out loud — fiat rails
                    track waking hours, chain deposits do not, staff against the
                    first row. The chart, its title and its legend show it. */}
              </div>
            </ChartFrame>
          </div>
        )}

        {/* ── where they fall out ────────────────────────────────────────── */}
        {pane === "funnel" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <ChartFrame title="FUNDING FUNNEL">
              <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                <RankedBars
                  items={f.funnel.map((step, i) => ({
                    label: step.label,
                    value: step.users,
                    colorIndex: i % SERIES.length,
                  }))}
                  format={(n) => fmt.int(n) ?? "—"}
                />
                {/* Kept: the legal gate is a live blocker on the last step. Cut only
                    the clause explaining why it is drawn as its own step. */}
                <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: 0 }}>
                  <strong style={{ color: MUT }}>Credited as USDX</strong> carries the legal gate. Without
                  sign-off, deposits settle to the address and stop there.
                </p>
              </div>
            </ChartFrame>

            <ChartFrame title="WHY A DEPOSIT FAILS">
              <DataTable head={["CODE", "COUNT", { label: "MEANING", align: "left" }]}>
                {f.failures.map((e) => (
                  <tr key={e.code}>
                    <Cell align="left" color={e.code === "UNSUPPORTED_REGION" ? AMBER : TXT}>
                      {e.code}
                    </Cell>
                    <Cell>{fmt.int(e.count)}</Cell>
                    <Cell align="left" color={MUT} mono={false}>
                      {e.meaning}
                    </Cell>
                  </tr>
                ))}
              </DataTable>
              {/* Cut: "a declined card is the trader's problem and a missing route
                  is ours" — the reason the codes are listed separately, and each
                  code's own MEANING column already says whose problem it is. */}
            </ChartFrame>
          </div>
        )}

        {/* ── the attribution story ──────────────────────────────────────── */}
        {pane === "addresses" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Was ninety words titled WHY THIS MATTERS: the case for addresses as
                an attribution key, plus a partner CEO's endorsement quoted with a
                date — our sales evidence, on a tenant's screen. What survives is
                the one operable line: the address is the funding-side attribution
                key, so it answers a question the order path cannot. */}
            <Note label="ATTRIBUTION">
              A deposit address belongs to the account before it belongs to an order, so funding is attributed
              here and order flow is attributed by builder code.
            </Note>

            <SortableTable
              searchPlaceholder="Filter by account or rail…"
              initialSort={5}
              minWidth={640}
              emptyTitle="No funded accounts"
              emptyBlurb="An address appears here the first time an account is funded through any rail."
              head={[
                { label: "ACCOUNT / ADDRESS", align: "left" },
                { label: "FIRST RAIL", align: "left" },
                { label: "FIRST FUNDED" },
                { label: "DEPOSITS" },
                { label: "DEPOSITED" },
                { label: "ROUTED SINCE" },
              ]}
              rows={f.addresses.map((a) => ({
                id: a.address,
                cells: [
                  { text: a.address, align: "left", color: TXT },
                  { text: RAIL_LABEL[a.firstSource], align: "left", color: MUT },
                  { text: fmt.day(a.firstFundedMs), sortValue: a.firstFundedMs, color: MUT },
                  { text: fmt.int(a.deposits) ?? "—", sortValue: a.deposits },
                  { text: fmt.usdExact(a.deposited) ?? "—", sortValue: a.deposited },
                  {
                    text: a.routedNotional === 0 ? "never traded" : (fmt.usd(a.routedNotional) ?? "—"),
                    sortValue: a.routedNotional,
                    color: a.routedNotional === 0 ? AMBER : GREEN,
                  },
                ],
              }))}
            />

            {/* Cut: a paragraph naming "never traded" as the row to act on. The
                column paints those rows amber and says the words, which is the
                same instruction in the place the operator is already looking. */}

            {/* The transport facts live with the addresses because this is the tab
                a reader reaches when they are thinking about building on this data
                — and what bounds that is the poll interval, not the funnel. */}
            <ChartFrame title="HOW THIS DATA WOULD ARRIVE">
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <Row label="Transport" hint="Not a websocket. There is no push channel today.">
                  <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>REST POLL</span>
                </Row>
                <Row label="Interval" hint="The freshness ceiling for anything on this page.">
                  <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>{f.pollIntervalS}s</span>
                </Row>
                <Row label="Source" hint="Not a published contract — these may change.">
                  <span style={{ ...dataType(SIZE.note), color: MUT, textAlign: "right" }}>
                    {f.polledEndpoints.map((e) => (
                      <span key={e} style={{ display: "block" }}>
                        {e}
                      </span>
                    ))}
                  </span>
                </Row>
                <Row label="Off-ramp" hint="Demoed, not decided. Withdrawal fan-out is still Todo.">
                  <Pill tone="mute">OUT OF PHASE ONE</Pill>
                </Row>
              </div>
              {/* Cut: the "fine for a dashboard, wrong for an alert" paragraph. The
                  Transport row's own hint — "Not a websocket. There is no push
                  channel today." — is the same warning, on the row it is about. */}
            </ChartFrame>
          </div>
        )}
      </SubPane>
    </>
  );
}
