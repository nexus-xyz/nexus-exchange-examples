/*
 * Request logs — the pane a developer opens when a call fails (WORKSTREAMS §3g).
 *
 * THE THREE TABS ARE THREE QUESTIONS, not three filters that happened to be
 * cheap. *Recent* is "did my call arrive"; *Errors* is "what is broken and since
 * when"; *Slowest* is "which route is costing me the deadline". Each one wants a
 * different chart above the same tape, which is the argument for tabs rather than
 * one long pane with a status dropdown: the dropdown would leave the wrong chart
 * on screen for two of the three questions.
 *
 * WHY THE ERROR CHART PLOTS ONLY FAILURES. The obvious chart is requests per hour
 * stacked by status class, and it is unreadable: 99% of the band is 2xx, so the
 * two series anyone cares about are a hairline at the top of a slab. Plotting the
 * failures alone gives them the whole scale, and the total volume is one figure in
 * the row above — where a number belongs.
 *
 * WHAT IS NOT HERE. No live tail. A console that streams rows is a console whose
 * page is never in a state anyone can screenshot, cite in a ticket, or grade in
 * this project's capture harness — and the request that is being debugged has
 * already happened. No "download all logs" either: this is a sample, and offering
 * an export of a sample as though it were the record is the kind of half-truth
 * that gets built into someone's reconciliation job.
 */

import Link from "next/link";

import { envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import { Note, PageHead, Panel, Pill } from "@/components/admin/shell";
import { SubPane, resolveSubPane, subPaneHref } from "@/components/admin/subpane";
import {
  Metric,
  MetricGrid,
  ProvenanceBadge,
  fmt,
  AMBER,
  DIM,
  FAINT,
  GREEN,
  MUT,
  RED,
  TXT,
} from "@/components/admin/parts";
import { ChartFrame, Histogram, RankedBars, StackedArea } from "@/components/admin/charts";
import { SortableTable, type TableRow } from "@/components/admin/interactive";
import { SIZE, body } from "@/components/admin/type";
import {
  CODE_MEANING,
  FAILURE_ONE_IN,
  SUCCESS_ROWS,
  TAPE_TOTAL_24H,
  errorCodeCounts,
  latencyDistribution,
  recentRequests,
  statusSeries,
  type RequestEntry,
} from "@/lib/venue/request-log";
import { ago, hhmm, hhmmss } from "@/lib/venue/clock";
import { monoLabel } from "@/lib/theme";

export const dynamic = "force-dynamic";

const PANES = [
  { id: "recent", label: "Recent" },
  { id: "errors", label: "Errors" },
  { id: "slowest", label: "Slowest" },
] as const;

/** The status colour, as a rule rather than per call site. */
function statusColor(status: number): string {
  if (status >= 500) return RED;
  if (status >= 400) return AMBER;
  return GREEN;
}

function toRows(entries: RequestEntry[]): TableRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    cells: [
      { text: hhmmss(entry.atMs), align: "left" as const, color: MUT, sortValue: entry.atMs },
      { text: entry.method, align: "left" as const, color: DIM },
      { text: entry.path, align: "left" as const, color: TXT },
      /* A key id, never a secret — and the id is already the truncated form the
         rest of the console shows. "public" is a real value here, not a blank:
         an unsigned read is a deliberate choice, and seeing it in the tape is how
         an operator confirms their proxy is making it. */
      { text: entry.keyId ?? "public", align: "left" as const, color: entry.keyId ? MUT : FAINT },
      { text: String(entry.status), color: statusColor(entry.status), sortValue: entry.status },
      { text: `${entry.latencyMs.toLocaleString("en-US")}ms`, sortValue: entry.latencyMs },
      { text: entry.code ?? "—", align: "left" as const, color: entry.code ? AMBER : FAINT },
      { text: entry.id, align: "left" as const, color: FAINT },
    ],
  }));
}

const HEAD = [
  { label: "WHEN (UTC)", align: "left" as const },
  { label: "METHOD", align: "left" as const },
  { label: "PATH", align: "left" as const },
  { label: "KEY", align: "left" as const },
  { label: "STATUS" },
  { label: "LATENCY" },
  { label: "CODE", align: "left" as const },
  { label: "REQUEST ID", align: "left" as const },
];

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string; tab?: string }>;
}) {
  const { env: rawEnv, tab } = await searchParams;
  const env = resolveEnv(rawEnv);
  const pane = resolveSubPane(PANES, tab);

  const entries = recentRequests();
  const series = statusSeries();
  const failures = entries.filter((e) => e.status >= 400);
  /*
   * PERCENTILES COME FROM THE SUCCESSES ONLY, and the label says so. The tape
   * over-samples failures by design, so a p99 taken over all of it would be the
   * timeout deadline — 5,000ms — on a venue whose calls almost all answer in
   * under a quarter second. A percentile computed over a biased sample is the
   * most confident wrong number a console can print.
   */
  const latency = latencyDistribution(entries.filter((e) => e.status < 400));
  /*
   * THE TAIL IS THE TAIL OF SUCCESSES. Ranking every row by latency put twenty
   * identical 5,000ms timeouts at the top of the list and made the Slowest tab a
   * second copy of Errors — a timeout is the deadline, not a measurement of how
   * long the work took, and averaging one into a percentile is how a p95 becomes
   * a number about your outage rather than about your service. The failures have
   * their own tab and it is one click away.
   */
  const succeeded = entries.filter((e) => e.status < 400);
  const slowest = [...succeeded].sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 40);

  const client24h = series.client.reduce((a, b) => a + b, 0);
  const server24h = series.server.reduce((a, b) => a + b, 0);
  const worstIndex = series.server.indexOf(Math.max(...series.server));
  const worstHourMs = series.hoursMs[worstIndex] ?? 0;
  /* Derived, never typed: the success rate is whatever the row budget works out
     to against the volume that is left after the failures. */
  const successOneIn = Math.round((TAPE_TOTAL_24H - client24h - server24h) / SUCCESS_ROWS);

  /* Per-route tail latency, from the same rows the table lists. Grouped on the
     route template rather than the concrete path, or `/orders/{id}` would be
     forty routes with one sample each and no percentile worth the name. */
  const byRoute = new Map<string, number[]>();
  for (const entry of succeeded) {
    const route = `${entry.method} ${entry.path}`;
    byRoute.set(route, [...(byRoute.get(route) ?? []), entry.latencyMs]);
  }
  const routeTail = [...byRoute.entries()]
    .filter(([, values]) => values.length >= 5)
    .map(([route, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { label: route, value: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0 };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const hrefFor = (id: string) =>
    subPaneHref("/admin/logs", id, { env: env === "live" ? "live" : undefined });

  return (
    <>
      {/* CUT: the page blurb. The window is the panel below it, the sample ratio
          is the tape's own subtitle, and "measured at your proxy" survives on the
          REQUESTS metric hint and the tail note. */}
      <PageHead
        eyebrow="BUILD · WHAT ACTUALLY HAPPENED"
        title="Request logs"
        right={
          server24h > 0 ? <Pill tone="bad">5XX IN WINDOW</Pill> : <Pill tone="good">NO SERVER ERRORS</Pill>
        }
      />

      <Panel title="The window" blurb="24 hours, ending at the venue's last recorded request.">
        <MetricGrid min={140} divided>
          <Metric
            label="REQUESTS"
            value={fmt.int(TAPE_TOTAL_24H)}
            provenance="live"
            hint="signed and public, at your proxy"
          />
          <Metric
            label="4XX"
            value={fmt.int(client24h)}
            provenance="live"
            color={AMBER}
            hint="rejected — your call, not our fault"
          />
          <Metric
            label="5XX"
            value={fmt.int(server24h)}
            provenance="live"
            color={server24h > 0 ? RED : GREEN}
            hint={server24h > 0 ? `worst hour ${hhmm(worstHourMs)} UTC` : "none in the window"}
          />
          <Metric
            label="P99 LATENCY (2XX)"
            value={`${latency.p99Ms}ms`}
            provenance="live"
            hint={`p50 ${latency.p50Ms}ms · successes only`}
          />
        </MetricGrid>
      </Panel>

      <SubPane
        panes={PANES}
        active={pane}
        hrefFor={hrefFor}
        title={pane === "recent" ? "The tape" : pane === "errors" ? "Failures" : "The tail"}
        /* The recent blurb is the sampling ratio and the slowest one says where
           timeouts went; both are facts the title cannot carry. The errors blurb
           restated the word "Failures" and is gone. */
        blurb={
          pane === "recent"
            ? `A stratified sample — ${entries.length} rows out of ${fmt.int(TAPE_TOTAL_24H)}: 1 success in ${successOneIn}, 1 failure in ${FAILURE_ONE_IN}.`
            : pane === "errors"
              ? undefined
              : "The 40 slowest calls that succeeded. Timeouts are under Errors."
        }
        right={<ProvenanceBadge provenance="live" />}
      >
        {pane === "recent" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/*
             * The distribution before the rows, for the same reason Keys puts a
             * chart before its table: the tape is 260 unordered facts and the
             * histogram is the one shape that says whether any of them are
             * surprising. The p99 marker is the bar an operator is looking for.
             */}
            <ChartFrame
              title="LATENCY DISTRIBUTION — SUCCESSFUL CALLS, SAMPLED"
              right={<ProvenanceBadge provenance="live" />}
            >
              <Histogram
                bins={latency.bins}
                markerIndex={latency.p99BinIndex}
                markerLabel={`p99 ${latency.p99Ms}ms`}
              />
            </ChartFrame>

            <SortableTable
              searchPlaceholder="Filter by path, key, status or request id…"
              initialSort={0}
              minWidth={880}
              emptyTitle="No requests in this window"
              emptyBlurb="Either the venue served nothing, or the proxy is not reporting. Both are worth a look at the health strip on Overview."
              head={HEAD}
              rows={toRows(entries)}
            />

            {/* Compressed: the ratios are in the subtitle above, so the note keeps
                only the trap — reading an error rate off this list. */}
            <Note tone="warn" label="SAMPLING">
              <strong style={{ color: TXT }}>The mix in this list is not the mix in your traffic</strong> — an
              error rate counted here comes out about {Math.round(successOneIn / FAILURE_ONE_IN)}× too high. The
              figures above are the real ones.
            </Note>
          </div>
        )}

        {pane === "errors" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <ChartFrame title="FAILURES PER HOUR, 24H" right={<ProvenanceBadge provenance="live" />}>
              <StackedArea
                labels={series.labels}
                series={[
                  { label: "4xx — rejected", values: series.client },
                  { label: "5xx — server", values: series.server },
                ]}
                height={140}
                format={(n) => fmt.int(Math.round(n)) ?? "—"}
              />
            </ChartFrame>

            {server24h > 0 && (
              <Note tone="warn" label="THE STEP">
                <span style={{ fontFamily: "inherit" }}>
                  {/* Kept in full-ish: this is the incident, and the last clause is
                      what to do about it. */}
                  5xx starts at <strong style={{ color: TXT }}>{hhmm(worstHourMs)} UTC</strong> ({ago(worstHourMs)}
                  ), almost all <strong style={{ color: TXT }}>POST /api/v1/orders</strong> returning 504. The
                  order may still have been accepted — reconcile against fills before resubmitting.
                </span>
              </Note>
            )}

            <ChartFrame title="FAILURES BY CODE, SAMPLED" right={<ProvenanceBadge provenance="live" />}>
              <RankedBars
                items={errorCodeCounts(entries).map((c) => ({ label: c.code, value: c.count }))}
                format={(n) => fmt.int(n) ?? "—"}
              />
            </ChartFrame>

            {/* The codes, with what each one means. A ranked bar names the
                failure; this is the line that tells a developer whether to retry
                it, and retry-or-not is the entire decision. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>WHAT THEY MEAN</span>
              {errorCodeCounts(entries).map((c) => (
                <div key={c.code} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                  <span style={{ ...monoLabel(SIZE.micro), color: TXT, flex: "0 0 190px" }}>{c.code}</span>
                  <span style={{ ...body(SIZE.body, 1.6), color: MUT, flex: "1 1 220px", minWidth: 0 }}>
                    {CODE_MEANING[c.code] ?? ""}
                  </span>
                </div>
              ))}
            </div>

            <SortableTable
              searchPlaceholder="Filter failures by path, key or code…"
              initialSort={0}
              minWidth={880}
              emptyTitle="Nothing failed in this window"
              emptyBlurb="The correct state, and the reason this pane does not lead with it — an empty failure list is not evidence that an integration works."
              head={HEAD}
              rows={toRows(failures)}
            />
          </div>
        )}

        {pane === "slowest" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/*
             * p95 by route, not p99: eight routes over a 260-row sample means the
             * smallest of them has a dozen samples, and a p99 computed from a
             * dozen points is the maximum wearing a percentile's name.
             */}
            <ChartFrame title="P95 LATENCY BY ROUTE — SUCCESSFUL CALLS" right={<ProvenanceBadge provenance="live" />}>
              <RankedBars items={routeTail} format={(n) => `${fmt.int(n)}ms`} />
            </ChartFrame>

            <SortableTable
              searchPlaceholder="Filter by path or key…"
              initialSort={5}
              minWidth={880}
              emptyTitle="No requests in this window"
              emptyBlurb="Nothing to rank."
              head={HEAD}
              rows={toRows(slowest)}
            />

            {/* Kept: where the number is measured changes what it means. The
                timeout-exclusion half is now the pane's subtitle. */}
            <Note tone="info" label="WHERE THE TIME GOES">
              Measured at your proxy, so these include the exchange round trip and your own hop.
            </Note>
          </div>
        )}
      </SubPane>

      {/* The retention window and the no-export rule stay; the sentence
          explaining why a sample is not a record went. */}
      <Note tone="info" label="RETENTION">
        The tape is held for 7 days and is not exported. For anything that has to balance, use{" "}
        <Link href={envHrefFor("/admin/api", env)} style={{ color: TXT }}>
          GET /api/v1/fills
        </Link>
        , and for who changed the venue,{" "}
        <Link href={envHrefFor("/admin/audit", env)} style={{ color: TXT }}>
          the audit log
        </Link>
        .
      </Note>
    </>
  );
}
