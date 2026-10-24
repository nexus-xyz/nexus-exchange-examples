/*
 * Billing — what the venue earned, and what would happen to it.
 *
 * WHY IT LEFT AUDIT. The two were one pane because they answer each other: an
 * unexplained number in billing is explained by the audit log. That is a reason
 * to link them, not to merge them — they are read by different people at
 * different frequencies (an Owner checks earnings monthly; anyone debugging a
 * fee change reads the audit log the same afternoon), and the merged pane made
 * the audit trail something you scrolled past to reach the money.
 *
 * ACCRUED AND SETTLED ARE SEPARATE COLUMNS, and they never merge. A builder fee
 * accrues continuously against the venue's own schedule and settles once a period,
 * so between two closes there is always a figure that is real money and a figure
 * that is still a projection. One blended "revenue" number would move on the day of
 * a close for reasons that have nothing to do with the venue's flow, and an
 * operator forecasting off it would be forecasting off the calendar.
 *
 * THE OPEN PERIOD IS SEVEN DAYS WIDE HERE because that is the settlement cadence
 * the fee schedule runs on. Everything older has closed; everything inside it is
 * still moving.
 */

import Link from "next/link";

import { readVenueDashboard } from "@/lib/venue/admin";
import { envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import { Grid, Note, PageHead, Panel, Pill, Row } from "@/components/admin/shell";
import {
  Metric,
  MetricGrid,
  ProvenanceBadge,
  fmt,
  FAINT,
  GREEN,
  MUT,
  TXT,
} from "@/components/admin/parts";
import { ChartFrame, StackedArea } from "@/components/admin/charts";
import { SIZE, body } from "@/components/admin/type";
import { monoLabel } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string }>;
}) {
  const env = resolveEnv((await searchParams).env);
  const d = await readVenueDashboard();
  const accrued = d.revenue.builderFeeAccrued.value ?? 0;

  /* Settled vs open, derived from the same daily series the chart plots rather
     than from a second source — the two panels on this page cannot disagree if
     they are the same arithmetic. */
  const OPEN_PERIOD_DAYS = 7;
  const feeOf = (notional: number) => notional * (d.builder.feeBps / 10_000);
  const settled = d.daily
    .slice(0, Math.max(0, d.daily.length - OPEN_PERIOD_DAYS))
    .reduce((sum, p) => sum + feeOf(p.notional), 0);
  const open = Math.max(0, accrued - settled);

  return (
    <>
      {/* CUT: the page blurb restated the three columns below it, and the
          "never merges them" line was rationale for a layout the page already
          shows. The NOTHING CHARGED pill is the claim that had to stay. */}
      <PageHead
        eyebrow="ORGANISATION · THE MONEY"
        title="Billing"
        right={<Pill tone="mute">PERIOD OPEN</Pill>}
      />

      {/* CUT: panel blurb explaining WHY accrued and charged are separate
          columns. Design rationale — it lives in the file header comment. */}
      <Panel title="Earnings">
        <MetricGrid min={140} divided>
          <Metric label="ACCRUED (30D)" value={fmt.usdExact(accrued)} provenance="estimate" color={GREEN} />
          <Metric label="SETTLED" value={fmt.usdExact(settled)} provenance="live" hint="through the last close" />
          <Metric
            label="OPEN"
            value={fmt.usdExact(open)}
            provenance="estimate"
            hint={`the last ${OPEN_PERIOD_DAYS} days`}
          />
          <Metric
            label="EXCHANGE FEES PAID"
            value={fmt.usdExact(d.revenue.exchangeFeesPaid.value)}
            provenance="live"
            hint="what your traders paid the venue"
          />
        </MetricGrid>

        {/* A magnitude series in its own right, so it gets a real chart with a
            scale rather than the sparkline that used to float here at a fixed
            520px inside a full-width panel. */}
        <div style={{ marginTop: 20 }}>
          <ChartFrame title="DAILY ACCRUAL, 30 DAYS" right={<ProvenanceBadge provenance="estimate" />}>
            <StackedArea
              labels={d.daily.map((p) => fmt.day(p.dayMs))}
              series={[
                {
                  label: "Builder fee accrued",
                  values: d.daily.map((p) => p.notional * (d.builder.feeBps / 10_000)),
                },
              ]}
              height={140}
              format={(n) => fmt.usdExact(n) ?? "—"}
            />
          </ChartFrame>
        </div>
      </Panel>

      <Grid min={320}>
        {/* CUT: panel blurb (restated the rows) and the hint on "Share of trader
            fees" (restated its own label). The two hints left state a constraint
            and a formula, which the labels cannot. */}
        <Panel title="Fee basis">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Row label="Venue fee" hint="No ceiling.">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>{d.builder.feeBps} bps</span>
            </Row>
            <Row label="Effective rate" hint="Accrued over routed notional, after per-market overrides.">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>
                {fmt.bps(d.revenue.effectiveBps.value) ?? "—"}
              </span>
            </Row>
            <Row label="Share of trader fees">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>{fmt.pct(d.revenue.feeRatio.value, 1) ?? "—"}</span>
            </Row>
          </div>
          {/* The gap between the headline rate and the effective one is the whole
              content of this panel — a venue that has set overrides and forgotten
              them finds out here, and nowhere else. */}
          {/* Compressed to the gotcha and the two links; the "doing it by
              accident" framing was the same fact twice. */}
          <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: "12px 0 0" }}>
            A gap between these two is per-market overrides.{" "}
            <Link href={envHrefFor("/admin/config", env)} style={{ color: MUT }}>
              Configuration
            </Link>{" "}
            lists them;{" "}
            <Link href={envHrefFor("/admin/audit", env)} style={{ color: MUT }}>
              Audit
            </Link>{" "}
            says who set them.
          </p>
        </Panel>

        {/* CUT: panel blurb, and the Schedule/Currency hints that restated their
            labels. The Owner-only constraint stays — it is the security claim. */}
        <Panel title="Payout">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Row label="Destination" hint="Owner-only.">
              <Pill tone="mute">NOT SET</Pill>
            </Row>
            <Row label="Schedule">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>WEEKLY</span>
            </Row>
            <Row label="Currency">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>USDX</span>
            </Row>
          </div>
          {/* One sentence, and it is the consequence of the NOT SET row above —
              which is a state of this venue, and one an Owner can clear today. */}
          <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: "12px 0 0" }}>
            With no destination set, settled fees hold in the venue&apos;s USDX balance instead of paying out.
          </p>
        </Panel>
      </Grid>

      {/* Compressed, not deleted: an in-memory ledger is a data-loss warning, and
          this is the one page where the loss is denominated in money. */}
      <Note tone="warn" label="THE RECORD THAT MATTERS">
        <span style={{ fontFamily: "inherit" }}>
          The attribution ledger behind these numbers is held in memory unless DATABASE_URL is set, and it is
          the venue&apos;s own record — the exchange cannot reproduce it. Back it before the next close;{" "}
          <Link href={envHrefFor("/admin/audit", env)} style={{ color: TXT }}>
            Audit
          </Link>{" "}
          carries the retention terms.
        </span>
      </Note>
    </>
  );
}
