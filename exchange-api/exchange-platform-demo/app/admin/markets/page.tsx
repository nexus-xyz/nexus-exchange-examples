/*
 * Every market, side by side.
 *
 * WHY THIS PAGE EXISTS. The drill-down at `/admin/markets/[market]` has been
 * reachable only through the markets table on Overview, and that table is the
 * EXCHANGE's view of a market — mark, 24h volume, trade count, status. It is the
 * right table for "is the venue working", which is Overview's job. It cannot
 * answer the question this page is for, because the answer is not in any one
 * row: which of my listings is worth keeping, and which of the ones I skipped is
 * worth adding. A per-market page cannot answer it either — unit economics for
 * one market are a number, and a number is only a decision next to nine others.
 *
 * SO THE PAGE IS TWO LISTS, NOT ONE. What you carry, with what it earned; and
 * what you do not, with what it would earn at your current fee. Splitting them
 * is the whole design: the two lists are read for opposite reasons (drop versus
 * add), and merged into one table with a CARRIED flag the comparison that
 * matters — this against its peers in the same decision — is the one you have to
 * do in your head.
 *
 * WHAT IS DELIBERATELY NOT HERE, per `docs/WORKSTREAMS.md` §3d/§3e: no trend
 * chart restating a column beside it, no rollup metrics that would be Overview's
 * six figures a second time, and no illustrated empty state. Every figure is a
 * table cell, and every column says where it came from.
 *
 * PROVENANCE IS PER COLUMN, because it has to be. Volume, status and this
 * venue's own routed flow are LIVE — measured, and reconcilable against the
 * ledger. Fee is EST: it accrues against the schedule and settles at period
 * close, so it is the one column that can still move after the fact. The two are
 * never averaged into one figure, and the headers carry the tag so no cell can be
 * read without it.
 */

import Link from "next/link";

import { readVenueDashboard } from "@/lib/venue/admin";
import {
  MARKET_KIND_LABEL,
  MARKET_REGISTRY,
  defaultConfig,
  effectiveFeeBps,
  envHrefFor,
  resolveEnv,
} from "@/lib/venue/config-model";
import { marketDetail } from "@/lib/venue/product-analytics";
import { Note, PageHead, Panel, Pill } from "@/components/admin/shell";
import { SortableTable } from "@/components/admin/interactive";
import {
  EmptyState,
  ErrorState,
  fmt,
  AMBER,
  FAINT,
  GREEN,
  MUT,
  TXT,
} from "@/components/admin/parts";

export const dynamic = "force-dynamic";

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string }>;
}) {
  const env = resolveEnv((await searchParams).env);
  const href = (pathname: string) => envHrefFor(pathname, env);

  const d = await readVenueDashboard();
  const config = defaultConfig(d.tenant.name, d.builder.feeBps);

  /*
   * ONE PASS OVER THE REGISTRY, and the registry is the spine rather than the
   * live snapshot. A market the exchange lists but the testnet deployment is not
   * currently carrying still belongs on this page — it is a listing you can make
   * — and it would drop out of a join built the other way round. The live row is
   * therefore optional, and its absence renders as an em dash, never a zero.
   */
  const rows = MARKET_REGISTRY.map((registry) => {
    const feeBps = effectiveFeeBps(config, registry.id);
    const detail = marketDetail(registry.id, feeBps);
    return {
      registry,
      feeBps,
      detail,
      carried: config.markets.includes(registry.id),
      live: d.live.markets.find((m) => m.market_id === registry.id) ?? null,
    };
  });

  const carried = rows.filter((r) => r.carried);
  const available = rows.filter((r) => !r.carried);

  return (
    <>
      <PageHead
        eyebrow="VENUE · EVERY MARKET AT ONCE"
        title="Markets"
        blurb="What each listing earns, and what each one you have not taken would earn at your fee."
        right={
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            {/* A config fact, not a measurement, so it wears a pill rather than a
                provenance badge: this is what your nexus.json says, and it is
                true by construction rather than read from anywhere. */}
            <Pill tone={carried.length > 0 ? "good" : "warn"}>
              {carried.length} OF {MARKET_REGISTRY.length} CARRIED
            </Pill>
            <Pill tone="info">{config.feeBps} BPS DEFAULT</Pill>
          </div>
        }
      />

      {/* The live half of both tables comes from one read, so one failure
          notice covers both — and the venue's own economics below are still
          worth reading, which is why this is a notice and not a replacement for
          the page. */}
      {d.live.error && (
        <ErrorState
          title="The shared book did not answer"
          detail={`${d.live.error} — the LIVE market columns below are blank for that reason. Your own routed figures and the fee estimate are unaffected.`}
        />
      )}

      <Panel
        title="Carried"
        blurb="Listed in your nexus.json. Rows open the market."
      >
        {carried.length === 0 ? (
          <EmptyState
            title="Your venue carries nothing"
            blurb="A venue with no markets can be signed into and cannot be traded on. Listing is a line in nexus.json."
          />
        ) : (
          <SortableTable
            /* Sorted by fee, descending, because that is the column the drop
               decision is made on — and the one an operator would otherwise
               click first every single visit.

               NO FILTER BOX ON EITHER TABLE. The registry is ten markets; a
               search input above three rows is a control that costs a row of
               console to save nobody a scroll. Both tables sort, which is the
               control a ten-row comparison actually needs. */
            initialSort={4}
            minWidth={720}
            head={[
              { label: "MARKET", align: "left" },
              { label: "24H VOLUME · LIVE" },
              { label: "ROUTED 30D · LIVE" },
              { label: "TRADERS · LIVE" },
              { label: "FEE 30D · EST" },
              { label: "REJECTS · LIVE" },
              { label: "STATUS · LIVE" },
            ]}
            rows={carried.map((r) => ({
              id: r.registry.id,
              href: href(`/admin/markets/${encodeURIComponent(r.registry.id)}`),
              cells: [
                { text: r.registry.id, align: "left" as const, color: TXT },
                {
                  text: fmt.usd(r.live?.volume_24h ?? null) ?? "—",
                  color: r.live?.volume_24h == null ? FAINT : undefined,
                  sortValue: r.live?.volume_24h ?? 0,
                },
                { text: fmt.usd(r.detail.routedNotional) ?? "—", sortValue: r.detail.routedNotional },
                { text: fmt.int(r.detail.traders) ?? "—", sortValue: r.detail.traders },
                {
                  text: fmt.usdExact(r.detail.feeAccrued) ?? "—",
                  color: GREEN,
                  sortValue: r.detail.feeAccrued,
                },
                {
                  /* Graded, not merely reported. The same 3% threshold the
                     drill-down uses, so a rate that is amber here is amber when
                     you open it — one rule, stated in one place per page. */
                  text: fmt.pct(r.detail.rejectionRate, 2) ?? "—",
                  color: r.detail.rejectionRate > 0.03 ? AMBER : undefined,
                  sortValue: r.detail.rejectionRate,
                },
                {
                  text: r.live?.status ?? "—",
                  color: r.live?.status === "active" ? GREEN : r.live?.status ? AMBER : FAINT,
                  sortValue: r.live?.status ?? "",
                },
              ],
            }))}
          />
        )}
      </Panel>

      <Panel
        title="Available"
        blurb="In the exchange's registry, not in your config. The figures are what these would do at your fee — not a record of anything that happened."
      >
        {available.length === 0 ? (
          <EmptyState
            title="You carry the whole registry"
            blurb="There is nothing left to add until the exchange lists something new."
          />
        ) : (
          <SortableTable
            initialSort={3}
            minWidth={640}
            head={[
              { label: "MARKET", align: "left" },
              { label: "CLASS", align: "left" },
              { label: "24H VOLUME · LIVE" },
              { label: "WOULD ACCRUE 30D · EST" },
              { label: "REJECTS · LIVE" },
              { label: "EXCHANGE" },
            ]}
            rows={available.map((r) => ({
              id: r.registry.id,
              href: href(`/admin/markets/${encodeURIComponent(r.registry.id)}`),
              cells: [
                { text: r.registry.id, align: "left" as const, color: TXT },
                { text: MARKET_KIND_LABEL[r.registry.kind], align: "left" as const, color: MUT, mono: false },
                {
                  text: fmt.usd(r.live?.volume_24h ?? null) ?? "—",
                  color: r.live?.volume_24h == null ? FAINT : undefined,
                  sortValue: r.live?.volume_24h ?? 0,
                },
                {
                  /* Deliberately NOT green. Green is money that accrued; this is
                     money that would have, on a listing that does not exist —
                     colouring it the same would make a hypothesis look like a
                     balance. */
                  text: fmt.usdExact(r.detail.feeAccrued) ?? "—",
                  sortValue: r.detail.feeAccrued,
                },
                {
                  text: fmt.pct(r.detail.rejectionRate, 2) ?? "—",
                  color: r.detail.rejectionRate > 0.03 ? AMBER : undefined,
                  sortValue: r.detail.rejectionRate,
                },
                {
                  /* A market the exchange has paused cannot be listed however the
                     config is edited, so its status is the first thing to read in
                     this table rather than the last. */
                  text: r.registry.exchangeStatus,
                  color: r.registry.exchangeStatus === "active" ? GREEN : AMBER,
                  sortValue: r.registry.exchangeStatus,
                },
              ],
            }))}
          />
        )}
      </Panel>

      <Note tone="info" label="WHAT ADDS A MARKET">
        A listing is a line in{" "}
        <Link href={href("/admin/config")} style={{ color: MUT }}>
          nexus.json
        </Link>
        , and the registry above is the whole of what a venue may choose from — it is the exchange&apos;s, not
        yours. A paused market cannot be carried until the exchange resumes it.
      </Note>
    </>
  );
}
