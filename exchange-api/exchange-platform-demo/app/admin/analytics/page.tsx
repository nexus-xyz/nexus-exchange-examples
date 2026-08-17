/*
 * Analytics — routed flow, and the API it arrived over.
 *
 * TWO SUB-PANES, NOT THREE. A `ui` pane sat between these two and measured the
 * venue's own frontend: sessions, median session length, device mix, an
 * acquisition funnel, a retention cohort grid. It is gone (EP-010). None of it
 * is exchange data — it is web analytics of an application the partner deploys
 * and owns, which the partner can instrument themselves, and keeping the tab
 * would have meant building an event-ingestion pipeline to feed the least
 * operationally useful surface in this console. What is left is the business
 * (`flow`) and the surface machines call (`api`), and they do not share a scale:
 * flow fails as a number, an API fails at a percentile.
 *
 * These are also the figures the exchange cannot produce for you — they are
 * measured at your own edge.
 *
 * WHY SUB-PANES AT ALL. The page was stacked panels running about eleven screens
 * on a phone and four on a laptop, all rendered on every visit. Nobody reads a
 * revenue split and a p99 histogram in the same minute: those are two jobs, done
 * by two people, at two frequencies. Behind a tab strip each job is one screen,
 * the one you are not doing is not rendered at all (the sections are branched,
 * not hidden with CSS), and each has an address you can paste into a thread.
 *
 * WHAT THE PLAN SUGGESTED AND WHAT WAS BUILT. WORKSTREAMS §3b proposed Flow /
 * Markets / Rejections. Two of those three do not exist on this page: the market
 * split of routed flow is three constants (MARKET_SPLIT below) and is one series
 * in one chart, and rejections are a five-row table inside the API section. A tab
 * holding one table is a tab that should have been a row — the primitive's own
 * doc comment says so.
 *
 * THE RANGE PICKER STAYS ABOVE THE TABS, in the page header, because it governs
 * both sections and belongs to the page rather than to either of them. It carries
 * `tab` and the tabs carry `range`, so neither control resets the other.
 */
import { resolveEnv } from "@/lib/venue/config-model";
import { readVenueDashboard } from "@/lib/venue/admin";
import {
  RANGES,
  RANGE_DAYS,
  apiAnalyticsFor,
  isRange,
  type Range,
} from "@/lib/venue/product-analytics";
import { Grid, LinkTabs, Note, PageHead } from "@/components/admin/shell";
import { SubPane, resolveSubPane, subPaneHref } from "@/components/admin/subpane";
import {
  BubbleScatter,
  ChartFrame,
  Histogram,
  Legend,
  RankedBars,
  SERIES,
  StackedArea,
} from "@/components/admin/charts";
import { CompositionBar } from "@/components/admin/charts/CompositionBar";
import {
  Cell,
  DataTable,
  Metric,
  MetricGrid,
  ProvenanceBadge,
  fmt,
  AMBER,
  DIM,
  FAINT,
  GREEN,
  MONO,
  MUT,
  TXT,
} from "@/components/admin/parts";
import { SIZE, body } from "@/components/admin/type";
import { SortableTable } from "@/components/admin/interactive";
import { monoLabel } from "@/lib/theme";

export const dynamic = "force-dynamic";

/* The market split of routed flow, in one place. It was inlined twice with the same
   three literals, which is how the two charts on this page drift apart. */
const MARKET_SPLIT = [
  { label: "BTC", share: 0.52 },
  { label: "ETH", share: 0.31 },
  { label: "SOL", share: 0.17 },
] as const;

/*
 * Two sections, each named by the thing it measures rather than by the shape of
 * the data in it. `flow` is the business; `api` is the surface it arrived over.
 * `flow` is first and so is the default — `resolveSubPane` falls back to
 * `PANES[0]`, so removing `ui` from the middle of this list changed neither the
 * default nor either surviving address.
 */
const PANES = [
  { id: "flow", label: "Flow" },
  { id: "api", label: "Branded API" },
] as const;

/** Panel title and blurb per section, so the frame states which job you are in. */
const PANE_HEAD: Record<(typeof PANES)[number]["id"], { title: string; blurb: string }> = {
  /* Second sentence cut from `api`: it restated the page blurb's "measured at
     your edge" claim, which the tab strip says without a sentence. */
  flow: { title: "Flow", blurb: "What routed, and where the fee comes from." },
  api: { title: "Branded API", blurb: "What machines do against your endpoint." },
};

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; env?: string; tab?: string }>;
}) {
  /*
   * The window lives in the URL, not in component state. A range an operator can
   * bookmark and paste into a thread is worth more than one that resets on
   * reload — and keeping it in the URL is what lets this page stay a server
   * component that RECOMPUTES the series rather than filtering it in the browser.
   * The sub-pane selection is in the URL for the same reason, and the two have to
   * carry each other or either control becomes a trapdoor out of the other.
   */
  const { range: rawRange, env: rawEnv, tab } = await searchParams;
  const env = resolveEnv(rawEnv);
  const range: Range = isRange(rawRange) ? rawRange : "24h";
  const days = RANGE_DAYS[range];
  const pane = resolveSubPane(PANES, tab);

  /* One helper for every internal link on this page, so no call site can build a
     bare pathname and drop the environment. `24h` is the default and stays out of
     the URL; `env=live` is the one that costs an operator real money if it is
     lost, so it is never omitted when it is set. */
  const linkTo = (next: { tab?: string; range?: Range }) =>
    subPaneHref("/admin/analytics", next.tab ?? pane, {
      env: env === "live" ? "live" : undefined,
      range: (next.range ?? range) === "24h" ? undefined : (next.range ?? range),
    });

  const d = await readVenueDashboard();
  const api = apiAnalyticsFor(range);
  /* `uiAnalytics()` was read here for the Branded UI pane's session and funnel
     figures. It stays in the model — Overview still reads its order split — but
     nothing on this page needs it now (EP-010). */
  /* The flow series is 30 days of ledger; a shorter window is its tail, not a
     separate dataset. Slicing keeps the two halves of this page consistent. */
  const flowDaily = d.daily.slice(-days);

  return (
    <>
      <PageHead
        eyebrow="MEASUREMENT · FLOW AND THE API"
        title="Analytics"
        /* Blurb cut: two sentences arguing that these figures are worth having.
           The eyebrow and the tab strip already name what is measured. */
        right={
          <LinkTabs
            label="WINDOW"
            options={RANGES}
            active={range}
            hrefFor={(option) => linkTo({ range: option as Range })}
          />
        }
      />

      {/* The window caveat is a property of the window, not of a section, so it
          sits with the picker rather than inside whichever tab is open. It used
          to carry a `pane !== "ui"` guard as well, keeping it off a funnel it
          said nothing about; the funnel is gone (EP-010) and a guard that can
          never be false is a claim about a pane that no longer exists. */}
      {range !== "24h" && (
        /* Trimmed to the gotcha and the instruction; the worked example of what a
           30-day p99 contains was three clauses of illustration. */
        <Note tone="info" label="WINDOW">
          A longer window <strong style={{ color: TXT }}>widens the tail</strong>. Set client timeouts against
          the wide window, not the 24-hour one.
        </Note>
      )}

      <SubPane
        panes={PANES}
        active={pane}
        hrefFor={(id) => linkTo({ tab: id })}
        tabsLabel="MEASURING"
        title={PANE_HEAD[pane].title}
        blurb={PANE_HEAD[pane].blurb}
      >
        {/* ── the venue as a business ─────────────────────────────────────── */}
        {pane === "flow" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <MetricGrid min={132} divided>
              <Metric
                label={`ROUTED (${range.toUpperCase()})`}
                value={fmt.usd(flowDaily.reduce((s, p) => s + p.notional, 0))}
                provenance="live"
              />
              <Metric label="FILLS" value={fmt.int(d.usage.fills.value)} provenance="live" />
              <Metric
                label="FEE ACCRUED"
                value={fmt.usdExact(d.revenue.builderFeeAccrued.value)}
                provenance="estimate"
                color={GREEN}
              />
              <Metric label="EFFECTIVE" value={fmt.bps(d.revenue.effectiveBps.value)} provenance="estimate" />
              <Metric
                label="FEE RATIO"
                value={fmt.pct(d.revenue.feeRatio.value, 1)}
                provenance="estimate"
                hint="your share of trader cost"
              />
            </MetricGrid>

            {/*
              ONE DAY IS A COMPOSITION, NOT A TREND.
              This page defaults to the 24-hour window, and 24 hours of a daily ledger
              is one point — so the flagship chart on the default view rendered as an
              empty 170px box with the same date printed at both ends of its x-axis.
              The fix is not a smaller chart, it is a different question: with one
              point the honest chart is "how did today split by market", which is a
              ranked bar. The stacked area returns the moment there is a second day to
              compare it to.
            */}
            {flowDaily.length < 2 ? (
              <ChartFrame
                title={`ROUTED NOTIONAL BY MARKET — ${flowDaily[0] ? fmt.day(flowDaily[0].dayMs).toUpperCase() : "TODAY"}`}
                right={<ProvenanceBadge provenance="live" />}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* scaleTo the day's own total, so a bar's length is its share of
                      the day. Normalised to the largest market instead, BTC's 52%
                      would fill the whole track and read as the entire day's flow. */}
                  <RankedBars
                    items={MARKET_SPLIT.map((m, i) => ({
                      label: m.label,
                      value: (flowDaily[0]?.notional ?? 0) * m.share,
                      colorIndex: i,
                    }))}
                    format={(n) => fmt.usd(n) ?? "—"}
                    scaleTo={flowDaily[0]?.notional}
                  />
                  <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>
                    ONE DAY — NO TREND TO READ. WIDEN THE WINDOW FOR A TIME SERIES.
                  </span>
                </div>
              </ChartFrame>
            ) : (
              <ChartFrame title="ROUTED NOTIONAL BY MARKET" right={<ProvenanceBadge provenance="live" />}>
                <StackedArea
                  labels={flowDaily.map((p) => fmt.day(p.dayMs))}
                  series={MARKET_SPLIT.map((m) => ({
                    label: m.label,
                    values: flowDaily.map((p) => p.notional * m.share),
                  }))}
                  format={(n) => fmt.usd(n) ?? "—"}
                />
              </ChartFrame>
            )}
          </div>
        )}

        {/* THE BRANDED UI PANE WAS HERE AND IS GONE (EP-010). Sessions, median
            session length, device mix, the acquisition funnel and the retention
            cohort grid are web analytics of the venue's OWN FRONTEND — not
            exchange data, and not something this console can measure without
            building an event-ingestion pipeline for the least operationally
            useful surface in it. A partner who wants them instruments their own
            template; it is their application. What survives is the UI-vs-API
            order split on Overview, which is a fact about routed flow. */}

        {/* ── the branded API ─────────────────────────────────────────────── */}
        {pane === "api" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <MetricGrid min={132} divided>
              <Metric
                label={`REQUESTS ${range.toUpperCase()}`}
                value={fmt.int(api.requests24h)}
                provenance="live"
              />
              <Metric label="p50" value={`${api.p50Ms} ms`} provenance="live" />
              <Metric
                label="p99"
                value={`${api.p99Ms} ms`}
                provenance="live"
                color={api.p99Ms > 200 ? AMBER : undefined}
              />
              <Metric
                label="ERROR RATE"
                value={fmt.pct(api.errorRate, 2)}
                provenance="live"
                color={api.errorRate > 0.02 ? AMBER : undefined}
              />
              <Metric
                label="RATE-LIMIT HEADROOM"
                value={fmt.pct(api.rateLimitHeadroom, 0)}
                provenance="live"
                hint="unused budget at peak"
              />
            </MetricGrid>

            <Grid min={300}>
              <ChartFrame
                title="LATENCY DISTRIBUTION"
                right={<span style={{ ...monoLabel(SIZE.micro), color: AMBER }}>p99 marked</span>}
              >
                <Histogram bins={api.latencyBins} markerIndex={api.p99BinIndex} markerLabel={`p99 ${api.p99Ms}ms`} />
              </ChartFrame>

              <ChartFrame title="CLIENT MIX" right={<ProvenanceBadge provenance="live" />}>
                {/* Shares of one total, so a composition bar rather than four
                    ranked bars against a 100 scale: the reading is "which SDK is
                    most of my traffic", and that is a division of one track. */}
                <CompositionBar
                  parts={api.sdks.map((s, i) => ({ label: s.label, fraction: s.share, colorIndex: i }))}
                  format={(f) => `${(f * 100).toFixed(0)}%`}
                />
              </ChartFrame>
            </Grid>

            <ChartFrame
              title="ENDPOINTS — VOLUME vs LATENCY vs ERROR RATE"
              right={<Legend items={[{ label: "bubble area = 24h requests", color: SERIES[0] }]} />}
            >
              {/* Three dimensions at once, which is the only way to see that the
                  slow endpoint and the failing endpoint are not the same one. */}
              <BubbleScatter
                points={api.endpoints.slice(0, 8).map((e, i) => ({
                  label: e.path.replace("/markets/{id}", "/mkt"),
                  x: e.p99Ms,
                  y: e.errorRate * 100,
                  size: e.requests24h,
                  colorIndex: i % SERIES.length,
                }))}
                xLabel="p99 latency (ms)"
                yLabel="error rate (%)"
                formatX={(n) => `${n.toFixed(0)}ms`}
                formatY={(n) => `${n.toFixed(2)}%`}
              />
            </ChartFrame>

            <ChartFrame title="ENDPOINT DETAIL">
              {/* Sortable, because the question is never "list my endpoints" — it is
                  "which one is slowest" or "which one fails most", and those are two
                  different orderings of the same ten rows. Sorting is on the numeric
                  value, never on the formatted text. */}
              <SortableTable
                searchPlaceholder="Filter endpoints by path or method…"
                initialSort={1}
                minWidth={620}
                head={[
                  { label: "ENDPOINT", align: "left" },
                  { label: range.toUpperCase() },
                  { label: "p50" },
                  { label: "p99" },
                  { label: "ERRORS" },
                ]}
                rows={api.endpoints.map((e) => ({
                  id: `${e.method} ${e.path}`,
                  cells: [
                    { text: `${e.method}  ${e.path}`, align: "left", color: TXT },
                    { text: fmt.int(e.requests24h) ?? "—", sortValue: e.requests24h },
                    { text: `${e.p50Ms}ms`, sortValue: e.p50Ms },
                    { text: `${e.p99Ms}ms`, sortValue: e.p99Ms, color: e.p99Ms > 300 ? AMBER : undefined },
                    {
                      text: `${(e.errorRate * 100).toFixed(2)}%`,
                      sortValue: e.errorRate,
                      color: e.errorRate > 0.01 ? AMBER : undefined,
                    },
                  ],
                }))}
              />
            </ChartFrame>

            <ChartFrame title="WHY REQUESTS FAIL">
              <DataTable head={["CODE", "COUNT", { label: "MEANING", align: "left" }]}>
                {api.errorCodes.map((e) => (
                  <tr key={e.code}>
                    <Cell align="left" color={e.code === "RESTRICTED_JURISDICTION" ? AMBER : TXT}>
                      {e.code}
                    </Cell>
                    <Cell>{fmt.int(e.count)}</Cell>
                    <Cell align="left" color={MUT} mono={false}>
                      {e.meaning}
                    </Cell>
                  </tr>
                ))}
              </DataTable>
              <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: "10px 0 0" }}>
                Match on <span style={{ fontFamily: MONO, color: DIM }}>code</span>, never the message. Jurisdiction
                refusals are permanent — never retry one.
              </p>
            </ChartFrame>
          </div>
        )}
      </SubPane>
    </>
  );
}
