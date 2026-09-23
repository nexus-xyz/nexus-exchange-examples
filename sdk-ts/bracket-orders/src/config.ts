// Configuration, validated before a single request goes out.
//
// The bracket comes from flags, since it's what changes between runs.
// Credentials and the deployment come from the environment, never from a
// committed file.

import { existsSync } from "node:fs";

import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";

/**
 * Where testnet answers.
 *
 * Spelled out rather than taken from `Network.Testnet`, as in the other
 * `sdk-ts` examples: `@nexus-xyz/exchange-ts` 0.4.0 ships
 * `https://exchange.nexus.xyz/api/exchange` as its testnet base, and that host
 * proxies to a decommissioned service (HTTP 500 on every route). The
 * `/indexer` prefix is part of the deployment. The bare host 404s.
 */
const TESTNET_BASE_URL = "https://api.testnet.nexus.xyz/indexer";

/** How often the watcher re-reads REST even when the socket is quiet. */
const DEFAULT_RECONCILE_SECONDS = 15;

export type Side = "Buy" | "Sell";

export class ConfigError extends Error {}
export class HelpRequested extends Error {}

export interface BracketFlags {
  readonly market: string;
  /** The entry's side. The exits are the other side. */
  readonly side: Side;
  readonly size: Dec;
  /** The entry's price guard: an IOC limit that can't fill worse than this. */
  readonly limit: Dec | null;
  /** Take-profit trigger price. */
  readonly tp: Dec | null;
  /** Stop-loss trigger price. */
  readonly sl: Dec | null;
}

export interface Config {
  readonly apiKey: string | undefined;
  readonly apiSecret: string | undefined;
  readonly baseUrl: string;
  readonly baseUrlOverridden: boolean;
  readonly wsUrl: string;
  /** What the target's balances are: declared by this app for its default, by you for an override. */
  readonly funds: "play" | "unknown";
  readonly live: boolean;
  readonly bracket: BracketFlags;
  readonly runId: string | null;
  readonly reconcileMs: number;
}

export const USAGE = `bracket-orders: an entry, plus a take-profit and a stop-loss that cancel each other.

Usage:
  npm start -- [bracket] [mode]

Bracket:
  --market ID        market to trade                         default BTC-USDX-PERP
  --side buy|sell    the entry's direction                   default buy
  --size N           entry size, a decimal                   default 0.002
  --limit P          worst price the entry may fill at (IOC). Required with --live.
  --tp P             take-profit trigger price.              Required with --live.
  --sl P             stop-loss trigger price.                Required with --live.

Mode:
  (none)             dry run: reads live data, sends no write of any kind
  --live             place the bracket on testnet and manage it until one exit fills
  --run-id ID        name this run (default: random). The orders' client ids derive from it.
  --help             print this

Ctrl-C while managing leaves the exits resting: the position stays protected.

Credentials come from the environment or .env; see .env.example.`;

function loadDotEnv(): void {
  const envFile = new URL("../.env", import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

function env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

const WHOLE = /^\d+$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function positiveDecimal(flag: string, raw: string): Dec {
  let value: Dec;
  try {
    value = dec.parse(raw);
  } catch {
    throw new ConfigError(`${flag} must be a plain decimal like 0.01, got ${JSON.stringify(raw)}`);
  }
  if (!dec.isPositive(value)) throw new ConfigError(`${flag} must be greater than zero`);
  return value;
}

function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`NEXUS_EXCHANGE_API_URL must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("NEXUS_EXCHANGE_API_URL must be http:// or https://");
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new ConfigError("NEXUS_EXCHANGE_API_URL must be a plain base URL: no query, fragment or userinfo");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api/v1")) {
    throw new ConfigError(
      "NEXUS_EXCHANGE_API_URL is the deployment base and must not include /api/v1, which the client adds. " +
        `Try ${JSON.stringify(`${url.origin}${path.slice(0, -"/api/v1".length)}`)}.`,
    );
  }
  return `${url.origin}${path}`;
}

/**
 * The WebSocket base for a REST base, **keeping the path prefix**.
 *
 * SDK 0.4.0's `Client.wsUrl` is the REST origin with the scheme swapped, and
 * `customNetwork` refuses a `wsUrl` with a path. Against this deployment that
 * gives `wss://api.testnet.nexus.xyz/ws`, which 404s: the stream is under
 * `/indexer`. So it's derived here and handed straight to `createWsClient`,
 * which takes a free-form `url`. Same workaround as `sdk-ts/dead-mans-switch`.
 */
function deriveWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString().replace(/\/+$/, "");
}

function parseWsUrl(raw: string, baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`NEXUS_EXCHANGE_WS_URL must be an absolute ws(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ConfigError("NEXUS_EXCHANGE_WS_URL must be ws:// or wss://");
  }
  // The token is minted over TLS; spending it over clear text would undo that.
  if (url.protocol === "ws:" && baseUrl.startsWith("https:")) {
    throw new ConfigError("NEXUS_EXCHANGE_WS_URL is ws:// while the REST base is https://; use wss://");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Parse the command line.
 *
 * Unknown flags are **refused**, not ignored. `--Live`, `--stop` and
 * `--live=true` would otherwise run a dry run its operator believed was live,
 * or a live bracket without the stop they thought they'd set.
 */
function parseArgs(argv: readonly string[]): { flags: Map<string, string>; live: boolean } {
  if (argv.includes("--help") || argv.includes("-h")) throw new HelpRequested();
  const valued = new Set(["--market", "--side", "--size", "--limit", "--tp", "--sl", "--run-id"]);
  const flags = new Map<string, string>();
  let live = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (!valued.has(arg)) throw new ConfigError(`unrecognised argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ConfigError(`${arg} needs a value`);
    if (flags.has(arg)) throw new ConfigError(`${arg} was given twice`);
    flags.set(arg, value);
    i += 1;
  }
  return { flags, live };
}

function optionalPrice(flags: Map<string, string>, flag: string): Dec | null {
  const raw = flags.get(flag);
  return raw === undefined ? null : positiveDecimal(flag, raw);
}

export function loadConfig(argv: readonly string[]): Config {
  const { flags, live } = parseArgs(argv);
  loadDotEnv();

  const apiKey = env("NEXUS_EXCHANGE_API_KEY");
  const apiSecret = env("NEXUS_EXCHANGE_API_SECRET");
  if ((apiKey === undefined) !== (apiSecret === undefined)) {
    throw new ConfigError(
      "set both NEXUS_EXCHANGE_API_KEY and NEXUS_EXCHANGE_API_SECRET, or neither. " +
        "Half a pair is always a mistake, and it surfaces later as an opaque 401.",
    );
  }

  const rawBase = env("NEXUS_EXCHANGE_API_URL");
  const baseUrl = rawBase === undefined ? TESTNET_BASE_URL : parseBaseUrl(rawBase);
  const rawWs = env("NEXUS_EXCHANGE_WS_URL");
  const wsUrl = rawWs === undefined ? deriveWsUrl(baseUrl) : parseWsUrl(rawWs, baseUrl);
  // A bare URL can't say whose money is behind it. The default is testnet and
  // this app declares it `play`. An override is `unknown` until you say
  // otherwise, and `--live` refuses `unknown`.
  const funds = rawBase === undefined || env("NEXUS_EXCHANGE_FUNDS") === "play" ? "play" : "unknown";

  const rawReconcile = env("NEXUS_BRACKET_RECONCILE_SECONDS");
  let reconcileSeconds = DEFAULT_RECONCILE_SECONDS;
  if (rawReconcile !== undefined) {
    if (!WHOLE.test(rawReconcile) || Number(rawReconcile) < 2 || Number(rawReconcile) > 300) {
      throw new ConfigError(
        `NEXUS_BRACKET_RECONCILE_SECONDS must be a whole number from 2 to 300, got ${JSON.stringify(rawReconcile)}`,
      );
    }
    reconcileSeconds = Number(rawReconcile);
  }

  const runId = flags.get("--run-id") ?? null;
  if (runId !== null && !RUN_ID.test(runId)) {
    throw new ConfigError(`a run id is 1-32 lowercase letters, digits and dashes, got ${JSON.stringify(runId)}`);
  }

  const sideRaw = (flags.get("--side") ?? "buy").toLowerCase();
  if (sideRaw !== "buy" && sideRaw !== "sell") throw new ConfigError(`--side must be buy or sell, got ${JSON.stringify(sideRaw)}`);
  const bracket: BracketFlags = {
    market: flags.get("--market") ?? "BTC-USDX-PERP",
    side: sideRaw === "buy" ? "Buy" : "Sell",
    size: positiveDecimal("--size", flags.get("--size") ?? "0.002"),
    limit: optionalPrice(flags, "--limit"),
    tp: optionalPrice(flags, "--tp"),
    sl: optionalPrice(flags, "--sl"),
  };

  if (live) {
    const missing = (["--limit", "--tp", "--sl"] as const).filter((f) => !flags.has(f));
    if (missing.length > 0) {
      throw new ConfigError(
        `--live needs ${missing.join(", ")}. A live bracket is placed only at prices you chose; ` +
          "the dry run's derived prices are an illustration, not a suggestion.",
      );
    }
    if (apiKey === undefined || apiSecret === undefined) {
      throw new ConfigError("--live places orders, so it needs testnet credentials. Copy .env.example to .env.");
    }
    if (funds !== "play") {
      throw new ConfigError(
        `--live refuses ${baseUrl}: an overridden host is undeclared, and undeclared is not play funds. ` +
          "Set NEXUS_EXCHANGE_FUNDS=play if you know it is a testnet.",
      );
    }
  }

  return {
    apiKey,
    apiSecret,
    baseUrl,
    baseUrlOverridden: rawBase !== undefined,
    wsUrl,
    funds,
    live,
    bracket,
    runId,
    reconcileMs: reconcileSeconds * 1000,
  };
}
