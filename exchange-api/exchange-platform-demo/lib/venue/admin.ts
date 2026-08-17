/*
 * What the dashboards read.
 *
 * One rule runs through this file: every figure declares where it came from.
 * `live` means the venue measured it — a request answered just now, or a row read
 * off the attribution ledger. `estimate` means it is derived from the builder-fee
 * model and has not settled yet, so it is what the venue has accrued rather than
 * what it has been paid.
 *
 * A dashboard that mixes the two silently is worse than no dashboard: it launders
 * a projection into a number someone forecasts against.
 */

import { summarise, type BuilderSummary } from "@nexus-eaas/venue-kit";

import { ACTIVE_TENANT } from "../tenant";
import { readLiveSnapshot, type LiveSnapshot } from "./live";
import { DEMO_VENUES, attributedFlow } from "./ledger-store";

export type Provenance = "live" | "estimate";

export interface Figure {
  value: number | null;
  provenance: Provenance;
}

const fig = (value: number | null, provenance: Provenance): Figure => ({ value, provenance });

/** Parse a venue-kit decimal string back to a number, for charting only. */
const dec = (value: string): number => Number(value) || 0;

// ── the developer's own venue ────────────────────────────────────────────────

export interface VenueDashboard {
  tenant: { id: string; name: string; wordmark: string; entity: string };
  builder: { code: string; feeBps: number };
  live: LiveSnapshot;
  /** Rollup for this venue's builder code. Null when the venue charges no fee. */
  rollup: BuilderSummary | null;
  usage: {
    traders: Figure;
    fills: Figure;
    routedNotional: Figure;
    /** Routed notional as a share of the venue-wide 24h volume. */
    shareOfVenueVolume: Figure;
  };
  revenue: {
    builderFeeAccrued: Figure;
    exchangeFeesPaid: Figure;
    /** Builder fee as a share of all fees the trader paid. */
    feeRatio: Figure;
    effectiveBps: Figure;
  };
  daily: { dayMs: number; notional: number }[];
}

export async function readVenueDashboard(): Promise<VenueDashboard> {
  const live = await readLiveSnapshot();
  const { ledger, fills, daily } = attributedFlow();
  const code = ACTIVE_TENANT.builder.code;

  const rollup = code ? (summarise(ledger, fills).find((r) => r.builderCode === code) ?? null) : null;
  const demo = DEMO_VENUES.find((v) => v.code === code) ?? null;

  const routed = rollup ? dec(rollup.notional) : 0;
  const accrued = rollup ? dec(rollup.builderFeeAccrued) : 0;
  const exchangeFees = rollup ? dec(rollup.venueFees) : 0;
  const venueVolume24h = live.markets.reduce((sum, m) => sum + (m.volume_24h ?? 0), 0);
  /*
   * Share of volume compares LIKE WITH LIKE. Dividing 30-day routed notional by
   * a 24-hour venue volume produced 1617% on screen — arithmetically fine and
   * completely meaningless. Both sides are one day.
   */
  const routedLatestDay = code ? (daily[daily.length - 1]?.byCode[code] ?? 0) : 0;

  return {
    tenant: {
      id: ACTIVE_TENANT.id,
      name: ACTIVE_TENANT.name,
      wordmark: ACTIVE_TENANT.wordmark,
      entity: ACTIVE_TENANT.legal.entity,
    },
    builder: ACTIVE_TENANT.builder,
    live,
    rollup,
    usage: {
      traders: fig(demo?.traders ?? null, "live"),
      fills: fig(rollup?.fills ?? 0, "live"),
      routedNotional: fig(routed, "live"),
      shareOfVenueVolume: fig(venueVolume24h > 0 ? routedLatestDay / venueVolume24h : null, "estimate"),
    },
    revenue: {
      builderFeeAccrued: fig(accrued, "estimate"),
      exchangeFeesPaid: fig(exchangeFees, "live"),
      feeRatio: fig(accrued + exchangeFees > 0 ? accrued / (accrued + exchangeFees) : null, "estimate"),
      effectiveBps: fig(routed > 0 ? (accrued / routed) * 10_000 : null, "estimate"),
    },
    daily: daily.map((d) => ({ dayMs: d.dayMs, notional: code ? (d.byCode[code] ?? 0) : 0 })),
  };
}

// ── the platform, across every venue ─────────────────────────────────────────
