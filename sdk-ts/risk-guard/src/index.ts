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
// that made things worse.
//
// "Not interruptible" is only an acceptable trade if the wait is a number you
// can state, and `timeoutMs` alone is not that number: it bounds one *attempt*,
// and the SDK retries transient failures on idempotent methods — `DELETE` among
// them, so the cancel retries too. See `MAX_CALL_MS` for the bound, which is
// derived from the retry settings this app sets rather than asserted.

import {
  ApiError,
  Client,
  Network,
  NexusExchangeError,
  TransportError,
  customNetwork,
  type NetworkSelector,
  type Order,
} from "@nexus-xyz/exchange-ts";

import { ConfigError, HelpRequested, USAGE, loadConfig } from "./config.js";
import { evaluate } from "./risk.js";
import type { Config } from "./config.js";
import type { Verdict } from "./risk.js";

/**
 * Per-*attempt* ceiling. Short enough to fail, generous enough for a cold TLS
 * handshake. Deliberately not the whole bound on a call — see `MAX_CALL_MS`.
 */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Retries after the first attempt, set explicitly rather than inherited.
 *
 * The SDK's default is 2, and it applies retries to every method in its
 * `IDEMPOTENT_METHODS` set — which includes `DELETE`, so `cancelAllOrders` is
 * retried like a read. That is correct of the SDK (a cancel-all is idempotent)
 * but it means the panic button's stuck time is a multiple of `timeoutMs`, not
 * `timeoutMs`. One retry is the trade this app wants: the reads are polled again
 * next tick anyway, so they lose little, while the cancel still survives a
 * single transient blip without being able to sit there for three attempts.
 */
const MAX_RETRIES = 1;

/** The SDK's default first backoff step, pinned so `MAX_CALL_MS` is ours. */
const RETRY_BASE_MS = 250;

/**
 * Worst case for one call, and so the longest a shutdown waits on one.
 *
 * Every attempt times out, and every backoff is taken at its ceiling: the SDK
 * sleeps `min(maxDelay, base·2ⁿ)` plus jitter of up to the same again, capped at
 * `maxDelay`, so `base·2ⁿ` summed over the retries bounds the sleeping.
 * Computed rather than written down, so it cannot drift from the two constants
 * above.
 *
 * One caveat worth stating rather than hiding: on a `429` the SDK honours the
 * server's `Retry-After` instead of its own backoff, clamped to 60s. A
 * rate-limited cancel can therefore exceed this bound — bounded still, but by
 * the server. Everything else is bounded here.
 */
const MAX_CALL_MS =
  (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS +
  Array.from({ length: MAX_RETRIES }, (_, n) => RETRY_BASE_MS * 2 ** n).reduce(
    (a, b) => a + b,
    0,
  );

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

/** One readable line from anything throwable, with whitespace collapsed. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * A failure that retrying cannot fix, carrying an exit code so a supervisor can
 * tell *why* the guard stopped and not merely that it did. Codes follow
 * `sysexits.h`, matching the Rust twin: `77` EX_NOPERM for credentials, `65`
 * EX_DATAERR for anything else terminal.
 */
class Fatal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Split an SDK error into "try again next tick" and "this will fail identically
 * forever".
 *
 * The distinction matters more here than anywhere else in the app. A guard whose
 * credentials were revoked protects nothing, and treating that as transient is
 * the worst failure this app has available: it stays alive, logs the same 401
 * every tick, and exits `0` if anyone ever stops it — so no supervisor restarts
 * it and no operator is told the account is now unwatched. The SDK classifies
 * this for us on `NexusExchangeError.transient`, the same flag its own retry
 * layer uses. Same rule as `unknown` in `risk.ts`: never let a failure read as a
 * clean bill of health.
 */
function classify(error: unknown): Fatal | null {
  if (!(error instanceof NexusExchangeError) || error.transient) return null;
  const auth = error instanceof ApiError && (error.status === 401 || error.status === 403);
  return new Fatal(auth ? 77 : 65, describe(error));
}

/**
 * A stable identity for a failing poll, for deciding whether the failure is news
 * rather than the same outage repeating.
 *
 * Groups by failure *class*, never by message. `Promise.all` rejects with
 * whichever of its two concurrent requests failed first, so one outage can
 * alternate between messages differing only in their URL or path — comparing
 * printed text would reprint both forever. A transport error and a named server
 * rejection are different news and both print; the same outage arriving by a
 * different route is not, and does not. The prefix keeps a failure key from ever
 * comparing equal to a verdict summary.
 */
function failureKey(error: unknown): string {
  if (error instanceof ApiError) return `poll failed: api ${error.status} ${error.code ?? ""}`;
  if (error instanceof NexusExchangeError) return `poll failed: ${error.constructor.name}`;
  return "poll failed: unknown";
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

/**
 * Resolve the target: testnet by default, or a validated custom descriptor.
 *
 * An override goes through `customNetwork` rather than the deprecated bare
 * `baseUrl`, because a URL on its own cannot say what the target moves. The
 * descriptor carries `funds` with the transport, so a guardrail can never read a
 * play-funds classification off a client pointed somewhere else. This app only
 * reads and cancels — neither is funds-guarded — so `"unknown"` costs nothing
 * here and is the honest value for a host nobody has declared.
 *
 * Testnet is named rather than left to the default: an example should never
 * leave a reader guessing whose money it watches. This SDK refuses
 * `Network.Mainnet` locally, before any bytes leave the process, so the "pointed
 * at real funds by accident" failure is the SDK's to prevent and not something
 * this app re-implements badly.
 */
function buildNetwork(baseUrl: string | undefined): NetworkSelector {
  if (baseUrl === undefined) return Network.Testnet;
  try {
    return customNetwork({ label: "custom", baseUrl, funds: "unknown" });
  } catch (error) {
    // The SDK's message already names the offending value and the shape it
    // wanted, so pass it through instead of writing a worse one over the top.
    throw new ConfigError(
      `NEXUS_EXCHANGE_API_URL is not a usable deployment base.\n  ${describe(error)}`,
    );
  }
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
  //
  // `customNetwork` validates and throws, and its rejection is turned into a
  // `ConfigError` here rather than allowed to escape. `NEXUS_EXCHANGE_API_URL`
  // is the one config value `config.ts` cannot check on its own — the rules for
  // a base URL belong to the SDK — which makes it both the most likely thing to
  // be wrong and, left alone, the worst-reported: a bare `NexusExchangeError` is
  // neither an `ApiError` nor a `TransportError`, so it would surface as an
  // unhandled rejection and a stack trace. Reclassifying it here puts it back
  // where every other bad setting is handled.
  const network = buildNetwork(config.baseUrl);

  const client = new Client({
    network,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    timeoutMs: REQUEST_TIMEOUT_MS,
    retry: { maxRetries: MAX_RETRIES, baseDelayMs: RETRY_BASE_MS },
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

  // A key for the last status reported, so a steady state does not reprint
  // itself every interval — 5,760 identical lines a day at the default 15s. It
  // is a key rather than the printed line, because a failing poll's message is
  // not stable; see `failureKey`.
  let lastReported = "";

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
      const changed = line !== lastReported;
      if (changed) {
        lastReported = line;
        log(line);
        for (const finding of verdict.findings) {
          if (finding.state !== "within") log(`  ${finding.limit}: ${finding.detail}`);
        }
      }

      if (verdict.breached) {
        await onBreach(client, config, orders, changed);
      } else if (verdict.indeterminate && changed) {
        // Reported, never acted on. Cancelling because a mark price is
        // temporarily unavailable would make an indexer hiccup into a trading
        // decision — the same reason `trading-terminal` refuses to quote off a
        // stale book. The honest posture is to say the limit cannot be proven
        // and let a human look.
        log("  a limit could not be proven — not acting on data this app does not trust");
      }
    } catch (error) {
      // An abort is the shutdown path, not a failure: the loop condition is
      // about to end it, and reporting it would read as an error.
      if (stopping.signal.aborted) break;
      // A failed poll is not evidence of safety. Report it, and stop outright if
      // retrying cannot help — see `classify`.
      const key = failureKey(error);
      if (key !== lastReported) {
        lastReported = key;
        log(`poll failed: ${describe(error)}`);
      }
      const fatal = classify(error);
      if (fatal !== null) throw fatal;
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
  changed: boolean,
): Promise<void> {
  if (orders.length === 0) return;
  if (!config.armed) {
    // Gated on `changed`: a standing breach should not print the same advisory
    // 5,760 times a day. The outcome of an actual cancel below is never gated,
    // because that is a write this app performed.
    if (changed) log(`  would cancel ${orders.length} resting order(s) — re-run with --arm`);
    return;
  }
  try {
    // No `signal`: this is the risk-reducing action, and Ctrl-C must not be what
    // stops it. `MAX_CALL_MS` is what bounds it instead.
    await client.cancelAllOrders();
    // Deliberately not "cancelled N": `cancelAllOrders` is the account-wide
    // `DELETE /orders` and it runs *after* the fetch above, so an order placed
    // in between is cancelled too. The count is what this app saw, and the audit
    // line for its only write says exactly that rather than implying a total it
    // cannot know — the SDK types the response `void`, so there is no number to
    // read either.
    log(`  cancelled every resting order on this account (${orders.length} seen this tick)`);
  } catch (error) {
    log(`  cancel failed: ${describe(error)}`);
    // Cancelling is idempotent, so a transient failure just means the next tick
    // tries again — the right behaviour while a limit is still breached. A
    // terminal one will fail the same way forever, and an armed guard that
    // cannot cancel is not a guard.
    const fatal = classify(error);
    if (fatal !== null) throw fatal;
    log("  will retry next tick");
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
  if (error instanceof HelpRequested) {
    console.log(USAGE);
    process.exit(0);
  }
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  if (error instanceof Fatal) {
    // The guard stopped because it could not do its job, and the exit code says
    // which kind of "could not" — see `classify`.
    console.error(
      `\nStopping: this cannot succeed by retrying, so the guard is not going to\n` +
        `pretend to watch.\n  ${error.message}`,
    );
    process.exit(error.code);
  }
  if (error instanceof ApiError || error instanceof TransportError) {
    console.error(
      `\nCouldn't reach the Exchange API.\n  ${describe(error)}\n\n` +
        "If the default host isn't serving the API for you, point the example at\n" +
        "another deployment. That value is the deployment *base* — the client adds\n" +
        "the /api/v1 prefix itself, and refuses a base that already carries it:\n\n" +
        "  NEXUS_EXCHANGE_API_URL=https://<host>/api/exchange npm start",
    );
    process.exit(1);
  }
  // Any other SDK error is a local rejection — a schema violation, a missing
  // credential — and `NexusExchangeError` is the *base* of `ApiError` and
  // `TransportError`, so it is not covered by the arm above. Without this it
  // would escape as an unhandled rejection and a stack trace, which is the
  // least useful way to tell someone their configuration is wrong.
  if (error instanceof NexusExchangeError) {
    console.error(`\nThe SDK rejected this before sending anything.\n  ${describe(error)}`);
    process.exit(1);
  }
  throw error;
}
