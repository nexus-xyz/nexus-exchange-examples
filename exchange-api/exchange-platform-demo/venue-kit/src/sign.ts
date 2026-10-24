/*
 * HMAC request signing. Server-side only — this module must never reach a bundle.
 *
 * WHOSE KEY THIS SIGNS WITH. Not the venue's, on the order path — a trader's
 * browser signs with its own delegated key, which can place and cancel orders and
 * cannot withdraw or transfer. That asymmetry is what makes it safe to put a
 * trading credential where a withdrawal credential must never go. The venue
 * holds nothing.
 *
 * This module is the server-side half: the Enterprise branded API, where a
 * partner does hold a key of its own and signs for its callers (`venue.ts`).
 *
 * THE CANONICAL STRING, taken from the server that verifies it — the exchange's
 * own auth-signing implementation — rather than from any client:
 *
 *     <timestamp_ms>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
 *
 * Five lines for a direct caller. There is a six-line variant with a trailing
 * client-IP line, but that one is for gateway keys multiplexing many users —
 * a branded-API proxy holding its own key is a direct caller and signs five.
 *
 * Three details that are each a 401 if you get them wrong:
 *   • `path` is the FULL path the server sees, prefix included (`/api/v1/orders`),
 *     not a stripped one.
 *   • the secret is hex — decode it to 32 bytes before use; signing with the
 *     hex *text* silently produces a valid-looking, always-rejected signature.
 *   • an empty body still contributes `sha256hex("")`, and an empty query is
 *     the empty string. Neither line is omitted.
 *
 * The key is network-scoped but the signature is not: the canonical string has
 * no network component, so a signed request is byte-identical on every host.
 * Only the key store differs. Sign for the host that minted the key and never
 * replay against another network.
 */

import { createHash, createHmac } from "node:crypto";

/** Server clock tolerance is 30s; this is the margin a caller should stay inside. */
export const TIMESTAMP_TOLERANCE_MS = 30_000;

export interface SigningKey {
  /** Key id, e.g. `nx_a1b2c3…`. Sent in the clear. */
  readonly keyId: string;
  /** 32-byte secret, hex-encoded — as returned once by `POST /keys`. */
  readonly secretHex: string;
}

export interface SignableRequest {
  readonly method: string;
  /** Full path including any prefix the server serves under. */
  readonly path: string;
  /** Query string without the leading `?`. Empty when there is none. */
  readonly query?: string;
  /** Serialised body, or empty for a GET. */
  readonly body?: string;
  /** Unix ms. Injected so tests are deterministic. */
  readonly timestampMs: number;
}

/** Build the exact string the server will rebuild and verify against. */
export function canonicalString(request: SignableRequest): string {
  const bodyHash = createHash("sha256")
    .update(request.body ?? "", "utf8")
    .digest("hex");
  return [
    String(request.timestampMs),
    request.method.toUpperCase(),
    request.path,
    request.query ?? "",
    bodyHash,
  ].join("\n");
}

/**
 * Decode the secret. Strict on length: a 31-byte or 33-byte secret is a
 * configuration error that would otherwise surface as an opaque 401 hours later.
 */
function decodeSecret(secretHex: string): Buffer {
  const normalised = secretHex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error("API secret must be 32 bytes, hex-encoded (64 hex characters)");
  }
  return Buffer.from(normalised, "hex");
}

/** The three headers an authenticated request carries. */
export function signHeaders(key: SigningKey, request: SignableRequest): Record<string, string> {
  const signature = createHmac("sha256", decodeSecret(key.secretHex))
    .update(canonicalString(request), "utf8")
    .digest("hex");

  return {
    "x-api-key": key.keyId,
    "x-timestamp": String(request.timestampMs),
    "x-signature": signature,
  };
}
