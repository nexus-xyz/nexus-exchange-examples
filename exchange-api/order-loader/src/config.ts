// Configuration: read from the environment, validated before anything runs.
//
// Every check here is a *local* refusal — before DNS, before TLS, before a
// credential is used. A misconfiguration that can be caught on this machine
// should never become a request, and for a loader that is sharper than usual:
// the mistake does not cost you one bad order, it costs you the whole file.

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** What the target's balances are made of. Drives the money guardrails. */
export type Funds = "play" | "real" | "unknown";

/** Which orders are worth spending a trading-class token to preview. */
export type PreviewPolicy = "none" | "first-per-market" | "all";

export interface Credentials {
  readonly apiKey: string;
  readonly apiSecretHex: string;
}

export interface Config {
  /** Deployment base URL. Paths like `/api/v1/orders/batch` are appended to it. */
  readonly baseUrl: string;
  readonly credentials: Credentials | null;
  readonly funds: Funds;
  /** Absolute path to the order file. */
  readonly orderFile: string;
  /** Orders per `POST /orders/batch` call. See `BATCH_CHUNK` below. */
  readonly chunkSize: number;
  readonly previewPolicy: PreviewPolicy;
  /** Refuse a file larger than this. A blast-radius cap, not a limit of the API. */
  readonly maxOrders: number;
  /** Fraction of each bucket this app will spend. Leaves room for co-tenants. */
  readonly utilisation: number;
  /** True when the file may contain a time-in-force that can take liquidity. */
  readonly allowTaker: boolean;
  /** True when `--submit` was passed. Without it nothing is sent. */
  readonly submit: boolean;
}

/**
 * The durable testnet deployment.
 *
 * **Not** `https://exchange.nexus.xyz/api/exchange`, which every Nexus SDK
 * shipped as its default until 2026-09 and which now answers `500` on every
 * route — it proxies to a decommissioned indexer (ENG-14039). The `/indexer`
 * suffix here is a route prefix the deployment mounts the service under, not
 * part of the API contract, and it is load-bearing: the bare host answers `404`
 * on every path. Copy the base whole rather than trimming it to the hostname.
 */
const DEFAULT_BASE_URL = "https://api.testnet.nexus.xyz/indexer";

/** The one deployment this example knows the funds posture of. */
const KNOWN_PLAY_HOST = "api.testnet.nexus.xyz";

/**
 * Mainnet's host, refused outright.
 *
 * The network map is deliberately off-pattern — mainnet is `api.nexus.xyz`, not
 * `api.mainnet.nexus.xyz` — so a client that interpolates the network name into
 * a hostname works everywhere except on real funds. This example never targets
 * mainnet, and naming the host is how that stays true even if someone sets the
 * environment variable by hand.
 */
const MAINNET_HOST = "api.nexus.xyz";

/**
 * Orders per batch call. Default 39, and the number is not a typo.
 *
 * The batch submit is charged `1 + floor(order_count / 40)` units of the
 * trading budget. Read that formula literally and the cheapest chunk is
 * **39**, not 40: 39 orders cost 1 unit, 40 orders cost 2. The spec's prose
 * says "up to 40 orders cost the same as a single order", which disagrees with
 * its own formula at exactly the multiples of 40 — so 39 is the size that is
 * optimal under the formula and no worse than 40 under the prose. It is a
 * two-fold difference in throughput at the boundary, which is a lot of
 * performance to lose to an off-by-one nobody would ever see.
 *
 * The ceiling is 40 for the same reason: past it you are paying for a second
 * unit anyway, and a chunk of 200 makes the per-order failure report in the
 * response array unreadable.
 */
const DEFAULT_CHUNK_SIZE = 39;
const MAX_CHUNK_SIZE = 40;

const DEFAULT_MAX_ORDERS = 200;
const DEFAULT_UTILISATION = 0.8;
const DEFAULT_ORDER_FILE = "orders.example.json";

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
 * into a terminal and from there into a scrollback or a CI log.
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
 *   * **userinfo** (`https://user:pass@host`) is credentials in a place nothing
 *     here reads, and `fetch` will happily put them in an `Authorization`
 *     header you did not write.
 *   * **query or fragment** on a *base* would be silently dropped when a path
 *     is appended — the operator's intent lost with no error.
 *   * **a base already ending in `/api/v1`** doubles the prefix, because every
 *     path in this app carries it. That produces a `404` and, worse, a
 *     signature over a path the server never sees.
 *   * **the mainnet host**, because this example places orders and mainnet is
 *     real funds.
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
      `refusing to run against ${MAINNET_HOST}: that is mainnet, and this ` +
        "example places orders in bulk. It is a testnet example by design.",
    );
  }
  const normalised = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  if (normalised.endsWith("/api/v1")) {
    throw new Error(
      "NEXUS_EXCHANGE_API_URL must not end in /api/v1 — this app appends the " +
        "full /api/v1/... path itself, so a base carrying it would send (and " +
        "sign) /api/v1/api/v1/...",
    );
  }
  return normalised;
}

/**
 * Decide what the target's funds are, failing closed.
 *
 * `unknown` is not a synonym for "safe". An operator who points this app at a
 * host it has never heard of gets `unknown`, and `unknown` is treated exactly
 * like `real`: submission is refused. Declaring `NEXUS_EXCHANGE_FUNDS=play` is
 * how you take responsibility for a target this example cannot vouch for.
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

/**
 * Credentials are all-or-nothing.
 *
 * Half a credential pair is always a mistake — a typo'd variable name, a `.env`
 * copied from somewhere else — and the failure it produces if you let it
 * through is an opaque `401` on the first signed call, long after the cause.
 */
function resolveCredentials(): Credentials | null {
  const apiKey = env("NEXUS_EXCHANGE_API_KEY");
  const apiSecretHex = env("NEXUS_EXCHANGE_API_SECRET");
  if (apiKey === undefined && apiSecretHex === undefined) return null;
  if (apiKey === undefined || apiSecretHex === undefined) {
    throw new Error(
      "set both NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET, or neither",
    );
  }
  return { apiKey, apiSecretHex };
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

function parsePreviewPolicy(raw: string | undefined): PreviewPolicy {
  const value = (raw ?? "first-per-market").toLowerCase();
  if (value !== "none" && value !== "first-per-market" && value !== "all") {
    throw new Error(
      `NEXUS_PREVIEW_POLICY must be none, first-per-market or all, got ${raw}`,
    );
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

function parseBoolean(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw new Error(`${name} must be true or false, got ${raw}`);
}

/**
 * Resolve the order file against this example's directory, not the working
 * directory, so `npm start` behaves the same from anywhere. An absolute path is
 * taken as given.
 */
function resolveOrderFile(raw: string): string {
  const here = fileURLToPath(new URL("..", import.meta.url));
  return resolvePath(here, raw);
}

/** Read `--file <path>` out of the argument list, if present. */
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
  const credentials = resolveCredentials();

  // Signed requests over cleartext put the API key — and a valid signature — on
  // the wire for anyone on the path. Loopback is exempt: there is no path.
  const base = new URL(baseUrl);
  if (
    credentials !== null &&
    base.protocol === "http:" &&
    !isLoopback(base.hostname)
  ) {
    throw new Error(
      `refusing to send signed requests in cleartext to ${base.hostname}: ` +
        "use https://",
    );
  }

  return {
    baseUrl,
    credentials,
    funds: resolveFunds(baseUrl),
    orderFile: resolveOrderFile(
      argValue(argv, "--file") ?? env("NEXUS_ORDER_FILE") ?? DEFAULT_ORDER_FILE,
    ),
    chunkSize: parseInteger(
      "NEXUS_BATCH_CHUNK",
      env("NEXUS_BATCH_CHUNK"),
      DEFAULT_CHUNK_SIZE,
      1,
      MAX_CHUNK_SIZE,
    ),
    previewPolicy: parsePreviewPolicy(env("NEXUS_PREVIEW_POLICY")),
    maxOrders: parseInteger(
      "NEXUS_MAX_ORDERS",
      env("NEXUS_MAX_ORDERS"),
      DEFAULT_MAX_ORDERS,
      1,
      5_000,
    ),
    utilisation: parseUtilisation(env("NEXUS_BUDGET_UTILISATION")),
    allowTaker: parseBoolean("NEXUS_ALLOW_TAKER", env("NEXUS_ALLOW_TAKER")),
    submit: argv.includes("--submit"),
  };
}
