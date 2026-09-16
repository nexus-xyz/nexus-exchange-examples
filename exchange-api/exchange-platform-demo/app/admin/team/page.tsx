/*
 * Team and access.
 *
 * The permission matrix is on the page rather than behind a docs link, because
 * the question an admin actually has at invite time is "what does this role let
 * them do" and the honest place to answer it is where the choice is made.
 *
 * WHY SUB-PANES (WORKSTREAMS §3f). This pane was six stacked sections — members,
 * invite, roles, matrix, policy, caveats — and about four screens tall on a
 * phone. They are not one job: an admin adding a person needs the first two, an
 * admin auditing an escalation needs the matrix, and the security owner turning
 * on MFA needs the last. The tab strip collapses the pane to one section for
 * free and puts each of the three in its own address.
 *
 * WHY THERE IS NO CHART HERE, on a pane the plan lists as chart-starved. The
 * venue has five members and four roles. "Members by role" is a five-slice
 * anything, and "logins over time" is a metric that only rises, which §3d rules
 * out by name. The gap on this pane was never a chart — it was invitations,
 * which are a state a person can be in for a week with nothing on screen saying
 * so. That is what got built instead.
 */

import { resolveEnv } from "@/lib/venue/config-model";
import { DEMO_MEMBERS, ROLE_SPEC, ROLES } from "@/lib/venue/team-model";
import { Grid, Note, PageHead, Panel, Pill, Row, inputStyle, primaryButtonStyle } from "@/components/admin/shell";
import { SubPane, resolveSubPane, subPaneHref } from "@/components/admin/subpane";
import { Cell, DataTable, fmt, AMBER, DIM, FAINT, GREEN, MUT, TXT } from "@/components/admin/parts";
import { SIZE, body, data as dataType } from "@/components/admin/type";
import { ExportCsv, SortableTable } from "@/components/admin/interactive";
import { CONSOLE_NOW_MS, ago } from "@/lib/venue/clock";
import { monoLabel } from "@/lib/theme";

export const dynamic = "force-dynamic";

const CAPS: { key: keyof (typeof ROLE_SPEC)["owner"]["can"]; label: string }[] = [
  { key: "read", label: "Read analytics" },
  { key: "config", label: "Edit config" },
  { key: "keys", label: "Manage keys" },
  { key: "fees", label: "Change fees" },
  { key: "team", label: "Manage team" },
  { key: "billing", label: "Billing & payout" },
];

const PANES = [
  { id: "members", label: "Members" },
  { id: "roles", label: "Roles & permissions" },
  { id: "policy", label: "Policy" },
] as const;

const DAY_MS = 86_400_000;
/* An invitation is a state with a clock on it. Both constants are relative to
   the console's fixed clock so the pane is deterministic — see operate/clock.ts. */
const INVITE_SENT_MS = CONSOLE_NOW_MS - 3 * DAY_MS;
const INVITE_TTL_DAYS = 7;

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string; tab?: string }>;
}) {
  const { env: rawEnv, tab } = await searchParams;
  const env = resolveEnv(rawEnv);
  const pane = resolveSubPane(PANES, tab);

  const members = DEMO_MEMBERS.filter((m) => m.status === "active");
  const invited = DEMO_MEMBERS.filter((m) => m.status === "invited");
  const noMfa = members.filter((m) => !m.mfa);

  const hrefFor = (id: string) =>
    subPaneHref("/admin/team", id, { env: env === "live" ? "live" : undefined });

  return (
    <>
      {/* CUT: the page blurb. The Roles tab is four roles with a sentence each
          and a permission matrix under them — the blurb was a précis of both. */}
      <PageHead
        eyebrow="ORGANISATION · WHO CAN DO WHAT"
        title="Team & access"
        right={
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Pill tone="mute">{members.length} active</Pill>
            {invited.length > 0 && <Pill tone="info">{invited.length} invited</Pill>}
            {noMfa.length > 0 && <Pill tone="warn">{noMfa.length} without MFA</Pill>}
          </div>
        }
      />

      <SubPane
        panes={PANES}
        active={pane}
        hrefFor={hrefFor}
        title={pane === "members" ? "Members" : pane === "roles" ? "Roles" : "Authentication policy"}
        /* The members blurb keeps the reason to sort by last active; the other two
           restated their own tab names. */
        blurb={pane === "members" ? "A dormant Admin is the cheapest credential to steal." : undefined}
        right={
          pane === "members" ? (
            <ExportCsv
              filename="nexus-venue-members.csv"
              header={["email", "role", "mfa", "last_active_ms", "last_active", "status"]}
              rows={DEMO_MEMBERS.map((m) => [
                m.email,
                ROLE_SPEC[m.role].label,
                m.mfa ? "on" : "off",
                m.lastActiveMs ?? "",
                m.lastActiveMs === null ? "never" : new Date(m.lastActiveMs).toISOString(),
                m.status,
              ])}
              provenance={["source: venue console membership"]}
              label="EXPORT"
            />
          ) : undefined
        }
      >
        {pane === "members" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <SortableTable
              searchPlaceholder="Filter by email or role…"
              initialSort={3}
              minWidth={600}
              emptyTitle="No members"
              emptyBlurb="A venue with no members cannot be administered. There is always at least an Owner."
              head={[
                { label: "EMAIL", align: "left" },
                { label: "ROLE", align: "left" },
                { label: "MFA" },
                { label: "LAST ACTIVE" },
                { label: "STATUS" },
              ]}
              rows={DEMO_MEMBERS.map((m) => ({
                id: m.email,
                cells: [
                  { text: m.email, align: "left", color: TXT },
                  { text: ROLE_SPEC[m.role].label, align: "left", color: MUT },
                  { text: m.mfa ? "on" : "off", color: m.mfa ? GREEN : AMBER, sortValue: m.mfa ? 1 : 0 },
                  {
                    text: m.lastActiveMs === null ? "never" : fmt.day(m.lastActiveMs),
                    sortValue: m.lastActiveMs ?? 0,
                    color: m.lastActiveMs === null ? FAINT : undefined,
                  },
                  { text: m.status, color: m.status === "active" ? GREEN : MUT },
                ],
              }))}
            />

            {/* Kept: who is exposed, and what turning the requirement on does to
                them. The "worth telling them" advice went. */}
            {noMfa.length > 0 && (
              <Note tone="warn" label="MFA">
                {noMfa.length} active member{noMfa.length === 1 ? "" : "s"} can reach this console with a password
                alone — <strong style={{ color: TXT }}>{noMfa.map((m) => m.email).join(", ")}</strong>. Requiring
                MFA under Policy locks them out until they enrol.
              </Note>
            )}

            <Grid min={320}>
              {/*
               * PENDING INVITATIONS, which is the state this pane had no surface
               * for. An invited person is neither a member nor absent: they hold a
               * link that grants a role for a week, and until now the only trace of
               * that was the word "invited" in a status column. An expiry an admin
               * cannot see is an expiry they will be surprised by.
               */}
              {/* The ROADMAP pill that sat in this header is gone; the count of
                  people actually waiting is the fact an admin reads here. */}
              <Panel
                title="Pending invitations"
                blurb="A link that grants a role, for a week."
                right={<Pill tone="mute">{invited.length} PENDING</Pill>}
              >
                {invited.length === 0 ? (
                  <p style={{ ...body(SIZE.body, 1.65), color: MUT, margin: 0 }}>
                    Nobody is waiting on an invitation.
                  </p>
                ) : (
                  <DataTable
                    head={[
                      { label: "EMAIL", align: "left" },
                      { label: "ROLE", align: "left" },
                      { label: "SENT", align: "right" },
                      { label: "EXPIRES", align: "right" },
                    ]}
                  >
                    {invited.map((m) => {
                      const expiresMs = INVITE_SENT_MS + INVITE_TTL_DAYS * DAY_MS;
                      const daysLeft = Math.round((expiresMs - CONSOLE_NOW_MS) / DAY_MS);
                      return (
                        <tr key={m.email}>
                          <Cell align="left" color={TXT}>
                            {m.email}
                          </Cell>
                          <Cell align="left" color={MUT}>
                            {ROLE_SPEC[m.role].label}
                          </Cell>
                          <Cell color={MUT}>{ago(INVITE_SENT_MS)}</Cell>
                          <Cell color={daysLeft <= 2 ? AMBER : MUT}>{`in ${daysLeft}d`}</Cell>
                        </tr>
                      );
                    })}
                  </DataTable>
                )}
                {/* Kept: resend and revoke do not exist yet, which is why there is
                    no button. The reassurance about expiry went. */}
                <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: "12px 0 0" }}>
                  Resend and revoke are not in the venue admin API yet.
                </p>
              </Panel>

              <Panel title="Invite a teammate" blurb="Analyst is the right default — read everything, change nothing.">
                <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                  <input placeholder="teammate@acme.xyz" aria-label="Teammate email" style={{ ...inputStyle, width: "100%" }} />
                  <select aria-label="Role" style={{ ...inputStyle, width: "100%" }} defaultValue="analyst">
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_SPEC[r].label}
                      </option>
                    ))}
                  </select>
                  <button style={primaryButtonStyle}>SEND INVITE</button>
                  {/* Kept: a leaked invite link is not a trading credential. */}
                  <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: 0 }}>
                    An invite grants a role, never a key.
                  </p>
                </div>
              </Panel>
            </Grid>
          </div>
        )}

        {pane === "roles" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {ROLES.map((r) => (
                <div key={r} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>{ROLE_SPEC[r].label.toUpperCase()}</span>
                  <span style={{ ...body(SIZE.body, 1.65), color: MUT }}>{ROLE_SPEC[r].blurb}</span>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>PERMISSION MATRIX</span>
              <DataTable head={["CAPABILITY", ...ROLES.map((r) => ROLE_SPEC[r].label.toUpperCase())]}>
                {CAPS.map((cap) => (
                  <tr key={cap.key}>
                    <Cell align="left" color={TXT} mono={false}>
                      {cap.label}
                    </Cell>
                    {ROLES.map((r) => {
                      const allowed = ROLE_SPEC[r].can[cap.key];
                      return (
                        <Cell key={r} color={allowed ? GREEN : DIM}>
                          {/* A glyph AND a colour — never colour alone. */}
                          {allowed ? "yes" : "—"}
                        </Cell>
                      );
                    })}
                  </tr>
                ))}
              </DataTable>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>WHAT ACCESS CONTROL DOES NOT COVER</span>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 9 }}>
                {/* Limitations, kept. Each lost the clause arguing for itself. */}
                {[
                  "Roles govern this console, not the exchange — a key's power comes from its own scopes.",
                  "Removing a member does not revoke keys they created. Rotate anything they touched.",
                  "There is no role above Owner.",
                  "Traders are not members; they never appear here.",
                ].map((line) => (
                  <li key={line} style={{ ...body(SIZE.body, 1.65), color: MUT }}>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {pane === "policy" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {/* CUT: the hints on Require MFA and Session length, which restated
                  their labels. SSO and the two below state a consequence. */}
              <Row label="Require MFA">
                {noMfa.length > 0 ? (
                  <Pill tone="warn">{noMfa.length} would be locked out</Pill>
                ) : (
                  <Pill tone="good">EVERY MEMBER ENROLLED</Pill>
                )}
              </Row>
              <Row label="SSO / SAML" hint="Your identity provider becomes the source of truth for membership.">
                <Pill tone="mute">NOT CONFIGURED</Pill>
              </Row>
              <Row label="Session length">
                <span style={{ ...dataType(), color: TXT }}>12h</span>
              </Row>
              <Row label="Invitation lifetime" hint="After this the link is dead and the invite must be re-sent.">
                <span style={{ ...dataType(), color: TXT }}>{INVITE_TTL_DAYS}d</span>
              </Row>
              <Row label="IP allowlist" hint="Restrict console and admin API to known egress ranges.">
                <Pill tone="mute">OFF</Pill>
              </Row>
            </div>

            {/* Kept: an operator who thinks the IP allowlist covers their API keys
                has a hole they cannot see. */}
            <Note tone="info" label="SCOPE">
              These settings govern the console, not the exchange API: a key with a{" "}
              <strong style={{ color: TXT }}>trade</strong> scope keeps working from any address whether or not
              an allowlist is on here.
            </Note>
          </div>
        )}
      </SubPane>
    </>
  );
}
