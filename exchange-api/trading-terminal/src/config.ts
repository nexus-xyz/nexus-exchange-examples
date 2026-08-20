// Configuration: read from the environment, validated before anything runs.
//
// Every check here is a *local* refusal — it happens before DNS, before TLS,
// before a credential is used. A misconfiguration that can be caught on this
// machine should never become a request, because a request is the thing that
// can move money or leak a secret.

import { existsSync } from "node:fs";

/** What the target's balances are made of. Drives the money guardrails. */
export type Funds = "play" | "real" | "unknown";

export interface Credentials {
  readonly apiKey: string;
  readonly apiSecretHex: string;
}

export interface Config {
  /** Gateway base URL. Paths like `/api/v1/orders` are appended to it. */
  readonly baseUrl: string;
  /** WebSocket endpoint, or `null` when none was configured. */
  readonly wsUrl: string | null;
  readonly credentials: Credentials | null;
  readonly funds: Funds;
  readonly market: string;
  /** How far from the mid the demo order rests, in basis points. */
  readonly orderDistanceBps: number;
  /** Demo order size as a decimal string, or `null` to use the venue minimum. */
  readonly orderQuantity: string | null;
  /** True when `--trade` was passed: the app may place one order. */
  readonly tradingEnabled: boolean;
}

/**
 * The one deployment this example knows the funds posture of.
 *
 * It is a *host*, not a URL prefix, because the network is carried in the host.
 * Anything else is `unknown` until the operator declares otherwise — see
 * `resolveFunds`.
 */
const KNOWN_PLAY_HOST = "exchange.nexus.xyz";

/** Default gateway base. Verified live: see the README's "About the host". */
const DEFAULT_BASE_URL = "https://exchange.nexus.xyz/api/exchange";

const DEFAULT_MARKET = "BTC-USDX-PERP";
const DEFAULT_ORDER_DISTANCE_BPS = 200;

/**
 * Load `.env` from beside this example, if present.
 *
 * Resolved relative to this file rather than the working directory, so the app
 * behaves the same however it is invoked. Node's `--env-file-if-exists` would
 * do the same job, but `tsx` re-execs and the flag's notice prints twice, which
 * makes a reader's first run look broken.
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
 * Validate the WebSocket endpoint.
 *
 * Refuses `ws://` to anything but loopback. The upgrade token rides in the
 * query string — `?token=…` — so a cleartext connection puts a live credential
 * on the wire in a URL, which is also the single most-logged part of a request.
 */
function parseWsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `NEXUS_EXCHANGE_WS_URL is not a valid URL: ${redactUrl(raw)}`,
    );
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(
      `NEXUS_EXCHANGE_WS_URL must be ws:// or wss://, got ${url.protocol}`,
    );
  }
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new Error(
      `refusing to send an upgrade token in cleartext to ${url.hostname}: ` +
        "use wss://",
    );
  }
  if (url.username || url.password) {
    throw new Error("NEXUS_EXCHANGE_WS_URL must not contain credentials");
  }
  if (url.searchParams.has("token")) {
    throw new Error(
      "NEXUS_EXCHANGE_WS_URL must not carry a token — this app mints a fresh " +
        "single-use one for every connection",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Decide what the target's funds are, failing closed.
 *
 * `unknown` is not a synonym for "safe". An operator who points this app at a
 * host it has never heard of gets `unknown`, and every money guardrail treats
 * `unknown` exactly like `real`. Declaring `NEXUS_EXCHANGE_FUNDS=play` is how
 * you take responsibility for a target this example cannot vouch for.
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

function parseBps(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  // `Number("")` is 0 and `Number("12abc")` is NaN — check the integer-ness of
  // the result rather than trusting the parse.
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error(
      `NEXUS_ORDER_DISTANCE_BPS must be an integer in [1, 10000], got ${raw}`,
    );
  }
  return value;
}

/**
 * A market id is interpolated into a request *path*, so it is constrained here
 * rather than trusted. The venue's own ids are of the form `BTC-USDX-PERP`;
 * anything outside that alphabet is a mistake, and refusing it locally keeps a
 * `../` or a `?` from ever being able to reshape a URL that is about to be
 * signed.
 */
function parseMarket(raw: string | undefined): string {
  const market = raw ?? DEFAULT_MARKET;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(market)) {
    throw new Error(`NEXUS_MARKET is not a valid market id: ${market}`);
  }
  return market;
}

function parseQuantity(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(
      `NEXUS_ORDER_QUANTITY must be a positive plain decimal, got ${raw}`,
    );
  }
  return raw;
}

export function loadConfig(argv: readonly string[]): Config {
  loadDotEnv();

  const baseUrl = parseBaseUrl(env("NEXUS_EXCHANGE_API_URL") ?? DEFAULT_BASE_URL);
  const wsRaw = env("NEXUS_EXCHANGE_WS_URL");
  const credentials = resolveCredentials();

  // Signed requests over cleartext put the API key — and a valid signature —
  // on the wire for anyone on the path. Loopback is exempt: there is no path.
  const baseHost = new URL(baseUrl);
  if (
    credentials !== null &&
    baseHost.protocol === "http:" &&
    !isLoopback(baseHost.hostname)
  ) {
    throw new Error(
      `refusing to send signed requests in cleartext to ${baseHost.hostname}: ` +
        "use https://",
    );
  }

  return {
    baseUrl,
    wsUrl: wsRaw === undefined ? null : parseWsUrl(wsRaw),
    credentials,
    funds: resolveFunds(baseUrl),
    market: parseMarket(env("NEXUS_MARKET")),
    orderDistanceBps: parseBps(
      env("NEXUS_ORDER_DISTANCE_BPS"),
      DEFAULT_ORDER_DISTANCE_BPS,
    ),
    orderQuantity: parseQuantity(env("NEXUS_ORDER_QUANTITY")),
    tradingEnabled: argv.includes("--trade"),
  };
}
