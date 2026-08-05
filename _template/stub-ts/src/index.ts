// Copy-to-start stub for a TypeScript example on the Nexus Exchange.
//
// It does the two things nearly every example needs — read public market data,
// then optionally make an authenticated call — and nothing else. Replace the
// body with your app; keep the shape.
//
// Run with:  npm install && npm start

import {
  Client,
  Network,
  ApiError,
  TransportError,
} from "@nexus-xyz/exchange-ts";

// Credentials are optional here on purpose: the public market-data section runs
// without them, so a reader gets output before doing any setup. Read them from
// the environment — never from a committed file.
const apiKey = process.env.NEXUS_EXCHANGE_API_KEY;
const apiSecret = process.env.NEXUS_EXCHANGE_API_SECRET;

// Testnet: play funds, faucet-credited USDX, no real-world value. It's the SDK
// default, but naming it makes the example's posture explicit rather than
// implied — an example should never leave a reader guessing whose money it
// moves. `Network.Mainnet` deliberately throws in this SDK version.
//
// NEXUS_EXCHANGE_API_URL overrides the host when you need a specific deployment
// (a local stack, or a testnet host other than the SDK's default).
const baseUrl = process.env.NEXUS_EXCHANGE_API_URL;

const client = new Client({
  network: Network.Testnet,
  apiKey,
  apiSecret,
  ...(baseUrl ? { baseUrl } : {}),
});

try {
  // --- Public market data (no credentials needed) ----------------------------

  const summaries = await client.fetchMarketSummaries();
  console.log(`${summaries.length} markets on testnet`);

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
        "\nCopy .env.example to .env and add a testnet key to see it.",
    );
    process.exit(0);
  }

  const account = await client.getAccount();
  console.log(
    `\nAccount: equity=${account.equity} balance=${account.balance} ` +
      `positions=${account.positions.length}`,
  );
} catch (error) {
  // An unreachable host is the overwhelmingly common first-run failure, and a
  // raw stack trace doesn't tell a reader what to do about it. Say it plainly.
  if (error instanceof ApiError || error instanceof TransportError) {
    // Error bodies can be a whole HTML error page; one line is all a reader needs.
    const detail = error.message.replace(/\s+/g, " ").slice(0, 120);
    console.error(
      `\nCouldn't reach the Exchange API at ${baseUrl ?? "the testnet default host"}.` +
        `\n  ${detail}…` +
        "\n\nIf the default host isn't serving the API for you, point the example" +
        "\nsomewhere else with NEXUS_EXCHANGE_API_URL=https://<host>/api/v1 npm start.",
    );
    process.exit(1);
  }
  throw error;
}
