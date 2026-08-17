import { useMemo } from "react";
import { buildFeed, type Feed } from "@/lib/feed";
import { getMarket } from "@/lib/markets";

/**
 * A feed per market the account has exposure to.
 *
 * This started life as `usePositionMarks` inside `Blotter.tsx`, returning a
 * `Map<string, number>` of last prices. It moved here and widened to the whole `Feed`
 * for two reasons:
 *
 *   1. **A panel must not derive its own feed.** The blotter computing its own marks
 *      meant two panels on one screen could disagree about the price of the same
 *      market — the thing `README.md`'s "panels agree with each other" convention
 *      exists to prevent. The shell owns the clock, so the shell owns the marks.
 *   2. **Settlement needs the ladder, not the last price.** Deciding whether a resting
 *      limit crossed means reading the same bids and asks the OrderBook is rendering.
 *      A blotter that fills at a price the book on screen never showed reads as fake,
 *      and `feed.last` alone cannot tell you whether there was size at the touch.
 *
 * Scoped deliberately: only markets with a position or a working order, never the whole
 * 32-market registry. `buildFeed` generates candles, a book and a tape per call, so the
 * cost is real and paid per tick.
 *
 * Grouping is each market's finest tick (`groupings[0]`) rather than whatever the user
 * has selected in the book. Grouping is a display aggregation — matching against a
 * coarsened ladder would let the UI's zoom level change whether an order fills.
 */
export function useMarks(tick: number, symbols: string[]): Map<string, Feed> {
  /*
   * `symbols` is joined into a primitive for the dependency array. The caller builds it
   * with `useMemo`, but any caller that forgets would hand a fresh array identity every
   * render and rebuild every feed each time — expensive, and it would make the marks
   * change identity on renders where no price moved.
   */
  const key = symbols.join(",");
  return useMemo(() => {
    const out = new Map<string, Feed>();
    for (const sym of key ? key.split(",") : []) {
      const m = getMarket(sym);
      out.set(sym, buildFeed(m, tick, m.groupings[0]));
    }
    return out;
  }, [tick, key]);
}
