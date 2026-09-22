// Configuration: read from the environment, validated before anything runs.
//
// There are no credentials to protect here — the replica reads public market
// data only — so the checks are about *where* it points: a base that would 404,
// a stream URL that is not a WebSocket, a market id that could reshape a path,
// and the one host this example must never talk to.

import { existsSync } from "node:fs";

export interface Config {
  /** REST base, e.g. `https://api.testnet.nexus.xyz/indexer`. Routes are appended. */
  readonly baseUrl: string;
  /** Public market-data WebSocket, e.g. `wss://…/indexer/stream`. */
  readonly streamUrl: string;
  readonly market: string;
  /** Milliseconds between REST cross-checks of the replica. */
  readonly crossCheckMs: number;
  /** Stop after this many milliseconds, or run until Ctrl-C when `null`. */
  readonly runForMs: number | null;
}

/**
 * The durable testnet deployment, including the `/indexer` route prefix it is
 * mounted under. The prefix is load-bearing: the bare host answers `404`.
 *
 * Not the SDKs' built-in `Network.TESTNET` base (`exchange.nexus.xyz/api/exchange`),
 * which proxies to a decommissioned indexer and answers `500` on every route.
 */
const DEFAULT_BASE_URL = "https://api.testnet.nexus.xyz/indexer";

/**
 * Mainnet, refused outright. This example is read-only, so the danger is not
 * money — it is a reader copying a URL out of a transcript and into a bot that
 * is not read-only.
 */
const MAINNET_HOST = "api.nexus.xyz";

const DEFAULT_MARKET = "BTC-USDX-PERP";
const DEFAULT_CROSSCHECK_SECONDS = 15;

/** Load `.env` from beside this example, if present — resolved from this file, not the cwd. */
function loadDotEnv(): void {
  const envFile = new URL("../.env", import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/** Read an environment variable, treating blank as absent. */
function env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NEXUS_EXCHANGE_API_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`NEXUS_EXCHANGE_API_URL must be http(s), got ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "NEXUS_EXCHANGE_API_URL must be a bare base: no credentials, query or fragment",
    );
  }
  refuseMainnet(url, "NEXUS_EXCHANGE_API_URL");
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  if (base.endsWith("/api/v1")) {
    throw new Error(
      "NEXUS_EXCHANGE_API_URL must not end in /api/v1 — this app appends the route itself",
    );
  }
  return base;
}

/**
 * The stream lives on the same deployment as REST: same host, same route
 * prefix, `wss://` instead of `https://`. Deriving it rather than defaulting it
 * separately is what keeps a reader who overrides one from silently pairing a
 * local REST with the public stream — a replica cross-checked against a
 * different venue than the one feeding it would report divergence forever.
 */
function deriveStreamUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/stream`;
  return url.toString();
}

function parseStreamUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NEXUS_EXCHANGE_STREAM_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(`NEXUS_EXCHANGE_STREAM_URL must be ws:// or wss://, got ${url.protocol}`);
  }
  refuseMainnet(url, "NEXUS_EXCHANGE_STREAM_URL");
  return url.toString();
}

function refuseMainnet(url: URL, name: string): void {
  if (url.hostname === MAINNET_HOST) {
    throw new Error(`${name} points at mainnet (${MAINNET_HOST}); this example is testnet-only`);
  }
}

/**
 * A market id is interpolated into a request path and a subscribe channel
 * (`book:<market>`), so it is constrained rather than trusted: a `/` or `?`
 * would reshape the URL, and a `*` would turn one market into all of them.
 */
function parseMarket(raw: string | undefined): string {
  const market = raw ?? DEFAULT_MARKET;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(market)) {
    throw new Error(`NEXUS_MARKET is not a valid market id: ${market}`);
  }
  return market;
}

function parseSeconds(raw: string | undefined, name: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > 86_400) {
    throw new Error(`${name} must be an integer number of seconds in [${min}, 86400], got ${raw}`);
  }
  return value;
}

/** `--seconds=N` or `--seconds N`: run for a bounded time, then print the summary. */
function parseRunFor(argv: readonly string[]): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    let raw: string | undefined;
    if (arg.startsWith("--seconds=")) raw = arg.slice("--seconds=".length);
    else if (arg === "--seconds") raw = argv[i + 1];
    else continue;
    // `?? ""` makes a bare trailing `--seconds` fail validation rather than be ignored.
    return (parseSeconds(raw ?? "", "--seconds", 1) ?? 0) * 1000;
  }
  return null;
}

export function loadConfig(argv: readonly string[]): Config {
  loadDotEnv();
  const baseUrl = parseBaseUrl(env("NEXUS_EXCHANGE_API_URL") ?? DEFAULT_BASE_URL);
  const streamRaw = env("NEXUS_EXCHANGE_STREAM_URL");
  const crossCheckSeconds =
    parseSeconds(env("NEXUS_CROSSCHECK_SECONDS"), "NEXUS_CROSSCHECK_SECONDS", 2) ??
    DEFAULT_CROSSCHECK_SECONDS;
  return {
    baseUrl,
    streamUrl: streamRaw === undefined ? deriveStreamUrl(baseUrl) : parseStreamUrl(streamRaw),
    market: parseMarket(env("NEXUS_MARKET")),
    crossCheckMs: crossCheckSeconds * 1000,
    runForMs: parseRunFor(argv),
  };
}
