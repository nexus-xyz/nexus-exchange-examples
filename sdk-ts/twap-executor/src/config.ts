// Configuration, validated before a single request goes out.
//
// The parent order comes from flags, since it's what changes between runs.
// Credentials and the deployment come from the environment, never from a
// committed file.

import { existsSync } from "node:fs";

import * as dec from "./decimal.js";
import type { Dec } from "./decimal.js";
import type { Side } from "./plan.js";

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

/** Fraction of each rate-limit budget this app spends. */
const DEFAULT_UTILISATION = 0.5;

/** Ceilings that keep an example an example. */
const MAX_SLICES = 200;
const MAX_DURATION_SECONDS = 24 * 60 * 60;

export class ConfigError extends Error {}
export class HelpRequested extends Error {}

export interface ParentFlags {
  readonly market: string;
  readonly side: Side;
  readonly size: Dec;
  readonly durationSeconds: number;
  readonly slices: number;
  readonly limit: Dec | null;
}

export interface Config {
  readonly apiKey: string | undefined;
  readonly apiSecret: string | undefined;
  readonly baseUrl: string;
  readonly baseUrlOverridden: boolean;
  /** What the target's balances are: declared by this app for its default, by you for an override. */
  readonly funds: "play" | "unknown";
  readonly utilisation: number;
  readonly live: boolean;
  /** A fresh run's parameters. `null` on `--resume`, where the journal owns them. */
  readonly parent: ParentFlags | null;
  readonly runId: string | null;
  readonly resume: boolean;
  /** Demonstration only: SIGKILL this process right after slice N is sent. */
  readonly killAfter: number | null;
}

export const USAGE = `twap-executor: work one parent order as timed IOC child orders.

Usage:
  npm start -- [parent] [mode]

Parent order (a fresh run):
  --market ID        market to trade             default BTC-USDX-PERP
  --side buy|sell    direction                   default buy
  --size N           total size, a decimal       default 0.006
  --duration S       seconds to work it over     default 60
  --slices N         number of child orders      default 6
  --limit P          worst price any child may trade at. Required with --live.

Mode:
  (none)             dry run: reads live data, sends no write of any kind
  --live             place real IOC orders on testnet
  --run-id ID        name this run (default: random). Child ids derive from it.
  --resume ID        continue run ID from its journal, reconciling against the venue first
  --kill-after N     demonstration: SIGKILL this process right after slice N is sent
  --help             print this

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
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function whole(flag: string, raw: string, min: number, max: number): number {
  if (!WHOLE.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new ConfigError(`${flag} must be a whole number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

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
 * Parse the command line.
 *
 * Unknown flags are **refused**, not ignored. `--Live`, `--limt` and
 * `--live=true` would otherwise run a dry run that its operator believed was
 * live, or worse, a live run without the limit they thought they'd set.
 */
function parseArgs(argv: readonly string[]): {
  flags: Map<string, string>;
  live: boolean;
} {
  if (argv.includes("--help") || argv.includes("-h")) throw new HelpRequested();
  const valued = new Set(["--market", "--side", "--size", "--duration", "--slices", "--limit", "--run-id", "--resume", "--kill-after"]);
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
  // A bare URL can't say whose money is behind it. The default is testnet and
  // this app declares it `play`. An override is `unknown` until you say
  // otherwise, and `--live` refuses `unknown`.
  const funds = rawBase === undefined || env("NEXUS_EXCHANGE_FUNDS") === "play" ? "play" : "unknown";

  const rawUtil = env("NEXUS_TWAP_UTILISATION");
  const utilisation = rawUtil === undefined ? DEFAULT_UTILISATION : Number(rawUtil);
  if (!(utilisation > 0 && utilisation <= 1)) {
    throw new ConfigError(`NEXUS_TWAP_UTILISATION must be in (0, 1], got ${JSON.stringify(rawUtil)}`);
  }

  const resumeId = flags.get("--resume");
  const runIdFlag = flags.get("--run-id");
  const runId = resumeId ?? runIdFlag ?? null;
  if (resumeId !== undefined && runIdFlag !== undefined) {
    throw new ConfigError("--resume already names the run; drop --run-id");
  }
  if (runId !== null && !RUN_ID.test(runId)) {
    throw new ConfigError(`a run id is 1-40 lowercase letters, digits and dashes, got ${JSON.stringify(runId)}`);
  }

  const parentFlags = ["--market", "--side", "--size", "--duration", "--slices", "--limit"];
  let parent: ParentFlags | null = null;
  if (resumeId !== undefined) {
    // The journal holds the parent a run was started with. Accepting new
    // values here would mean resuming a different order under the same child
    // ids, and the venue's dedupe would then answer for the *old* one.
    const given = parentFlags.filter((f) => flags.has(f));
    if (given.length > 0) {
      throw new ConfigError(`--resume continues the run as journaled; ${given.join(", ")} cannot change it`);
    }
  } else {
    const sideRaw = (flags.get("--side") ?? "buy").toLowerCase();
    if (sideRaw !== "buy" && sideRaw !== "sell") throw new ConfigError(`--side must be buy or sell, got ${JSON.stringify(sideRaw)}`);
    const limitRaw = flags.get("--limit");
    parent = {
      market: flags.get("--market") ?? "BTC-USDX-PERP",
      side: sideRaw === "buy" ? "Buy" : "Sell",
      size: positiveDecimal("--size", flags.get("--size") ?? "0.006"),
      durationSeconds: whole("--duration", flags.get("--duration") ?? "60", 1, MAX_DURATION_SECONDS),
      slices: whole("--slices", flags.get("--slices") ?? "6", 1, MAX_SLICES),
      limit: limitRaw === undefined ? null : positiveDecimal("--limit", limitRaw),
    };
    if (live && parent.limit === null) {
      throw new ConfigError(
        "--live needs --limit. A TWAP with no price guard will buy at whatever the book offers for as long as it runs.",
      );
    }
  }

  const killRaw = flags.get("--kill-after");
  const killAfter = killRaw === undefined ? null : whole("--kill-after", killRaw, 0, MAX_SLICES - 1);

  if (live && (apiKey === undefined || apiSecret === undefined)) {
    throw new ConfigError("--live places orders, so it needs testnet credentials. Copy .env.example to .env.");
  }
  if (live && funds !== "play") {
    throw new ConfigError(
      `--live refuses ${baseUrl}: an overridden host is undeclared, and undeclared is not play funds. ` +
        "Set NEXUS_EXCHANGE_FUNDS=play if you know it is a testnet.",
    );
  }

  return {
    apiKey,
    apiSecret,
    baseUrl,
    baseUrlOverridden: rawBase !== undefined,
    funds,
    utilisation,
    live,
    parent,
    runId,
    resume: resumeId !== undefined,
    killAfter,
  };
}
