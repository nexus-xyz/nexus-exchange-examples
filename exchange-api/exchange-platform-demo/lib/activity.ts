/*
 * Mock feed for the account activity ledger.
 *
 * Emits WIRE shapes and runs them through the adapter in ./api/activity.ts, so the
 * parsing path is exercised rather than bypassed — swapping this for `fetch` should
 * change this file only. Same arrangement as ./seasons.ts.
 *
 * The rows tell one coherent story rather than being a scatter of plausible amounts:
 * 25,000 USDX arrives from Arbitrum, 12,000 of it is pushed to the perps balance to
 * back the positions the blotter shows, a little moves out and around, and one
 * withdrawal is still pending. A ledger whose rows do not add up to the balances on
 * the next tab is a fixture that will teach the team the wrong thing.
 */

import { dec } from "./api/adapter";
import { parseAccountActivity, type WireAccountActivity } from "./api/activity";
import { EPOCH_MS } from "./feed";

const min = (n: number) => n * 60_000;
const hr = (n: number) => n * 3_600_000;

/** The demo account's own address, as the deposit modal shows it. */
const SELF = "0x8d41f27a0c6e5b93d2af10c7e4b8951736ac0e2d";

const WIRE_ACTIVITY: WireAccountActivity[] = [
  {
    id: "act-0008",
    kind: "withdrawal",
    status: "pending",
    asset: "USDX",
    from: "Spot",
    to: "Arbitrum",
    destination: "0x51c0a4e2b7f1d9c3a8e6b204f7d1c9a3e5b80714",
    amount: dec("-2500.00"),
    usd_value: dec("2500.00"),
    fee: dec("1.50"),
    timestamp: EPOCH_MS - min(12),
  },
  {
    id: "act-0007",
    kind: "internal_transfer",
    status: "completed",
    asset: "USDX",
    from: "Main",
    to: "Sub-account 1",
    destination: null,
    amount: dec("-1500.00"),
    usd_value: dec("1500.00"),
    fee: dec("0"),
    timestamp: EPOCH_MS - hr(3),
  },
  {
    id: "act-0006",
    kind: "spot_transfer",
    status: "completed",
    asset: "USDX",
    from: "Spot",
    to: SELF,
    destination: null,
    amount: dec("-800.00"),
    usd_value: dec("800.00"),
    fee: dec("0"),
    timestamp: EPOCH_MS - hr(9),
  },
  {
    id: "act-0005",
    kind: "account_transfer",
    status: "completed",
    asset: "USDX",
    from: "Spot",
    to: "Perps",
    destination: null,
    amount: dec("-12000.00"),
    usd_value: dec("12000.00"),
    fee: dec("0"),
    timestamp: EPOCH_MS - hr(26),
  },
  {
    id: "act-0004",
    kind: "deposit",
    status: "completed",
    asset: "USDX",
    from: "Arbitrum",
    to: "Spot",
    destination: SELF,
    amount: dec("25000.00"),
    usd_value: dec("25000.00"),
    fee: dec("0"),
    timestamp: EPOCH_MS - hr(27),
  },
  {
    id: "act-0003",
    kind: "deposit",
    status: "completed",
    asset: "SOL",
    from: "Solana",
    to: "Spot",
    destination: SELF,
    amount: dec("40.00"),
    usd_value: dec("6484.00"),
    fee: dec("0"),
    timestamp: EPOCH_MS - hr(52),
  },
  {
    id: "act-0002",
    kind: "withdrawal",
    status: "failed",
    asset: "USDX",
    from: "Spot",
    to: "Ethereum",
    // Failed at the bridge: the destination is still what was asked for, and
    // blanking it would hide which withdrawal to retry.
    destination: "0x2f9b7c1e0a4d6538b9e2c7f04a18d35c6e0b9247",
    amount: dec("0"),
    usd_value: dec("3000.00"),
    fee: dec("0"),
    timestamp: EPOCH_MS - hr(70),
  },
  {
    id: "act-0001",
    kind: "deposit",
    status: "completed",
    asset: "USDX",
    from: "Nexus",
    to: "Spot",
    destination: SELF,
    amount: dec("5000.00"),
    usd_value: dec("5000.00"),
    fee: dec("0"),
    timestamp: EPOCH_MS - hr(96),
  },
];

/** Newest first, which is the order every history table in this terminal reads in. */
export const ACCOUNT_ACTIVITY = WIRE_ACTIVITY.map(parseAccountActivity);
