// Offline tests for `parseClosed` under both wire spellings of
// `GET /positions/closed`: the v0.8.1 names the published spec documents, and
// the CCXT names spec 0.9.74 serves instead (ENG-16850). No network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fromString, toString } from "./decimal.js";
import { parseClosed, TypeWatch } from "./wire.js";

const CLOSED_AT = 1_760_000_000_000;

/** A `ClosedPosition` row as spec v0.8.1 names it. */
const LEGACY = {
  market_id: "BTC-USDX-PERP",
  side: "Long",
  size: "0.5",
  entry_price: "60000.0",
  exit_price: "61000.0",
  realized_pnl: "500.0",
  closed_at_ms: CLOSED_AT,
};

/** The same row as spec 0.9.74 names it, on CCXT's unified `Position`. */
const CCXT = {
  symbol: "BTC-USDX-PERP",
  side: "Long",
  size: "0.5",
  entryPrice: "60000.0",
  // On a CLOSED position this is the exit price, not the market's last trade.
  lastPrice: "61000.0",
  realizedPnl: "500.0",
  lastUpdateTimestamp: CLOSED_AT,
};

function plain(raw: unknown) {
  const row = parseClosed(new TypeWatch(), raw);
  return {
    marketId: row.marketId,
    side: row.side,
    size: row.size && toString(row.size),
    entryPrice: row.entryPrice && toString(row.entryPrice),
    exitPrice: row.exitPrice && toString(row.exitPrice),
    realizedPnl: toString(row.realizedPnl),
    closedAtMs: row.closedAtMs,
  };
}

describe("parseClosed", () => {
  it("reads the v0.8.1 spelling", () => {
    const row = plain(LEGACY);
    assert.deepEqual(row, {
      marketId: "BTC-USDX-PERP",
      side: "Long",
      size: toString(fromString("0.5")),
      entryPrice: toString(fromString("60000.0")),
      exitPrice: toString(fromString("61000.0")),
      realizedPnl: toString(fromString("500.0")),
      closedAtMs: CLOSED_AT,
    });
  });

  it("reads the 0.9.74 CCXT spelling to the same values", () => {
    assert.deepEqual(plain(CCXT), plain(LEGACY));
  });

  it("maps lastPrice onto exitPrice", () => {
    const ccxt = parseClosed(new TypeWatch(), { ...CCXT, entryPrice: undefined });
    assert.ok(ccxt.exitPrice !== null);
    assert.equal(toString(ccxt.exitPrice), toString(fromString("61000.0")));
    assert.equal(ccxt.entryPrice, null);
  });

  it("prefers the v0.8.1 name when a row carries both", () => {
    const both = {
      ...CCXT,
      ...LEGACY,
      symbol: "ETH-USDX-PERP",
      entryPrice: "1.0",
      lastPrice: "2.0",
      realizedPnl: "3.0",
      lastUpdateTimestamp: 1,
    };
    assert.deepEqual(plain(both), plain(LEGACY));
  });

  it("falls back to the CCXT name when the v0.8.1 one is null", () => {
    assert.deepEqual(plain({ ...CCXT, realized_pnl: null, closed_at_ms: null }), plain(LEGACY));
  });

  it("reports type fidelity under the spelling that was read", () => {
    const watch = new TypeWatch();
    parseClosed(watch, { ...CCXT, realizedPnl: 500 });
    assert.deepEqual(
      watch.divergent().map((o) => o.field),
      ["ClosedPosition.realizedPnl"],
    );
  });

  it("still refuses a row carrying neither spelling of realized P&L, naming the v0.8.1 field", () => {
    const { realizedPnl: _, ...rest } = CCXT;
    assert.throws(() => parseClosed(new TypeWatch(), rest), /realized_pnl/);
  });
});
