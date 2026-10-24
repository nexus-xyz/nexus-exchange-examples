/*
 * One market, on its own page.
 *
 * The console was aggregate everywhere, and an aggregate hides the decision. A
 * venue-wide rejection rate of 1.2% is a number; "GOLD rejects 6% of its orders,
 * almost all of them MIN_NOTIONAL, and accrues forty dollars a month" is an
 * instruction — drop the listing from nexus.json. PACKAGING.md §6 calls this unit
 * economics per market, and it is the one analysis an operator cannot do from
 * their own logs, because they do not have the market's total volume to divide by.
 *
 * The book half and the attributed half of this page are both measured, but from
 * different sources — volume, mark and status come from the shared book, and your
 * routed flow comes from the venue's own attribution ledger. The two are never
 * mixed inside one figure, because the windows they are measured over differ.
 */

import { notFound } from "next/navigation";

import { readVenueDashboard } from "@/lib/venue/admin";
import { MARKET_REGISTRY, defaultConfig, effectiveFeeBps, envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import { marketDetail } from "@/lib/venue/product-analytics";
import { Breadcrumb, Grid, Note, PageHead, Panel, Pill } from "@/components/admin/shell";
import { ChartFrame, RankedBars, StackedArea } from "@/components/admin/charts";
import {
  Cell,
  DataTable,
  EmptyState,
  ErrorState,
  Metric,
  MetricGrid,
  ProvenanceBadge,
  fmt,
  AMBER,
  ARCHIVO,
  FAINT,
  GREEN,
  MUT,
  TXT,
} from "@/components/admin/parts";

export const dynamic = "force-dynamic";

export default async function MarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ market: string }>;
  searchParams: Promise<{ env?: string }>;
}) {
  const { market } = await params;
  const env = resolveEnv((await searchParams).env);
  const marketId = decodeURIComponent(market);

  /* A market this venue could never carry is a 404, not an empty page — the
     registry is the exchange's, and inventing a detail page for a market that
     does not exist would be the console making something up. */
  const registry = MARKET_REGISTRY.find((m) => m.id === marketId);
  if (!registry) notFound();

  const d = await readVenueDashboard();
  const config = defaultConfig(d.tenant.name, d.builder.feeBps);
  const feeBps = effectiveFeeBps(config, marketId);
  const detail = marketDetail(marketId, feeBps);
  const listed = config.markets.includes(marketId);
  const live = d.live.markets.find((m) => m.market_id === marketId) ?? null;
  /*
   * Share of the market's own volume — the shared-book dividend made visible. It
   * is only computable because the book is public, which is the whole pitch.
   *
   * AND IT IS THE ONE FIGURE ON THIS PAGE THAT DIVIDES ACROSS TWO WINDOWS, which
   * is exactly what the header comment above warns about: this venue's latest
   * routed day over the book's rolling 24h volume. When the two fall out of step —
   * a restated book, a day boundary crossed mid-read — the ratio can print
   * "SHARE OF MARKET 257.026%" in the same calm ink as every other figure, as
   * though a venue could route two and a half times a market's entire volume.
   *
   * A ratio over 1 is therefore UNKNOWN, not clamped and not printed. `null` renders
   * as an em dash and the hint says why — which is the console's own rule about the
   * difference between zero and unknown, applied to itself.
   */
  const rawShare = live?.volume_24h && live.volume_24h > 0
    ? (detail.daily[detail.daily.length - 1]?.notional ?? 0) / live.volume_24h
    : null;
  const shareImplausible = rawShare !== null && rawShare > 1;
  const share = shareImplausible ? null : rawShare;

  return (
    <>
      {/* The way back out of a drill-down dropped `?env=live`: an operator who
          opened a market from the LIVE overview and clicked "Overview" to go back
          landed on TEST, having changed network by pressing Back. Both crumbs go
          through envHrefFor now, same as the sidebar.

          The Markets crumb also used to point at Overview, because there was no
          index to point at — a crumb that lies about the shape of the hierarchy.
          It goes where it says now. */}
      <Breadcrumb
        trail={[
          { label: "Overview", href: envHrefFor("/admin", env) },
          { label: "Markets", href: envHrefFor("/admin/markets", env) },
          { label: marketId },
        ]}
      />

      <PageHead
        eyebrow="ONE MARKET · YOUR FLOW THROUGH IT"
        title={marketId}
        /* Second sentence cut: what belongs to the exchange rather than to the
           venue is the eyebrow's job, and it said it. Leverage stays — it is a
           limit, not a description. */
        blurb={`${registry.base} · ${registry.maxLeverage}× maximum leverage on the shared book.`}
        right={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Pill tone={listed ? "good" : "mute"}>{listed ? "LISTED" : "NOT LISTED"}</Pill>
            <Pill tone={registry.exchangeStatus === "active" ? "good" : "warn"}>
              EXCHANGE {registry.exchangeStatus.toUpperCase()}
            </Pill>
            <Pill tone="info">{feeBps} BPS</Pill>
          </div>
        }
      />

      {!listed && (
        <Note tone="warn" label="NOT CARRIED">
          Your venue does not list {marketId}. The figures below are what it <em>would</em> do at your current
          fee — useful for deciding whether to add it, and not a record of anything that happened.
        </Note>
      )}

      {/* Blurb cut: "What this one market is worth to the venue" is the title in
          a sentence. */}
      <Panel title="Unit economics">
        <MetricGrid min={136} divided>
          <Metric label="ROUTED (30D)" value={fmt.usd(detail.routedNotional)} provenance="live" />
          <Metric label="FILLS" value={fmt.int(detail.fills)} provenance="live" />
          <Metric label="TRADERS" value={fmt.int(detail.traders)} provenance="live" />
          <Metric
            label="FEE ACCRUED"
            value={fmt.usdExact(detail.feeAccrued)}
            provenance="estimate"
            color={GREEN}
            hint="settles at period close"
          />
          <Metric label="EFFECTIVE" value={fmt.bps(detail.effectiveBps)} provenance="estimate" />
          <Metric
            label="REJECTION RATE"
            value={fmt.pct(detail.rejectionRate, 2)}
            provenance="live"
            color={detail.rejectionRate > 0.03 ? AMBER : undefined}
            hint={detail.rejectionRate > 0.03 ? "high for one market" : undefined}
          />
        </MetricGrid>
      </Panel>

      <Grid min={340}>
        <Panel title="Your routed notional" blurb="30 days, this market only">
          <ChartFrame title="DAILY" right={<ProvenanceBadge provenance="live" />}>
            <StackedArea
              labels={detail.daily.map((p) => fmt.day(p.dayMs))}
              series={[{ label: marketId, values: detail.daily.map((p) => p.notional) }]}
              height={150}
              format={(n) => fmt.usd(n) ?? "—"}
            />
          </ChartFrame>
        </Panel>

        {/* Blurb cut: an argument for the panel, not a fact in it. */}
        <Panel title="Flow quality">
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <MetricGrid min={130} divided>
              <Metric
                label="MAKER SHARE"
                value={fmt.pct(detail.makerShare, 0)}
                provenance="live"
                hint="the rest takes liquidity"
              />
              <Metric label="AVG FILL" value={fmt.usdExact(detail.avgFillSize)} provenance="live" />
              <Metric
                label="SHARE OF MARKET"
                value={fmt.pct(share, 3)}
                provenance="estimate"
                hint={
                  shareImplausible
                    ? "unknown — the two windows are out of step"
                    : "your latest day ÷ live 24h"
                }
              />
            </MetricGrid>
            {/* Cut: three clauses selling SHARE OF MARKET as the shared-book
                dividend. The figure carries its own EST pill and a hint saying
                what it divides; the pitch is not the operator's business. */}
          </div>
        </Panel>
      </Grid>

      <Grid min={340}>
        {/* Blurb cut: "per market, because the mix differs by market" — the page
            is one market, so "here" in the title already scopes it. */}
        <Panel title="Why orders are rejected here">
          {detail.rejections.length === 0 ? (
            <EmptyState
              title="No rejections recorded"
              blurb="Either nothing has been submitted for this market, or everything that was submitted filled."
            />
          ) : (
            <>
              {/*
                THE BARS AND THE TABLE PRINTED THE SAME COUNTS TWICE, six inches
                apart, in the same panel — the exact thing WORKSTREAMS §3d rules
                out. Neither one was the redundant half on its own: the bars carry
                the comparison (is MIN_NOTIONAL most of this, or is the mix flat?)
                and the table carries the meaning, which is what turns a code into
                an action. So the COUNT COLUMN is gone and the two halves are now
                one reading — the bar is the number, the row is the explanation.
              */}
              <RankedBars
                items={detail.rejections.map((r, i) => ({ label: r.code, value: r.count, colorIndex: i % 4 }))}
                format={(n) => fmt.int(n) ?? "—"}
              />
              <div style={{ marginTop: 16 }}>
                <DataTable head={[{ label: "CODE", align: "left" }, { label: "WHAT IT MEANS", align: "left" }]}>
                  {detail.rejections.map((r) => (
                    <tr key={r.code}>
                      <Cell align="left" color={r.code === "RESTRICTED_JURISDICTION" ? AMBER : TXT}>
                        {r.code}
                      </Cell>
                      <Cell align="left" color={MUT} mono={false}>
                        {r.meaning}
                      </Cell>
                    </tr>
                  ))}
                </DataTable>
              </div>
            </>
          )}
        </Panel>

        <Panel title="The market itself" blurb="Live from the shared book" right={<ProvenanceBadge provenance="live" />}>
          {d.live.error ? (
            <ErrorState title="The venue did not answer" detail={d.live.error} />
          ) : live === null ? (
            <EmptyState
              title="Not on this deployment"
              blurb={`${marketId} is in the registry but the testnet deployment is not carrying it right now. That is the exchange's state, not your venue's.`}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <DataTable head={[{ label: "FIELD", align: "left" }, "VALUE"]}>
                <tr>
                  <Cell align="left" color={MUT}>Mark price</Cell>
                  {/* fmt.price, not toLocaleString — the raw locale format drops
                      trailing zeros, so this two-row block put the decimal point
                      in two different places on two numbers that are read against
                      each other. Same fix the Overview markets table already had. */}
                  <Cell color={TXT}>{fmt.price(live.engine_mark_price) ?? "—"}</Cell>
                </tr>
                <tr>
                  <Cell align="left" color={MUT}>Last trade</Cell>
                  <Cell color={TXT}>{fmt.price(live.last_trade_price) ?? "—"}</Cell>
                </tr>
                <tr>
                  <Cell align="left" color={MUT}>24h volume</Cell>
                  <Cell color={TXT}>{fmt.usd(live.volume_24h) ?? "—"}</Cell>
                </tr>
                <tr>
                  <Cell align="left" color={MUT}>24h trades</Cell>
                  <Cell color={TXT}>{fmt.int(live.trade_count) ?? "—"}</Cell>
                </tr>
                <tr>
                  <Cell align="left" color={MUT}>Open interest</Cell>
                  {/* Absent from /markets/summary on this deployment. An em dash,
                      never a zero — zero would read as "flat", not "unknown". */}
                  <Cell color={live.open_interest === null ? FAINT : TXT}>{fmt.usd(live.open_interest) ?? "—"}</Cell>
                </tr>
                <tr>
                  <Cell align="left" color={MUT}>Status</Cell>
                  <Cell color={live.status === "active" ? GREEN : AMBER}>{live.status ?? "—"}</Cell>
                </tr>
              </DataTable>
            </div>
          )}
        </Panel>
      </Grid>
    </>
  );
}
