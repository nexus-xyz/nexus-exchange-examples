// Copy-to-start stub for a TypeScript example on the Nexus Exchange.
//
// It does the two things nearly every example needs — read public market data,
// then optionally make an authenticated call — and nothing else. Replace the
// body with your app; keep the shape.
//
// Run with:  npm install && npm start

import { Client, ApiError, TransportError } from "@nexus-xyz/exchange-ts";

// Credentials are optional here on purpose: the public market-data section runs
// without them, so a reader gets output before doing any setup. Read them from
// the environment — never from a committed file.
const apiKey = process.env.NEXUS_EXCHANGE_API_KEY;
const apiSecret = process.env.NEXUS_EXCHANGE_API_SECRET;

// Which deployment to talk to.
//
// The pinned SDK (0.1.0) exposes `Network.Stable | Beta | Local` and defaults to
// Stable — it has no `Testnet` member, so an example on this version can't select
// a testnet by name. Its Stable host doesn't currently serve `/api/v1` either, so
// this stub takes the host explicitly and leaves the SDK default as a fallback.
// Set NEXUS_EXCHANGE_API_URL to the API base you've been given.
const baseUrl = process.env.NEXUS_EXCHANGE_API_URL;

const client = new Client({
  apiKey,
  apiSecret,
  ...(baseUrl ? { baseUrl } : {}),
});

try {
  // --- Public market data (no credentials needed) ----------------------------

  const summaries = await client.fetchMarketSummaries();
  console.log(`${summaries.length} markets`);

  const first = summaries[0];
  if (!first) {
    console.log("No markets returned — nothing else to show.");
    process.exit(0);
  }

  const ticker = await client.fetchTicker(first.market_id);
  console.log(
    `${first.market_id}: last=${ticker.last} mark=${ticker.markPrice}`,
  );

  const book = await client.fetchOrderBook(first.market_id);
  console.log(
    `top of book: bid=${book.bids[0]?.[0] ?? "—"} ask=${book.asks[0]?.[0] ?? "—"}`,
  );

  // --- Authenticated call (skipped without credentials) ---------------------

  // Degrade gracefully rather than throwing: an example that dies on a missing
  // key teaches nothing, and CI builds without credentials.
  if (!apiKey || !apiSecret) {
    console.log(
      "\nNo credentials set — skipping the authenticated call." +
        "\nCopy .env.example to .env and add an API key to see it.",
    );
    process.exit(0);
  }

  const account = await client.getAccount();
  console.log(
    `\nAccount: equity=${account.equity} balance=${account.balance} ` +
      `positions=${account.positions.length}`,
  );
} catch (error) {
  // A wrong or unreachable host is the overwhelmingly common first-run failure,
  // and a raw stack trace doesn't tell a reader what to do about it. Say it
  // plainly instead.
  if (error instanceof ApiError || error instanceof TransportError) {
    // Error bodies can be a whole HTML error page; one line is all a reader needs.
    const detail = error.message.replace(/\s+/g, " ").slice(0, 120);
    console.error(
      `\nCouldn't reach the Exchange API at ${baseUrl ?? "the SDK's default host"}.` +
        `\n  ${detail}…` +
        "\n\nSet NEXUS_EXCHANGE_API_URL to the API base URL you've been given" +
        "\n(for example: NEXUS_EXCHANGE_API_URL=https://<host>/api/v1 npm start).",
    );
    process.exit(1);
  }
  throw error;
}
