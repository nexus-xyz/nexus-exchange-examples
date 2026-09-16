"use client";

/*
 * The configuration editor.
 *
 * THE FILE IS THE SOURCE OF TRUTH, NOT THIS SCREEN. Every control writes into a
 * `VenueConfig` and the panel at the bottom renders it as `nexus.json` — the
 * artefact you commit. That direction matters: a console that owns the state and
 * emits config on export produces drift the moment someone edits the file, while
 * a console that is a *view over the file* cannot. It is also what makes preview
 * deploys, rollbacks and code review work on a venue at all.
 *
 * So there is no Save button. There is a diff and a copy, and the deploy is a
 * git push — which is the same loop the rest of the platform promises.
 *
 * Changes here live in this browser tab only.
 */

import { useMemo, useState } from "react";

import { TOKEN_COLOR, TOKEN_WEIGHT, tokenizeLine } from "@/lib/highlight";

import {
  ARCHIVO,
  DIM,
  FAINT,
  GREEN,
  HI,
  L1,
  L2,
  L3,
  MONO,
  MUT,
  R_SM,
  SUNK,
  TAP_FLOOR,
  TERM,
  TXT,
  monoLabel,
  titleLabel,
} from "@/lib/theme";
import {
  MARKET_KIND_LABEL,
  MARKET_REGISTRY,
  normaliseFeeBps,
  defaultConfig,
  effectiveFeeBps,
  toNexusJson,
  type AvailableMarket,
  type VenueConfig,
} from "@/lib/venue/config-model";
import { Grid, Panel, Pill, Row, buttonStyle, inputStyle } from "./shell";
import { SIZE, body, data as dataType } from "./type";

export function ConfigEditor({
  venueName,
  builderCode,
  initialFeeBps,
}: {
  venueName: string;
  builderCode: string;
  initialFeeBps: number;
}) {
  const [config, setConfig] = useState<VenueConfig>(() => defaultConfig(venueName, initialFeeBps));
  const [copied, setCopied] = useState(false);

  const json = useMemo(() => toNexusJson(config, builderCode), [config, builderCode]);
  const baseline = useMemo(
    () => toNexusJson(defaultConfig(venueName, initialFeeBps), builderCode),
    [venueName, initialFeeBps, builderCode],
  );
  const dirty = json !== baseline;

  const patch = (next: Partial<VenueConfig>) => setConfig((c) => ({ ...c, ...next }));

  const toggleMarket = (id: string) =>
    setConfig((c) => ({
      ...c,
      markets: c.markets.includes(id) ? c.markets.filter((m) => m !== id) : [...c.markets, id],
    }));

  const setOverride = (id: string, value: string) =>
    setConfig((c) => {
      const next = { ...c.feeOverrides };
      if (value === "") delete next[id];
      else next[id] = normaliseFeeBps(Number(value));
      return { ...c, feeOverrides: next };
    });

  const grouped = MARKET_REGISTRY.reduce<Record<string, AvailableMarket[]>>((acc, m) => {
    (acc[m.kind] ??= []).push(m);
    return acc;
  }, {});

  return (
    <>
      <Grid min={330}>
        <Panel
          title="Markets"
          blurb="Choose what your venue carries. You are selecting from the shared book, not creating markets."
          right={<Pill tone="info">{config.markets.length} listed</Pill>}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {Object.entries(grouped).map(([kind, markets]) => (
              <div key={kind} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>
                  {MARKET_KIND_LABEL[kind as AvailableMarket["kind"]].toUpperCase()}
                </span>
                {markets.map((m) => {
                  const listed = config.markets.includes(m.id);
                  const blocked = m.exchangeStatus !== "active";
                  return (
                    <label
                      key={m.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        padding: "7px 9px",
                        /* The whole row is the target — the checkbox is 16px and a
                           16px box is exactly the size this project's tap-target
                           floor calls out by name. The label carries the height so
                           the tick can stay a tick. */
                        minHeight: TAP_FLOOR,
                        borderRadius: R_SM,
                        border: `1px solid ${listed ? `${GREEN}44` : L2}`,
                        background: listed ? `${GREEN}0a` : SUNK,
                        cursor: blocked ? "not-allowed" : "pointer",
                        opacity: blocked ? 0.45 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={listed}
                        disabled={blocked}
                        onChange={() => toggleMarket(m.id)}
                        style={{ accentColor: GREEN, cursor: "inherit", width: 16, height: 16, flexShrink: 0, margin: 0 }}
                      />
                      <span style={{ ...dataType(), color: TXT, flex: 1 }}>{m.id}</span>
                      <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>{m.maxLeverage}×</span>
                      {blocked && <Pill tone="warn">{m.exchangeStatus}</Pill>}
                    </label>
                  );
                })}
              </div>
            ))}
            <p style={{ ...body(SIZE.note, 1.5), color: FAINT, margin: 0, lineHeight: 1.6 }}>
              A paused market cannot be listed. Tick size, risk parameters and the oracle stay with the
              exchange.
            </p>
          </div>
        </Panel>

        <Panel
          title="Fees"
          blurb="Additive on top of the exchange schedule and kept in full. You set it, up to a 10 bps ceiling, and your traders approve a maximum before it is charged."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Row label="Venue fee" hint="Applies to every market without an override.">
              <input
                type="number"
                min={0}
                value={config.feeBps}
                onChange={(e) => patch({ feeBps: normaliseFeeBps(Number(e.target.value)) })}
                style={{ ...inputStyle, width: 68, textAlign: "right" }}
              />
              <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>BPS</span>
            </Row>

            <div style={{ paddingTop: 10 }}>
              <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>PER-MARKET OVERRIDES</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
                {config.markets.map((id) => (
                  <div key={id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span style={{ ...dataType(), color: MUT, flex: 1 }}>{id}</span>
                    <input
                      type="number"
                      min={0}
                            placeholder={String(config.feeBps)}
                      value={config.feeOverrides[id] ?? ""}
                      onChange={(e) => setOverride(id, e.target.value)}
                      style={{ ...inputStyle, width: 62, textAlign: "right" }}
                    />
                    <span style={{ ...monoLabel(SIZE.micro), color: DIM, width: 54, textAlign: "right" }}>
                      = {effectiveFeeBps(config, id)} bps
                    </span>
                  </div>
                ))}
                {config.markets.length === 0 && (
                  <span style={{ ...body(SIZE.note, 1.6), color: FAINT }}>List a market first.</span>
                )}
              </div>
            </div>

            {/* A paragraph on how to use per-market pricing competitively went here. It was
                strategy advice, not help text — the operator setting an override knows why they
                want one. The half worth keeping is the limitation. */}
            <p style={{ ...body(SIZE.note, 1.5), color: FAINT, margin: "12px 0 0", lineHeight: 1.6 }}>
              The clamp here is a convenience — the cap is enforced at fill time.
            </p>
          </div>
        </Panel>
      </Grid>

      <Grid min={330}>
        <Panel
          title="Referral programme"
          blurb="Your own growth loop, funded from your own fee."
          right={
            <Toggle
              on={config.referral.enabled}
              onChange={(on) => patch({ referral: { ...config.referral, enabled: on } })}
            />
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, opacity: config.referral.enabled ? 1 : 0.45 }}>
            <Row label="Referrer share" hint="Of your venue fee, paid to whoever brought the trader.">
              <NumberField
                value={config.referral.referrerSharePct}
                max={100}
                suffix="%"
                onChange={(v) => patch({ referral: { ...config.referral, referrerSharePct: v } })}
              />
            </Row>
            <Row label="Referee discount" hint="Off your venue fee for the new trader.">
              <NumberField
                value={config.referral.refereeDiscountPct}
                max={100}
                suffix="%"
                onChange={(v) => patch({ referral: { ...config.referral, refereeDiscountPct: v } })}
              />
            </Row>
            <Row label="Attribution window" hint="How long a signup stays credited to the referrer.">
              <NumberField
                value={config.referral.attributionWindowDays}
                max={365}
                suffix="d"
                onChange={(v) => patch({ referral: { ...config.referral, attributionWindowDays: v } })}
              />
            </Row>

            <div style={{ paddingTop: 12 }}>
              <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>ACTIVE CODES</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {config.referral.codes.map((c) => (
                  <div
                    key={c.code}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "7px 9px",
                      background: SUNK,
                      border: `1px solid ${L2}`,
                      borderRadius: R_SM,
                    }}
                  >
                    <span style={{ ...dataType(), color: HI }}>{c.code}</span>
                    <span style={{ ...body(SIZE.note, 1.5), color: FAINT, flex: 1 }}>{c.owner}</span>
                    <span style={{ ...monoLabel(SIZE.micro), color: MUT }}>{c.signups} signups</span>
                  </div>
                ))}
              </div>
            </div>

            <p style={{ ...body(SIZE.note, 1.5), color: FAINT, margin: "12px 0 0", lineHeight: 1.6 }}>
              {/* The reassurance that "the maths never goes negative" is a consequence the
                  operator derives from the first sentence in about a second. */}
              A referral splits <em>your</em> fee, never the exchange&apos;s — so the most you can give away
              is 100% of your own take.
            </p>
          </div>
        </Panel>

        <Panel
          title="Sub-builder codes"
          blurb="Partners building on you, the way you build on Nexus."
          right={<Pill tone="info">{config.subBuilders.filter((s) => s.active).length} active</Pill>}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {config.subBuilders.map((sub, i) => (
              <div
                key={sub.code}
                style={{
                  border: `1px solid ${L2}`,
                  borderRadius: R_SM,
                  background: SUNK,
                  padding: "10px 11px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ ...dataType(), color: HI, flex: 1 }}>{sub.code}</span>
                  <Toggle
                    on={sub.active}
                    onChange={(on) =>
                      setConfig((c) => {
                        const next = [...c.subBuilders];
                        next[i] = { ...sub, active: on };
                        return { ...c, subBuilders: next };
                      })
                    }
                  />
                </div>
                <span style={{ ...body(SIZE.note, 1.6), color: MUT }}>{sub.label}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ ...monoLabel(SIZE.micro), color: FAINT, flex: 1 }}>REVENUE SHARE</span>
                  <NumberField
                    value={sub.revenueSharePct}
                    max={100}
                    suffix="%"
                    onChange={(v) =>
                      setConfig((c) => {
                        const next = [...c.subBuilders];
                        next[i] = { ...sub, revenueSharePct: v };
                        return { ...c, subBuilders: next };
                      })
                    }
                  />
                </div>
              </div>
            ))}
            <p style={{ ...body(SIZE.note, 1.5), color: FAINT, margin: "4px 0 0", lineHeight: 1.6 }}>
              {/* The closing analogy — "precisely the relationship you have with Nexus, one level
                  up" — was a pleasing observation about the model, not a fact the operator needs
                  while setting a split. */}
              The exchange sees one builder code — yours. The split with a sub-partner is your bookkeeping,
              computed by your proxy from the same fills.
            </p>
          </div>
        </Panel>
      </Grid>

      <Grid min={330}>
        <Panel title="Trading policy" blurb="What your traders can do on your surface.">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {(Object.keys(config.orderTypes) as (keyof typeof config.orderTypes)[]).map((key) => (
              <Row key={key} label={ORDER_TYPE_LABEL[key]} hint={ORDER_TYPE_HINT[key]}>
                <Toggle
                  on={config.orderTypes[key]}
                  onChange={(on) => patch({ orderTypes: { ...config.orderTypes, [key]: on } })}
                />
              </Row>
            ))}
          </div>
        </Panel>

        <Panel title="Interface" blurb="Surface-level choices that need no code change.">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Row label="Default market" hint="What a first-time visitor lands on.">
              <select
                value={config.ui.defaultMarket}
                onChange={(e) => patch({ ui: { ...config.ui, defaultMarket: e.target.value } })}
                style={{ ...inputStyle, minWidth: 150 }}
              >
                {config.markets.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Funding countdown" hint="Show the time to the next funding payment.">
              <Toggle
                on={config.ui.showFundingCountdown}
                onChange={(on) => patch({ ui: { ...config.ui, showFundingCountdown: on } })}
              />
            </Row>
            <Row label="Leaderboard" hint="Competitions and season standings.">
              <Toggle
                on={config.ui.showLeaderboard}
                onChange={(on) => patch({ ui: { ...config.ui, showLeaderboard: on } })}
              />
            </Row>
            <Row label="Guest browsing" hint="Let visitors read the book before connecting a wallet.">
              <Toggle
                on={config.ui.allowGuestBrowsing}
                onChange={(on) => patch({ ui: { ...config.ui, allowGuestBrowsing: on } })}
              />
            </Row>
          </div>
        </Panel>
      </Grid>

      <Panel
        title="Branded API"
        blurb="Serve the whole exchange as yours."
        right={<Pill tone="warn">PHASE 5</Pill>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Row label="API domain" hint="Your traders' bots hit this host and never see Nexus.">
            <input
              placeholder="api.acme.xyz"
              value={config.api.domain}
              onChange={(e) => patch({ api: { ...config.api, domain: e.target.value } })}
              style={{ ...inputStyle, width: 190 }}
            />
          </Row>
          <Row label="Key prefix" hint="Keys mint as <prefix>_live_… and <prefix>_test_…">
            <input
              value={config.api.keyPrefix}
              onChange={(e) => patch({ api: { ...config.api, keyPrefix: e.target.value.replace(/[^a-z0-9]/gi, "") } })}
              style={{ ...inputStyle, width: 110 }}
            />
          </Row>
          <Row label="Branded spec & SDK" hint="Publish an OpenAPI document and packages under your name.">
            <Toggle
              on={config.api.brandedSpec}
              onChange={(on) => patch({ api: { ...config.api, brandedSpec: on } })}
            />
          </Row>
          <Row label="Rate limit" hint="Per-partner request budget.">
            <NumberField
              value={config.api.rateLimitPerSec}
              max={5000}
              suffix="/s"
              onChange={(v) => patch({ api: { ...config.api, rateLimitPerSec: v } })}
            />
          </Row>
        </div>
      </Panel>

      <Panel
        title="nexus.json"
        blurb="The file this console edits. Commit it — the deploy is a git push."
        right={
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            {dirty ? <Pill tone="warn">MODIFIED</Pill> : <Pill tone="mute">UNCHANGED</Pill>}
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                void navigator.clipboard?.writeText(json);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? "COPIED" : "COPY"}
            </button>
          </div>
        }
      >
        <pre
          style={{
            margin: 0,
            padding: 12,
            /* TERM, not a hand-mixed #08080a: the inset-field surface is a token,
               and a literal here would not follow a re-skinned tenant. */
            background: TERM,
            border: `1px solid ${L2}`,
            borderRadius: R_SM,
            fontFamily: MONO,
            fontSize: SIZE.data,
            lineHeight: 1.65,
            color: TXT,
            overflowX: "auto",
            maxHeight: 420,
          }}
        >
          {/* The file the console exists to produce, highlighted like any other
              JSON. It is the artefact an operator copies out, so it should read
              the way it will read in their editor. */}
          {json.split("\n").map((line, i) => (
            <div key={i}>
              {tokenizeLine(line, "json").map((t, j) => (
                <span key={j} style={{ color: TOKEN_COLOR[t.kind], fontWeight: TOKEN_WEIGHT[t.kind] }}>
                  {t.text}
                </span>
              ))}
              {line === "" ? " " : null}
            </div>
          ))}
        </pre>
        {/* The drift argument for why there is no Save button was two sentences of design
            rationale. The operator needs the fact, not the reasoning. */}
        <p style={{ ...body(SIZE.note, 1.6), color: FAINT, margin: "10px 0 0" }}>
          Edits live in this tab only. Commit the file — there is no Save.
        </p>
      </Panel>
    </>
  );
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  limit: "Limit",
  market: "Market",
  stop: "Stop / take-profit",
  scale: "Scale ladders",
  twap: "TWAP",
};

const ORDER_TYPE_HINT: Record<string, string> = {
  limit: "Resting orders. Turning this off leaves only marketable flow.",
  market: "Immediate execution, subject to the slippage cap.",
  stop: "Triggered orders — needs a trigger price on submission.",
  scale: "One draft, many rungs. Popular with desks, noisy for retail.",
  twap: "Sliced execution on a fixed clock.",
};

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      /*
       * THE TARGET IS 32px TALL; THE TRACK IS STILL 21.
       *
       * A 38×21 switch is the shape this control should be — any taller and it
       * stops reading as a switch — but 21px is under this project's 32px hard
       * floor for a control you have to hit, and these govern whether an order
       * type exists on the venue. So the button grows a transparent 32px hit
       * area and paints the same pill inside it. Nothing moves visually; the
       * thumb gets 50% more to aim at.
       */
      style={{
        width: 38,
        height: TAP_FLOOR,
        border: "none",
        background: "none",
        display: "inline-flex",
        alignItems: "center",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 38,
          height: 21,
          borderRadius: 11,
          border: `1px solid ${on ? GREEN : L3}`,
          background: on ? `${GREEN}2e` : SUNK,
          position: "relative",
          display: "block",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 19 : 2,
            width: 15,
            height: 15,
            borderRadius: "50%",
            background: on ? GREEN : MUT,
            transition: "left 120ms ease",
          }}
        />
      </span>
    </button>
  );
}

function NumberField({
  value,
  max,
  suffix,
  onChange,
}: {
  value: number;
  max: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
        style={{ ...inputStyle, width: 66, textAlign: "right" }}
      />
      <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>{suffix}</span>
    </span>
  );
}
