// HMAC-SHA256 request signing, by hand.
//
// This is the whole of the Exchange's authentication scheme, and writing it out
// is half the point of a no-SDK example. Three headers, one canonical string:
//
//     <timestamp_ms>\n<METHOD>\n<path>\n<query>\n<sha256hex(body)>
//
// HMAC-SHA256 that string with the **hex-decoded** secret, hex-encode the
// result, and send it as `x-signature` alongside `x-api-key` and `x-timestamp`.
// No trailing newline. An empty query is the empty string; an empty body still
// contributes `sha256hex("")`.
//
// Three traps, each of which produces an indistinguishable `401`:
//
//  1. **The secret is hex, and it is the decoded bytes that key the HMAC.**
//     Signing with the ASCII of the hex string is the classic mistake and it
//     verifies against nothing.
//
//  2. **`<path>` is the path the *indexer* verifies, not the path in your
//     URL.** The `/api/exchange` gateway strips its own prefix before the
//     request reaches the service that checks the signature, so a request sent
//     to `https://exchange.nexus.xyz/api/exchange/api/v1/orders` is verified as
//     `/api/v1/orders`. Sign what the indexer sees. `rest.ts` keeps the two
//     halves — the signed path and the sent URL — derived from one value each,
//     so they cannot drift apart.
//
//  3. **`<query>` must be the exact bytes on the wire.** Percent-encoding is
//     not canonicalised anywhere: if you build the query string once for the
//     signature and let a URL library re-encode it for the request, any
//     disagreement about which characters need escaping breaks the signature.
//     `rest.ts` builds it once and uses the same string for both.

import { createHash, createHmac } from "node:crypto";

/** Lower-case hex SHA-256 of a byte string. */
export function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Decode a hex secret to the bytes that key the HMAC.
 *
 * Rejects malformed input instead of truncating at the first bad character —
 * a mis-decoded secret signs perfectly well and fails only at the server, with
 * a `401` that says nothing about why. The error deliberately does not echo the
 * value: it is the credential.
 */
export function decodeSecret(secretHex: string): Buffer {
  if (secretHex.length === 0 || secretHex.length % 2 !== 0) {
    throw new Error("API secret must be a non-empty, even-length hex string");
  }
  if (!/^[0-9a-fA-F]+$/.test(secretHex)) {
    throw new Error("API secret must be hex characters only");
  }
  return Buffer.from(secretHex, "hex");
}

export interface SignedHeaders {
  "x-api-key": string;
  "x-timestamp": string;
  "x-signature": string;
}

/**
 * Build the three authentication headers for one request.
 *
 * `path` is the indexer-visible path (see trap 2 above), `query` the exact
 * encoded query string with no leading `?`, and `body` the exact bytes being
 * sent — for a bodyless request, an empty buffer, which still hashes.
 *
 * `timestampMs` must be within **30 seconds** of the server's clock or the
 * signature is refused as a replay. That window is the reason `rest.ts` reads
 * the server's `Date` header and reports skew: a machine with a drifting clock
 * fails every signed call with a `401` that looks exactly like a bad secret.
 */
export function signRequest(
  apiKey: string,
  secret: Buffer,
  method: string,
  path: string,
  query: string,
  body: Uint8Array,
  timestampMs: number,
): SignedHeaders {
  const timestamp = String(timestampMs);
  const canonical = [
    timestamp,
    method.toUpperCase(),
    path,
    query,
    sha256Hex(body),
  ].join("\n");

  return {
    "x-api-key": apiKey,
    "x-timestamp": timestamp,
    "x-signature": createHmac("sha256", secret).update(canonical).digest("hex"),
  };
}
