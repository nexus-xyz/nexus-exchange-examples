/*
 * Funding, as data.
 *
 * Same rule as /api/admin/summary: the console renders nothing this route cannot
 * return.
 *
 * The `polling` block is not decoration: the upstream analytics are REST polls of
 * two dashboard endpoints, not a stream, so a consumer that builds a live tape on
 * top of this would be building on a 60-second sample. The interval is part of the
 * contract for that reason.
 */

import { NextResponse } from "next/server";

import { FUNDING_RAILS, FUNDING_TERMINUS, fundingAnalytics } from "@/lib/venue/product-analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const funding = fundingAnalytics();
  return NextResponse.json(
    {
      rails: FUNDING_RAILS,
      terminus: FUNDING_TERMINUS,
      analytics: funding,
      polling: {
        transport: "REST poll",
        intervalSeconds: funding.pollIntervalS,
        endpoints: funding.polledEndpoints,
        note: "polled, not a websocket",
      },
      /*
       * This response is a documented tenant-facing contract, so the note says what
       * is true of the DATA and stops there. It used to carry our ticket ids and
       * internal delivery state — none of which a consumer of this endpoint can act
       * on, and all of which we would then owe them an update on.
       */
      provenance: {
        figures: "live — deposit records as the funding provider reported them",
        freshness: `sampled every ${funding.pollIntervalS}s`,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
