/*
 * The request tape — what a developer opens when a call fails.
 *
 * IT IS A STRATIFIED SAMPLE, AND IT SAYS SO. The venue proxy serves ~190k
 * requests a day; a console that offered to list them would be offering a
 * scrollbar, not an answer. So successes are sampled thinly and failures
 * thickly — the error-biased sampling every real request inspector does, for the
 * obvious reason that nobody debugs a missing 200.
 *
 * The consequence is stated wherever the tape renders: **counts in this list are
 * not proportional**. A reader who counts failures here and divides by the row
 * count gets an error rate forty times too high. The true rates are the figures
 * in the window row above the table, which come from the full-volume series, and
 * the two sampling rates are printed beside the list rather than implied.
 *
 * The failure rows are drawn from the SAME hourly series the chart plots, so a
 * spike in the chart lands in the hour whose rows are failing. An inspector
 * whose list disagreed with its own chart would be worse than either alone.
 *
 * THERE IS AN INCIDENT IN THE WINDOW, deliberately. A request log drawn from a
 * clean 24 hours is a log nobody can evaluate: every row is a 200, the status
 * chart is a flat band, and the pane looks finished while never having been
 * asked the question it exists for. Eight hours before the console's clock,
 * `POST /api/v1/orders` starts returning 504 for two hours — an upstream
 * timeout, visible as a step in the status series, listed row by row under
 * Errors, and correlated in time with nothing else on the page, which is what
 * makes it worth investigating rather than obvious.
 *
 * Seeded and deterministic off the console clock, so the hourly buckets line up
 * with every other 24h window on the page.
 */

import { CONSOLE_NOW_MS, HOUR_MS, hourStarts, prng } from "./clock";

export interface RequestEntry {
  /** The id the API returns in `x-request-id`. What you quote in a ticket. */
  id: string;
  atMs: number;
  method: string;
  path: string;
  /** Which credential signed it. Public reads carry none. */
  keyId: string | null;
  status: number;
  latencyMs: number;
  /** The machine-readable failure, for anything that is not a 2xx. */
  code: string | null;
}

/** method, path, weight, p50, p99, base error rate, the code it fails with */
const ROUTES: [string, string, number, number, number, number, string][] = [
  /* The failure code on a read is a CLIENT failure — a query that did not parse,
     a market that does not exist. UPSTREAM_TIMEOUT is deliberately absent from
     every row here: it is a 504, it belongs to the incident, and letting a read
     route carry it put 504s in the 4xx allocation below, which is a list that
     contradicts the chart above it. */
  ["GET", "/api/v1/markets/summary", 42, 41, 180, 0.0004, "MALFORMED_QUERY"],
  ["GET", "/api/v1/tickers", 31, 38, 165, 0.0003, "MALFORMED_QUERY"],
  ["POST", "/api/v1/orders", 19, 62, 240, 0.021, "MIN_NOTIONAL"],
  ["GET", "/api/v1/positions", 14, 55, 210, 0.001, "UNAUTHORIZED"],
  ["GET", "/api/v1/fills", 12, 58, 232, 0.0008, "UNAUTHORIZED"],
  ["DELETE", "/api/v1/orders/{id}", 9, 49, 198, 0.012, "ORDER_NOT_FOUND"],
  ["GET", "/api/v1/account/summary", 8, 53, 205, 0.0007, "UNAUTHORIZED"],
  ["PATCH", "/api/v1/orders/{id}", 6, 66, 268, 0.014, "POST_ONLY_WOULD_CROSS"],
  ["GET", "/api/v1/markets/{id}/candles", 4, 71, 320, 0.0011, "UNKNOWN_MARKET"],
  ["POST", "/api/v1/orders/batch", 2, 88, 410, 0.009, "INSUFFICIENT_MARGIN"],
];

/** The HTTP status each failure code is served as. */
const CODE_STATUS: Record<string, number> = {
  MIN_NOTIONAL: 422,
  INSUFFICIENT_MARGIN: 422,
  POST_ONLY_WOULD_CROSS: 422,
  ORDER_NOT_FOUND: 404,
  UNKNOWN_MARKET: 404,
  MALFORMED_QUERY: 400,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  UPSTREAM_TIMEOUT: 504,
};

export const CODE_MEANING: Record<string, string> = {
  MIN_NOTIONAL: "order below the market minimum — never retry unchanged",
  INSUFFICIENT_MARGIN: "the account cannot support the position",
  POST_ONLY_WOULD_CROSS: "a PostOnly order would have taken liquidity",
  ORDER_NOT_FOUND: "already filled, already cancelled, or never existed",
  UNKNOWN_MARKET: "no such market on this network — check the symbol and the environment",
  MALFORMED_QUERY: "a query parameter did not parse; the body was never read",
  UNAUTHORIZED: "signature, timestamp or key — the 401 does not say which, by design",
  RATE_LIMITED: "429 — the key's per-second budget was exhausted",
  UPSTREAM_TIMEOUT: "the exchange did not answer inside the proxy's deadline",
};

/** Keys the tape attributes traffic to, heaviest first. */
const KEYS = ["nx_live_7f3a…", "nx_test_b21c…", "nx_test_44de…"] as const;

/** The incident: `POST /api/v1/orders` times out for two hours. */
const INCIDENT_FROM_MS = CONSOLE_NOW_MS - 9 * HOUR_MS;
const INCIDENT_TO_MS = CONSOLE_NOW_MS - 7 * HOUR_MS;

export const TAPE_TOTAL_24H = 191_600;

/**
 * The two sampling rates.
 *
 * Successes are a fixed number of rows — enough to read, few enough to render —
 * and failures are a rate, because the useful property of a failure list is that
 * its shape follows the failures rather than the page size. Both are exported so
 * the pane can print them: a sample whose rate is not on screen is a sample a
 * reader will treat as a census.
 */
export const SUCCESS_ROWS = 190;
export const FAILURE_ONE_IN = 25;

function percentileLatency(p50: number, p99: number, u: number): number {
  /* A log-normal tail from two percentiles, which is the shape latency has. A
     uniform draw between p50 and p99 would put a quarter of the sample in a
     region a real service almost never visits. */
  const shape = Math.log(p99 / p50) / 2.326;
  const z = Math.sqrt(2) * inverseErf(2 * Math.min(0.9995, Math.max(0.0005, u)) - 1);
  return Math.max(3, Math.round(p50 * Math.exp(shape * z)));
}

/** Enough of an inverse error function for a latency draw. Deterministic. */
function inverseErf(x: number): number {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t * t - ln / a) - t);
}

/** Pick a route, weighted by `by`. Total is passed in so it is computed once. */
function pickRoute(random: () => number, by: (route: (typeof ROUTES)[number]) => number, total: number) {
  let pick = random() * total;
  for (const candidate of ROUTES) {
    pick -= by(candidate);
    if (pick <= 0) return candidate;
  }
  return ROUTES[ROUTES.length - 1]!;
}

/**
 * The tape, newest first.
 *
 * WHY THE FAILURES ARE NOT A COIN FLIP. The first version of this drew a failure
 * per row from each route's error rate and shipped a pane whose entire subject —
 * the Errors tab — was empty, because 260 draws against a ~1.5% blended rate
 * came up zero on this seed. A demonstration of a request inspector that depends
 * on luck to contain a request worth inspecting is not a demonstration.
 *
 * So failures are ALLOCATED rather than sampled: the hourly series is the source
 * of truth for how many there were, and one row is emitted per
 * `FAILURE_ONE_IN` of them, in the hour they belong to. The list therefore
 * always shows the incident, and it always shows it in the right hour — the two
 * properties this pane exists for, neither of which should be probabilistic.
 */
export function recentRequests(): RequestEntry[] {
  const random = prng(0x10c5);
  const series = statusSeries();
  const entries: RequestEntry[] = [];

  const weightTotal = ROUTES.reduce((sum, r) => sum + r[2], 0);
  /* Failures are not distributed like traffic — they are distributed like
     traffic × that route's error rate, which is why `POST /orders` dominates a
     failure list it does not dominate in volume. */
  const failWeight = (route: (typeof ROUTES)[number]) => route[2] * route[5];
  const failWeightTotal = ROUTES.reduce((sum, r) => sum + failWeight(r), 0);

  const id = () => `req_${(0x1000000 + Math.floor(random() * 0xfffffff)).toString(16).slice(0, 10)}`;
  /* The live proxy signs most calls; CI and a laptop sign the rest. Public reads
     carry no credential at all — the cheapest rate-limit headroom a venue can
     buy, and the tape should show it being bought. */
  const signer = (allowPublic: boolean) =>
    allowPublic && random() < 0.34 ? null : KEYS[random() < 0.86 ? 0 : random() < 0.7 ? 1 : 2]!;

  // ── successes: a flat sample, drawn on the diurnal curve ──────────────────
  for (let i = 0; i < SUCCESS_ROWS; i += 1) {
    const u = random();
    const skew = 1 - Math.pow(1 - u, 1.35);
    const atMs = Math.round(CONSOLE_NOW_MS - skew * 24 * HOUR_MS);
    const [method, path, , p50, p99] = pickRoute(random, (r) => r[2], weightTotal);

    entries.push({
      id: id(),
      atMs,
      method,
      path,
      keyId: signer(method === "GET"),
      status: method === "POST" ? 201 : method === "DELETE" ? 204 : 200,
      latencyMs: percentileLatency(p50, p99, random()),
      code: null,
    });
  }

  // ── failures: allocated from the hourly series, one row per FAILURE_ONE_IN ─
  series.hoursMs.forEach((hourMs, h) => {
    const at = () => Math.round(hourMs + random() * HOUR_MS);

    for (let i = 0; i < Math.round((series.server[h] ?? 0) / FAILURE_ONE_IN); i += 1) {
      /* The incident is one route timing out. A 504 is the deadline, not a slow
         success, so its latency is the deadline every time. */
      entries.push({
        id: id(),
        atMs: at(),
        method: "POST",
        path: "/api/v1/orders",
        keyId: KEYS[0]!,
        status: 504,
        latencyMs: 5_000,
        code: "UPSTREAM_TIMEOUT",
      });
    }

    for (let i = 0; i < Math.round((series.client[h] ?? 0) / FAILURE_ONE_IN); i += 1) {
      const route = pickRoute(random, failWeight, failWeightTotal);
      const [method, path, , p50, p99, , code] = route;
      /* About one 4xx in seven is a 429, which is what the venue-level count on
         Keys works out to (168 of ~1,200). The two panes are read within a
         minute of each other and must not disagree about how common that is. */
      const failureCode = random() < 0.14 ? "RATE_LIMITED" : code;

      entries.push({
        id: id(),
        atMs: at(),
        method,
        path,
        /* A 429 is always a signed call — an unsigned public read has no budget
           to exhaust. */
        keyId: failureCode === "RATE_LIMITED" ? KEYS[0]! : signer(false),
        status: CODE_STATUS[failureCode] ?? 400,
        latencyMs: percentileLatency(p50 * 0.6, p99 * 0.6, random()),
        code: failureCode,
      });
    }
  });

  return entries.sort((a, b) => b.atMs - a.atMs);
}

export interface StatusSeries {
  hoursMs: number[];
  labels: string[];
  ok: number[];
  client: number[];
  server: number[];
}

/**
 * Hourly counts by status class, at FULL volume rather than sample volume.
 *
 * The tape above is a sample and the chart is not, because they answer different
 * questions: "how many 5xx were there" must not be a sixth of the truth just
 * because the list under it is. The two are drawn from the same shape, so a spike
 * in the chart lands in the hour whose rows are failing.
 */
export function statusSeries(): StatusSeries {
  const random = prng(0x5ec7);
  const hoursMs = hourStarts(24);

  const ok: number[] = [];
  const client: number[] = [];
  const server: number[] = [];

  for (const ms of hoursMs) {
    const hourOfDay = new Date(ms).getUTCHours();
    const centred = ((hourOfDay - 14 + 36) % 24) - 12;
    const diurnal = 0.42 + 0.58 * Math.exp(-(centred * centred) / 30);
    const total = Math.round((TAPE_TOTAL_24H / 24) * diurnal * (0.88 + random() * 0.24));

    const inIncident = ms >= INCIDENT_FROM_MS && ms < INCIDENT_TO_MS;
    const serverCount = inIncident ? Math.round(total * 0.061) : Math.round(total * 0.0004 * random());
    const clientCount = Math.round(total * (0.008 + random() * 0.004));

    server.push(serverCount);
    client.push(clientCount);
    ok.push(total - serverCount - clientCount);
  }

  return { hoursMs, labels: hoursMs.map((ms) => new Date(ms).toISOString().slice(11, 16)), ok, client, server };
}

/**
 * The latency distribution of the sample, with the p99 bucket marked.
 *
 * Computed from the same rows the table lists rather than from a second model —
 * a histogram that disagrees with the tape beneath it is worse than no histogram,
 * because both look authoritative.
 */
export function latencyDistribution(entries: RequestEntry[]): {
  bins: { label: string; value: number }[];
  p50Ms: number;
  p99Ms: number;
  p99BinIndex: number;
} {
  const width = 25;
  const count = 20;
  const bins = Array.from({ length: count }, (_, i) => ({
    label: i === count - 1 ? `${width * i}+` : `${width * i}ms`,
    value: 0,
  }));

  for (const entry of entries) {
    const index = Math.min(count - 1, Math.floor(entry.latencyMs / width));
    bins[index]!.value += 1;
  }

  const sorted = [...entries].map((e) => e.latencyMs).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const p99Ms = at(0.99);

  return {
    bins,
    p50Ms: at(0.5),
    p99Ms,
    p99BinIndex: Math.min(count - 1, Math.floor(p99Ms / width)),
  };
}

/** Failures in the window, grouped by code — what to fix, in order. */
export function errorCodeCounts(entries: RequestEntry[]): { code: string; count: number; meaning: string }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.code) continue;
    counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count, meaning: CODE_MEANING[code] ?? "" }))
    .sort((a, b) => b.count - a.count);
}
