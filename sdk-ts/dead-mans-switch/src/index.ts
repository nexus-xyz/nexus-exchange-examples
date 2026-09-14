// A session supervisor that proves cancel-on-disconnect.
//
// Run it with:  npm start           (dry run — reports, changes nothing)
//               npm start -- --live (arms COD, places one order, kills itself)
//
// What this example is for
// ------------------------
// Every write example in this catalog cancels its own orders in a `finally`.
// That covers a clean exit and nothing else. This one is about the failure mode
// where the process is simply *gone* — SIGKILL, a lost network, an evicted
// container — and the only thing left that can cancel is the exchange.
//
// So the app is two processes, and it has to be:
//
//   * `src/session.ts` is the trading session. It opens the authenticated
//     WebSocket that cancel-on-disconnect keys off, places one resting order,
//     and then waits to die. It contains no cleanup of any kind.
//   * this file is the supervisor. It arms COD, spawns the session, **SIGKILLs
//     it**, and then watches the venue cancel an order that no live process is
//     managing any more.
//
// One process could not demonstrate this. If the process that places the order
// is also the process that reports the outcome, then either it survived — in
// which case the kill was not real — or it did not, in which case there is
// nobody left to tell you what happened. The split is what makes the kill a
// genuine SIGKILL rather than a graceful shutdown wearing its name.
//
// It also puts the safety net in the right place. The supervisor never holds a
// WebSocket, so its own liveness is invisible to COD, and it is still running
// when the demonstration ends: if COD does *not* fire, the supervisor cancels
// the order itself and says the demonstration failed. An example that can leave
// a resting order behind on a venue is not one anybody should run.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import { Client, NexusExchangeError } from "@nexus-xyz/exchange-ts";
import type { CancelOnDisconnectStatus, Order } from "@nexus-xyz/exchange-ts";

import { ASSUMED_GRACE_SECONDS, ConfigError, HelpRequested, USAGE, loadConfig } from "./config.js";
import { PlanError, describePlan, planRestingOrder } from "./plan.js";
import { buildClient, describe, isTransient, isVenueError } from "./venue.js";
import type { Config } from "./config.js";
import type { Plan } from "./plan.js";
import type { SessionMessage } from "./session.js";

/** Exit codes, so a supervisor of *this* supervisor can tell the cases apart. */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
/** Preconditions were not met, and nothing was placed. */
const EXIT_REFUSED = 2;
/** The demonstration ran and COD did not fire. This app cancelled the order. */
const EXIT_NOT_PROVEN = 3;
/** Interrupted after the order was placed. Cleanup ran; the outcome is unknown. */
const EXIT_INTERRUPTED = 130;

/** How long to wait for the session to get an order resting. */
const SESSION_READY_TIMEOUT_MS = 60_000;
/** How often the supervisor re-reads its own account's open orders. */
const WATCH_POLL_MS = 1_000;

/**
 * Aborted by SIGINT/SIGTERM.
 *
 * A signal handler is the wrong place to write cleanup: it can fire at any
 * point, including inside the cleanup it would be duplicating. So the handler
 * does one thing — abort this — and every wait in the app is written to notice.
 * The single `finally` in `liveRun` stays the only code that undoes anything.
 */
const interrupted = new AbortController();

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

class Interrupted extends Error {}

function throwIfInterrupted(): void {
  if (interrupted.signal.aborted) throw new Interrupted("interrupted");
}

/** Sleep that ends early on an interrupt, and reports which happened. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      interrupted.signal.removeEventListener("abort", finish);
      resolve();
    }
    interrupted.signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Render a COD status honestly — all three fields, never two.
 *
 * `enabled` is the account's opt-in. `active` is `enabled` *and* the
 * exchange-side feature switch, which is what actually decides whether a
 * disconnect cancels anything. Collapsing the two into one "COD: on" is the
 * mistake this line exists to make impossible: an account can be opted in on a
 * deployment where the feature is off, and reporting that as covered is worse
 * than reporting nothing, because it is precisely the state in which somebody
 * stops cancelling their own orders.
 *
 * `grace_secs` is `null` when the feature is unavailable on the deployment at
 * all, which is a third thing again and not the same as "off".
 */
function describeCod(status: CancelOnDisconnectStatus): string {
  const grace = status.grace_secs === null || status.grace_secs === undefined
    ? "unreported"
    : `${status.grace_secs}s`;
  const meaning = status.active
    ? "the venue will cancel for you"
    : status.enabled
      ? "opted in, but the exchange-side switch is off — nothing will fire"
      : "not opted in";
  return `cancel-on-disconnect: enabled=${status.enabled} active=${status.active} grace=${grace} — ${meaning}`;
}

/** The grace window to plan around, with the fallback named rather than hidden. */
function graceMs(status: CancelOnDisconnectStatus): number {
  return (status.grace_secs ?? ASSUMED_GRACE_SECONDS) * 1000;
}

async function buildPlan(client: Client, config: Config): Promise<Plan> {
  const markets = await client.fetchMarkets();
  const market = markets.find((m) => m.market_id === config.market);
  if (market === undefined) {
    throw new PlanError(
      `market ${config.market} not found on this deployment. ` +
        `Available: ${markets.map((m) => m.market_id).join(", ")}`,
    );
  }
  const mark = await client.fetchMarkPrice(config.market);
  return planRestingOrder(market, mark, config.priceOffsetBps);
}

/**
 * Dry run: say what is true and what would happen, and write nothing.
 *
 * This is the default because the live path arms an account-wide setting and
 * places a real order, and neither of those is something an example should do
 * because you ran it to see what it did. Everything below is a read: the same
 * three-state COD status the live run acts on, the same plan it would place,
 * and the same refusals it would hit — reported rather than acted on.
 */
async function dryRun(client: Client, config: Config): Promise<number> {
  const plan = await buildPlan(client, config);
  log(`would place: ${describePlan(plan, config.priceOffsetBps)}`);

  const status = await client.getCancelOnDisconnect();
  log(describeCod(status));

  const resting = await client.getOpenOrders();
  log(`this account currently has ${resting.length} resting order(s)`);

  const deadlineSeconds = (graceMs(status) + config.watchSlackMs) / 1000;
  log(
    `--live would: arm COD if needed, spawn the session, SIGKILL it, then watch for up to ` +
      `${deadlineSeconds}s for the venue to cancel the order.`,
  );
  if (!status.active) {
    log("…and it would refuse before placing anything, because active=false.");
  }
  if (resting.length > 0) {
    log("…and it would refuse, because COD cancels EVERY resting order on the account.");
  }
  return EXIT_OK;
}

interface Session {
  readonly child: ChildProcess;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

/**
 * Spawn the session as a child of this process.
 *
 * `process.execArgv` is passed through deliberately: under `tsx` those flags
 * are what teach node to load TypeScript, so a child spawned without them
 * cannot import its own entry point. Re-using `process.execPath` with the
 * parent's loader flags also keeps the two processes on one runtime — a session
 * running under a different node than the supervisor would be a difference
 * nobody wrote down.
 */
function spawnSession(): Session {
  const sessionPath = fileURLToPath(new URL("./session.ts", import.meta.url));
  const child = spawn(process.execPath, [...process.execArgv, sessionPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) {
    child.kill("SIGKILL");
    throw new Error("the session was spawned without pipes, so it cannot report its order");
  }
  return { child, stdout, stderr };
}

/**
 * Read the session's stdout protocol until it reports an order resting.
 *
 * Resolves with the order id, or rejects. The session's stderr is the human
 * channel and is forwarded as it arrives, so a reader watching the terminal
 * sees the session's own account of what it did interleaved with the
 * supervisor's.
 */
function awaitResting(session: Session): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`the session did not get an order resting within ${SESSION_READY_TIMEOUT_MS / 1000}s`));
    }, SESSION_READY_TIMEOUT_MS);

    function done(): boolean {
      if (settled) return true;
      settled = true;
      clearTimeout(timer);
      interrupted.signal.removeEventListener("abort", onAbort);
      return false;
    }
    function fail(error: Error): void {
      if (!done()) reject(error);
    }
    function onAbort(): void {
      fail(new Interrupted("interrupted while the session was starting"));
    }
    interrupted.signal.addEventListener("abort", onAbort, { once: true });

    createInterface({ input: session.stderr }).on("line", (line: string) => {
      log(`  session: ${line}`);
    });

    createInterface({ input: session.stdout }).on("line", (line: string) => {
      let message: SessionMessage;
      try {
        message = JSON.parse(line) as SessionMessage;
      } catch {
        // Not protocol. Do not guess at it, and do not drop it either: an
        // unparseable line on the machine channel is a bug worth seeing.
        log(`  session (unparsed): ${line}`);
        return;
      }
      if (message.event === "resting") {
        if (!done()) resolve(message.orderId);
      } else if (message.event === "failed") {
        fail(new Error(`the session failed: ${message.message}`));
      }
    });

    session.child.on("error", (error) => fail(error));
    session.child.on("exit", (code, signal) => {
      fail(new Error(`the session exited (code=${code} signal=${signal}) before placing an order`));
    });
  });
}

/** Wait for the child to be gone, and report how it went. */
function awaitExit(session: Session): Promise<string> {
  return new Promise((resolve) => {
    const { child } = session;
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(`code=${child.exitCode} signal=${child.signalCode}`);
      return;
    }
    child.on("exit", (code, signal) => resolve(`code=${code} signal=${signal}`));
  });
}

function isAlive(session: Session | null): session is Session {
  return session !== null && session.child.exitCode === null && session.child.signalCode === null;
}

/**
 * Is this order still resting?
 *
 * Deliberately `GET /orders` — the account's open orders — rather than
 * `GET /orders/{id}`, and the difference matters. A single-order lookup answers
 * `404` for an order that never existed and for one that is gone, and it
 * answers with a *status* for one that is cancelled. Absence from the open-order
 * list is the question actually being asked: is there still an order of mine on
 * this book.
 *
 * A failed poll is never read as "gone". That would be the same class of bug as
 * a risk guard reading a missing value as zero: the one moment the app cannot
 * see is the one it must not conclude anything from.
 */
async function stillResting(client: Client, orderId: string): Promise<boolean | "unknown"> {
  try {
    const open = await client.getOpenOrders();
    return open.some((order: Order) => order.id === orderId);
  } catch (error) {
    if (isTransient(error)) return "unknown";
    throw error;
  }
}

/** The live demonstration. Returns the process exit code. */
async function liveRun(client: Client, config: Config): Promise<number> {
  const before = await client.getCancelOnDisconnect();
  log(describeCod(before));

  // COD is account-wide: when it fires it cancels **every** resting order on
  // the account, not just the one this app placed. Running the demonstration on
  // an account that is already working would destroy somebody's book to prove a
  // point about a different order. Refuse, before arming anything.
  const existing = await client.getOpenOrders();
  if (existing.length > 0) {
    log(`REFUSED: this account has ${existing.length} resting order(s).`);
    log("  cancel-on-disconnect cancels EVERY resting order on the account when it fires,");
    log("  so running this demonstration here would cancel orders it did not place.");
    log("  Use an account with an empty book.");
    return EXIT_REFUSED;
  }

  const plan = await buildPlan(client, config);
  log(`plan: ${describePlan(plan, config.priceOffsetBps)}`);
  throwIfInterrupted();

  // Restore-on-clean-exit: the account's COD setting is not this example's to
  // keep. `null` means it was already on and this app did not touch it.
  let restoreCodTo: boolean | null = null;
  let status = before;

  let session: Session | null = null;
  let orderId: string | null = null;
  let outcome = EXIT_ERROR;

  try {
    // ARMED INSIDE THE `try`, AND THE INTENT RECORDED BEFORE THE CALL.
    //
    // Assigning `restoreCodTo` after the await treated a write as applied only
    // if we heard it succeed. But the response is not the write: a 5s client
    // timeout, a 502 issued after the venue applied it, or a dropped
    // connection all leave the account armed with the exception escaping and
    // `restoreCodTo` still `null` — an account-wide `enabled = true` it never
    // asked for, never restored, and never mentioned in the output. The
    // README promises restore "only if this app was the one that changed it",
    // and in that window this app is exactly that.
    //
    // A write that MAY have applied has to be treated as applied.
    if (!before.enabled) {
      restoreCodTo = false;
      status = await client.setCancelOnDisconnect(true);
      log(`armed: ${describeCod(status)}`);
    }

    // The refusal that keeps this example honest. `enabled` is now true, but
    // `active` is `enabled && the exchange-side switch`, and that switch ships
    // off. Placing an order here would rest it on a venue that is not going to
    // cancel it — an example asserting a guarantee it is not getting.
    if (!status.active) {
      log("REFUSED: cancel-on-disconnect is opted in but not active on this deployment.");
      log("  `active` is the account opt-in AND the exchange-side feature switch, and the");
      log("  switch is off here, so a disconnect will cancel nothing. Nothing was placed.");
      log("  There is no client-side setting that changes this — it is the venue's.");
      return EXIT_REFUSED;
    }

    const grace = graceMs(status);
    log("spawning the session — it will place one order and then be killed");
    session = spawnSession();
    orderId = await awaitResting(session);

    // Confirm over REST rather than trusting the session's word for it. The
    // session is about to be destroyed and its report is the last thing it
    // says; if the order is not actually on the book, the watch below would
    // find it "gone" immediately and report a cancel that never happened.
    const seen = await stillResting(client, orderId);
    if (seen !== true) {
      throw new Error(
        `the session reported order ${orderId} resting, but ${
          seen === "unknown" ? "the confirming read failed" : "it is not in this account's open orders"
        }`,
      );
    }
    log(`confirmed over REST: ${orderId} is resting`);
    throwIfInterrupted();

    // The kill. SIGKILL, not SIGTERM: a catchable signal would let the session
    // run a handler, and then a passing demonstration would only prove that
    // handlers run. Nothing in the session survives this — no `finally`, no
    // `exit` hook, no flush.
    log(`SIGKILL -> session pid ${session.child.pid} (nothing in it gets to run)`);
    const killedAt = Date.now();
    session.child.kill("SIGKILL");
    log(`session gone: ${await awaitExit(session)}`);
    session = null;

    const deadline = killedAt + grace + config.watchSlackMs;
    log(
      `watching ${orderId} — venue grace is ${grace / 1000}s, giving up after ` +
        `${(grace + config.watchSlackMs) / 1000}s`,
    );

    for (;;) {
      const resting = await stillResting(client, orderId);
      const elapsed = ((Date.now() - killedAt) / 1000).toFixed(1);
      if (resting === false) {
        outcome = EXIT_OK;
        log(`PROVEN: ${orderId} was cancelled ${elapsed}s after the kill, by the venue.`);
        log("  Nothing this app runs did that — the process that placed it no longer exists.");
        orderId = null;
        break;
      }
      if (interrupted.signal.aborted) {
        outcome = EXIT_INTERRUPTED;
        log(`interrupted ${elapsed}s after the kill, before the venue's window closed.`);
        break;
      }
      if (Date.now() >= deadline) {
        outcome = EXIT_NOT_PROVEN;
        log(`NOT PROVEN: ${orderId} is still resting ${elapsed}s after the kill.`);
        log("  Cancelling it below. See the README's 'When it does not fire' for the usual causes.");
        break;
      }
      if (resting === "unknown") log("  a poll failed — not reading that as cancelled");
      await sleep(WATCH_POLL_MS);
    }
  } finally {
    // Cleanup, in the order that matters. None of these take an abort signal: a
    // Ctrl-C during cleanup must not be what leaves an order on the book.
    if (isAlive(session)) session.child.kill("SIGKILL");
    if (orderId !== null) {
      // Reached when the demonstration failed, when it was interrupted, or when
      // it threw partway. This is the safety net that makes the example
      // runnable at all: the venue was given its chance and did not take it, so
      // the order does not stay.
      try {
        await client.cancelOrder(orderId);
        log(`cleanup: cancelled ${orderId}`);
      } catch (error) {
        log(`cleanup: FAILED to cancel ${orderId}: ${describe(error)}`);
        log("  Cancel it yourself before leaving this account unattended.");
      }
    }
    // THE SWEEP, BEFORE COD IS DISARMED, because `orderId` is not the same
    // question as "is anything resting".
    //
    // `orderId` is assigned in exactly one place — `await awaitResting(...)` —
    // and every rejection path of that call leaves it `null`: the watch
    // timeout, the session reporting `failed`, the child exiting or erroring
    // before `resting`, and interrupt. In each, the order may already be on
    // the book: the client is built with `timeoutMs: 5_000` and `placeOrder`
    // is a POST, which the SDK does not retry, so a timeout on a request the
    // engine ACCEPTED throws in the child and the parent never learns the id.
    // The branch above then skips the cancel, and this block used to disarm
    // COD within a few hundred ms — well inside testnet's 10s grace, so the
    // timer that would have saved the order is switched off before it fires.
    //
    // `cancelAllOrders()` is safe here for one specific reason: `liveRun`
    // refused to start on a non-empty book, so anything resting now is ours.
    // A FLAG, NOT AN EARLY `return`. A `return` inside `finally` discards the
    // exception that is propagating — including the `Interrupted` the caller
    // matches on to choose its exit code and message.
    let bookConfirmedEmpty = false;
    try {
      const open = await client.getOpenOrders();
      if (open.length === 0) {
        bookConfirmedEmpty = true;
      } else {
        log(`cleanup: ${open.length} order(s) still resting — cancelling before disarming`);
        await client.cancelAllOrders();
        const after = await client.getOpenOrders();
        if (after.length > 0) {
          log(`cleanup: FAILED — ${after.length} order(s) STILL resting.`);
          log("  Cancel them yourself before leaving this account unattended.");
        } else {
          bookConfirmedEmpty = true;
          log("cleanup: book is empty");
        }
      }
    } catch (error) {
      // Could not PROVE the book is empty, so do not disarm the thing that
      // would clear it. An account left armed is the safe direction to err in;
      // an order left resting is not.
      log(`cleanup: could not confirm the book is empty: ${describe(error)}`);
    }

    if (restoreCodTo === null) {
      // Nothing to restore: COD was already on and this app never changed it.
      // Say nothing rather than imply a restore is being withheld.
    } else if (!bookConfirmedEmpty) {
      log("  NOT restoring cancel-on-disconnect: the book was not confirmed empty,");
      log("  so the venue keeps its chance to cancel. Turn it off once you have checked.");
    } else {
      try {
        const restored = await client.setCancelOnDisconnect(restoreCodTo);
        log(`restored: ${describeCod(restored)}`);
      } catch (error) {
        log(`cleanup: FAILED to restore cancel-on-disconnect: ${describe(error)}`);
        log("  It is still enabled on this account. Turn it off if that is not what you want.");
      }
    }
  }

  return outcome;
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2));
  const client = buildClient(config);

  // Say which target *and* what its funds are, on the first line. An overridden
  // host is `funds: "unknown"` — printing "play funds" at a host nobody
  // declared would be exactly the mislabelling the SDK's descriptor design
  // exists to prevent.
  log(
    config.baseUrlOverridden
      ? `dead-mans-switch on ${config.baseUrl} (funds: unknown — undeclared target)`
      : `dead-mans-switch on ${config.baseUrl} (testnet, play funds)`,
  );
  log(
    config.live
      ? "--live: this run arms cancel-on-disconnect and places one real order"
      : "dry run — nothing is armed and nothing is placed. Pass --live for the real thing.",
  );

  return config.live ? await liveRun(client, config) : await dryRun(client, config);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted.signal.aborted) return;
    console.log(
      `\n${signal} — unwinding to the cleanup path. A second ${signal} exits at once, ` +
        "which can leave an order resting.",
    );
    process.once(signal, () => process.exit(EXIT_INTERRUPTED));
    interrupted.abort();
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof HelpRequested) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }
  if (error instanceof ConfigError || error instanceof PlanError) {
    console.error(`\n${error.message}`);
    process.exit(EXIT_ERROR);
  }
  if (error instanceof Interrupted) {
    // "cleanup ran", not "nothing was left resting". Cleanup now sweeps the
    // book on every path, but it can still fail to prove it is empty — the
    // poll can error, or a cancel can be refused — and it says so in the log
    // when that happens. This line is printed by the outer handler, which does
    // not know which of those occurred, so it must not assert the outcome.
    //
    // Interrupt is the path where this matters most: Ctrl-C reaches the child
    // too (`spawn` passes no `detached`, so it shares the process group), so it
    // can land between `placeOrder` and the parent learning the order id.
    console.error(
      `\n${error.message} — cleanup ran. Check the lines above: they say ` +
        "whether the book was confirmed empty.",
    );
    process.exit(EXIT_INTERRUPTED);
  }
  if (isVenueError(error)) {
    console.error(
      `\nCouldn't reach the Exchange API.\n  ${describe(error)}\n\n` +
        "If this host isn't serving the API for you, point the example at another\n" +
        "deployment. That value is the deployment *base* — the client adds the\n" +
        "/api/v1 prefix itself, and refuses a base that already carries it:\n\n" +
        "  NEXUS_EXCHANGE_API_URL=https://<host>/<prefix> npm start",
    );
    process.exit(EXIT_ERROR);
  }
  // Any other SDK error is a local rejection — a schema violation, a missing
  // credential. `NexusExchangeError` is the *base* of `ApiError` and
  // `TransportError`, so it is not covered by the arm above, and without this
  // it would escape as an unhandled rejection and a stack trace.
  if (error instanceof NexusExchangeError) {
    console.error(`\nThe SDK rejected this before sending anything.\n  ${describe(error)}`);
    process.exit(EXIT_ERROR);
  }
  throw error;
}
