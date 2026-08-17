/*
 * Audit — who changed what, and when.
 *
 * WHAT LEFT. Earnings and payout are now `/admin/billing`. They lived here
 * because they answer each other — an unexplained number in billing is explained
 * by this log — but that is an argument for a link, which both pages now carry,
 * not for one pane where the money pushed the record below the fold.
 *
 * WHY THERE IS NO CHART ON THIS PAGE, deliberately, on a page the plan calls
 * chart-starved. The venue has seven audit entries across five days. Every chart
 * that could be drawn from them — events per day, events by actor, a severity
 * mix — is a second encoding of a table that is already short enough to read in
 * full, which is precisely the decoration WORKSTREAMS §3d rules out. The useful
 * treatment for a short forensic list is search and sort over the whole of it,
 * and that is what it has. A venue with ten thousand entries would want a
 * frequency chart and this page will earn one then.
 *
 * The other half of completeness is stating what is NOT recorded. An audit log
 * whose coverage is unstated is one an operator will assume covers everything —
 * and the first time that assumption is load-bearing is during an incident.
 */

import Link from "next/link";

import { envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import { DEMO_AUDIT } from "@/lib/venue/team-model";
import { Grid, Note, PageHead, Panel, Pill, Row } from "@/components/admin/shell";
import { Cell, DataTable, fmt, AMBER, FAINT, MUT, TXT } from "@/components/admin/parts";
import { SIZE, body } from "@/components/admin/type";
import { ExportCsv, SortableTable } from "@/components/admin/interactive";
import { monoLabel } from "@/lib/theme";

export const dynamic = "force-dynamic";

/* Severity is carried as a colour AND as the word itself, because a table that
   encodes urgency in colour alone is unreadable to a colour-blind operator and
   to anyone who prints it. */
const SEVERITY_COLOR = { info: MUT, notice: TXT, warn: AMBER } as const;

/**
 * Coverage, as data rather than as a paragraph.
 *
 * Each row is a class of thing that happens to a venue and whether this log sees
 * it. The `no` rows are the point: they are where an operator would otherwise
 * assume coverage they do not have.
 */
const COVERAGE: { what: string; recorded: boolean; where: string }[] = [
  { what: "Configuration and fee changes", recorded: true, where: "actor, before → after" },
  { what: "Key mint and revoke", recorded: true, where: "actor, key id, scopes" },
  { what: "Team invite, role change, removal", recorded: true, where: "actor and subject" },
  { what: "Market listing and delisting", recorded: true, where: "actor, market id" },
  { what: "Payout destination changes", recorded: true, where: "Owner only, always notice" },
  { what: "Console sign-ins", recorded: false, where: "your identity provider holds these" },
  { what: "API calls made with a key", recorded: false, where: "the request log, 7 days" },
  { what: "Trader activity on your venue", recorded: false, where: "the exchange — traders are not members" },
];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string }>;
}) {
  const env = resolveEnv((await searchParams).env);
  const warnings = DEMO_AUDIT.filter((e) => e.severity === "warn").length;

  return (
    <>
      {/* CUT: the page blurb named the table's own columns. */}
      <PageHead
        eyebrow="ORGANISATION · THE RECORD"
        title="Audit"
        right={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {warnings > 0 && <Pill tone="warn">{warnings} to review</Pill>}
            <ExportCsv
              filename="nexus-venue-audit.csv"
              header={["timestamp_ms", "when", "actor", "action", "detail", "severity"]}
              rows={DEMO_AUDIT.map((e) => [
                e.atMs,
                new Date(e.atMs).toISOString(),
                e.actor,
                e.action,
                e.detail,
                e.severity,
              ])}
              provenance={[
                "source: venue audit log",
                "builder fee figures elsewhere in this console are ESTIMATES until the period closes",
              ]}
            />
          </div>
        }
      />

      {/* CUT: blurb. The panel opens with a search box; nothing needed to say so. */}
      <Panel title="Audit log">
        <SortableTable
          searchPlaceholder="Filter by actor, action or detail…"
          initialSort={0}
          minWidth={680}
          emptyTitle="Nothing has been changed"
          emptyBlurb="A fresh venue has an empty audit log, and that is the correct state — not a missing feature."
          head={[
            { label: "WHEN", align: "left" },
            { label: "ACTOR", align: "left" },
            { label: "ACTION", align: "left" },
            { label: "DETAIL", align: "left" },
            { label: "SEVERITY", align: "right" },
          ]}
          rows={DEMO_AUDIT.map((e) => ({
            id: `${e.atMs}-${e.action}`,
            cells: [
              { text: fmt.day(e.atMs), align: "left", color: MUT, sortValue: e.atMs },
              { text: e.actor, align: "left", color: e.actor === "system" ? FAINT : TXT },
              { text: e.action, align: "left", color: TXT },
              { text: e.detail, align: "left", color: MUT, mono: false },
              { text: e.severity.toUpperCase(), color: SEVERITY_COLOR[e.severity] },
            ],
          }))}
        />
      </Panel>

      <Grid min={320}>
        {/* CUT: blurb. The LOGGED column has "no" rows in it, which says it. */}
        <Panel title="What is recorded">
          <DataTable
            head={[
              { label: "EVENT", align: "left" },
              { label: "LOGGED", align: "right" },
              { label: "DETAIL", align: "left" },
            ]}
          >
            {COVERAGE.map((row) => (
              <tr key={row.what}>
                <Cell align="left" color={TXT} mono={false}>
                  {row.what}
                </Cell>
                {/* A glyph AND a colour — never colour alone. */}
                <Cell color={row.recorded ? TXT : FAINT}>{row.recorded ? "yes" : "no"}</Cell>
                <Cell align="left" color={row.recorded ? MUT : FAINT} mono={false}>
                  {row.where}
                </Cell>
              </tr>
            ))}
          </DataTable>
        </Panel>

        {/* CUT: the blurb and the two hints that restated their rows. The
            sampling constraint and the data-loss warning stay. */}
        <Panel title="Retention">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Row label="Audit log">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>13 months</span>
            </Row>
            <Row label="Request log" hint="Sampled, and not exported.">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>7 days</span>
            </Row>
            <Row label="Attribution ledger" hint="Order → venue mapping. Lose it and attribution is unrecoverable.">
              <Pill tone="warn">IN MEMORY</Pill>
            </Row>
            <Row label="Fills">
              <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>exchange</span>
            </Row>
          </div>
          <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: "12px 0 0" }}>
            The exchange cannot reproduce the attribution ledger. Back it with a real database before it matters
            to{" "}
            <Link href={envHrefFor("/admin/billing", env)} style={{ color: MUT }}>
              Billing
            </Link>
            .
          </p>
        </Panel>
      </Grid>

      {/* Kept: the leaver's keys outliving them is the hole, and filter-then-rotate
          is what to do about it. */}
      <Note tone="info" label="LEAVERS">
        Removing a member does not revoke the keys they minted. Filter this log by their address, then rotate
        what they touched from{" "}
        <Link href={envHrefFor("/admin/keys", env)} style={{ color: TXT }}>
          Keys
        </Link>
        .
      </Note>
    </>
  );
}
