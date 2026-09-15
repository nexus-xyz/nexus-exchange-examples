// Building the client, and turning SDK failures into one readable line.
//
// Shared by the supervisor and the session it spawns, because both talk to the
// same deployment and must describe it the same way. A second, subtly different
// client in the child would be the easiest way to end up demonstrating
// something other than what the parent reported.

import {
  ApiError,
  Client,
  NexusExchangeError,
  TransportError,
  customNetwork,
} from "@nexus-xyz/exchange-ts";

import { ConfigError } from "./config.js";
import type { Config } from "./config.js";

/**
 * Per-*attempt* ceiling. Short enough to fail, generous enough for a cold TLS
 * handshake.
 */
export const REQUEST_TIMEOUT_MS = 5_000;

/** Retries after the first attempt. The SDK's own default is 2. */
export const MAX_RETRIES = 1;

/**
 * Build the client for the configured deployment.
 *
 * The target goes through `customNetwork` rather than the deprecated bare
 * `baseUrl`, because a URL on its own cannot say what the target moves: the
 * descriptor carries `funds` alongside the transport, so no guardrail can read
 * a play-funds classification off a client pointed somewhere else.
 *
 * The default base is declared `"play"` — it is testnet, named as such, and
 * this example is the thing declaring it. An override is `"unknown"`, because a
 * bare URL from an environment variable cannot say whose money is behind it and
 * this app is not going to guess on the reader's behalf. That difference is
 * printed on the app's first line.
 */
export function buildClient(config: Config): Client {
  let network;
  try {
    network = customNetwork({
      label: config.baseUrlOverridden ? "custom" : "testnet",
      baseUrl: config.baseUrl,
      funds: config.baseUrlOverridden ? "unknown" : "play",
    });
  } catch (error) {
    // `NEXUS_EXCHANGE_API_URL` is the one setting `config.ts` cannot fully
    // check on its own — the rules for a base URL belong to the SDK. A bare
    // `NexusExchangeError` is neither an `ApiError` nor a `TransportError`, so
    // left alone it escapes as an unhandled rejection and a stack trace.
    // Reclassifying it here puts it back where every other bad setting is
    // reported.
    throw new ConfigError(
      `NEXUS_EXCHANGE_API_URL was rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return new Client({
    network,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    timeoutMs: REQUEST_TIMEOUT_MS,
    retry: { maxRetries: MAX_RETRIES },
  });
}

/** One readable line from anything throwable, with whitespace collapsed. */
export function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

/**
 * Whether an error is worth another attempt.
 *
 * The SDK classifies this for us on `NexusExchangeError.transient`, the same
 * flag its own retry layer uses. Used only by the watch loop, where a single
 * failed poll must not be read as "the order is gone".
 */
export function isTransient(error: unknown): boolean {
  return error instanceof NexusExchangeError && error.transient;
}

/** True for the errors that mean "the venue was reached and said no". */
export function isVenueError(error: unknown): boolean {
  return error instanceof ApiError || error instanceof TransportError;
}
