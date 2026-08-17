/*
 * Account activity — the money-movement ledger.
 *
 * WHAT THIS MIRRORS
 *
 * A PROPOSED read-only endpoint, not a vendored one. `openapi.json` has
 * `WireFundsEntry` (`GET /deposits`, `GET /withdrawals`), which covers two of the
 * five movements a custodial venue owes its users a record of and carries none of
 * the columns the table needs — no status, no counterparty, no fee. So this file
 * is the terminal's side of a contract that does not exist yet, written to the same
 * conventions as ./seasons.ts, and it says so rather than pretending otherwise.
 *
 *   • Every amount is a DECIMAL STRING. Parsing happens here and nowhere else.
 *   • `kind` and `status` are additive enums with an unknown-member fallback, for
 *     the reason ./seasons.ts states: the contract gates validate schema names, not
 *     enum membership, so a closed enum turns a future member into a runtime parse
 *     failure in an already-deployed client.
 *   • `destination` is nullable, not an empty string. A transfer between two of your
 *     own balances has no destination — that is different from one whose destination
 *     was not reported.
 *
 * WHY IT IS NOT `WireFundsEntry` WIDENED
 *
 * A deposit and a spot-to-perps transfer are the same event to a user — value moved,
 * here is where it went — and the reference proves the point by rendering all nine of
 * its sub-tabs through ONE column set. Modelling them as separate resources would
 * make the client join them back together to render a single table.
 */

import type { Decimal, TimestampMs } from "./types";

/** Additive. Anything unrecognised parses to `"unknown"` rather than throwing. */
export type ActivityKind =
  | "deposit"
  | "withdrawal"
  | "account_transfer"
  | "spot_transfer"
  | "internal_transfer"
  | "unknown";

const ACTIVITY_KINDS: readonly ActivityKind[] = [
  "deposit",
  "withdrawal",
  "account_transfer",
  "spot_transfer",
  "internal_transfer",
];

export type ActivityStatus = "completed" | "pending" | "failed" | "unknown";
const ACTIVITY_STATUSES: readonly ActivityStatus[] = ["completed", "pending", "failed"];

export type WireAccountActivity = {
  id: string;
  kind: string;
  status: string;
  asset: string;
  /** Where the value left. A venue balance name, or a chain. */
  from: string;
  /** Where it landed. */
  to: string;
  /**
   * The off-venue endpoint, when there is one: an address, truncated by the client.
   * Null for movements that never leave the venue.
   */
  destination: string | null;
  /** Signed. Negative = left this account. */
  amount: Decimal;
  usd_value: Decimal;
  fee: Decimal;
  timestamp: TimestampMs;
};

export type AccountActivity = {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  asset: string;
  from: string;
  to: string;
  destination: string | null;
  amount: number;
  usdValue: number;
  fee: number;
  ts: TimestampMs;
};

const member = <T extends string>(raw: string, known: readonly T[]): T | "unknown" =>
  (known as readonly string[]).includes(raw) ? (raw as T) : "unknown";

const num = (v: Decimal): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function parseAccountActivity(w: WireAccountActivity): AccountActivity {
  return {
    id: w.id,
    kind: member(w.kind, ACTIVITY_KINDS),
    status: member(w.status, ACTIVITY_STATUSES),
    asset: w.asset,
    from: w.from,
    to: w.to,
    destination: w.destination,
    amount: num(w.amount),
    usdValue: num(w.usd_value),
    fee: num(w.fee),
    ts: w.timestamp,
  };
}

/**
 * The sub-tabs, and which kinds each admits.
 *
 * FIVE, not their nine. `Earn`, `Vaults`, `Staking` and `Auctions` each map to a
 * product they have and we do not — a lending market, vaults, staking, and spot
 * listing auctions. Shipping them would be four permanently empty ledgers, which is
 * the dead-affordance failure the settings audit already named.
 *
 * Note what their nine sub-tabs do NOT do: change the column set. All nine render the
 * same ten headers and filter rows only. That is why this is a filter table and not
 * five tables.
 */
export const ACTIVITY_VIEWS = [
  { id: "all", label: "All", kinds: null },
  { id: "account", label: "Account Transfers", kinds: ["account_transfer"] },
  { id: "funds", label: "Deposits and Withdrawals", kinds: ["deposit", "withdrawal"] },
  { id: "spot", label: "Spot Transfers", kinds: ["spot_transfer"] },
  { id: "internal", label: "Internal Transfers", kinds: ["internal_transfer"] },
] as const satisfies readonly {
  id: string;
  label: string;
  kinds: readonly ActivityKind[] | null;
}[];

export type ActivityView = (typeof ACTIVITY_VIEWS)[number]["id"];

/** Read-only, like the rest of this surface. Money moves through deposit/withdraw. */
export const ACTIVITY_ENDPOINTS = [
  {
    method: "GET",
    path: "/api/v1/account/activity",
    auth: true,
    note: "PROPOSED — one ledger, filtered by kind",
  },
] as const;
