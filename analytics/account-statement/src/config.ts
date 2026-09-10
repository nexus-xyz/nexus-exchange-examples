// Configuration: read from the environment, validated before anything runs.
//
// Every check here is a *local* refusal — before DNS, before TLS, before a
// credential is used. A misconfiguration that can be caught on this machine
// should never become a request.

import { existsSync } from "node:fs";

/** What the target's balances are made of. Reported, never assumed. */
export type Funds = "play" | "real" | "unknown";

/**
 * The statement period, which is also the `window` sent to
 * `/account/portfolio-history`.
 *
 * These are the only four values the endpoint accepts, and the choice is not
 * cosmetic: `window` fixes the server-side downsample cadence *and* the point
 * capacity. See `WINDOW_SPEC`.
 */
export type Window = "day" | "week" | "month" | "all";

export interface Credentials {
  readonly apiKey: string;
  readonly apiSecretHex: string;
}

export interface Config {
  /** Deployment base URL. Paths like `/api/v1/fills` are appended to it. */
  readonly baseUrl: string;
  readonly credentials: Credentials | null;
  readonly funds: Funds;
  readonly window: Window;
  /** Restrict the statement to one market. Empty means every market. */
  readonly market: string | null;
  /** Ceiling on rows pulled per paginated surface. A politeness cap. */
  readonly maxRows: number;
  /** Fraction of the read budget this app will spend. In (0, 1]. */
  readonly utilisation: number;
  /** Print unrounded decimal strings beside every rounded figure. */
  readonly exact: boolean;
}

/**
 * What each `window` actually means, from the endpoint's own documentation.
 *
 * The trap this table exists to prevent: **`window` clamps the point count
 * server-side to that window's own capacity.** Asking `limit: 366` on a `day`
 * window quietly returns at most 288 points — "a larger value is clamped, not
 * rejected" — so a report that assumes it received what it asked for
 * mis-ranges its own axis and silently shortens its period. This app asks for
 * the capacity the table says exists and then believes the *response*, not the
 * request.
 */
export const WINDOW_SPEC: Readonly<
  Record<Window, { readonly cadenceMs: number; readonly maxPoints: number; readonly spanMs: number; readonly label: string }>
> = {
  day: { cadenceMs: 300_000, maxPoints: 288, spanMs: 24 * 3600_000, label: "24 hours" },
  week: { cadenceMs: 3600_000, maxPoints: 168, spanMs: 7 * 24 * 3600_000, label: "7 days" },
  month: { cadenceMs: 6 * 3600_000, maxPoints: 120, spanMs: 30 * 24 * 3600_000, label: "30 days" },
  all: { cadenceMs: 86_400_000, maxPoints: 366, spanMs: 366 * 24 * 3600_000, label: "366 days" },
};

/**
 * The durable testnet deployment.
 *
 * **Not** `https://exchange.nexus.xyz/api/exchange`, which every Nexus SDK
 * shipped as its default until 2026-09 and which now answers `500` on every
 * route — it proxies to a decommissioned indexer (ENG-14039). The `/indexer`
 * suffix here is a route prefix the deployment mounts the service under, not
 * part of the API contract, and it is load-bearing: the bare host answers
 * `404` on every path. Copy the base whole rather than trimming it to the
 * hostname.
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

const DEFAULT_MAX_ROWS = 1_000;
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
 *   * **userinfo** (`https://user:pass@host`) is credentials in a place
 *     nothing here reads, and `fetch` will happily put them in an
 *     `Authorization` header you did not write.
 *   * **query or fragment** on a *base* would be silently dropped when a path
 *     is appended — the operator's intent lost with no error.
 *   * **a base already ending in `/api/v1`** doubles the prefix, because every
 *     path in this app carries it. That produces a `404` and, worse, a
 *     signature over a path the server never sees.
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
        "full /api/v1/... path itself, so a base carrying it would send (and " +
        "sign) /api/v1/api/v1/...",
    );
  }
  return normalised;
}

/**
 * Decide what the target's funds are, failing closed.
 *
 * Nothing here places an order, so this does not gate anything — it is
 * *reported*, in the header line, because a statement whose numbers came from
 * a host the reader did not expect is worse than no statement. `unknown` is
 * the honest answer for a host this example has never heard of.
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
 * Half a credential pair is always a mistake — a typo'd variable name, a
 * `.env` copied from somewhere else — and the failure it produces if you let
 * it through is an opaque `401` on the first signed call, long after the
 * cause.
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

function parseWindow(raw: string | undefined): Window {
  const value = (raw ?? "day").toLowerCase();
  if (value !== "day" && value !== "week" && value !== "month" && value !== "all") {
    throw new Error(
      `window must be day, week, month or all, got ${raw}. Those are the only ` +
        "four the portfolio-history endpoint accepts.",
    );
  }
  return value;
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
  const credentials = resolveCredentials();

  // Signed requests over cleartext put the API key — and a valid signature —
  // on the wire for anyone on the path. Loopback is exempt: there is no path.
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
    window: parseWindow(argValue(argv, "--window") ?? env("NEXUS_STATEMENT_WINDOW")),
    market: parseMarket(argValue(argv, "--market") ?? env("NEXUS_MARKET")),
    maxRows: parseInteger(
      "NEXUS_MAX_ROWS",
      env("NEXUS_MAX_ROWS"),
      DEFAULT_MAX_ROWS,
      1,
      10_000,
    ),
    utilisation: parseUtilisation(env("NEXUS_BUDGET_UTILISATION")),
    exact: argv.includes("--exact"),
  };
}
