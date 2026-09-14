// Wiring and lifecycle.
//
// The shape of a run: read the file, learn the venue's rules and its budgets,
// decide the whole file is placeable, print it — and stop there unless
// `--submit` says otherwise. **Dry run is the default and it is not a flag you
// can forget.** An example that places orders the moment someone runs it is a
// hazard, and the two properties that keep this one safe are that the default
// path sends no write at all, and that everything the armed path places is
// cancelled before the process exits.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { sleep } from "./async.js";
import { RateBudget, RESYNC_INTERVAL_MS } from "./budget.js";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import * as dec from "./decimal.js";
import { Loader } from "./loader.js";
import { parseMarkets, planOrders } from "./plan.js";
import type { PlannedOrder } from "./plan.js";
import { RestClient } from "./rest.js";

/** Hard ceiling on shutdown. A wedged API must not turn a clean exit into a hang. */
const SHUTDOWN_DEADLINE_MS = 20_000;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(message: string): void {
  console.log(`${stamp()}  ${message}`);
}

/** Describe the target in one line, so nobody has to guess whose money this is. */
function describeTarget(config: Config): string {
  const funds =
    config.funds === "play"
      ? "play funds"
      : `funds="${config.funds}" — NOT declared play money`;
  return `${config.baseUrl} (${funds})`;
}

function describeOrder(order: PlannedOrder): string {
  return (
    `#${String(order.index).padStart(3)} ${order.marketId.padEnd(14)} ` +
    `${order.side.padEnd(4)} ${dec.toString(order.quantity).padStart(10)} @ ` +
    `${dec.toString(order.price).padStart(12)}  ${order.timeInForce}` +
    `  notional≈${dec.toString(order.notional)}`
  );
}

/**
 * Read the venue's budgets. Free — this is the one call that costs no tokens.
 *
 * A failure here is not fatal: the loader degrades to a deliberately slow
 * assumed rate and says so. What it must never do is silently fall back to the
 * tier table in the docs, which is per-deployment configuration the spec
 * explicitly tells clients not to hardcode.
 */
async function refreshBudget(
  rest: RestClient,
  budget: RateBudget,
  quiet: boolean,
): Promise<void> {
  if (!rest.hasCredentials) {
    budget.degrade("no API credentials, so the endpoint cannot be called");
    return;
  }
  try {
    const status = await rest.request<unknown>({
      method: "GET",
      path: "/api/v1/account/rate-limit",
      signed: true,
      idempotent: true,
      // Zero, and that is the whole point: polling this endpoint consumes no
      // tokens, so a client can pace itself without paying to find out how.
      weight: 0,
    });
    budget.applyStatus(status);
  } catch (error) {
    if (quiet) return;
    const detail = error instanceof Error ? error.message : String(error);
    budget.degrade(detail);
  }
}

/**
 * Re-read the budgets periodically while writing.
 *
 * The local model drifts: the key is shared with whatever else the account is
 * running, and the venue's tokens are the real ones. Resyncing is free, so the
 * only cost of doing it often is a round trip, and the benefit is that a
 * co-tenant's traffic shows up as pacing rather than as a `429`.
 */
async function resyncLoop(
  rest: RestClient,
  budget: RateBudget,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await sleep(RESYNC_INTERVAL_MS, signal);
    } catch {
      return; // aborted
    }
    if (signal.aborted) return;
    // Quiet: a transient failure mid-run should not downgrade a budget that is
    // already known good, nor print on every tick.
    await refreshBudget(rest, budget, true);
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2));

  // Shutdown is two stages, and the distinction is load-bearing. `stopping`
  // means "start no new work": the submit loop stops between batches and the
  // resync loop unwinds. `halted` means "no more requests at all", and is
  // tripped only once the cancel has finished or run out of time. If the REST
  // client watched the same signal that Ctrl-C trips, the first thing shutdown
  // would do is guarantee the cancel request could not be sent.
  const stopping = new AbortController();
  const halted = new AbortController();

  let secondSignal = false;
  const onSignal = (name: string): void => {
    if (secondSignal) {
      console.log(
        `\n${stamp()}  ${name} again — exiting now. Orders from this run may ` +
          "still be resting; cancel them by hand.",
      );
      process.exit(130);
    }
    secondSignal = true;
    log(`shutting down (${name})`);
    stopping.abort(new Error(`shutdown: ${name}`));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const budget = new RateBudget(config.utilisation, (note) => log(note));
  const rest = new RestClient(config, budget, halted.signal, (warning) =>
    log(`warning: ${warning}`),
  );

  const runId = process.env["NEXUS_RUN_ID"]?.trim() || randomBytes(4).toString("hex");

  log(`Nexus Exchange order loader — ${describeTarget(config)}`);
  log(`order file: ${config.orderFile}`);
  log(`run id: ${runId} (client_id prefix "ol-${runId}-")`);

  // 1. What may we spend? Read it from the venue before anything else, so the
  //    very first real call is already paced.
  await refreshBudget(rest, budget, false);
  for (const line of budget.describe()) log(line);
  if (budget.isDiscovered) log(`tier: ${budget.tierName}`);

  // 2. What are the venue's rules? Public, unauthenticated, weight 1.
  const markets = parseMarkets(
    await rest.request<unknown>({
      method: "GET",
      path: "/api/v1/markets/summary",
      idempotent: true,
      weight: 1,
    }),
  );
  log(`markets: ${[...markets.keys()].join(", ")}`);

  // 3. Is the file placeable, in its entirety?
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(config.orderFile, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read ${config.orderFile}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const plan = planOrders(raw, {
    markets,
    allowTaker: config.allowTaker,
    runId,
  });

  console.log("");
  for (const order of plan.orders) console.log(`  ${describeOrder(order)}`);
  for (const rejection of plan.rejections) {
    console.log(`  #${String(rejection.index).padStart(3)} REJECTED  ${rejection.reason}`);
  }
  console.log("");

  if (plan.rejections.length > 0) {
    throw new Error(
      `${plan.rejections.length} of ${plan.orders.length + plan.rejections.length} ` +
        "order(s) in the file are not placeable. Nothing was sent: a bulk " +
        "loader that applies the half of a file it likes leaves you with a " +
        "position nobody wrote down. Fix the file and run again.",
    );
  }
  if (plan.orders.length === 0) {
    log("the order file is empty; nothing to do");
    return;
  }
  if (plan.orders.length > config.maxOrders) {
    throw new Error(
      `${plan.orders.length} orders exceeds NEXUS_MAX_ORDERS=${config.maxOrders}. ` +
        "That ceiling is this example's blast radius, not the venue's limit — " +
        "raise it deliberately.",
    );
  }

  const preview = Loader.selectForPreview(plan.orders, config.previewPolicy);
  const chunks = Math.ceil(plan.orders.length / config.chunkSize);
  log(
    `plan: ${plan.orders.length} order(s), ${chunks} batch(es) of up to ` +
      `${config.chunkSize}, ${preview.length} preview(s) ` +
      `(policy "${config.previewPolicy}")`,
  );
  log(
    "cost: previews and submits are both charged to the trading bucket, so " +
      `this run needs ${preview.length} + ${chunks} trading unit(s) at minimum`,
  );

  // 4. The gate. Everything above this line is read-only.
  if (!config.submit) {
    log("DRY RUN — nothing was sent. Re-run with --submit to place these orders.");
    return;
  }
  if (config.funds !== "play") {
    throw new Error(
      `refusing to submit against a target whose funds are "${config.funds}". ` +
        "This example places orders in bulk and is testnet-only. Set " +
        "NEXUS_EXCHANGE_FUNDS=play only if you are certain the target is play money.",
    );
  }
  if (!rest.hasCredentials) {
    throw new Error(
      "--submit needs NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET",
    );
  }

  const loader = new Loader(rest, budget, log);
  const resync = resyncLoop(rest, budget, stopping.signal);

  try {
    for (const order of preview) {
      if (stopping.signal.aborted) break;
      const outcome = await loader.preview(order);
      log(
        `preview #${outcome.order.index} ${outcome.order.marketId}: ` +
          `${outcome.accepted ? "accepted" : "REJECTED"} ${outcome.detail}`,
      );
      if (!outcome.accepted) {
        throw new Error(
          `the venue would reject order #${outcome.order.index}. Nothing has ` +
            "been submitted; fix the file rather than finding out one batch in.",
        );
      }
    }

    if (!stopping.signal.aborted) {
      await loader.submit(plan.orders, config.chunkSize, stopping.signal);
    }
  } finally {
    // Runs on every exit path — a clean finish, a thrown error, a signal.
    stopping.abort(new Error("run finished"));
    await resync.catch(() => {});

    const deadline = AbortSignal.timeout(SHUTDOWN_DEADLINE_MS);
    if (loader.hasOutstandingWrites) {
      log("cancelling every order this run placed");
      await loader.cancelEverything(deadline).catch((error: unknown) => {
        log(`cancel failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    halted.abort(new Error("halted"));

    const lines = loader.summarise();
    if (lines.length > 0) {
      console.log("");
      console.log("  result");
      for (const line of lines) console.log(line);
      console.log("");
    }
    for (const line of loader.budgetLines()) log(line);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${stamp()}  error: ${message}`);
  process.exitCode = 1;
});
