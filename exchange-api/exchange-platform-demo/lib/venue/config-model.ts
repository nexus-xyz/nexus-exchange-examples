/*
 * What a venue operator can actually configure.
 *
 * The design rule that decides every entry below: **a venue configures its own
 * surface, never the shared book.** Listing a market on your venue means showing
 * it in your UI and accepting orders for it; it does not create the market, set
 * its tick size, or change its risk parameters — those belong to the exchange,
 * and one tenant must not be able to move them for everyone. So "markets" is a
 * subset selection over a registry, not a market editor.
 *
 * The second rule: **the venue sets its own price, under a hard ceiling of 10
 * bps, and the trader approves a maximum before a basis point moves.** This is a
 * reversal. The ceiling was removed on the argument that disclosure plus
 * competition disciplines the price, and it came back because disclosure is not
 * consent — the fee is inside one blended rate, so a trader reads a price and
 * never reads a decision — and because a venue charging an outrageous fee damages
 * the exchange it matched on rather than itself. The consent is signed by the
 * trader's main wallet, never by their delegated trading key: the credential that
 * can trade must not be able to authorise being charged. See venue-kit's
 * `builder/fee.ts` for the full argument and `MAX_FEE_BPS` for the number.
 */

import { normaliseFeeBps } from "@nexus-eaas/venue-kit";

export { normaliseFeeBps };

/** A market the exchange lists, which a venue may choose to carry. */
export interface AvailableMarket {
  id: string;
  base: string;
  /** Asset class, for grouping in the picker. */
  kind: "crypto" | "fx" | "commodity" | "index";
  maxLeverage: number;
  /** Whether the exchange itself has this live. A venue cannot list what is not. */
  exchangeStatus: "active" | "paused" | "delisted";
}

/*
 * The registry a venue picks from. In the deployed product this comes from
 * `GET /markets`; here it is the set the testnet actually carries plus the
 * classes the venue thesis names, so the picker shows the shape of the choice.
 */
export const MARKET_REGISTRY: AvailableMarket[] = [
  { id: "BTC-USDX-PERP", base: "BTC", kind: "crypto", maxLeverage: 50, exchangeStatus: "active" },
  { id: "ETH-USDX-PERP", base: "ETH", kind: "crypto", maxLeverage: 50, exchangeStatus: "active" },
  { id: "SOL-USDX-PERP", base: "SOL", kind: "crypto", maxLeverage: 20, exchangeStatus: "active" },
  { id: "XRP-USDX-PERP", base: "XRP", kind: "crypto", maxLeverage: 20, exchangeStatus: "active" },
  { id: "DOGE-USDX-PERP", base: "DOGE", kind: "crypto", maxLeverage: 10, exchangeStatus: "active" },
  { id: "EUR-USDX-PERP", base: "EUR", kind: "fx", maxLeverage: 100, exchangeStatus: "active" },
  { id: "JPY-USDX-PERP", base: "JPY", kind: "fx", maxLeverage: 100, exchangeStatus: "paused" },
  { id: "XAU-USDX-PERP", base: "GOLD", kind: "commodity", maxLeverage: 25, exchangeStatus: "active" },
  { id: "WTI-USDX-PERP", base: "OIL", kind: "commodity", maxLeverage: 20, exchangeStatus: "paused" },
  { id: "SPX-USDX-PERP", base: "SPX", kind: "index", maxLeverage: 20, exchangeStatus: "active" },
];

export const MARKET_KIND_LABEL: Record<AvailableMarket["kind"], string> = {
  crypto: "Crypto",
  fx: "FX",
  commodity: "Commodities",
  index: "Index",
};

/**
 * A referral programme the VENUE runs for its own users — distinct from the
 * builder fee, which is what the venue charges. A referral shares part of the
 * venue's own take with whoever brought the trader; it cannot dip into the
 * exchange's fee, because that is not the venue's to give.
 */
export interface ReferralProgramme {
  enabled: boolean;
  /** Share of the venue's builder fee paid to the referrer, in percent. */
  referrerSharePct: number;
  /** Discount on the venue's builder fee for the referred trader, in percent. */
  refereeDiscountPct: number;
  /** Days the attribution lasts after signup. */
  attributionWindowDays: number;
  codes: { code: string; owner: string; signups: number; routedNotional: number }[];
}

/**
 * Sub-builder codes: the venue's own partners, under the venue's code.
 *
 * This is the recursion the Exchange Kernel thesis implies — a venue that can be
 * built on is a venue whose partners can be built on. It is emulated entirely in
 * the venue: the exchange sees one builder code, and the split between the venue
 * and its sub-partner is the venue's own bookkeeping. Which is exactly the
 * relationship Nexus has with the venue today.
 */
export interface SubBuilderCode {
  code: string;
  label: string;
  /** Share of the venue's fee this partner keeps, in percent. */
  revenueSharePct: number;
  feeBpsOverride: number | null;
  active: boolean;
}

export interface OrderTypePolicy {
  limit: boolean;
  market: boolean;
  stop: boolean;
  scale: boolean;
  twap: boolean;
}

export interface VenueConfig {
  name: string;
  domains: string[];
  markets: string[];
  /** Venue-wide builder fee, in whole basis points. No ceiling. */
  feeBps: number;
  /** Per-market overrides. Absent = inherit `feeBps`. */
  feeOverrides: Record<string, number>;
  /** Cap a venue applies to its own traders, ≤ the market's exchange maximum. */
  maxLeverageOverride: Record<string, number>;
  orderTypes: OrderTypePolicy;
  referral: ReferralProgramme;
  subBuilders: SubBuilderCode[];
  ui: {
    defaultMarket: string;
    showFundingCountdown: boolean;
    showLeaderboard: boolean;
    allowGuestBrowsing: boolean;
  };
  api: {
    /** The branded API host. Phase 5 — shown here as the config it will take. */
    domain: string;
    keyPrefix: string;
    brandedSpec: boolean;
    rateLimitPerSec: number;
  };
}

/**
 * The console's environment, read off the URL.
 *
 * WHY THIS LIVES HERE. `env` used to be the literal `"test"` typed into nine pages,
 * which made the sidebar's environment switcher a caption rather than a control. It
 * is a single value that every page needs and no page owns, so it is resolved in one
 * place from the one piece of state a server component can carry across a
 * navigation: the query string. That also means an operator can bookmark the live
 * console, and paste a link that lands a colleague on the same network.
 */
export type VenueEnv = "test" | "live";

export function resolveEnv(raw: string | undefined): VenueEnv {
  /* Anything unrecognised is TEST. The failure mode has to point at play money:
     defaulting a malformed URL to live would put an operator on real funds because
     of a typo. */
  return raw === "live" ? "live" : "test";
}

/** The same path, on the other network. Query-only, so it works from any route. */
export function envHrefFor(pathname: string, env: VenueEnv): string {
  return env === "live" ? `${pathname}?env=live` : pathname;
}

export function defaultConfig(name: string, feeBps: number): VenueConfig {
  return {
    name,
    domains: [],
    markets: ["BTC-USDX-PERP", "ETH-USDX-PERP", "SOL-USDX-PERP"],
    feeBps,
    feeOverrides: {},
    maxLeverageOverride: {},
    orderTypes: { limit: true, market: true, stop: true, scale: true, twap: true },
    referral: {
      enabled: feeBps > 0,
      referrerSharePct: 20,
      refereeDiscountPct: 10,
      attributionWindowDays: 90,
      codes: [
        { code: "LAUNCH", owner: "growth@acme.xyz", signups: 214, routedNotional: 4_820_000 },
        { code: "PODCAST", owner: "growth@acme.xyz", signups: 63, routedNotional: 910_000 },
      ],
    },
    subBuilders: [
      { code: "bld_acme_bot", label: "Acme Bot Desk", revenueSharePct: 35, feeBpsOverride: null, active: true },
      { code: "bld_acme_embed", label: "Partner embed", revenueSharePct: 50, feeBpsOverride: 1, active: false },
    ],
    ui: {
      defaultMarket: "BTC-USDX-PERP",
      showFundingCountdown: true,
      showLeaderboard: true,
      allowGuestBrowsing: true,
    },
    api: {
      domain: "",
      keyPrefix: "nx",
      brandedSpec: false,
      rateLimitPerSec: 50,
    },
  };
}

/** The effective fee for a market, after any per-market override. */
export function effectiveFeeBps(config: VenueConfig, marketId: string): number {
  const override = config.feeOverrides[marketId];
  return normaliseFeeBps(override ?? config.feeBps);
}

/**
 * The config as `nexus.json` — the artefact the console exists to produce.
 *
 * Config-as-code is the whole ergonomic pitch, so the console is a *view* over a
 * file the operator can commit, not a database the file is generated from. What
 * you edit here is what you would push.
 */
export function toNexusJson(config: VenueConfig, builderCode: string): string {
  const doc: Record<string, unknown> = {
    name: config.name,
    ...(config.domains.length > 0 ? { domains: config.domains } : {}),
    markets: config.markets,
    builder: {
      code: builderCode,
      feeBps: normaliseFeeBps(config.feeBps),
      ...(Object.keys(config.feeOverrides).length > 0
        ? {
            feeOverrides: Object.fromEntries(
              Object.entries(config.feeOverrides).map(([m, v]) => [m, normaliseFeeBps(v)]),
            ),
          }
        : {}),
      ...(config.subBuilders.some((s) => s.active)
        ? {
            subBuilders: config.subBuilders
              .filter((s) => s.active)
              .map((s) => ({
                code: s.code,
                revenueSharePct: s.revenueSharePct,
                ...(s.feeBpsOverride !== null ? { feeBps: s.feeBpsOverride } : {}),
              })),
          }
        : {}),
    },
    ...(config.referral.enabled
      ? {
          referral: {
            referrerSharePct: config.referral.referrerSharePct,
            refereeDiscountPct: config.referral.refereeDiscountPct,
            attributionWindowDays: config.referral.attributionWindowDays,
          },
        }
      : {}),
    orderTypes: Object.entries(config.orderTypes)
      .filter(([, on]) => on)
      .map(([k]) => k),
    ui: config.ui,
    ...(config.api.domain
      ? {
          api: {
            domain: config.api.domain,
            keyPrefix: config.api.keyPrefix,
            brandedSpec: config.api.brandedSpec,
            rateLimit: { requestsPerSec: config.api.rateLimitPerSec },
          },
        }
      : {}),
  };
  return JSON.stringify(doc, null, 2);
}
