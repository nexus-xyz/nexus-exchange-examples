/*
 * The venue console, as data.
 *
 * The console renders nothing this route cannot return. A platform whose pitch is
 * that the API is the product cannot ship an operator surface with capabilities
 * its API lacks — that contradiction would be visible on the first screen a
 * developer touches.
 *
 * AUTH. Read-only, and it takes the bearer token described in PACKAGING.md §6 —
 * the figures are the venue's own routed flow and revenue, which is exactly the
 * data a competitor would want and the venue would never publish.
 */

import { NextResponse } from "next/server";

import { readVenueDashboard } from "@/lib/venue/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const dashboard = await readVenueDashboard();
  return NextResponse.json(
    {
      ...dashboard,
      /* Restated at the top level so a consumer that never reads a nested
         `provenance` field still knows which figures have settled and which are
         still accruing. A scripted reconciliation needs that distinction more
         than the console does. */
      provenance: {
        attribution: "live — joined from the attribution ledger",
        builderFee: "estimate — accrued against the fee schedule, settles at period close",
        marketData: "live — read from the venue at request time",
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
