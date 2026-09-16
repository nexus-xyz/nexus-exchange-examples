/*
 * Configuration — everything about the venue that is a setting rather than a
 * deploy. The editor itself is `ConfigEditor`, which is a client component
 * because it is a form; this page is the frame around it.
 *
 * WHY THERE IS NO CHART HERE, on a pane WORKSTREAMS §3c lists as chart-starved.
 * Nothing on this page is a measurement. A fee is a decision, a market list is a
 * selection, an order-type policy is a switch — and the chart you could draw of
 * them ("fee over time") is the audit log with worse resolution and no actor. §3c
 * asks for the chart that tells an operator which row matters; on a settings pane
 * the answer to that is the one that changed recently and who changed it, which
 * is a list of five entries, not a plot.
 *
 * So what this page gained instead is the last change and its actor, in the
 * header, and the recent-changes list beneath the editor. An operator who opens
 * a config screen after an incident is asking "what moved", and until now this
 * pane could not answer it at all — the answer was two clicks away on Audit and
 * nothing here said so.
 */

import Link from "next/link";

import { ACTIVE_TENANT } from "@/lib/tenant";
import { envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import { DEMO_AUDIT } from "@/lib/venue/team-model";
import { Note, PageHead, Panel } from "@/components/admin/shell";
import { Cell, DataTable, fmt, AMBER, FAINT, MUT, TXT } from "@/components/admin/parts";
import { ConfigEditor } from "@/components/admin/ConfigEditor";
import { SIZE, body } from "@/components/admin/type";

export const dynamic = "force-dynamic";

/*
 * Which audit actions are changes to THIS page's subject.
 *
 * A prefix list rather than a category on the entry, because the audit log is
 * the shared record and its actions are named by what they did — `fee.update`,
 * `market.list` — not by which console pane happens to render them. Adding a
 * pane must not require re-tagging history.
 */
const CONFIG_ACTIONS = ["fee.", "market.", "venue.", "referral."];

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string }>;
}) {
  const env = resolveEnv((await searchParams).env);
  const changes = DEMO_AUDIT.filter((e) => CONFIG_ACTIONS.some((prefix) => e.action.startsWith(prefix)));
  const latest = changes[0] ?? null;

  return (
    <>
      {/* CUT: the page blurb. The editor's own nexus.json panel says what the
          file is and that edits are not saved. */}
      <PageHead
        eyebrow="VENUE · WHAT IS A SETTING"
        title="Configuration"
        right={
          latest && (
            /* The one fact a settings pane owes a reader before they change
               anything: it is not in the state they left it in. */
            <span style={{ ...body(SIZE.note, 1.5), color: FAINT, textAlign: "right" }}>
              Last changed {fmt.day(latest.atMs)}
              <br />
              <span style={{ color: MUT }}>{latest.actor}</span>
            </span>
          )
        }
      />

      <ConfigEditor
        venueName={ACTIVE_TENANT.name}
        builderCode={ACTIVE_TENANT.builder.code || "bld_your_venue"}
        initialFeeBps={ACTIVE_TENANT.builder.feeBps}
      />

      {/* CUT: the blurb (the note below already says the list is filtered) and the
          rationale half of the empty state. */}
      <Panel title="Recent changes to this venue">
        {changes.length === 0 ? (
          <p style={{ ...body(SIZE.body, 1.65), color: MUT, margin: 0 }}>
            Nothing has been changed since this venue was created.
          </p>
        ) : (
          <DataTable
            head={[
              { label: "WHEN", align: "left" },
              { label: "ACTOR", align: "left" },
              { label: "ACTION", align: "left" },
              { label: "DETAIL", align: "left" },
            ]}
          >
            {changes.map((e) => (
              <tr key={`${e.atMs}-${e.action}`}>
                <Cell align="left" color={MUT}>
                  {fmt.day(e.atMs)}
                </Cell>
                <Cell align="left" color={e.actor === "system" ? FAINT : TXT}>
                  {e.actor}
                </Cell>
                <Cell align="left" color={e.severity === "warn" ? AMBER : TXT}>
                  {e.action}
                </Cell>
                <Cell align="left" color={MUT} mono={false}>
                  {e.detail}
                </Cell>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>

      {/* Kept: that this list is partial, and the 13-month retention. */}
      <Note tone="info" label="THE WHOLE RECORD">
        This list is filtered to what this page changes.{" "}
        <Link href={envHrefFor("/admin/audit", env)} style={{ color: TXT }}>
          Audit
        </Link>{" "}
        carries everything else, for thirteen months.
      </Note>
    </>
  );
}
