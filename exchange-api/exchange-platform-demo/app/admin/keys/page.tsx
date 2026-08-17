/*
 * Keys — the credentials for this platform's admin API.
 *
 * WHAT THESE KEYS ARE, STATED FIRST BECAUSE THE PAGE USED TO GET IT WRONG
 * (EP-008). Operator identity is a separate account model from the Exchange's:
 * an organisation with members and roles, not a wallet. So the credential this
 * pane mints is a PLATFORM key — it authenticates calls to the venue admin API,
 * the same surface the console itself calls — and not an exchange HMAC trading
 * key. The two were conflated here: the page handed over `NEXUS_API_*` and told
 * the operator how to sign a request with it. Exchange request signing is
 * documentation of the *exchange* API and lives on `/admin/api` → Signing,
 * beside the canonical string it is about.
 *
 * The controls here are real: a key mints, its secret is revealed exactly once,
 * and revocation is gated on the assertion that the replacement is already
 * deployed. The gate is the design: revoking before the replacement is deployed
 * is the fastest way to take a venue down, and it is a mistake an operator makes
 * once — so the console asks for the assertion rather than the confirmation.
 *
 * WHAT LEFT. Webhooks were a heading here, then a route, and are now nothing at
 * all (EP-010) — the pointer note at the foot of this page went with them. The
 * signature-verification snippet moved to `/admin/api` in an earlier pass,
 * beside the canonical string it reproduces.
 *
 * WHAT ARRIVED. A chart above the table, which is §3c's argument: the table
 * ranks keys by 24-hour requests, and 24-hour requests is not the number that
 * breaks. A key averaging 2/s against a 50/s ceiling is fine on a daily total
 * and is refused at 14:00. So the first thing on the page is peak throughput per
 * key against the ceiling — the chart that says which row matters — and the
 * whole story of how it got there is one tab away under Usage.
 */

import { ACTIVE_TENANT } from "@/lib/tenant";
import { defaultConfig, envHrefFor, resolveEnv } from "@/lib/venue/config-model";
import { DEMO_KEYS } from "@/lib/venue/team-model";
import { apiAnalytics } from "@/lib/venue/product-analytics";
import { Grid, Note, PageHead, Panel, Pill, Row } from "@/components/admin/shell";
import { SubPane, resolveSubPane, subPaneHref } from "@/components/admin/subpane";
import {
  Cell,
  DataTable,
  Metric,
  MetricGrid,
  ProvenanceBadge,
  fmt,
  AMBER,
  FAINT,
  GREEN,
  MUT,
  TXT,
} from "@/components/admin/parts";
import { ChartFrame, RankedBars } from "@/components/admin/charts";
import { SIZE, body } from "@/components/admin/type";
import { KeysManager } from "@/components/admin/KeysManager";
import { CeilingBars } from "@/components/admin/charts/CeilingBars";
import { keyUsage } from "@/lib/venue/usage-model";
import { hhmm } from "@/lib/venue/clock";
import { monoLabel } from "@/lib/theme";
import Link from "next/link";

export const dynamic = "force-dynamic";

const KEY_AGE_DAYS = 66;

/**
 * A per-second rate, at a precision that does not erase the small ones.
 *
 * One decimal is right at 50/s and wrong at 0.04/s — a development key in daily
 * use rendered as "0.0/s", which reads as a key nobody has called and is the
 * kind of quiet zero an operator revokes something over.
 */
const perSec = (n: number): string => `${n < 1 ? n.toFixed(2) : n.toFixed(1)}/s`;

const PANES = [
  { id: "keys", label: "Keys" },
  { id: "usage", label: "Usage & limits" },
] as const;

export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string; tab?: string }>;
}) {
  const { env: rawEnv, tab } = await searchParams;
  const env = resolveEnv(rawEnv);
  const pane = resolveSubPane(PANES, tab);

  const api = apiAnalytics();
  /* The ceiling is a SETTING, so it is read from the config the console edits
     rather than typed here. It used to be the literal 50 in this file and the
     literal 50 in `defaultConfig`, which is two places for one number and the
     usual way a console starts lying about a limit after somebody raises it. */
  const ceiling = defaultConfig(ACTIVE_TENANT.name, ACTIVE_TENANT.builder.feeBps).api.rateLimitPerSec;
  const refused24h = api.errorCodes.find((e) => e.code === "RATE_LIMITED")?.count ?? 0;
  const usage = keyUsage(DEMO_KEYS, ceiling, refused24h);
  /* The key the Usage pane draws in full. One chart of the key that is near the
     rule beats three charts of which two are empty by construction. */
  const busiest = [...usage].sort((a, b) => b.peakPerSec - a.peakPerSec)[0]!;

  const hrefFor = (id: string) =>
    subPaneHref("/admin/keys", id, { env: env === "live" ? "live" : undefined });

  return (
    <>
      {/* The blurb came BACK, one sentence, and it is the EP-008 correction: the
          page had no line saying which of the two credentials this is, and
          everything else on it read as though it were the exchange's. The rest
          of the old blurb stays cut — its claims are the rules list below. */}
      <PageHead
        eyebrow="BUILD · PLATFORM CREDENTIALS"
        title="Keys"
        blurb="Credentials for the venue admin API — the surface this console calls. Exchange trading keys are a different credential, minted against the trading account."
        right={KEY_AGE_DAYS > 60 ? <Pill tone="warn">ROTATION DUE</Pill> : <Pill tone="good">HEALTHY</Pill>}
      />

      {KEY_AGE_DAYS > 60 && (
        /* Kept: the order is the actionable part, and reversing it is an outage. */
        <Note tone="warn" label="ROTATION DUE">
          <span style={{ fontFamily: "inherit" }}>
            <strong style={{ color: TXT }}>nx_live_7f3a…</strong> is {KEY_AGE_DAYS} days old and serves your
            production integration. Create, deploy, then revoke — the reverse order breaks it.
          </span>
        </Note>
      )}

      <SubPane
        panes={PANES}
        active={pane}
        hrefFor={hrefFor}
        title={pane === "keys" ? "Platform API keys" : "Usage against the ceiling"}
        /* CUT: the keys blurb — the rotation checklist already says two keys can
           be valid at once. The usage blurb keeps its unit and nothing else. */
        blurb={pane === "keys" ? undefined : "Per key, per second, at the peak."}
        /* The ROADMAP pill that sat here is gone; what belongs in a pane header is
           a count of the thing the pane is about. */
        right={<Pill tone="mute">{DEMO_KEYS.length} keys</Pill>}
      >
        {pane === "keys" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/*
             * THE CHART BEFORE THE TABLE (§3c). It is not a second encoding of
             * the table's 24-hour count — it is a different unit. The table
             * ranks by requests per day, which is the number that never
             * breaks; this ranks by the worst second against the budget, which
             * is the number that does. On this venue they disagree: the CI key
             * does 5% of production's daily volume and a third of its peak.
             */}
            <ChartFrame
              title={`PEAK REQUESTS PER SECOND, LAST 24H · CEILING ${ceiling}/S`}
              right={<ProvenanceBadge provenance="live" />}
            >
              <RankedBars
                items={usage.map((u) => ({ label: u.key.id, value: u.peakPerSec }))}
                /* Scaled to the CEILING, never to the largest key. A full bar
                   has to mean "at the limit" — normalised to the biggest key it
                   would mean "the biggest key", which is true of some key
                   always and tells an operator nothing. */
                scaleTo={ceiling}
                format={(n) => perSec(n)}
              />
            </ChartFrame>

            <KeysManager keys={DEMO_KEYS} env={env} />

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>THE RULES THAT MATTER</span>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7 }}>
                {[
                  /* Security claims, kept and shortened. A "public market data
                     needs no key" bullet used to sit here; it went with the
                     exchange framing (EP-008) — public market data is not what
                     this credential reaches. */
                  <>
                    The secret is shown <strong>once</strong>, at creation. There is no recovery — mint a
                    replacement instead.
                  </>,
                  /* The worked example (a Developer cannot mint `withdraw`) went —
                     the permission matrix on Team is where roles are enumerated. */
                  <>Scopes are additive and never exceed the role of whoever minted the key.</>,
                  /* Reframed with EP-008. This bullet used to read "keys are
                     network-scoped and signatures are not: a mainnet key in a
                     preview deployment can place real orders" — true of an
                     exchange HMAC key and not of this one. The environment split
                     is still real and still the thing that costs money; what a
                     live key reaches is the live organisation's records. */
                  <>
                    A key belongs to one environment. A live key changes your live venue — its fees, its market
                    list, its payout destination — from wherever it is deployed.
                  </>,
                ].map((line, i) => (
                  <li key={i} style={{ ...body(SIZE.body, 1.65), color: MUT }}>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {pane === "usage" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <MetricGrid min={140} divided>
              <Metric
                label="CEILING"
                value={`${ceiling}/s`}
                provenance="live"
                hint="per key — nexus.json api.rateLimit"
              />
              <Metric
                label="PEAK, BUSIEST KEY"
                value={perSec(busiest.peakPerSec)}
                provenance="live"
                color={busiest.headroom === 0 ? AMBER : TXT}
                hint={`at ${hhmm(busiest.peakAtMs)} UTC`}
              />
              <Metric
                label="HEADROOM AT PEAK"
                value={fmt.pct(busiest.headroom, 0)}
                provenance="live"
                color={busiest.headroom < 0.2 ? AMBER : GREEN}
                hint="unused budget in the worst second"
              />
              <Metric
                label="REFUSED (24H)"
                value={fmt.int(refused24h)}
                provenance="live"
                color={refused24h > 0 ? AMBER : GREEN}
                hint="429s across every key"
              />
            </MetricGrid>

            <ChartFrame
              title={`${busiest.key.id} — HOURLY PEAK, 24H`}
              right={<ProvenanceBadge provenance="live" />}
            >
              <CeilingBars
                labels={busiest.hoursMs.map((ms) => hhmm(ms))}
                accepted={busiest.acceptedPeak}
                refused={busiest.refused}
                ceiling={ceiling}
              />
            </ChartFrame>

            {/* CUT: the paragraph explaining why only the busiest key is drawn.
                The chart is titled with the key it draws and the other keys are
                rows in the table directly beneath it. */}

            <DataTable
              head={[
                { label: "KEY", align: "left" },
                { label: "MEAN", align: "right" },
                { label: "PEAK", align: "right" },
                { label: "HEADROOM", align: "right" },
                { label: "CLIPPED HRS", align: "right" },
                { label: "429s", align: "right" },
              ]}
            >
              {usage.map((u) => (
                <tr key={u.key.id}>
                  <Cell align="left" color={TXT}>
                    {u.key.id}
                  </Cell>
                  <Cell>{perSec(u.meanPerSec)}</Cell>
                  <Cell color={u.headroom === 0 ? AMBER : undefined}>{perSec(u.peakPerSec)}</Cell>
                  <Cell color={u.headroom < 0.2 ? AMBER : MUT}>{fmt.pct(u.headroom, 0)}</Cell>
                  <Cell color={u.clippedHours > 0 ? AMBER : FAINT}>{u.clippedHours || "—"}</Cell>
                  <Cell color={u.refusedTotal > 0 ? AMBER : FAINT}>{fmt.int(u.refusedTotal) ?? "—"}</Cell>
                </tr>
              ))}
            </DataTable>

            <Grid min={300}>
              <Panel title="What a 429 actually does">
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <Row label="Response" hint="The body carries RATE_LIMITED and nothing else useful.">
                    <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>429</span>
                  </Row>
                  <Row label="Retry-After" hint="Seconds. Honour it — retrying sooner extends the window.">
                    <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>1</span>
                  </Row>
                  <Row label="Scope" hint="Per key, per second. Two keys have two budgets.">
                    <span style={{ ...monoLabel(SIZE.micro), color: TXT }}>key</span>
                  </Row>
                  {/* Was "Cancels — a cancel refused for rate is an order still
                      working", which is an exchange order-path consequence and
                      not one of this API's (EP-008). The equivalent here is the
                      halt: the one admin call whose refusal leaves the venue
                      doing something the operator has decided it should stop. */}
                  <Row label="Halt" hint="A halt refused for rate is a venue still routing.">
                    <Pill tone="warn">NOT EXEMPT</Pill>
                  </Row>
                </div>
              </Panel>

              <Panel title="Buying headroom" blurb="In the order that costs least.">
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 9 }}>
                  {/* The steps stay — they are what to do — minus the sentence
                      each one spent justifying itself. */}
                  {[
                    /* First two rewritten with EP-008: "move public reads off the
                       signed key" and "subscribe instead of polling" were both
                       about the exchange's market-data path, which this
                       credential does not touch. */
                    "Cache what rarely moves — your market list and fee schedule change on your own schedule, not the market's.",
                    "Read on a period, not in a loop. Nothing behind this API changes faster than you can act on it.",
                    "Split by workload, not by environment, so a reporting job cannot starve a control call.",
                    "Then ask for a higher ceiling. It is the only step that needs us.",
                  ].map((line) => (
                    <li key={line} style={{ ...body(SIZE.body, 1.65), color: MUT }}>
                      {line}
                    </li>
                  ))}
                </ul>
              </Panel>
            </Grid>

            {/* Kept as the pointer only; the "this pane vs that pane" gloss went. */}
            <Note tone="info" label="WHERE THE 429s ARE">
              Every refusal is a row on{" "}
              <Link href={envHrefFor("/admin/logs", env)} style={{ color: TXT }}>
                Logs
              </Link>
              , with its timestamp, path and key.
            </Note>
          </div>
        )}
      </SubPane>

      {/* A WEBHOOKS pointer note sat here — "moved to /admin/webhooks", plus a
          count of failing endpoints. Both the note and the route it pointed at
          are gone with EP-010. Nothing replaces it: a pointer to a feature that
          no longer exists is the dead affordance the pointer was written to
          avoid. */}
    </>
  );
}
