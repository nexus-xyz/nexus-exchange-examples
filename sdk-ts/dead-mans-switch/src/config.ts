// Configuration, validated before a single request goes out.
//
// Every check here is local: it costs nothing, and a misconfiguration caught on
// this machine never becomes a write against someone's account.

import { existsSync } from "node:fs";

/**
 * Where testnet actually answers.
 *
 * This is spelled out here rather than taken from `Network.Testnet`, and that
 * is not a style choice. `@nexus-xyz/exchange-ts` 0.4.0 ships
 * `https://exchange.nexus.xyz/api/exchange` as the testnet base, and that host
 * returns **HTTP 500 on every route** — it proxies to a decommissioned service.
 * The durable host is below, and the `/indexer` prefix is load-bearing: the
 * bare origin 404s. `nexus-exchange-ts#78` moves the constant; until a release
 * carries it, an example that names `Network.Testnet` cannot reach the venue at
 * all. See the README's "Which deployment it talks to".
 */
const TESTNET_BASE_URL = "https://api.testnet.nexus.xyz/indexer";

/** The market the demonstration rests its one order on. */
const DEFAULT_MARKET = "BTC-USDX-PERP";

/**
 * How far below the mark the resting order is priced, in basis points.
 *
 * Two constraints pull in opposite directions and this sits between them. Too
 * close and the order can fill during the demonstration, which is a position
 * this example did not ask for. Too far and the engine's price band rejects it
 * outright — `check_price_band` refuses any limit price more than the market's
 * `price_band_bps` away from the mark, which is 500 bps on the testnet perps
 * today. 400 bps is inside that band on every market here, with room left for a
 * mark that moves between the quote and the placement.
 *
 * Validated against the *live* band at runtime rather than trusted, because the
 * band is a per-market parameter an operator can change.
 */
const DEFAULT_PRICE_OFFSET_BPS = 400;

/**
 * Extra time to wait past the venue's own grace window before calling the
 * demonstration failed.
 *
 * The grace window is the venue's promise; this is slack for everything else in
 * the path — the indexer noticing the socket closed, the cancel reaching the
 * engine, this app's next poll. Generous on purpose: declaring failure early
 * and cancelling the order ourselves would destroy the evidence.
 */
const DEFAULT_WATCH_SLACK_SECONDS = 30;

/**
 * Fallback grace window, used only when the venue reports `grace_secs: null`.
 * That means the feature is unavailable on the deployment, which `--live`
 * refuses on anyway; this keeps the *dry run* able to print a deadline.
 */
export const ASSUMED_GRACE_SECONDS = 10;

const MIN_SLACK_SECONDS = 5;
const MAX_SLACK_SECONDS = 600;

export interface Config {
  readonly apiKey: string;
  readonly apiSecret: string;
  /** REST deployment base. Always a concrete value — never left to the SDK. */
  readonly baseUrl: string;
  /** True when `baseUrl` came from the environment rather than the default. */
  readonly baseUrlOverridden: boolean;
  /** WebSocket base, prefix included. Derived from `baseUrl` unless overridden. */
  readonly wsUrl: string;
  readonly market: string;
  readonly priceOffsetBps: number;
  readonly watchSlackMs: number;
  /** True when `--live` was passed: the app may arm COD and place one order. */
  readonly live: boolean;
}

export class ConfigError extends Error {}

/** Thrown for `--help`, so the caller can print usage and exit zero. */
export class HelpRequested extends Error {}

export const USAGE = `dead-mans-switch — prove the venue cancels for you when your client dies.

Usage:
  npm start                 dry run: report COD status and the order it would place
  npm start -- --live       the real thing: arm COD, place one order, SIGKILL the session
  npm start -- --help       print this

--live places a real order on testnet with a real API key. Everything else is
read-only. Credentials and settings come from the environment or .env; see
.env.example for every variable and its meaning.`;

/**
 * Load `.env` from beside this example, if present.
 *
 * Resolved relative to this file rather than the working directory, so the app
 * behaves the same however it is invoked — including in the child session,
 * which is spawned with no inherited cwd guarantee.
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
 * Whole digits, and nothing else.
 *
 * `Number()` is far too generous for a value that decides an order price: it
 * reads `"1e5"` as 100000 and `"0x1e"` as 30, and `Number.isInteger` agrees
 * with both. (Surrounding whitespace is already gone — `env` trims.)
 */
const WHOLE_NUMBER_RE = /^\d+$/;

function wholeNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const refuse = (): never => {
    throw new ConfigError(
      `${name} must be a whole number between ${min} and ${max}, got ${JSON.stringify(raw)}`,
    );
  };
  if (!WHOLE_NUMBER_RE.test(raw)) refuse();
  const value = Number(raw);
  if (value < min || value > max) refuse();
  return value;
}

/**
 * Turn a REST base into a WebSocket base, **keeping the path prefix**.
 *
 * This function exists because the SDK's own derivation does not keep it. In
 * 0.4.0 `Client.wsUrl` is the REST origin with the scheme swapped, and
 * `customNetwork` refuses a `wsUrl` carrying a path at all ("wsUrl must be an
 * origin with no path"). Against this deployment that yields
 * `wss://api.testnet.nexus.xyz/ws`, which 404s — the live stream is under
 * `/indexer`. So the WS base is computed here and handed straight to
 * `createWsClient`, which takes a free-form `url` and does not go through the
 * network descriptor.
 *
 * Not a workaround worth hiding: it is the single reason this example can hold
 * the authenticated socket that cancel-on-disconnect keys off, and it stops
 * being necessary the moment `nexus-exchange-ts#78` ships.
 */
function deriveWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString().replace(/\/+$/, "");
}

function parseBaseUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must be http:// or https://, got ${JSON.stringify(raw)}`);
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new ConfigError(
      `${name} must be a plain base URL — no query, fragment or userinfo, got ${JSON.stringify(raw)}`,
    );
  }
  // The SDK appends `/api/v1` itself and refuses a base that already carries
  // it. Catching it here names the variable that is wrong instead of letting
  // the SDK's message arrive with no context.
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api/v1")) {
    throw new ConfigError(
      `${name} is the deployment base and must not include /api/v1 — the client adds it. ` +
        `Try ${JSON.stringify(`${url.origin}${path.slice(0, -"/api/v1".length)}`)}.`,
    );
  }
  return `${url.origin}${path}`;
}

/**
 * Read the argument list.
 *
 * Unrecognised arguments are **refused**, not ignored. Every near-miss for the
 * one flag that matters — `--Live`, `-live`, `--live=true` — would otherwise
 * silently leave the app in dry run while its operator believed the
 * demonstration had run. Here that direction is the safe one, but "the flag you
 * typed did nothing" is never an acceptable answer either way.
 */
function parseArgs(argv: readonly string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) throw new HelpRequested();
  let live = false;
  for (const arg of argv) {
    if (arg === "--live") {
      live = true;
      continue;
    }
    throw new ConfigError(`unrecognised argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
  }
  return live;
}

export function loadConfig(argv: readonly string[]): Config {
  // Before `.env` is read or a credential is touched: a typo'd flag should not
  // need a key in the environment to be reported.
  const live = parseArgs(argv);

  loadDotEnv();

  const apiKey = env("NEXUS_EXCHANGE_API_KEY");
  const apiSecret = env("NEXUS_EXCHANGE_API_SECRET");
  // Credentials are required for both modes, and there is no useful public-data
  // fallback here. Even the dry run has to read this account's COD status and
  // its open orders to say anything true, and the market parameters it prices
  // against come from `GET /markets`, which this SDK signs. A half-run that
  // printed a plan and skipped the status would be reporting the least
  // interesting half.
  //
  // Half a credential pair is always a mistake — a typo'd variable name, a
  // `.env` copied from elsewhere — and left alone it surfaces as an opaque 401
  // long after the cause.
  if (apiKey === undefined || apiSecret === undefined) {
    throw new ConfigError(
      "this example reads and changes your account's cancel-on-disconnect setting,\n" +
        "so it needs both NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET.\n" +
        "Copy .env.example to .env and add a testnet key.",
    );
  }

  const rawBase = env("NEXUS_EXCHANGE_API_URL");
  const baseUrl =
    rawBase === undefined ? TESTNET_BASE_URL : parseBaseUrl("NEXUS_EXCHANGE_API_URL", rawBase);

  const rawWs = env("NEXUS_EXCHANGE_WS_URL");
  let wsUrl: string;
  if (rawWs === undefined) {
    wsUrl = deriveWsUrl(baseUrl);
  } else {
    let parsed: URL;
    try {
      parsed = new URL(rawWs);
    } catch {
      throw new ConfigError(
        `NEXUS_EXCHANGE_WS_URL must be an absolute ws(s) URL, got ${JSON.stringify(rawWs)}`,
      );
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new ConfigError(
        `NEXUS_EXCHANGE_WS_URL must be ws:// or wss://, got ${JSON.stringify(rawWs)}`,
      );
    }
    // A `ws://` socket beside an `https://` REST base is a TLS downgrade for
    // the one request that carries a spendable token. The SDK refuses this pair
    // in `customNetwork`; the same rule applies to the URL this app builds by
    // hand, or the check would have been bypassed rather than satisfied.
    if (parsed.protocol === "ws:" && baseUrl.startsWith("https:")) {
      throw new ConfigError(
        "NEXUS_EXCHANGE_WS_URL is insecure ws:// while the REST base is https://. " +
          "The WebSocket token is minted over TLS and would then be spent in clear text.",
      );
    }
    wsUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  }

  const market = env("NEXUS_DMS_MARKET") ?? DEFAULT_MARKET;

  return {
    apiKey,
    apiSecret,
    baseUrl,
    baseUrlOverridden: rawBase !== undefined,
    wsUrl,
    market,
    // Upper bound is the widest band any market here declares; the *live* band
    // is checked against this in `plan.ts`, which is the check that counts.
    priceOffsetBps: wholeNumber("NEXUS_DMS_PRICE_OFFSET_BPS", DEFAULT_PRICE_OFFSET_BPS, 1, 5000),
    watchSlackMs:
      wholeNumber(
        "NEXUS_DMS_WATCH_SLACK_SECONDS",
        DEFAULT_WATCH_SLACK_SECONDS,
        MIN_SLACK_SECONDS,
        MAX_SLACK_SECONDS,
      ) * 1000,
    live,
  };
}
