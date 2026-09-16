/*
 * The tenant registry. Two entries: the default venue, and a worked example of
 * a partner one.
 *
 * `nexus` carries `feeBps: 0` because the first-party venue takes no builder fee
 * on top of its own schedule — the builder fee is what a *partner* charges. A
 * non-zero default here would quietly double-charge every first-party trade in
 * the disclosure.
 */

import { resolveTenant, type TenantConfig } from "./tenant.ts";

/** Testnet: play funds, faucet-funded, no real-world value. */
const TESTNET_API_BASE = "https://exchange.nexus.xyz/api/exchange";

export const NEXUS: TenantConfig = {
  id: "nexus",
  name: "Nexus Exchange",
  palette: { green: "#12b981", red: "#ef4444", bg: "#0a0a0b", hi: "#fafafa" },
  venue: { apiBase: TESTNET_API_BASE, proxyPath: "/api/venue" },
  builder: { code: "", feeBps: 0 },
  legal: {
    entity: "Nexus",
    disclosure: "./legal/nexus-disclosure.md",
  },
};

export const ACME: TenantConfig = {
  id: "acme",
  name: "Acme Perps",
  palette: { green: "#22d3ee", red: "#f43f5e", bg: "#0b0b12", hi: "#f8fafc" },
  venue: { apiBase: TESTNET_API_BASE, proxyPath: "/api/venue" },
  builder: { code: "bld_acme", feeBps: 2 },
  legal: {
    entity: "Acme Markets Ltd",
    disclosure: "./legal/acme-disclosure.md",
  },
};

export const TENANTS: Readonly<Record<string, TenantConfig>> = { nexus: NEXUS, acme: ACME };

/**
 * The active tenant for this build. `NEXT_PUBLIC_TENANT_ID` is inlined at build
 * time, which is what makes one deploy equal one venue.
 */
export const ACTIVE_TENANT: TenantConfig = resolveTenant(
  TENANTS,
  process.env["NEXT_PUBLIC_TENANT_ID"],
  "nexus",
);
