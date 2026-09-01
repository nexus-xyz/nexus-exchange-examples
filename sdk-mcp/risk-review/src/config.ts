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
  /**
   * The network name handed to the MCP server.
   *
   * `custom` when a base URL is given: the server selects a deployment by name,
   * and a URL without a name is a target nobody has described.
   */
  readonly network: "testnet" | "custom";
  readonly baseUrl: string | undefined;
  readonly limits: Limits;
}

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

export function loadConfig(): Config {
  loadDotEnv();

  const apiKey = env("NEXUS_EXCHANGE_API_KEY");
  const apiSecret = env("NEXUS_EXCHANGE_API_SECRET");
  // Half a credential pair is always a mistake — a typo'd variable name, a
  // `.env` copied from elsewhere — and left alone it surfaces as an opaque 401
  // long after the cause.
  if (apiKey === undefined || apiSecret === undefined) {
    throw new ConfigError(
      "this example reviews your account, so it needs both " +
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
      "no limits configured, so there is nothing to review. Set at least one of " +
        "NEXUS_GUARD_MAX_NOTIONAL, NEXUS_GUARD_MAX_LOSS or " +
        "NEXUS_GUARD_MIN_AVAILABLE_MARGIN — see .env.example.",
    );
  }

  const baseUrl = env("NEXUS_EXCHANGE_API_URL");
  return {
    apiKey,
    apiSecret,
    network: baseUrl === undefined ? "testnet" : "custom",
    baseUrl,
    limits,
  };
}
