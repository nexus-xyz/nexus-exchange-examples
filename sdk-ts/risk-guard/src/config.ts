// Configuration, validated before a single request goes out.
//
// Every check here is local: it costs nothing, and a misconfiguration caught on
// this machine never becomes a request against someone's account.

import { existsSync } from "node:fs";

import * as dec from "./decimal.js";

export interface Limits {
  /** Cap on total position notional, or `null` when not configured. */
  readonly maxNotional: dec.Dec | null;
  /** Cap on total unrealized loss, as a positive magnitude. */
  readonly maxLoss: dec.Dec | null;
  /** Floor on available margin. */
  readonly minAvailableMargin: dec.Dec | null;
}

export interface Config {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly baseUrl: string | undefined;
  readonly limits: Limits;
  readonly intervalMs: number;
  /** True when `--arm` was passed: the guard may cancel resting orders. */
  readonly armed: boolean;
}

/** Shortest polling interval. A guard that hammers the API is its own problem. */
const MIN_INTERVAL_SECONDS = 2;
/**
 * Longest polling interval: one hour. A guard that checks less often than this
 * is not really watching anything, and an interval that large is much more
 * likely to be a typo than a decision.
 *
 * There is a sharper reason for a ceiling than taste, though. `setTimeout`
 * silently clamps any delay past 2^31-1 ms (~24.8 days) **to 1 ms** and warns,
 * so without an upper bound a fat-fingered `NEXUS_GUARD_INTERVAL_SECONDS` does
 * not merely make the guard sleep forever — past that threshold it inverts into
 * a hot loop hammering the API, which is the exact failure
 * `MIN_INTERVAL_SECONDS` exists to prevent, reached from the other end.
 */
const MAX_INTERVAL_SECONDS = 3600;
const DEFAULT_INTERVAL_SECONDS = 15;

export class ConfigError extends Error {}

/**
 * Load `.env` from beside this example, if present.
 *
 * Resolved relative to this file rather than the working directory, so the app
 * behaves the same however it is invoked.
 */
function loadDotEnv(): void {
  const envFile = new URL("../.env", import.meta.url);
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

/** Read an environment variable, treating blank as absent. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parse a limit as an exact decimal.
 *
 * Limits must be strictly positive. A zero or negative limit is almost always a
 * typo, and it is the kind of typo that either fires the guard permanently or
 * never — neither of which the author intended.
 */
function limit(name: string): dec.Dec | null {
  const raw = env(name);
  if (raw === undefined) return null;
  let value: dec.Dec;
  try {
    value = dec.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (dec.compare(value, dec.ZERO) <= 0) {
    throw new ConfigError(`${name} must be greater than zero, got ${raw}`);
  }
  return value;
}

/**
 * Whole decimal digits, and nothing else.
 *
 * `Number()` is far too generous to decide a poll interval: it reads `"1e5"` as
 * 100000, `"0x1e"` as 30 and `"1e100"` as a finite number — and
 * `Number.isInteger` says yes to all three, so checking the parsed result is not
 * enough. Each has a plausible-looking reading that is not the one the author
 * meant. This is the same rule `decimal.ts` applies to the limits, for the same
 * reason, and the two should not disagree about what a number is. (Surrounding
 * whitespace is already gone: `env` trims, so `" 30 "` arrives as `"30"`.)
 */
const WHOLE_SECONDS_RE = /^\d+$/;

function interval(): number {
  const raw = env("NEXUS_GUARD_INTERVAL_SECONDS");
  if (raw === undefined) return DEFAULT_INTERVAL_SECONDS * 1000;
  const refuse = (): never => {
    throw new ConfigError(
      `NEXUS_GUARD_INTERVAL_SECONDS must be a whole number of seconds between ` +
        `${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}, got ${JSON.stringify(raw)}`,
    );
  };
  if (!WHOLE_SECONDS_RE.test(raw)) refuse();
  const seconds = Number(raw);
  if (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) refuse();
  return seconds * 1000;
}

/**
 * What `--help` prints. The whole interface is one flag, and saying so costs
 * less than making a reader open `index.ts` to find that out.
 */
export const USAGE = `risk-guard — watch one Nexus Exchange account against limits you set.

Usage:
  npm start                 watch and report; changes nothing
  npm start -- --arm        let a breach cancel every resting order
  npm start -- --help       print this

Credentials and limits come from the environment or .env; at least one limit is
required. See .env.example for every variable and its meaning.`;

/** Thrown for `--help`, so the caller can print usage and exit zero. */
export class HelpRequested extends Error {}

/**
 * Read the argument list and return whether the guard is armed.
 *
 * Unrecognised arguments are **refused**, not ignored. The near-misses for the
 * one flag that matters all look plausible — `--armed`, `-arm`, `--arm=true` —
 * and every one of them would otherwise leave an operator believing the guard
 * may act, with a startup banner agreeing, while it silently stayed watch-only.
 * A guard you think is armed and is not is worse than no guard. Every other
 * ambiguous input in this module is refused; this is the one where the quiet
 * default was "the safety feature is off".
 */
function parseArgs(argv: readonly string[]): boolean {
  // Help wins over everything, including a bad argument beside it: someone
  // asking what the flags are should be told, not corrected.
  if (argv.includes("--help") || argv.includes("-h")) throw new HelpRequested();
  let armed = false;
  for (const arg of argv) {
    if (arg === "--arm") {
      armed = true;
      continue;
    }
    throw new ConfigError(`unrecognised argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
  }
  return armed;
}

export function loadConfig(argv: readonly string[]): Config {
  // Before `.env` is read or a credential is touched: a typo'd flag should not
  // need a key in the environment to be reported.
  const armed = parseArgs(argv);

  loadDotEnv();

  const apiKey = env("NEXUS_EXCHANGE_API_KEY");
  const apiSecret = env("NEXUS_EXCHANGE_API_SECRET");
  // Half a credential pair is always a mistake — a typo'd variable name, a
  // `.env` copied from elsewhere — and left alone it surfaces as an opaque 401
  // long after the cause.
  if (apiKey === undefined || apiSecret === undefined) {
    throw new ConfigError(
      "this example watches your account, so it needs both " +
        "NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET.\n" +
        "Copy .env.example to .env and add a testnet key.",
    );
  }

  const limits: Limits = {
    maxNotional: limit("NEXUS_GUARD_MAX_NOTIONAL"),
    maxLoss: limit("NEXUS_GUARD_MAX_LOSS"),
    minAvailableMargin: limit("NEXUS_GUARD_MIN_AVAILABLE_MARGIN"),
  };

  // A guard with no limits is not a guard, and it would sit there printing
  // reassuring output forever. Refuse rather than imply coverage that does not
  // exist — the same reason CI's discovery step fails on a gate that checks
  // nothing.
  if (
    limits.maxNotional === null &&
    limits.maxLoss === null &&
    limits.minAvailableMargin === null
  ) {
    throw new ConfigError(
      "no limits configured, so there is nothing to guard. Set at least one of " +
        "NEXUS_GUARD_MAX_NOTIONAL, NEXUS_GUARD_MAX_LOSS or " +
        "NEXUS_GUARD_MIN_AVAILABLE_MARGIN — see .env.example.",
    );
  }

  return {
    apiKey,
    apiSecret,
    baseUrl: env("NEXUS_EXCHANGE_API_URL"),
    limits,
    intervalMs: interval(),
    armed,
  };
}
