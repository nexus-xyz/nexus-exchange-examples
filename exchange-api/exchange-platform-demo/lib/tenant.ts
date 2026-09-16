/*
 * The tenant — one branded venue, resolved once at build time.
 *
 * This is the seam that turns a single-brand terminal into an Exchange-as-a-Service
 * venue. It is deliberately build-time and not a React context: `lib/theme.ts` exports
 * flat consts that 32 files import directly, and a runtime provider would mean
 * editing every one of those call sites and giving up the first-render
 * determinism the audit harness pins. One venue = one deploy = one
 * NEXT_PUBLIC_TENANT_ID, which is the unit the offering sells anyway.
 *
 * Only the palette and the identity live here. Fee *mechanics* — the additive
 * builder fee and its cap — are `venue-kit`'s, mirrored in OrderTicket.
 */

export interface TenantPalette {
  /** Bid / long / positive. */
  green: string;
  /** Ask / short / negative. */
  red: string;
  /** Warning / degraded. */
  amber: string;
  /** Page background. */
  bg: string;
  /** Headings and emphasised numbers. */
  hi: string;
  /** The accent the brand mark and active chrome use. */
  accent: string;
}

export interface TenantConfig {
  id: string;
  /** Shown in the document title. */
  name: string;
  /** The wordmark in the top-left. Kept short — it renders as letterspaced caps. */
  wordmark: string;
  palette: TenantPalette;
  /**
   * The venue's builder code and its additive fee, in basis points. `feeBps: 0`
   * means no builder fee is charged or disclosed, which is correct for the
   * first-party venue — the builder fee is what a *partner* adds on top.
   */
  builder: { code: string; feeBps: number };
  /** A partner is a different legal entity and cannot inherit Nexus's copy. */
  legal: { entity: string };
}

/** The default tenant. Palette values lifted verbatim from the original theme.ts. */
export const NEXUS: TenantConfig = {
  id: "nexus",
  name: "Nexus Exchange",
  wordmark: "NEXUS",
  palette: {
    green: "#0ecb81",
    red: "#f6465d",
    amber: "#caa54a",
    bg: "#000",
    hi: "#f3f3f3",
    accent: "#0ecb81",
  },
  builder: { code: "", feeBps: 0 },
  legal: { entity: "Nexus" },
};

/** A worked partner example: different palette, a builder code, a 2 bps fee. */
export const ACME: TenantConfig = {
  id: "acme",
  name: "Acme Perps",
  wordmark: "ACME",
  palette: {
    green: "#22d3ee",
    red: "#f43f5e",
    amber: "#e0b23c",
    bg: "#07070c",
    hi: "#f8fafc",
    accent: "#22d3ee",
  },
  builder: { code: "bld_acme", feeBps: 2 },
  legal: { entity: "Acme Markets Ltd" },
};

export const TENANTS: Record<string, TenantConfig> = { nexus: NEXUS, acme: ACME };

/**
 * Resolve the active tenant. Strict on an unknown id — a typo must fail the
 * build, not quietly ship a partner venue under Nexus's brand and legal entity.
 *
 * A function rather than an inline expression so tests can resolve any tenant;
 * the module-scope call below is what the bundler constant-folds.
 */
export function resolveTenant(id: string | undefined, fallbackId = "nexus"): TenantConfig {
  const wanted = id?.trim() || fallbackId;
  const tenant = TENANTS[wanted];
  if (!tenant) {
    throw new Error(
      `unknown NEXT_PUBLIC_TENANT_ID ${JSON.stringify(wanted)} — known tenants: ${Object.keys(TENANTS)
        .sort()
        .join(", ")}`,
    );
  }
  return tenant;
}

/* Inlined at build time — there is no runtime env to consult in a static client
   bundle, which is the same reason the rest of this app's config is build-time. */
export const ACTIVE_TENANT: TenantConfig = resolveTenant(process.env.NEXT_PUBLIC_TENANT_ID);
