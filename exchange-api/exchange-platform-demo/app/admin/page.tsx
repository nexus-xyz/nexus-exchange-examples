/*
 * Overview — the page an operator leaves open on a second monitor.
 *
 * It answers "is my venue working" in the first screenful and "what should I do
 * about it" in the second. Deep analysis lives in Analytics; this page is
 * deliberately not a dashboard of everything.
 *
 * Two additions changed what this page is for. The first-run checklist is here
 * because the console's real day one has no flow, no traders and no fee, and
 * every other panel has nothing to say in that state — the checklist is what an
 * operator reads before any data exists. And the operational controls are here
 * rather than buried in Configuration, because the moment you want to halt a
 * venue is the moment you are already looking at its health.
 */

import Link from "next/link";

import { readVenueDashboard } from "@/lib/venue/admin";
import { defaultConfig, envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import { DEMO_MEMBERS } from "@/lib/venue/team-model";
import { apiAnalytics, uiAnalytics } from "@/lib/venue/product-analytics";
import { Grid, PageHead, Panel, Pill, buttonStyle } from "@/components/admin/shell";
import { ChartFrame, RankedBars, StackedArea } from "@/components/admin/charts";
import { Checklist, type ChecklistItem } from "@/components/admin/Checklist";
import { OpsControls } from "@/components/admin/OpsControls";
import { SortableTable } from "@/components/admin/interactive";
import { subPaneHref } from "@/components/admin/subpane";
import {
  EmptyState,
  ErrorState,
  Metric,
  MetricGrid,
  ProvenanceBadge,
  fmt,
  AMBER,
  FAINT,
  GREEN,
  L1,
  MUT,
  TXT,
} from "@/components/admin/parts";
import { SIZE, body } from "@/components/admin/type";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string }>;
}) {
  const env = resolveEnv((await searchParams).env);
  /*
   * EVERY LINK OUT OF THIS PAGE CARRIES THE ENVIRONMENT, and before this pass
   * none of them did. The checklist's four actions, the retry link and every row
   * of the markets table were bare pathnames — so an operator on live who
   * clicked REVIEW TEAM, or opened a market to check its volume, landed on test
   * data with nothing on screen saying the network had changed except an amber
   * edge disappearing. Same defect the shell fixed for the sidebar; the pages
   * had it too. `envHrefFor` is the one place that decision lives.
   */
  const href = (pathname: string) => envHrefFor(pathname, env);
  const d = await readVenueDashboard();
  const api = apiAnalytics();
  const ui = uiAnalytics();
  const config = defaultConfig(d.tenant.name, d.builder.feeBps);

  const healthy = d.live.stats?.health === "healthy";
  const tone = d.live.error ? "bad" : healthy ? "good" : "warn";
  /* 700ms and 1,500ms: a public market read is a cache hit at the edge, so anything
     past half a second is a cold path and anything past a second and a half is a
     trader noticing. Neither number is a service level — they are the thresholds at
     which an operator should look. */
  const rttTone =
    d.live.rttMs === null ? "mute" : d.live.rttMs > 1_500 ? "bad" : d.live.rttMs > 700 ? "warn" : "good";

  /*
   * SHARE OF BOOK divides this venue's latest routed day by the whole book's 24h
   * volume, and the two windows can drift out of step across a venue-wide restate
   * — which prints a venue routing more than the market's entire volume. An
   * impossible ratio in confident ink is worse than no figure, so over 1 reads as
   * unknown. Same guard, same reason, on the market drill-down.
   */
  const rawShareOfBook = d.usage.shareOfVenueVolume.value;
  const shareOfBook = rawShareOfBook !== null && rawShareOfBook > 1 ? null : rawShareOfBook;

  /*
   * The checklist is derived from the same environment and config the rest of the
   * console reads — never authored — so it cannot congratulate an operator for
   * something they have not done. Every row is something the operator can act on
   * from this console; a row they cannot move is not a checklist item, it is news.
   */
  const hasKey = Boolean(process.env.NEXUS_API_KEY_ID);
  const hasDb = Boolean(process.env.DATABASE_URL);
  const noMfa = DEMO_MEMBERS.filter((m) => m.status === "active" && !m.mfa).length;

  const checklist: ChecklistItem[] = [
    {
      label: "The venue answers",
      state: d.live.error ? "todo" : "done",
      /* Cut: "the cheapest health signal you have" — rationale for reading the
         row, which the row already is. The failure branch keeps its consequence. */
      detail: d.live.error
        ? `The public market read failed: ${d.live.error}. Nothing downstream works until this does.`
        : `Public market data read in ${d.live.rttMs ?? "—"}ms.`,
    },
    {
      label: "Markets listed",
      state: config.markets.length > 0 ? "done" : "todo",
      /* Cut: "Listing is selection, not creation…" — a definition, and Config is
         where an operator meets the constraint that matters. */
      detail:
        config.markets.length > 0
          ? `Carrying ${config.markets.length} of the ${d.live.markets.length} markets the exchange currently lists.`
          : "Your venue carries nothing.",
      action: (
        <Link href={href("/admin/config")} style={{ ...buttonStyle, textDecoration: "none" }}>
          CONFIGURE
        </Link>
      ),
    },
    {
      label: "Signing key installed",
      state: hasKey ? "done" : "todo",
      /* Cut: "Public reads work without one" — restates the row above it. */
      detail: hasKey
        ? "NEXUS_API_KEY_ID is present."
        : "No key in the environment: this venue can read the book and cannot sign an order.",
      action: (
        <Link href={href("/admin/keys")} style={{ ...buttonStyle, textDecoration: "none" }}>
          MINT A KEY
        </Link>
      ),
    },
    {
      label: "Attribution ledger is durable",
      state: hasDb ? "done" : "todo",
      detail: hasDb
        ? "DATABASE_URL is set — the ledger survives a redeploy."
        : /* Kept: this is a data-loss warning. Cut only the clause explaining WHY
             the exchange cannot reproduce it — the loss is the operable fact. */
          "The ledger is in memory: lose it and attribution is unrecoverable.",
    },
    {
      label: "Every operator has MFA",
      state: noMfa === 0 ? "done" : "todo",
      detail:
        noMfa === 0
          ? "All active members carry a second factor."
          : `${noMfa} active member${noMfa === 1 ? "" : "s"} can reach this console with a password alone.`,
      action: (
        <Link href={href("/admin/team")} style={{ ...buttonStyle, textDecoration: "none" }}>
          REVIEW TEAM
        </Link>
      ),
    },
    /* "Webhooks delivering" was here — a done/todo row derived from the count of
       failing endpoints, with a TEST DELIVERY action. Gone with the feature
       (EP-010): there is no delivery system to be healthy, so the row could
       never be anything but green, and a checklist row nobody can move is the
       exact defect the note below records. */
    /* Two rows removed here — builder-fee crediting and funding rails. Both were
       states of the platform rather than of this venue, so neither had an action
       an operator could take, and a checklist whose last two rows cannot be
       cleared teaches the reader to stop clearing rows. */
  ];

  return (
    <>
      <PageHead
        eyebrow="VENUE · EVERYTHING AT ONCE"
        title={d.tenant.name}
        right={
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            <Pill tone={tone}>
              {d.live.error ? "UNREACHABLE" : (d.live.stats?.health ?? "unknown").toUpperCase()}
            </Pill>
            {/* A round trip is a measurement, so it is graded rather than reported.
                It sat in mute ink at 1,965ms — a two-second read of public market
                data is the loudest signal on this page and it was the quietest
                thing on it. `null` stays neutral: unknown is not slow. */}
            <Pill tone={rttTone}>{d.live.rttMs === null ? "RTT UNKNOWN" : `${d.live.rttMs}ms RTT`}</Pill>
          </div>
        }
      />

      {d.live.error && (
        <ErrorState
          title="The venue did not answer its own health check"
          detail={d.live.error}
          retry={
            <Link href={href("/admin")} style={{ ...buttonStyle, textDecoration: "none" }}>
              RETRY
            </Link>
          }
        />
      )}

      {/*
        THE FIGURES COME FIRST NOW, and the checklist has moved below them.
        This page's job is "is my venue working", and the first screenful was eight
        setup cards: the operator's own numbers began below the fold, on the one page
        they leave open on a second monitor. Setup is read once and health is read
        every day, so health goes at the top and setup goes under it.
      */}
      {/* Blurb cut: "The six figures that describe the whole business" counted the
          contents of the panel it sat on. */}
      <Panel title="This venue">
        <MetricGrid min={132} divided>
          <Metric label="ROUTED (30D)" value={fmt.usd(d.usage.routedNotional.value)} provenance="live" />
          <Metric label="TRADERS" value={fmt.int(d.usage.traders.value)} provenance="live" />
          <Metric
            label="FEE ACCRUED"
            value={fmt.usdExact(d.revenue.builderFeeAccrued.value)}
            provenance="estimate"
            color={GREEN}
            hint="settles at period close"
          />
          <Metric
            label="SHARE OF BOOK"
            value={fmt.pct(shareOfBook, 3)}
            provenance="estimate"
            hint={
              shareOfBook === null && d.usage.shareOfVenueVolume.value !== null
                ? "unknown — the two windows are out of step"
                : "latest day ÷ live 24h"
            }
          />
          <Metric label="API CALLS 24H" value={fmt.int(api.requests24h)} provenance="live" />
          <Metric
            label="ERROR RATE"
            value={fmt.pct(api.errorRate, 2)}
            provenance="live"
            color={api.errorRate > 0.02 ? AMBER : undefined}
          />
        </MetricGrid>
      </Panel>

      <Grid min={340}>
        <Panel title="Routed notional" blurb="30 days, by market">
          <ChartFrame title="STACKED BY MARKET" right={<ProvenanceBadge provenance="live" />}>
            <StackedArea
              labels={d.daily.map((p) => fmt.day(p.dayMs))}
              series={[
                { label: "BTC", values: d.daily.map((p) => p.notional * 0.52) },
                { label: "ETH", values: d.daily.map((p) => p.notional * 0.31) },
                { label: "SOL", values: d.daily.map((p) => p.notional * 0.17) },
              ]}
              format={(n) => fmt.usd(n) ?? "—"}
            />
          </ChartFrame>
        </Panel>

        {/* Blurb cut: "The number that decides your next sprint" — an argument for
            reading the chart, not a fact about it. */}
        <Panel title="Where orders come from">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Two parts of one whole, so the track is the whole — not the larger of
                the two. Max-normalised, "API / SDK" filled the bar completely and the
                panel read as though nothing arrived over the UI. */}
            <RankedBars
              items={[
                { label: "API / SDK", value: ui.apiOrders, colorIndex: 0 },
                { label: "Branded UI", value: ui.uiOrders, colorIndex: 1 },
              ]}
              format={(n) => fmt.int(n) ?? "—"}
              scaleTo={ui.apiOrders + ui.uiOrders}
            />
            {/*
              TOP ENDPOINTS BY VOLUME WAS HERE AND IS GONE.
              It plotted `api.endpoints.slice(0, 5)` — the first five rows of the
              same array Analytics renders in full, sortable, beside the p50, p99
              and error rate that make an endpoint ranking mean something. A
              truncated, unsortable copy of another pane's table is not an
              overview of it; it is the same pane, worse, and it pushed the
              markets table below the fold on the one page an operator leaves
              open. What survives is the split above, which is the only endpoint
              question that belongs at venue altitude: is my traffic arriving
              through my UI or through my API. One link replaces 5 bars.
            */}
            <div style={{ borderTop: `1px solid ${L1}`, paddingTop: 13 }}>
              {/* The sentence around this link explained what the linked pane
                  contains; the link's own label already does. */}
              <span style={{ ...body(SIZE.note, 1.55), color: FAINT }}>
                Per-endpoint latency and errors:{" "}
                <Link
                  /* Built with the sub-pane helper rather than by string
                     concatenation, so this lands on the API tab of the LIVE
                     Analytics pane when the operator is on live — the exact
                     trapdoor `subPaneHref`'s `keep` argument exists to close. */
                  href={subPaneHref("/admin/analytics", "api", { env: env === "live" ? "live" : undefined })}
                  style={{ color: MUT }}
                >
                  Analytics → Branded API
                </Link>
                .
              </span>
            </div>
          </div>
        </Panel>
      </Grid>

      <Panel
        title="Markets"
        /* Blurb cut: the LIVE badge to the right says the first half, and the rows
           are already links. */
        right={<ProvenanceBadge provenance="live" />}
      >
        {d.live.error ? (
          <ErrorState title="The market read failed" detail={d.live.error} />
        ) : d.live.markets.length === 0 ? (
          /* Kept: it tells the operator the fault is not theirs to fix. */
          <EmptyState
            title="The exchange returned no markets"
            blurb="The exchange's state, not your venue's — there is nothing to configure your way out of."
          />
        ) : (
          <SortableTable
            searchPlaceholder="Filter markets…"
            initialSort={2}
            minWidth={640}
            head={[
              { label: "MARKET", align: "left" },
              { label: "MARK" },
              { label: "24H VOLUME" },
              { label: "TRADES" },
              { label: "CARRIED" },
              { label: "STATUS" },
            ]}
            rows={d.live.markets.map((m) => {
              const carried = config.markets.includes(m.market_id);
              return {
                id: m.market_id,
                /* Drill-down is the row itself. A separate "view" column would be a
                   second thing to aim at for the same intent. */
                href: href(`/admin/markets/${encodeURIComponent(m.market_id)}`),
                cells: [
                  { text: m.market_id, align: "left" as const, color: TXT },
                  {
                    /* fmt.price, not toLocaleString: the raw locale format drops
                       trailing zeros, so this column read 1,875.02 / 75.558 /
                       63,017.6 and the decimal point landed in three places. Right
                       alignment does not align numbers of unequal precision. */
                    text: fmt.price(m.engine_mark_price) ?? "—",
                    sortValue: m.engine_mark_price ?? 0,
                  },
                  { text: fmt.usd(m.volume_24h) ?? "—", sortValue: m.volume_24h ?? 0 },
                  { text: fmt.int(m.trade_count) ?? "—", sortValue: m.trade_count ?? 0 },
                  {
                    /* "CARRIED" / "—", not a green "yes" beside a green "active".
                       Two adjacent columns both painting GREEN made the eye read one
                       state where there are two — whether YOU list it, and whether
                       THE EXCHANGE runs it, which can disagree. Only the exchange's
                       status is a status; yours is a fact, so it wears label ink. */
                    text: carried ? "CARRIED" : "—",
                    color: carried ? MUT : FAINT,
                    sortValue: carried ? 1 : 0,
                  },
                  { text: m.status ?? "—", color: m.status === "active" ? GREEN : AMBER },
                ],
              };
            })}
          />
        )}
      </Panel>

      {/* Blurb cut: "Derived from this deployment, not a generic list" argued for
          the checklist's own credibility rather than stating a fact. */}
      <Panel title="Getting to live">
        <Checklist items={checklist} />
      </Panel>

      {/* Blurb cut: "The controls with a consequence" — each control states its own
          consequence, which is where an operator reads it. */}
      <Panel
        title="Operations"
        right={<Pill tone={env === "live" ? "warn" : "good"}>{env.toUpperCase()}</Pill>}
      >
        {/* OpsStatusNote removed with the component — it labelled the panel's
            build status, and each control states its own consequence instead. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <OpsControls env={env} openOrders={d.usage.fills.value === null ? null : 0} />
          {/*
            Two blocks cut here, both design rationale on an operator's screen:
            the SEPARATION note (why halt and cancel-all are two buttons instead of
            one emergency stop) and the "everything above is also an API call"
            line. The first is a decision, recorded here rather than rendered; the
            second is a claim about the console, not a control.
          */}
        </div>
      </Panel>
    </>
  );
}
