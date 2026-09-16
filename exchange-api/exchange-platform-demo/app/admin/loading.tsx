/*
 * What the content column looks like while the console is reading the venue.
 *
 * This is a real state, not a nicety: every page here is `force-dynamic` and does
 * a server-side read of the live testnet with an eight-second timeout, so on a
 * slow read the operator is looking at this.
 *
 * A SERVER COMPONENT AGAIN, and back to the content column only. It was a client
 * component for one reason: it drew its own copy of the whole shell, so it had to
 * know which nav row to highlight and which environment to paint, and neither is
 * knowable on the server from inside a loading boundary. Both problems were
 * artefacts of drawing the shell twice. Now `app/admin/layout.tsx` owns the shell
 * and React keeps it mounted across the navigation — the sidebar is never
 * unmounted, so its active row and its amber live edge cannot flicker, because
 * nothing re-renders them. What is left for this file is the only thing that was
 * ever actually unknown: the page.
 *
 * The skeleton is deliberately generic — a heading, a metric row, a chart-and-rows
 * panel. Every console pane opens with some arrangement of those three, and a
 * skeleton that tried to match each page exactly would be thirteen skeletons to
 * keep in step with thirteen layouts.
 */

import { Panel } from "@/components/admin/shell";
import { Skeleton, SkeletonMetrics, SkeletonRows } from "@/components/admin/parts";

export default function ConsoleLoading() {
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }} role="status" aria-label="Loading the console">
        <Skeleton height={22} width={220} />
        <Skeleton height={12} width={520} />
      </div>

      <Panel title=" ">
        <SkeletonMetrics count={6} />
      </Panel>

      <Panel title=" ">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Skeleton height={150} />
          <SkeletonRows rows={5} />
        </div>
      </Panel>
    </>
  );
}
