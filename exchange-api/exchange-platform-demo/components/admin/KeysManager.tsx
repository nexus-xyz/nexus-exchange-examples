"use client";

/*
 * Platform API keys, as things you can actually do.
 *
 * WHAT THESE KEYS ARE (EP-008). Credentials for calling *our* admin API — the
 * same surface this console calls. They are not exchange HMAC trading keys, and
 * this component used to blur the two by handing over signing advice with the
 * secret. Exchange request signing is documented once, on API reference →
 * Signing, beside the canonical string it is about.
 *
 * WHAT LEFT. `WebhookManager` lived at the bottom of this file — endpoint list,
 * add-endpoint field, and a SEND TEST EVENT control — and is gone with EP-010
 * along with the pane that rendered it.
 *
 * THE ONE-TIME SECRET IS THE WHOLE POINT OF THIS COMPONENT. The copy on the page
 * has always said the secret is shown once and is not recoverable; a console
 * where creating a key is a decorative button never has to honour that. So the
 * reveal is built as the real thing: the secret arrives in the create response,
 * lives in component state, is never re-fetchable, and the panel refuses to close
 * until the operator says they have stored it. If they navigate away, it is gone —
 * which is exactly what happens with the real credential store.
 *
 * ROTATION ORDER IS ENFORCED BY THE UI, not just documented in it. Create → deploy
 * → revoke. Revoking first is an outage, and it is the most common way a team
 * takes its own venue down, so the revoke control on a key stays behind a
 * checkbox that asserts the replacement is already live. A warning nobody has to
 * interact with is a warning nobody reads.
 */

import { useState } from "react";

import {
  AMBER,
  ARCHIVO,
  DIM,
  FAINT,
  GREEN,
  L1,
  L2,
  MONO,
  MUT,
  R_SM,
  RED,
  SUNK,
  TAP_CONTROL,
  TAP_FLOOR,
  TXT,
  monoLabel,
} from "@/lib/theme";
import type { ApiKey } from "@/lib/venue/team-model";
import { buttonStyle, inputStyle, primaryButtonStyle } from "./shell";
import { EmptyState, fmt } from "./parts";
import { SIZE, body, data as dataType } from "./type";
import { CopyField, SortableTable, postAdmin } from "./interactive";

const SCOPES = ["read", "trade", "withdraw"] as const;
type Scope = (typeof SCOPES)[number];

interface MintedKey {
  id: string;
  secret: string;
  env: "test" | "live";
  label: string;
  scopes: string[];
}

export function KeysManager({ keys, env }: { keys: ApiKey[]; env: "test" | "live" }) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read", "trade"]);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [stored, setStored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<Record<string, string>>({});

  const create = async () => {
    setError(null);
    try {
      const response = await fetch("/api/admin/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "key.create", target: label, env, scopes }),
      });
      const data = (await response.json()) as { key?: MintedKey; error?: string };
      if (!response.ok || !data.key) {
        setError(data.error ?? `the mint failed with ${response.status}`);
        return;
      }
      setMinted(data.key);
      setStored(false);
      setCreating(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "the request could not be sent");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── the one-time secret ──────────────────────────────────────────── */}
      {minted && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "14px 15px",
            border: `1px solid ${AMBER}44`,
            background: `${AMBER}0d`,
            borderRadius: R_SM,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <span style={{ ...monoLabel(SIZE.micro), color: AMBER }}>SHOWN ONCE</span>
            <span style={{ ...body(SIZE.body, 1.6), color: TXT, flex: 1, minWidth: 200 }}>
              This secret is not stored anywhere the console can read it back. Copy it into your deployment
              environment now — if you lose it the only fix is minting a replacement.
            </span>
          </div>

          <CopyField label="KEY ID" value={minted.id} wide />
          <CopyField label="SECRET" value={minted.secret} mask wide />

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "9px 10px",
              background: SUNK,
              border: `1px solid ${L2}`,
              borderRadius: R_SM,
            }}
          >
            <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>PASTE INTO YOUR ENVIRONMENT</span>
            {/* NEXUS_PLATFORM_*, not NEXUS_API_* (EP-008). The NEXUS_API_ pair is
                the EXCHANGE credential — it is what the SDK snippet on API
                reference takes, and what the Overview checklist looks for — and
                handing a platform key over under that name was the conflation
                this pane is being corrected for. Two credentials, two names. */}
            <code style={{ ...dataType(SIZE.note), color: MUT, wordBreak: "break-all", lineHeight: 1.7 }}>
              NEXUS_PLATFORM_KEY_ID={minted.id}
              <br />
              NEXUS_PLATFORM_SECRET={"•".repeat(24)}
            </code>
            {/* CUT: the hex-decode-before-signing warning. It is a rule of the
                EXCHANGE's HMAC scheme, not of this credential, and it is already
                stated on API reference → Signing beside the canonical string it
                is about. Repeating it here was what made these read as exchange
                trading keys. */}
            <span style={{ ...body(SIZE.note, 1.55), color: FAINT }}>
              This key authenticates calls to the venue admin API — the surface this console itself calls. It
              places no orders.
            </span>
          </div>

          {/* The gate on the whole rotation, so the row carries the floor height
              rather than leaving it to a 13px default checkbox. */}
          <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", minHeight: TAP_FLOOR }}>
            <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} style={{ accentColor: GREEN, width: 16, height: 16, flexShrink: 0, margin: 0 }} />
            <span style={{ ...body(SIZE.body, 1.6), color: MUT }}>
              I have stored this secret somewhere it survives this tab.
            </span>
          </label>

          <button
            type="button"
            disabled={!stored}
            onClick={() => setMinted(null)}
            style={{
              ...buttonStyle,
              alignSelf: "flex-start",
              opacity: stored ? 1 : 0.5,
              cursor: stored ? "pointer" : "not-allowed",
            }}
          >
            DISMISS
          </button>
        </div>
      )}

      {/* ── create ───────────────────────────────────────────────────────── */}
      {creating ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 11,
            padding: "13px 14px",
            background: SUNK,
            border: `1px solid ${L2}`,
            borderRadius: R_SM,
          }}
        >
          <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>NEW {env.toUpperCase()} KEY</span>
          <input
            value={label}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What will use this key? e.g. Nightly reporting job"
            aria-label="Key label"
            style={{ ...inputStyle, width: "100%" }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>SCOPES</span>
            {SCOPES.map((scope) => {
              const on = scopes.includes(scope);
              return (
                <label
                  key={scope}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 8px",
                    /* A scope chip is a control, and the chip — not the 13px
                       browser checkbox inside it — is what a thumb aims at. The
                       36–40 band, same as the other chips on this console. */
                    minHeight: TAP_CONTROL,
                    border: `1px solid ${on ? `${GREEN}44` : L2}`,
                    background: on ? `${GREEN}0a` : "transparent",
                    borderRadius: R_SM,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setScopes((s) => (on ? s.filter((x) => x !== scope) : [...s, scope]))}
                    style={{ accentColor: GREEN, width: 16, height: 16, flexShrink: 0, margin: 0 }}
                  />
                  <span style={{ ...monoLabel(SIZE.micro), color: on ? TXT : MUT }}>{scope}</span>
                </label>
              );
            })}
          </div>
          {scopes.includes("withdraw") && (
            <span style={{ ...body(SIZE.note, 1.6), color: AMBER }}>
              A withdraw scope moves money. It is available to an Owner only, and a key that holds it should
              never be deployed to anything a browser can reach.
            </span>
          )}
          {error && <span style={{ ...dataType(), color: RED }}>{error}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={primaryButtonStyle} onClick={create} disabled={scopes.length === 0}>
              MINT KEY
            </button>
            <button type="button" style={buttonStyle} onClick={() => setCreating(false)}>
              CANCEL
            </button>
          </div>
        </div>
      ) : null}

      {/* ── the keys themselves ──────────────────────────────────────────── */}
      {keys.length === 0 ? (
        <EmptyState
          title="No keys yet"
          /* Reframed with EP-008: the old blurb ("a key is what lets it sign an
             order") described an exchange trading key. A platform key is what
             lets something other than this browser session read and change the
             organisation's own records. */
          blurb="Everything on this console is an admin API call. A key is what lets your own tooling make the same calls."
          action={
            <button type="button" style={primaryButtonStyle} onClick={() => setCreating(true)}>
              CREATE THE FIRST KEY
            </button>
          }
        />
      ) : (
        <SortableTable
          /* The mint control lives on the table's own toolbar rather than in a
             full-width band above it — the action and the list it changes should be
             within a glance of each other, and the band cost 40px to say one thing. */
          toolbar={
            creating ? undefined : (
              <button type="button" style={primaryButtonStyle} onClick={() => setCreating(true)}>
                CREATE {env.toUpperCase()} KEY
              </button>
            )
          }
          searchPlaceholder="Filter keys by id, label or scope…"
          initialSort={4}
          minWidth={720}
          head={[
            { label: "KEY", align: "left" },
            { label: "LABEL", align: "left" },
            { label: "ENV" },
            { label: "SCOPES", align: "left" },
            { label: "24H REQUESTS" },
            { label: "LAST USED" },
          ]}
          rows={keys.map((k) => ({
            id: k.id,
            cells: [
              { text: k.id, align: "left", color: revoked[k.id] ? FAINT : TXT },
              { text: k.label, align: "left", color: MUT, mono: false },
              { text: k.env, color: k.env === "live" ? AMBER : GREEN },
              { text: k.scopes.join(" · "), align: "left", color: MUT },
              { text: fmt.int(k.requests24h) ?? "—", sortValue: k.requests24h },
              {
                text: k.lastUsedMs === null ? "never" : fmt.day(k.lastUsedMs),
                sortValue: k.lastUsedMs ?? 0,
                color: k.lastUsedMs === null ? FAINT : undefined,
              },
            ],
          }))}
        />
      )}

      {/* ── rotation, in the order that is not an outage ─────────────────── */}
      <RotationPanel keys={keys} revoked={revoked} onRevoke={(id, message) => setRevoked((r) => ({ ...r, [id]: message }))} />
    </div>
  );
}

/**
 * Rotation, framed as a sequence rather than as a button.
 *
 * The ordering is the entire content: create, deploy, *then* revoke. Every team
 * that has taken its own venue down did it by revoking first, so the revoke
 * control is gated on an explicit assertion that the replacement is already
 * serving traffic — the assertion is the point, not the click.
 */
function RotationPanel({
  keys,
  revoked,
  onRevoke,
}: {
  keys: ApiKey[];
  revoked: Record<string, string>;
  onRevoke: (id: string, message: string) => void;
}) {
  const [deployed, setDeployed] = useState(false);
  const [target, setTarget] = useState(keys[0]?.id ?? "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11, borderTop: `1px solid ${L1}`, paddingTop: 15 }}>
      <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>ROTATE A KEY</span>

      <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
        {[
          "Mint the replacement above. The old key keeps working — two keys can be valid at once.",
          "Deploy the replacement and watch its request count start moving on this page.",
          "Only then revoke the old one. Revoking before the replacement is live is an outage, and it is the usual way a venue goes down.",
        ].map((line, i) => (
          <li key={i} style={{ ...body(SIZE.body, 1.6), color: MUT }}>
            {line}
          </li>
        ))}
      </ol>

      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Key to revoke" style={{ ...inputStyle, minWidth: 190 }}>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.id} — {k.label}
            </option>
          ))}
        </select>
        {/* The assertion that unlocks a revoke — the one control between an
            operator and their own outage, so it gets a real hit area too. */}
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer", minHeight: TAP_FLOOR }}>
          <input type="checkbox" checked={deployed} onChange={(e) => setDeployed(e.target.checked)} style={{ accentColor: GREEN, width: 16, height: 16, flexShrink: 0, margin: 0 }} />
          <span style={{ ...body(SIZE.body, 1.6), color: MUT }}>The replacement is deployed and serving.</span>
        </label>
        <button
          type="button"
          disabled={!deployed || !target}
          onClick={async () => onRevoke(target, await postAdmin("/api/admin/actions", { action: "key.revoke", target }))}
          style={{
            ...buttonStyle,
            color: deployed ? RED : FAINT,
            border: `1px solid ${deployed ? `${RED}55` : L2}`,
            background: deployed ? `${RED}0d` : SUNK,
            cursor: deployed ? "pointer" : "not-allowed",
          }}
        >
          REVOKE
        </button>
      </div>

      {Object.entries(revoked).map(([id, message]) => (
        <span key={id} style={{ ...body(SIZE.note, 1.6), color: MUT }}>
          <span style={{ fontFamily: MONO, color: TXT }}>{id}</span> — {message}
        </span>
      ))}
    </div>
  );
}
