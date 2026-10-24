/*
 * The tenant — one branded venue, resolved once at module scope.
 *
 * Build-time, not a runtime provider. The terminal this kit dresses is a static
 * Next export whose config is already `NEXT_PUBLIC_*`-inlined at module scope,
 * and its palette is a flat const module imported directly by dozens of files.
 * A runtime context would mean editing every one of those import sites and
 * giving up the SSR/first-client-render determinism its audit harness pins.
 *
 * One branded exchange = one deploy = one domain = one analytics scope. That is
 * the unit the offering sells, so it is the unit the config models.
 */

/** Palette tokens the terminal's `lib/theme.ts` sources its hex from. */
export interface TenantPalette {
  readonly green: string;
  readonly red: string;
  readonly bg: string;
  readonly hi: string;
}

/** Where this venue's traffic goes. Never a signing secret — see `sign.ts`. */
export interface TenantVenue {
  /** Public API base, e.g. `https://exchange.nexus.xyz/api/exchange`. */
  readonly apiBase: string;
  /**
   * Same-origin path signed routes are addressed to.
   *
   * A core venue has no server in the order path: the browser signs with the
   * trader's delegated key and calls `apiBase` directly. This path exists for the
   * Enterprise branded-API case — a venue serving its own hostname and key prefix
   * to its traders' bots — where a proxy is the point rather than a dependency.
   */
  readonly proxyPath: string;
}

/**
 * The builder code this venue tags its flow with, and the additive fee it
 * discloses. `feeBps` is normalised to non-negative tenths of a basis point,
 * clamped to `MAX_FEE_BPS`, before it is ever shown or accrued.
 *
 * The ceiling is one of two protections and the weaker one. The other is the
 * trader's own approval of a per-venue maximum, signed once by their main wallet
 * — never by the delegated trading key, because the credential that can trade
 * must not be able to authorise being charged. See `builder/fee.ts` for why the
 * cap came back after being removed.
 */
export interface TenantBuilder {
  readonly code: string;
  readonly feeBps: number;
}

/**
 * Legal identity. Mandatory and per-tenant reviewed: a white-label venue is a
 * different legal entity and cannot ship Nexus's disclosures. There is no
 * inherited default here on purpose — an absent value must fail the build, not
 * quietly fall back to Nexus's Cayman-VASP copy.
 */
export interface TenantLegal {
  readonly entity: string;
  readonly disclosure: string;
}

export interface TenantConfig {
  readonly id: string;
  readonly name: string;
  readonly palette: TenantPalette;
  readonly venue: TenantVenue;
  readonly builder: TenantBuilder;
  readonly legal: TenantLegal;
}

/**
 * Resolve the active tenant from a registry. Strict: an unknown id throws at
 * build rather than serving a venue under the wrong brand and the wrong legal
 * entity, which is the failure mode that actually matters here.
 */
export function resolveTenant(
  registry: Readonly<Record<string, TenantConfig>>,
  id: string | undefined,
  fallbackId: string,
): TenantConfig {
  const wanted = id?.trim() || fallbackId;
  const tenant = registry[wanted];
  if (!tenant) {
    const known = Object.keys(registry).sort().join(", ");
    throw new Error(`unknown tenant ${JSON.stringify(wanted)} — known tenants: ${known}`);
  }
  return tenant;
}
