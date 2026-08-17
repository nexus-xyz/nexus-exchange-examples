/*
 * Team, roles, keys, and the audit trail.
 *
 * The role set is deliberately small. Every console that ends up with fifteen
 * roles started with five that were not separated along the axis that mattered,
 * and the axis that matters here is: who can move money, who can change what
 * traders are charged, and who can only look. Four roles, one sentence each, and
 * a permission matrix that fits on a screen.
 *
 * The two roles that are NOT here are as deliberate as the four that are. There
 * is no "super admin" above Owner, because a second unlimited role means nobody
 * knows which one is authoritative. And there is no per-market role, because a
 * venue that needs one has an org-chart problem the console should not encode.
 */

export const ROLES = ["owner", "admin", "developer", "analyst"] as const;
export type Role = (typeof ROLES)[number];

export interface RoleSpec {
  label: string;
  blurb: string;
  /** Fewer, broader capabilities beat a long checklist nobody reads. */
  can: { billing: boolean; team: boolean; fees: boolean; keys: boolean; config: boolean; read: boolean };
}

export const ROLE_SPEC: Record<Role, RoleSpec> = {
  owner: {
    label: "Owner",
    blurb: "Everything, including billing and payout destination. Exactly one per venue.",
    can: { billing: true, team: true, fees: true, keys: true, config: true, read: true },
  },
  admin: {
    label: "Admin",
    blurb: "Runs the venue: fees, markets, team, keys. Cannot change where money is paid out.",
    can: { billing: false, team: true, fees: true, keys: true, config: true, read: true },
  },
  developer: {
    label: "Developer",
    blurb: "Ships the integration: keys and config. Cannot change fees or the team.",
    can: { billing: false, team: false, fees: false, keys: true, config: true, read: true },
  },
  analyst: {
    label: "Analyst",
    blurb: "Reads everything, changes nothing. The right default for a new joiner.",
    can: { billing: false, team: false, fees: false, keys: false, config: false, read: true },
  },
};

export interface Member {
  email: string;
  role: Role;
  status: "active" | "invited";
  lastActiveMs: number | null;
  mfa: boolean;
}

export const DEMO_MEMBERS: Member[] = [
  { email: "founder@acme.xyz", role: "owner", status: "active", lastActiveMs: 1_786_600_000_000, mfa: true },
  { email: "eng@acme.xyz", role: "admin", status: "active", lastActiveMs: 1_786_540_000_000, mfa: true },
  { email: "quant@acme.xyz", role: "developer", status: "active", lastActiveMs: 1_786_320_000_000, mfa: false },
  { email: "growth@acme.xyz", role: "analyst", status: "active", lastActiveMs: 1_786_180_000_000, mfa: true },
  { email: "newhire@acme.xyz", role: "analyst", status: "invited", lastActiveMs: null, mfa: false },
];

/** An API key belongs to an environment, and the environment decides the money. */
export interface ApiKey {
  id: string;
  label: string;
  env: "test" | "live";
  createdMs: number;
  lastUsedMs: number | null;
  /** Scopes are additive and always a subset of the creating member's role. */
  scopes: ("read" | "trade" | "withdraw")[];
  requests24h: number;
}

export const DEMO_KEYS: ApiKey[] = [
  { id: "nx_live_7f3a…", label: "Production venue proxy", env: "live", createdMs: 1_781_000_000_000, lastUsedMs: 1_786_684_000_000, scopes: ["read", "trade"], requests24h: 184_320 },
  { id: "nx_test_b21c…", label: "Preview + CI", env: "test", createdMs: 1_781_400_000_000, lastUsedMs: 1_786_600_000_000, scopes: ["read", "trade"], requests24h: 9_112 },
  { id: "nx_test_44de…", label: "Local development", env: "test", createdMs: 1_784_000_000_000, lastUsedMs: 1_786_100_000_000, scopes: ["read"], requests24h: 302 },
];

export interface AuditEntry {
  atMs: number;
  actor: string;
  action: string;
  detail: string;
  severity: "info" | "notice" | "warn";
}

export const DEMO_AUDIT: AuditEntry[] = [
  { atMs: 1_786_681_000_000, actor: "eng@acme.xyz", action: "fee.update", detail: "BTC-USDX-PERP override 2 → 3 bps", severity: "notice" },
  { atMs: 1_786_640_000_000, actor: "quant@acme.xyz", action: "key.create", detail: "nx_test_44de… scopes read", severity: "info" },
  { atMs: 1_786_602_000_000, actor: "founder@acme.xyz", action: "member.invite", detail: "newhire@acme.xyz as analyst", severity: "info" },
  { atMs: 1_786_520_000_000, actor: "eng@acme.xyz", action: "market.list", detail: "added XAU-USDX-PERP", severity: "notice" },
  { atMs: 1_786_460_000_000, actor: "system", action: "key.rotate.due", detail: "nx_live_7f3a… is 66 days old", severity: "warn" },
  { atMs: 1_786_390_000_000, actor: "growth@acme.xyz", action: "referral.create", detail: "code PODCAST", severity: "info" },
  { atMs: 1_786_300_000_000, actor: "eng@acme.xyz", action: "venue.deploy", detail: "production · commit 2454a0d", severity: "info" },
];
