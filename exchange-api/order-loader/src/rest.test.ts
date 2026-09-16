// One regression test, for one bug that disabled the app against every
// deployment but the one it was developed on.
//
// `wirePath` composes the left-hand side of `rest.ts`'s signing guard: the
// pathname a request is *expected* to carry, compared against what the URL
// parser actually produces. If the two disagree the request is refused before
// it is sent, because a signature over a path the server never sees fails as a
// bare `401` that looks exactly like a bad secret.
//
// The bug: composing it as `new URL(base).pathname + path` yields
// `//api/v1/...` for a base with no path prefix, since that `pathname` is `/`
// and `path` already starts with one. Against
// `https://api.testnet.nexus.xyz/indexer` the prefix is `/indexer` and the
// concatenation comes out right, so it looked correct; against a loopback
// venue or the bare host it fired on every single request.
//
// The invariant worth asserting is not a fixed string, it is *agreement with
// the URL parser* — that is what the guard actually compares — so every case
// below checks both.

import assert from "node:assert/strict";
import { test } from "node:test";

import { wirePath } from "./rest.js";

const PATHS = ["/api/v1/orders/batch", "/api/v1/account/rate-limit", "/ws/token"];

const BASES: ReadonlyArray<readonly [string, string]> = [
  // The deployment this example targets: a base that carries a route prefix.
  ["https://api.testnet.nexus.xyz/indexer", "/indexer"],
  // The regression case. No path prefix at all, so `pathname` is `/`.
  ["http://127.0.0.1:9090", ""],
  // The bare testnet host — same shape, and the one a reader most easily
  // reaches for by trimming the prefix off the default.
  ["https://api.testnet.nexus.xyz", ""],
  // `config.ts` strips a trailing slash before this is ever called, but the
  // function must not depend on that having happened.
  ["http://localhost:8080/", ""],
  ["https://example.test/gateway/", "/gateway"],
];

test("wirePath agrees with the URL parser for every base shape", () => {
  for (const [base, prefix] of BASES) {
    for (const path of PATHS) {
      const expected = wirePath(base, path);
      assert.equal(
        expected,
        `${prefix}${path}`,
        `${base} + ${path} should compose to ${prefix}${path}`,
      );
      // The guard compares against this. Disagreement is what disabled the app.
      assert.equal(
        expected,
        new URL(`${base.replace(/\/+$/, "")}${path}`).pathname,
        `${base} + ${path} must equal what the URL parser sends on the wire`,
      );
      assert.ok(
        !expected.startsWith("//"),
        `${base} + ${path} produced a doubled leading slash: ${expected}`,
      );
    }
  }
});
