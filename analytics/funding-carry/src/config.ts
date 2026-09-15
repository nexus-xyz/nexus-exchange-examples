// Configuration: read from the environment, validated before anything runs.
//
// Adapted from `account-statement`'s copy (CONTRIBUTING.md § 1). The host
// guards are the same and are worth keeping verbatim; the credential handling
// is gone, because **this example takes none**. Every surface it reads is
// public, which is the whole reason it is the one to run first.
//
// Every check here is a *local* refusal — before DNS, before TLS. A
// misconfiguration that can be caught on this machine should never become a
// request.

import { existsSync } from "node:fs";

/** What the target's balances are made of. Reported, never assumed. */
export type Funds = "play" | "real" | "unknown";

/** What to sort the ranking by. See `carry.ts` for what each one means. */
export type SortKey = "ratio" | "carry" | "margin";

export interface Config {
  /** Deployment base URL. Paths like `/api/v1/tickers` are appended to it. */
  readonly baseUrl: string;
  readonly funds: Funds;
  /** Look-back for the statistics, in hours. See `windowHours` below. */
  readonly windowHours: number;
  /** Refuse to rank a market with fewer settled windows than this. */
  readonly minSamples: number;
  readonly sortBy: SortKey;
  /** Restrict the ranking to one market. Empty means every market found. */
  readonly market: string | null;
  /** Fraction of the read budget this app will spend. In (0, 1]. */
  readonly utilisation: number;
  /** Print the full-scale decimal strings beside every rounded figure. */
  readonly exact: boolean;
}

/**
 * Default look-back: 7 days.
 *
 * Chosen against what the endpoint actually holds rather than against what
 * would be nice. Measured on the live testnet: `GET
 * /markets/{id}/funding?limit=1000` returned **173–174 settled windows
 * spanning 7.2 days** on every market. So a 7-day window is very nearly the
 * whole buffer, and a 30-day one would silently be a 7-day one wearing a
 * different label. The app reports the coverage it actually got, so a
 * deployment with a deeper buffer will simply say so.
 */
const DEFAULT_WINDOW_HOURS = 168;

/**
 * Refuse to rank a market on fewer than this many settled windows.
 *
 * **This is the number that keeps the ranking honest**, so it gets its
 * arithmetic stated rather than asserted. The quantity being ranked is a
 * dispersion, and the sample standard deviation of a roughly normal sample has
 * a relative standard error of about `1 / sqrt(2(n - 1))`. That is:
 *
 * ```
 *   n =   3  →  ±50%      a "ranking" that is mostly noise
 *   n =  10  →  ±24%
 *   n =  30  →  ±13%      the default
 *   n = 168  →  ±5.5%     a full 7-day window at hourly settlement
 * ```
 *
 * At n = 3 the dispersion estimate can be out by half, which is larger than
 * the gaps this ranking would be claiming to resolve — so three points do not
 * get a confident-looking number, they get "not ranked". The app prints this
 * figure per market from that market's own `n`, so the reader sees the error
 * bar on the statistic rather than being asked to trust the cutoff.
 *
 * `--min-samples` lowers it, and the output says when it has been lowered.
 */
const DEFAULT_MIN_SAMPLES = 30;

/**
 * The durable testnet deployment.
 *
 * **Not** `https://exchange.nexus.xyz/api/exchange`, which every Nexus SDK
 * shipped as its default until 2026-09 and which now answers `500` on every
 * route — it proxies to a decommissioned indexer (ENG-14039). The `/indexer`
 * suffix here is a route prefix the deployment mounts the service under, not
 * part of the API contract, and it is load-bearing: the bare host answers
 * `404` on every path (measured: `https://api.testnet.nexus.xyz/api/v1/markets/summary`
 * → `404`, the same path under `/indexer` → `200`). Copy the base whole rather
 * than trimming it to the hostname.
 */
const DEFAULT_BASE_URL = "https://api.testnet.nexus.xyz/indexer";

/** The one deployment this example knows the funds posture of. */
const KNOWN_PLAY_HOST = "api.testnet.nexus.xyz";

/**
 * Mainnet's host, refused outright.
 *
 * The network map is deliberately off-pattern — mainnet is `api.nexus.xyz`,
 * not `api.mainnet.nexus.xyz` — so a client that interpolates the network name
 * into a hostname works everywhere except on real funds. This example is a
 * testnet example; naming the host is how that stays true even if someone sets
 * the environment variable by hand.
 *
 * Refusing it by *name* rather than by reachability also matters: the host has
 * no DNS record today, so an unnamed refusal would look like a network fault
 * rather than a decision.
 */
const MAINNET_HOST = "api.nexus.xyz";

const DEFAULT_UTILISATION = 0.8;

/** Market ids are `BTC-USDX-PERP`-shaped; the spec pins the pattern. */
const MARKET_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;

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
 * Blank out any `user:password@` in a URL before it goes in a message.
 *
 * A URL that failed to parse is echoed back so the operator can see what was
 * wrong with it — and a password pasted into it would otherwise be echoed too,
 * into a terminal and from there into a scrollback or a CI log. Nothing here
 * reads a credential, but nothing here should print one either.
 */
function redactUrl(raw: string): string {
  return raw.replace(/\/\/[^/@\s]*@/, "//<redacted>@");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Validate an absolute HTTP(S) base URL and normalise its trailing slash.
 *
 * The rejections are all cases where the URL would still "work" well enough to
 * send a request and then behave in a way the operator did not intend:
 *
 *   * **userinfo** (`https://user:pass@host`) is credentials in a place
 *     nothing here reads, and `fetch` will happily put them in an
 *     `Authorization` header you did not write.
 *   * **query or fragment** on a *base* would be silently dropped when a path
 *     is appended — the operator's intent lost with no error.
 *   * **a base already ending in `/api/v1`** doubles the prefix, because every
 *     path in this app carries it. That produces a `404`.
 *   * **the mainnet host**, because this is a testnet example.
 */
function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `NEXUS_EXCHANGE_API_URL is not a valid URL: ${redactUrl(raw)}`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `NEXUS_EXCHANGE_API_URL must be http(s), got ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new Error("NEXUS_EXCHANGE_API_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error(
      "NEXUS_EXCHANGE_API_URL must not contain a query string or fragment",
    );
  }
  if (url.hostname === MAINNET_HOST) {
    throw new Error(
      `refusing to run against ${MAINNET_HOST}: that is mainnet, and this is ` +
        "a testnet example by design.",
    );
  }
  const normalised = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  if (normalised.endsWith("/api/v1")) {
    throw new Error(
      "NEXUS_EXCHANGE_API_URL must not end in /api/v1 — this app appends the " +
        "full /api/v1/... path itself, so a base carrying it would send " +
        "/api/v1/api/v1/...",
    );
  }
  return normalised;
}

/**
 * Decide what the target's funds are, failing closed.
 *
 * Nothing here places an order — this app has no write path at all — so this
 * does not gate anything. It is *reported*, in the header line, because a
 * ranking whose numbers came from a host the reader did not expect is worse
 * than no ranking. `unknown` is the honest answer for a host this example has
 * never heard of.
 */
function resolveFunds(baseUrl: string): Funds {
  const declared = env("NEXUS_EXCHANGE_FUNDS")?.toLowerCase();
  if (declared !== undefined) {
    if (declared !== "play" && declared !== "real" && declared !== "unknown") {
      throw new Error(
        `NEXUS_EXCHANGE_FUNDS must be play, real or unknown, got ${declared}`,
      );
    }
    return declared;
  }
  const host = new URL(baseUrl).hostname;
  if (host === KNOWN_PLAY_HOST) return "play";
  if (isLoopback(host)) return "play";
  return "unknown";
}

function parseMarket(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = raw.toUpperCase();
  if (!MARKET_RE.test(value) || value.length > 64) {
    throw new Error(
      `NEXUS_MARKET is not a market id: ${raw}. They look like BTC-USDX-PERP.`,
    );
  }
  return value;
}

function parseInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  // `Number("")` is 0 and `Number("12abc")` is NaN — check the integer-ness of
  // the result rather than trusting the parse.
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${raw}`);
  }
  return value;
}

function parseUtilisation(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_UTILISATION;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `NEXUS_BUDGET_UTILISATION must be a number in (0, 1], got ${raw}`,
    );
  }
  return value;
}

function parseSortKey(raw: string | undefined): SortKey {
  const value = (raw ?? "ratio").toLowerCase();
  if (value !== "ratio" && value !== "carry" && value !== "margin") {
    throw new Error(
      `--by must be ratio, carry or margin, got ${raw}. "ratio" is carry per ` +
        "unit of its own variability, which is the question this tool exists " +
        "to answer; the other two rank the numerator and the leverage-adjusted " +
        "numerator on their own.",
    );
  }
  return value;
}

/** Read `--flag <value>` out of the argument list, if present. */
function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

export function loadConfig(argv: readonly string[]): Config {
  loadDotEnv();

  const baseUrl = parseBaseUrl(
    env("NEXUS_EXCHANGE_API_URL") ?? DEFAULT_BASE_URL,
  );

  return {
    baseUrl,
    funds: resolveFunds(baseUrl),
    windowHours: parseInteger(
      "NEXUS_CARRY_WINDOW_HOURS",
      argValue(argv, "--window-hours") ?? env("NEXUS_CARRY_WINDOW_HOURS"),
      DEFAULT_WINDOW_HOURS,
      1,
      24 * 366,
    ),
    minSamples: parseInteger(
      "NEXUS_CARRY_MIN_SAMPLES",
      argValue(argv, "--min-samples") ?? env("NEXUS_CARRY_MIN_SAMPLES"),
      DEFAULT_MIN_SAMPLES,
      // Two is the floor the arithmetic itself imposes: the sample variance
      // divides by `n - 1`. It is nowhere near enough to rank on, and the
      // output says so loudly at anything below the default.
      2,
      100_000,
    ),
    sortBy: parseSortKey(argValue(argv, "--by") ?? env("NEXUS_CARRY_SORT")),
    market: parseMarket(argValue(argv, "--market") ?? env("NEXUS_MARKET")),
    utilisation: parseUtilisation(env("NEXUS_BUDGET_UTILISATION")),
    exact: argv.includes("--exact"),
  };
}

/** The default, exported so the renderer can say when it was overridden. */
export const DEFAULT_MIN_SAMPLES_VALUE = DEFAULT_MIN_SAMPLES;
