// An agent-shaped risk review of one Nexus Exchange account, over MCP.
//
// Run it with:  npm start
//
// This is the same review `sdk-rust/risk-guard` and `sdk-ts/risk-guard` perform
// — total notional, unrealized loss, available margin, against limits you set —
// but reached through the MCP tool surface instead of a typed SDK. It is
// read-only: it reports, and changes nothing.
//
// What an MCP example has to show that an SDK example does not
// ------------------------------------------------------------
// With an SDK, an app can only call the functions someone wrote into it. With
// MCP, the app — or the model driving it — can call anything the server offers,
// and this server offers 63 tools, 16 of which move money. The interesting
// engineering is therefore not "how do I call a tool", which is one line, but
// **how do I bound what may be called at all**.
//
// So the shape of this example is: connect, verify the tool contract, narrow the
// surface to an explicit allowlist, and report what was deliberately left
// untouched. That narrowing lives in `mcp.ts`, in one function, because a blast
// radius enforced in two places is a blast radius enforced in neither.
//
// Deterministic on purpose
// ------------------------
// There is no model in the loop. The point of the example is the tool surface
// and the guardrails around it; an LLM in the middle would make the output
// non-reproducible, need a second API key, and obscure the part worth reading.
// The README shows how to hand the same server to Claude once you have seen
// what it can reach.
//
// Lifecycle
// ---------
// The server is a real subprocess. Every exit path — success, a failed
// handshake, a bad limit, a thrown parse — goes through the same `finally`, so
// the review cannot leave an orphaned server behind. That is the whole of the
// concurrency story: one call at a time, one child, always reaped.

import { ConfigError, loadConfig } from "./config.js";
import { ALLOWED_TOOLS, McpError, Session } from "./mcp.js";
import { evaluate } from "./risk.js";
import type { Config } from "./config.js";
import type { PositionView } from "./risk.js";

function log(message: string): void {
  console.log(message);
}

/** Read a string field that must be present, or fail with the field named. */
function requireString(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = source[key];
  if (typeof value === "string") return value;
  // Numbers appear on the CCXT-shaped routes; stringify rather than reject, but
  // never invent a value for a field that simply is not there.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new McpError(
    `${where}: expected a "${key}" field, got ${JSON.stringify(value)}`,
  );
}

/** Optional decimal-or-null, with its paired `*_error` reason. */
function optionalDecimal(
  source: Record<string, unknown>,
  key: string,
): { value: string | null; error: string | null } {
  const raw = source[key];
  const error = source[`${key}_error`];
  const reason = typeof error === "string" ? error : null;
  if (typeof raw === "string") return { value: raw, error: null };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { value: String(raw), error: null };
  }
  return { value: null, error: reason };
}

/**
 * Lift a list out of a tool payload.
 *
 * Accepts a bare array or a wrapped one, and refuses anything else rather than
 * quietly seeing zero rows — an empty list would read as "no exposure", which is
 * the one wrong answer that matters here.
 */
function asArray(payload: unknown, where: string): Record<string, unknown>[] {
  const candidate = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object"
      ? ((payload as Record<string, unknown>)["positions"] ??
        (payload as Record<string, unknown>)["orders"] ??
        (payload as Record<string, unknown>)["data"])
      : undefined;
  if (!Array.isArray(candidate)) {
    throw new McpError(`${where}: expected a list, got ${typeof payload}`);
  }
  return candidate.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === "object",
  );
}

function asObject(payload: unknown, where: string): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new McpError(`${where}: expected an object, got ${typeof payload}`);
  }
  return payload as Record<string, unknown>;
}

function toPosition(row: Record<string, unknown>): PositionView {
  const notional = optionalDecimal(row, "notional_value");
  return {
    marketId: requireString(row, "market_id", "get_positions"),
    // Required, not optional, and deliberately so: `size` is what lets the
    // review prove a flat position contributes zero notional even when its mark
    // price is missing. Reading it as absent would quietly turn that proof off,
    // so a payload without it fails loudly instead.
    size: requireString(row, "size", "get_positions"),
    notional: notional.value,
    notionalError: notional.error,
    unrealizedPnl: requireString(row, "unrealized_pnl", "get_positions"),
  };
}

async function review(session: Session, config: Config): Promise<boolean> {
  log(
    `tool surface: ${session.surface.total} tools offered, ` +
      `${session.surface.mutating} of them mutating — this review uses ` +
      `${ALLOWED_TOOLS.length}, all read-only (${ALLOWED_TOOLS.join(", ")})`,
  );

  // Sequential, not `Promise.all`: a stdio MCP server is one process behind one
  // pipe, so overlapping calls buy nothing here and make a failure harder to
  // attribute to the tool that caused it.
  const balance = asObject(await session.call("get_balance"), "get_balance");
  const positions = asArray(await session.call("get_positions"), "get_positions").map(
    toPosition,
  );
  const orders = asArray(await session.call("get_open_orders"), "get_open_orders");

  const verdict = evaluate(
    {
      positions,
      availableMargin: requireString(balance, "available_margin", "get_balance"),
    },
    config.limits,
  );

  log("");
  log(`positions: ${positions.length}    resting orders: ${orders.length}`);
  for (const finding of verdict.findings) {
    const mark =
      finding.state === "within" ? "ok " : finding.state === "breached" ? "!! " : "?? ";
    log(`${mark}${finding.limit}: ${finding.detail}`);
  }
  log("");

  if (verdict.breached) {
    log("BREACHED — at least one limit is over.");
    if (orders.length > 0) {
      // Deliberately not acted on. `cancel_order` is on the server and is not on
      // this app's allowlist: a review that can also cancel is no longer a
      // review, and the point of the allowlist is that widening it is a visible
      // edit rather than a quiet capability.
      log(
        `  ${orders.length} resting order(s) would be worth cancelling. This app ` +
          "does not cancel — see sdk-rust/risk-guard for the armed version.",
      );
    }
  } else if (verdict.indeterminate) {
    log("UNPROVEN — a limit's inputs were incomplete, so it is not known to be safe.");
  } else {
    log("ok — every configured limit is within range.");
  }
  return verdict.breached;
}

async function main(): Promise<number> {
  const config = loadConfig();
  // Say which target and what its funds are. A custom target is one nobody has
  // described, and printing "play funds" there would be exactly the
  // mislabelling the network descriptors exist to prevent.
  log(
    config.baseUrl === undefined
      ? "risk-review on the testnet deployment (play funds)"
      : `risk-review on ${config.baseUrl} (custom target — funds undeclared)`,
  );

  const session = await Session.open(config);
  try {
    const breached = await review(session, config);
    // A breach is a finding, not a crash — but exiting non-zero makes this
    // usable from cron or CI without parsing stdout.
    return breached ? 2 : 0;
  } finally {
    // The one thing that must happen on every path. See the lifecycle note.
    await session.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError || error instanceof McpError) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
