/*
 * The data phase — whether the panels have their first response yet.
 *
 * WHY THIS EXISTS
 *
 * `components/terminal/states.tsx` is a complete state layer: LoadingState,
 * LoadingFigure, ErrorState, StaleBadge, AbsentValue, and a TableState dispatcher
 * that fixes the precedence between them. It is careful work — it argues, correctly,
 * that skeleton rows in a numeric table are a lie, that "No open positions" during a
 * 503 is a lie, and that a bar measured in `ch` does not shift the layout when the
 * number lands.
 *
 * None of it had ever rendered.
 *
 * Every panel takes fixtures that are non-empty by construction, `TableState` is
 * called with `count` and neither `loading` nor `error`, and `LoadingState`,
 * `LoadingFigure` and `ErrorState` had no call sites at all. The layer existed in the
 * repository and not in the app: never painted, never captured, never graded, and
 * free to rot. That is the same defect class as a capture filed under a name it does
 * not show — a thing we believe we have because it is written down.
 *
 * So the phase is a URL parameter, for the reason every other piece of state here is:
 * addressable state is gradeable state. `?load=cold` is a real screen a reader can
 * open, link to, and file a bug against, and the harness captures it like any other.
 *
 * WHAT THE PHASES ARE
 *
 *   ready  → the response landed. The default, and therefore absent from the URL.
 *   cold   → first load in flight. No data exists yet, so panels render their
 *            loading state rather than an empty one. This is NOT the same as empty
 *            and the distinction is the entire point of the state layer.
 *   error  → the upstream failed. Panels name the endpoint and the status, because
 *            `GET /positions · 503` is a bug report and a sad face is not.
 *
 * There is deliberately no `stale` phase yet. Stale is per-field freshness and
 * already has its own vocabulary in lib/api/absence.ts; folding it in here would
 * imply the whole terminal goes stale at once, which is not how a feed degrades.
 *
 * WHAT WAITS, AND WHAT DOES NOT
 *
 * The rule is REGISTRY VERSUS MEASUREMENT, and it is worth stating because the first
 * pass got it wrong in both directions.
 *
 * Registry renders immediately: the market list, the symbol, its max leverage, its
 * tick size, the fee schedule, column headers, tab labels. These are configuration —
 * the app has them before it asks the venue anything, and blanking them would make a
 * cold start look like a broken app rather than a loading one.
 *
 * Measurement waits: prices, sizes, depth, the tape, candles, balances, positions,
 * open orders, funding, and every count derived from them. These are answers to
 * questions, and a fixture painted while the question is still in flight is the one
 * thing a terminal must never do.
 *
 * The tell that a surface is on the wrong side: a tab reading `Positions (3)` above a
 * table reading "Loading". The count is a measurement wearing structure's clothes.
 *
 * WHAT THIS IS NOT
 *
 * Not a loading simulator. Nothing spins for 800ms to look busy, nothing jitters, and
 * no duration is claimed anywhere — the phase is an INPUT, held still, so a screenshot
 * of it means something. When these panels are wired to the real API the phase comes
 * from the fetch layer instead of the URL and every consumer below is unchanged.
 *
 * Duration is also not the observable. What latency does to a UI is produce ORDERINGS
 * and PARTIAL STATES — the book is up while the account is not — and that is what is
 * modelled here. Milliseconds only answer "does it feel slow", which a mock cannot
 * honestly assert and a specification does not need.
 *
 * ── PER SURFACE, NOT GLOBAL ─────────────────────────────────────────────────
 *
 * The first version of this file took an `endpoint` argument at twelve call sites and
 * IGNORED IT. The route was used to label the error string and nothing else; every
 * surface resolved off one global phase, so `?load=error` blanked the entire terminal
 * at once.
 *
 * That is the opposite of the contract this repository already states. AGENTS.md rule
 * 9: a per-entry upstream failure surfaces on the affected entry rather than failing
 * the snapshot, and the aggregate stays 200 as long as one upstream succeeded. A
 * single flag that blanks twelve panels is precisely the failure model that rule
 * exists to forbid.
 *
 * It is also the third time on this project that a value has been computed and then
 * not consulted — `TableState` was called with `count` and not `loading`; the visual
 * floor computed an exact pixel diff and let a coarse fingerprint decide. A parameter
 * threaded through twelve call sites and ignored is worse than one never added,
 * because every call site looks correct.
 *
 * ── THE SURFACES ────────────────────────────────────────────────────────────
 *
 * Twelve routes, but not twelve loading regions: `/v1/orders` and `/v1/positions` are
 * one blotter behind one fetch, and pretending otherwise would specify a granularity
 * no implementation will have. FOUR regions, and the split that matters is the first
 * one — PUBLIC versus PRIVATE. Market data is cacheable and needs no session; account
 * data is behind an auth round trip. Every venue loads them at different times, and
 * the state a visitor actually sees is "market data up, account pending".
 *
 * THERE IS NO `registry` REGION, and there was one for about ten minutes. The market
 * list, tick sizes and leverage caps are a build-time fixture here — `GET /markets`
 * is never actually called — so a region for it would have had no consumer, no way to
 * fail, and no way to be graded. That is the same "declared and never implemented"
 * pattern as `enum-fidelity` sitting in floor.json for months and the endpoint
 * parameter this file threaded through twelve call sites and ignored. When the
 * registry becomes a real fetch it gets a region; until then it does not get one for
 * looking tidy. `audit/scripts/state.mjs` is what caught it.
 */

import { createContext, useContext } from "react";

/**
 * The independent loading regions. This list is a DESIGN DECISION, not an inventory —
 * it says which parts of this app must be able to render without waiting for each
 * other, which is the thing an engineer implementing it has to know.
 */
export const SURFACES = ["market", "account", "history", "activity"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * Route → region. Every endpoint named at a `usePhase` call site appears here, and
 * `audit/scripts/state.mjs` fails if one does not — a route with no region would
 * silently resolve to the default and be ungradeable, which is the whole defect this
 * file was rewritten to fix.
 */
export const SURFACE_OF: Readonly<Record<string, Surface>> = {
  "/v1/book": "market",
  "/v1/trades": "market",
  "/v1/candles": "market",
  "/v1/account": "account",
  "/v1/balances": "account",
  "/v1/positions": "account",
  "/v1/orders": "account",
  "/v1/twap": "account",
  "/v1/orders/history": "history",
  "/v1/fills": "history",
  "/v1/funding/history": "history",
  "/v1/activity": "activity",
};

export const PHASES = ["ready", "cold", "error"] as const;
export type DataPhase = (typeof PHASES)[number];

export const isPhase = (v: unknown): v is DataPhase =>
  typeof v === "string" && (PHASES as readonly string[]).includes(v);

/** What every surface is doing. Absent keys are `ready`. */
export type PhaseMap = Partial<Record<Surface, DataPhase>>;

/*
 * PRESETS — the load states worth arguing about, named.
 *
 * The specification lives in these three. The free-form syntax below exists so a
 * reviewer can construct the odd case without us pre-enumerating a cross product of
 * three states across five surfaces.
 */
export const PRESETS: Readonly<Record<string, PhaseMap>> = {
  /** First paint. Nothing has answered. */
  cold: { market: "cold", account: "cold", history: "cold", activity: "cold" },
  /**
   * THE ONE THAT MATTERS. Market data is up, the account is not — cached public data
   * against an auth round trip, which is what every visitor sees and what the trade
   * screen must remain fully useful under.
   */
  public: { account: "cold", history: "cold", activity: "cold" },
  /**
   * One upstream is down and the rest are fine. Rule 9 made visible: the panels that
   * have data keep it, and only the failed region says so.
   */
  degraded: { account: "error" },
  /** Everything failed. Kept because it was the old `?load=error` and links exist. */
  error: { market: "error", account: "error", history: "error", activity: "error" },
};

/**
 * `?load=` → a phase map.
 *
 * Accepts a preset name (`cold`, `public`, `degraded`, `error`) or an explicit list
 * (`market:cold,account:error`). Tolerant: an unknown surface or phase is skipped
 * rather than rejected, because these get typed by hand into a review comment.
 */
export function parseLoad(raw: string | undefined): PhaseMap {
  if (!raw) return {};
  if (PRESETS[raw]) return PRESETS[raw];
  const out: PhaseMap = {};
  for (const part of raw.split(",")) {
    const [s, p] = part.split(":").map((x) => x.trim());
    if ((SURFACES as readonly string[]).includes(s) && isPhase(p)) out[s as Surface] = p;
  }
  return out;
}

/** A phase map back to the shortest `?load=` that produces it. */
export function encodeLoad(map: PhaseMap): string {
  const entries = SURFACES.filter((s) => map[s] && map[s] !== "ready").map((s) => `${s}:${map[s]}`);
  if (!entries.length) return "";
  for (const [name, preset] of Object.entries(PRESETS)) {
    const p = SURFACES.filter((s) => preset[s] && preset[s] !== "ready").map((s) => `${s}:${preset[s]}`);
    if (p.length === entries.length && p.every((x, i) => x === entries[i])) return name;
  }
  return entries.join(",");
}

const PhaseContext = createContext<PhaseMap>({});

export const DataPhaseProvider = PhaseContext.Provider;

/**
 * The phase for one route.
 *
 * `endpoint` is no longer decoration. It selects the region, and it still names the
 * failure — `GET /positions · 503` is a bug report, a sad face is not.
 */
export function usePhase(endpoint?: string) {
  const map = useContext(PhaseContext);
  const surface = endpoint ? SURFACE_OF[endpoint] : undefined;
  /* An unmapped route resolves to `ready` rather than to some global default. A
     surface nobody classified must not silently inherit another one's failure. */
  const phase: DataPhase = (surface && map[surface]) || "ready";
  return {
    phase,
    loading: phase === "cold",
    error:
      phase === "error"
        ? { message: "Could not reach the venue", endpoint, status: 503 }
        : null,
  };
}

/**
 * For a component that renders one region directly rather than a named route.
 *
 * Defaults to `account`, which is what every current caller is: the blotter tab
 * counts, the stat cells, the ticket's buying power.
 */
export function useDataPhase(surface: Surface = "account"): DataPhase {
  return useContext(PhaseContext)[surface] ?? "ready";
}
