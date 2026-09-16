/*
 * A market that is not in the registry.
 *
 * A 404 rather than an empty detail page, because the registry belongs to the
 * exchange: if a market is not in it, the venue could not carry it however the
 * config were edited. Rendering a page of zeroes would imply otherwise.
 *
 * Content only — `app/admin/layout.tsx` draws the console around it. A not-found
 * boundary renders inside its segment's layout, so building a second shell here
 * would nest one console inside another.
 */

import Link from "next/link";

import { MARKET_REGISTRY } from "@/lib/venue/config-model";
import { PageHead, Panel } from "@/components/admin/shell";
import { EmptyState, ARCHIVO, MONO, MUT, TXT } from "@/components/admin/parts";
import { SIZE, body } from "@/components/admin/type";
import { L2, monoLabel } from "@/lib/theme";

export default function MarketNotFound() {
  return (
    <>
      <PageHead
        title="No such market"
        blurb="The exchange lists a fixed registry of markets and a venue selects from it. A market outside the registry cannot be listed, priced or drilled into."
      />
      <Panel title="What the exchange does list">
        <EmptyState
          title="Pick one of these"
          blurb="Every market a venue can carry, whatever its configuration."
          action={
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, justifyContent: "center", maxWidth: 520 }}>
              {MARKET_REGISTRY.map((m) => (
                <Link
                  key={m.id}
                  href={`/admin/markets/${encodeURIComponent(m.id)}`}
                  style={{ ...monoLabel(SIZE.micro), color: TXT, textDecoration: "none", border: `1px solid ${L2}`, borderRadius: 4, padding: "5px 8px" }}
                >
                  {m.id}
                </Link>
              ))}
            </div>
          }
        />
        <p style={{ ...body(SIZE.note, 1.6), color: MUT, margin: "14px 0 0" }}>
          Adding a market to the registry is the exchange&apos;s decision, not a venue setting — see{" "}
          <span style={{ fontFamily: MONO }}>Configuration → Markets</span> for what a venue does control.
        </p>
      </Panel>
    </>
  );
}
