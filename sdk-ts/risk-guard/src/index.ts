// A standing risk guard for one Nexus Exchange account.
//
// Run it with:  npm start           (watch and report)
//               npm start -- --arm  (also cancel resting orders on a breach)
//
// It polls the account, checks it against limits you set, and — only when armed
// — cancels every resting order the moment a limit is breached. That is the
// entire write surface: **this app can only ever reduce exposure.** It never
// places an order, never amends one, and deliberately does not flatten
// positions, because flattening means sending a market order and a market order
// is a new risk, not the removal of one.
//
// What this example is for
// ------------------------
// `exchange-api/trading-terminal` builds a trading app on the raw REST +
// WebSocket API and spends ~2,700 lines doing it: HMAC signing, retry policy,
// bounded response reads, clock-skew detection, exact decimal handling. This
// app is a few hundred lines because the SDK already owns all of that. What is
// left is the part that is actually yours — deciding what "too much risk" means
// and what to do about it — which is what a whole-app example should be showing.
//
// Concurrency, in full
// --------------------
// There is none to get wrong, and that is a design choice rather than an
// accident. The loop is strictly sequential: fetch, evaluate, act, sleep. A tick
// cannot start while the previous one is still running, so there is no shared
// mutable state between overlapping ticks, no guard flag to forget, and nothing
// to deadlock on. The one concurrent step is fetching the account and the open
// orders together, and it is safe precisely because the open orders do not feed
// any limit — they are only the thing being cancelled.
//
// The one lifecycle rule: **an in-flight cancel is never interrupted.** Ctrl-C
// stops the loop, but the stop signal is deliberately not attached to the cancel
// request, because a shutdown that aborts the risk-reducing action is a shutdown
// that made things worse. Every request is bounded by the client's own timeout
// instead, so "not interruptible" never means "hangs forever".

import {
  ApiError,
  Client,
  Network,
  TransportError,
  customNetwork,
  type Order,
} from "@nexus-xyz/exchange-ts";

import { ConfigError, loadConfig } from "./config.js";
import { evaluate } from "./risk.js";
import type { Config } from "./config.js";
import type { Verdict } from "./risk.js";

/** Per-request ceiling. Generous for a cold start, short enough to fail. */
const REQUEST_TIMEOUT_MS = 15_000;

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

/** One readable line from anything throwable, with whitespace collapsed. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** `setTimeout` that unwinds when `signal` aborts, instead of outliving it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function summarise(verdict: Verdict, orders: readonly Order[]): string {
  const state = verdict.breached
    ? "BREACHED"
    : verdict.indeterminate
      ? "UNPROVEN"
      : "ok";
  const detail = verdict.findings
    .map((f) => `${f.limit}=${f.state}`)
    .join(" ");
  return `${state}  ${detail}  resting=${orders.length}`;
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));

  // `stopping` ends the loop and unwinds the sleep. It is never attached to the
  // cancel request — see the lifecycle rule in the header.
  const stopping = new AbortController();
  let stopped = false;
  const stop = (reason: string): void => {
    if (stopped) {
      // Asked twice. Go now, and say what that can cost.
      console.log("\nforcing exit — a cancel may still have been in flight");
      process.exit(130);
    }
    stopped = true;
    log(`shutting down (${reason})`);
    stopping.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // Testnet is named rather than left to the default: an example should never
  // leave a reader guessing whose money it watches. This SDK refuses
  // `Network.Mainnet` locally, before any bytes leave the process, so the
  // "pointed at real funds by accident" failure is the SDK's to prevent and not
  // something this app re-implements badly.
  //
  // An override goes through `customNetwork` rather than the deprecated bare
  // `baseUrl`, because a URL on its own cannot say what the target moves. The
  // descriptor carries `funds` with the transport, so a guardrail can never read
  // a play-funds classification off a client pointed somewhere else. This app
  // only reads and cancels — neither is funds-guarded — so `"unknown"` costs
  // nothing here and is the honest value for a host nobody has declared.
  const network =
    config.baseUrl === undefined
      ? Network.Testnet
      : customNetwork({
          label: "custom",
          baseUrl: config.baseUrl,
          funds: "unknown",
        });

  const client = new Client({
    network,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  // Say which target *and* what its funds are. An overridden host is
  // `funds: "unknown"` — printing "play funds" there would be the exact
  // mislabelling the SDK's descriptor design exists to prevent, and this line is
  // the only place a reader learns whose money is being watched.
  log(
    config.baseUrl === undefined
      ? "risk-guard on the testnet default host (play funds)"
      : `risk-guard on ${config.baseUrl} (funds: unknown — undeclared target)`,
  );
  log(describeLimits(config));
  log(
    config.armed
      ? "--arm: a breach will cancel every resting order on this account"
      : "watch-only. Pass --arm to let a breach cancel resting orders.",
  );

  let lastLine = "";

  while (!stopping.signal.aborted) {
    try {
      // Fetched together: two round trips of skew is less than doing them back
      // to back, and the orders do not feed any limit anyway.
      const [account, orders] = await Promise.all([
        client.getAccount({ signal: stopping.signal }),
        client.getOpenOrders({ signal: stopping.signal }),
      ]);

      const verdict = evaluate(
        { positions: account.positions, availableMargin: account.available_margin },
        config.limits,
      );

      const line = summarise(verdict, orders);
      if (line !== lastLine) {
        lastLine = line;
        log(line);
        for (const finding of verdict.findings) {
          if (finding.state !== "within") log(`  ${finding.limit}: ${finding.detail}`);
        }
      }

      if (verdict.breached) {
        await onBreach(client, config, orders);
      } else if (verdict.indeterminate) {
        // Reported, never acted on. Cancelling because a mark price is
        // temporarily unavailable would make an indexer hiccup into a trading
        // decision — the same reason `trading-terminal` refuses to quote off a
        // stale book. The honest posture is to say the limit cannot be proven
        // and let a human look.
        log("  a limit could not be proven — not acting on data this app does not trust");
      }
    } catch (error) {
      // A failed poll is not evidence of safety. Report it and try again next
      // tick; never let it read as a clean bill of health.
      if (!stopping.signal.aborted) {
        log(`poll failed: ${describe(error)}`);
        lastLine = "";
      }
    }

    await sleep(config.intervalMs, stopping.signal);
  }
}

/**
 * Act on a breach: cancel every resting order, once there is one to cancel.
 *
 * There is no "already fired" latch, and there does not need to be. The
 * condition is *breached and orders exist*, so a successful cancel makes the
 * next tick a no-op by itself, while an order placed during a still-live breach
 * is caught on the tick after it appears. A latch would have to be cleared by
 * something, and every rule for clearing it is a rule that can be wrong.
 */
async function onBreach(
  client: Client,
  config: Config,
  orders: readonly Order[],
): Promise<void> {
  if (orders.length === 0) return;
  if (!config.armed) {
    log(`  would cancel ${orders.length} resting order(s) — re-run with --arm`);
    return;
  }
  try {
    // No `signal`: this is the risk-reducing action, and Ctrl-C must not be
    // what stops it. The client's `timeoutMs` still bounds it.
    await client.cancelAllOrders();
    log(`  cancelled ${orders.length} resting order(s)`);
  } catch (error) {
    // Cancelling is idempotent, so the next tick simply tries again — which is
    // the right behaviour while a limit is still breached.
    log(`  cancel failed: ${describe(error)} — will retry next tick`);
  }
}

function describeLimits(config: Config): string {
  const parts: string[] = [];
  const { maxNotional, maxLoss, minAvailableMargin } = config.limits;
  if (maxNotional !== null) parts.push(`max-notional`);
  if (maxLoss !== null) parts.push(`max-loss`);
  if (minAvailableMargin !== null) parts.push(`min-available-margin`);
  return `limits: ${parts.join(", ")} — polling every ${config.intervalMs / 1000}s`;
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  if (error instanceof ApiError || error instanceof TransportError) {
    console.error(
      `\nCouldn't reach the Exchange API.\n  ${describe(error)}\n\n` +
        "If the default host isn't serving the API for you, point the example\n" +
        "somewhere else with NEXUS_EXCHANGE_API_URL=https://<host>/api/v1 npm start.",
    );
    process.exit(1);
  }
  throw error;
}
