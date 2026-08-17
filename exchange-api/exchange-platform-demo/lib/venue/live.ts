/*
 * Live venue data — the real testnet, read server-side.
 *
 * WHY SERVER-SIDE. The gateway's CORS allowlist admits exactly one local origin
 * spelling (`http://localhost:3000`) — not 127.0.0.1, not port 3001, not a LAN
 * address. A branded venue runs on whatever port and host its operator chose, so
 * a browser call is a coin flip. Reading from a route handler makes host and port
 * stop mattering: there is no `Origin` header on a server-to-server fetch and so
 * no CORS at all. It is also where the venue's key will live once signed routes
 * are wired, so this is the same seam, not a workaround.
 *
 * Every endpoint here is `security: []` in the spec — public market data. No
 * credential is involved and none is needed.
 */

/** The venue API root. Testnet balances are denominated in test USDX. */
export const VENUE_API_BASE =
  process.env.NEXUS_API_BASE?.trim() || "https://exchange.nexus.xyz/api/exchange";

/** One market's public summary, as `GET /markets/summary` returns it. */
export interface MarketSummary {
  market_id: string;
  last_trade_price: number | null;
  engine_mark_price: number | null;
  volume_24h: number | null;
  trade_count: number | null;
  status: string | null;
  open_interest: number | null;
}

/** The venue's own health, as `GET /stats` returns it. */
export interface VenueStats {
  connected: boolean;
  health: string;
  events_per_sec: number | null;
  fills_total: number | null;
  event_ingest_us_avg: number | null;
}

export interface LiveSnapshot {
  markets: MarketSummary[];
  stats: VenueStats | null;
  /** Null when the venue answered; a message when it did not. */
  error: string | null;
  fetchedAtMs: number;
  /** Round-trip to the venue, in ms — the venue's own latency reading. */
  rttMs: number | null;
}

/*
 * A read that fails must look different from a read that returned zero. Every
 * absent figure stays `null` and the caller renders the absence, rather than a
 * confident 0 that means "we could not ask."
 */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(`${VENUE_API_BASE}${path}`, {
    signal,
    headers: { accept: "application/json" },
    /* Live data. Next would otherwise cache this indefinitely at build time. */
    cache: "no-store",
    redirect: "manual",
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read the venue's public state. Never throws — failure is a field, not an exception. */
export async function readLiveSnapshot(): Promise<LiveSnapshot> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const [rawMarkets, rawStats] = await Promise.all([
      getJson<unknown[]>("/markets/summary", controller.signal),
      getJson<Record<string, unknown>>("/stats", controller.signal),
    ]);

    const markets: MarketSummary[] = (rawMarkets ?? []).map((entry) => {
      const m = entry as Record<string, unknown>;
      return {
        market_id: String(m["market_id"] ?? ""),
        last_trade_price: num(m["last_trade_price"]),
        engine_mark_price: num(m["engine_mark_price"]),
        volume_24h: num(m["volume_24h"]),
        trade_count: num(m["trade_count"]),
        status: typeof m["status"] === "string" ? m["status"] : null,
        open_interest: num(m["open_interest"]),
      };
    });

    return {
      markets,
      stats: rawStats
        ? {
            connected: rawStats["connected"] === true,
            health: String(rawStats["health"] ?? "unknown"),
            events_per_sec: num(rawStats["events_per_sec"]),
            fills_total: num(rawStats["fills_total"]),
            event_ingest_us_avg: num(rawStats["event_ingest_us_avg"]),
          }
        : null,
      error: rawMarkets === null ? "the venue refused the market read" : null,
      fetchedAtMs: Date.now(),
      rttMs: Date.now() - started,
    };
  } catch (cause) {
    return {
      markets: [],
      stats: null,
      error: cause instanceof Error ? cause.message : "the venue could not be reached",
      fetchedAtMs: Date.now(),
      rttMs: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
