/*
 * The session state machine.
 *
 * WHY THIS EXISTS RATHER THAN AN SDK
 *
 * Daniel asked whether to wire Dynamic.xyz and Halliday directly. The answer we reached
 * was: specify the STATES, not the vendor. Three reasons, and the third is the one that
 * decided it.
 *
 *   1. This project is a specification. Nobody reading it is unclear on how a wallet
 *      connector works, and `lib/api/README` already documents the auth contract that
 *      matters — `POST /auth/login` (EVM signature) → `POST /keys` → HMAC, per-account
 *      rate limits, 429 handling. A vendor SDK sits underneath that; it does not
 *      replace it.
 *   2. Two vendors mean two third parties in the capture path, and the harness has a
 *      `no-external-requests` hard floor whose whole job is that a capture cannot
 *      depend on the network.
 *   3. Stubbing the SDK under the harness would mean the graded artifact stops being
 *      the real one — and this project's entire discipline is that the thing verified
 *      is the thing shipped. That is a worse loss than a failing check.
 *
 * So: the states are real, addressable and graded, and swapping a vendor in later is
 * replacing a stub behind an interface that already exists rather than unpicking an SDK
 * from five surfaces.
 *
 * WHAT THE STATES ARE
 *
 *   out      → nobody is connected. The venue is fully readable: markets, book, tape,
 *              chart, fee schedule. Nothing account-shaped resolves.
 *   pending  → the wallet picker is open. A real state, not a transition — it is what
 *              the user is looking at while they decide, and it is the one a capture
 *              harness could never reach before because it lived in component state.
 *   in       → connected. An address exists, and the gates open.
 *
 * There is deliberately no `error` state yet. A connector reports a dozen distinct
 * failures (rejected, wrong chain, locked, no provider) and inventing one generic
 * failure screen would specify something no vendor actually produces.
 */

export const SESSIONS = ["out", "pending", "in"] as const;
export type Session = (typeof SESSIONS)[number];

export const isSession = (v: unknown): v is Session =>
  typeof v === "string" && (SESSIONS as readonly string[]).includes(v);

/**
 * The connected address.
 *
 * A fixture, and it has to be: a real connector returns whatever wallet the reader
 * happens to have, and a capture that renders a different address on every machine is
 * not comparable. Wired to a vendor, this is the only value that changes.
 */
export const SESSION_ADDRESS = "0xD09a4F1c8b7E2a55Ce31b8a4E7C0dA2f9B6417FD";

/** `0xD09a…17FD` — the form every venue uses, and the one the nav pill shows. */
export const shortAddress = (a: string = SESSION_ADDRESS) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * What a session may do.
 *
 * The gates used to be hardcoded: `Transfer` and `Withdraw` carried a literal
 * `aria-disabled="true"` and a comment explaining they were gated on the reference
 * venue. That made "what is reachable logged out" a fact about a comment rather than a
 * property of the app — nothing could grade it, and nothing could change it.
 *
 * Reading it off the session makes it a rule. It also states the one thing a reader of
 * this spec must not get wrong: moving money is gated on the WALLET, never on an API
 * key. See ApiKey.scopes in lib/account.
 */
export function can(session: Session) {
  const connected = session === "in";
  return {
    /** Read market data. Always — a venue nobody can read is a venue nobody joins. */
    browse: true,
    /** See balances, positions, orders, fills. */
    account: connected,
    /** Place, amend and cancel orders. */
    trade: connected,
    /** Deposit, withdraw, transfer between subaccounts. Wallet-gated, always. */
    moveFunds: connected,
  };
}
