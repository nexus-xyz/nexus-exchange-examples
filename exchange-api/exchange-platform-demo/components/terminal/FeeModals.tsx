"use client";

/*
 * The two modals behind the Portfolio header's `View Volume` and `View Fee Schedule`.
 *
 * Built from captured screenshots of the reference venue's volume-history and
 * fee-schedule surfaces, captured from a connected session — neither is reachable
 * logged out, which is why they were unknown until now.
 *
 * They are the same dialog shell, and the shell is the one `DepositModal` already
 * uses: fixed, centred, Escape to close, a click-off shield, and a `role="dialog"`
 * with `aria-modal`. Kept as one local component here rather than pulled up into a
 * primitive, because three is the number at which a shared modal starts to be worth
 * it and we are at three — noted for whoever adds the fourth.
 */

import { useState, type ReactNode } from "react";
import { useHotkey } from "@/hooks/useHotkey";
import { ACCOUNT } from "@/lib/account";
import { comma } from "@/lib/format";
import { MAKER_RATE, TAKER_RATE, VENUE_TAKER_RATE } from "./OrderTicket";
import {
  AMBER,
  ARCHIVO,
  DIM,
  FAINT,
  HI,
  L1,
  L2,
  L3,
  MONO,
  MUT,
  NUM,
  PANEL,
  R_MD,
  R_LG,
  R_XL,
  SUNK,
  TERM,
  TXT,
  monoLabel,
} from "@/lib/theme";

/**
 * A centred dialog at desktop, a BOTTOM SHEET on a phone.
 *
 * Captured at 390 for the first time (`shots/responsive/mobile.modal.{volume,fees}`):
 * theirs arrive from the bottom edge, rounded on the top two corners only, sized to
 * their content, with a drag handle and the page dimmed behind. Ours was the desktop
 * dialog scaled down — centred, all four corners rounded, floating in the middle of
 * the screen with 51px of gap above it and no relationship to any edge.
 *
 * The difference is not decoration. A centred dialog on a phone has no origin: it did
 * not come from anywhere and there is no direction to dismiss it in. A sheet came from
 * the bottom and goes back there, which is the only affordance a thumb can act on
 * without hunting for a close button.
 *
 * Same keyframes as the market selector, so every sheet in the app arrives the same way.
 */
function Dialog({
  title,
  onClose,
  width = 460,
  compact = false,
  children,
}: {
  title: string;
  onClose: () => void;
  width?: number;
  /** Phone width: render as a bottom sheet. */
  compact?: boolean;
  children: ReactNode;
}) {
  useHotkey("Escape", onClose);
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <>
      <div
        onClick={onClose}
        className={compact && !reduced ? "nx-scrim" : undefined}
        style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.62)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={reduced ? undefined : compact ? "nx-sheet" : "nx-dialog"}
        style={{
          position: "fixed",
          zIndex: 61,
          ...(compact
            ? {
                left: 0,
                right: 0,
                bottom: 0,
                maxHeight: "86vh",
                borderRadius: `${R_XL}px ${R_XL}px 0 0`,
                borderBottom: "none",
              }
            : {
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width,
                maxWidth: "94vw",
                maxHeight: "88vh",
                borderRadius: R_LG,
              }),
          overflowY: "auto",
          overscrollBehavior: "contain",
          background: PANEL,
          border: `1px solid ${L3}`,
          boxShadow: "0 30px 80px rgba(0,0,0,0.86)",
        }}
      >
        {compact && (
          <div
            aria-hidden="true"
            style={{ width: 36, height: 4, borderRadius: 2, background: L3, margin: "9px auto 0" }}
          />
        )}
        <div style={{ position: "sticky", top: 0, background: PANEL, padding: "18px 20px 10px", zIndex: 1 }}>
          <button
            onClick={onClose}
            aria-label={`Close ${title}`}
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              width: 32,
              height: 32,
              border: "none",
              background: "transparent",
              color: DIM,
              fontFamily: MONO,
              fontSize: 15,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: 17, color: HI }}>{title}</div>
        </div>
        <div style={{ padding: "0 20px 20px" }}>{children}</div>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────── volume history */

const VOL_COLS = "1.15fr 0.85fr 1fr 1fr";

/**
 * Fourteen daily rows and a total.
 *
 * `Date (UTC)` — explicitly UTC, even though the blotter's own time column follows the
 * viewer's timezone on their site. A fee period is a venue-wide window, so it has to be
 * stated in the venue's clock or two traders in different places would compute
 * different tiers from the same table.
 *
 * Exchange volume is the whole venue's; the two "weighted" columns are this account's
 * share of it. They are what the tier is actually computed from, which is why the
 * footnote about spot counting double sits under them rather than in the fee modal.
 */
function volumeRows(): { date: string; exchange: number; maker: number; taker: number }[] {
  const out = [];
  // Deterministic, and anchored to the fixtures' own epoch rather than to `new Date()`
  // so the table is identical on the server and the client.
  const day = 86_400_000;
  const end = Date.UTC(2026, 7, 1);
  for (let i = 0; i < 14; i++) {
    const ts = end - i * day;
    const d = new Date(ts);
    const seed = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const exchange = 1.4e9 + Math.abs(seed) * 4.2e9;
    const share = ACCOUNT.volume24h * (0.7 + Math.abs(seed) * 0.6);
    out.push({
      date: d.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
      exchange,
      maker: share * 0.42,
      taker: share * 0.58,
    });
  }
  return out;
}

const bn = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}m` : `$${comma(n, 2)}`;

export function VolumeHistoryModal({ open, onClose, compact = false }: { open: boolean; onClose: () => void; compact?: boolean }) {
  if (!open) return null;
  const rows = volumeRows();
  const total = rows.reduce(
    (a, r) => ({ exchange: a.exchange + r.exchange, maker: a.maker + r.maker, taker: a.taker + r.taker }),
    { exchange: 0, maker: 0, taker: 0 },
  );
  const makerShare = total.exchange > 0 ? (total.maker / total.exchange) * 100 : 0;

  const cell = (v: string, color = NUM) => (
    <span style={{ textAlign: "right", color, fontFamily: MONO, fontSize: 11 }}>{v}</span>
  );

  return (
    <Dialog title="Your Volume History" onClose={onClose} width={520} compact={compact}>
      <div role="table" aria-label="Volume history" style={{ border: `1px solid ${L1}`, borderRadius: R_MD, overflow: "hidden" }}>
        <div
          role="row"
          style={{
            display: "grid",
            gridTemplateColumns: VOL_COLS,
            gap: 8,
            padding: "8px 11px",
            background: TERM,
            ...monoLabel(9, "0.06em"),
            color: DIM,
          }}
        >
          <span role="columnheader">Date (UTC)</span>
          <span role="columnheader" style={{ textAlign: "right" }}>Exchange Volume</span>
          <span role="columnheader" style={{ textAlign: "right" }}>Your Weighted Maker Volume</span>
          <span role="columnheader" style={{ textAlign: "right" }}>Your Weighted Taker Volume</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.date}
            role="row"
            style={{
              display: "grid",
              gridTemplateColumns: VOL_COLS,
              gap: 8,
              padding: "6px 11px",
              borderTop: `1px solid ${L1}`,
              fontFamily: MONO,
              fontSize: 11,
              color: MUT,
            }}
          >
            <span>{r.date}</span>
            {cell(bn(r.exchange))}
            {cell(bn(r.maker))}
            {cell(bn(r.taker))}
          </div>
        ))}
        {/* Their total row is tinted, not bold — it reads as a summary rather than as
            another day. */}
        <div
          role="row"
          style={{
            display: "grid",
            gridTemplateColumns: VOL_COLS,
            gap: 8,
            padding: "7px 11px",
            borderTop: `1px solid ${L2}`,
            background: SUNK,
            fontFamily: MONO,
            fontSize: 11,
            color: AMBER,
          }}
        >
          <span>Total</span>
          {cell(bn(total.exchange), AMBER)}
          {cell(bn(total.maker), AMBER)}
          {cell(bn(total.taker), AMBER)}
        </div>
      </div>

      <div style={{ marginTop: 12, fontFamily: MONO, fontSize: 11, color: MUT }}>
        Your 14 day maker volume share is {makerShare.toFixed(2)}%
      </div>
      <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.55, color: FAINT }}>
        Dates do not include the current day. Perps and spot volume are counted together to
        determine your fee tier, and spot volume counts double toward your fee tier.
      </div>
    </Dialog>
  );
}

/* ───────────────────────────────────────────────────── fee schedule */

/**
 * The tier ladder, in their shape: seven tiers keyed on 14-day volume, with taker and
 * maker rates that both fall as volume rises — and a maker rate that reaches zero
 * rather than going negative, because the rebate is a separate discount above.
 *
 * Ours are OUR numbers, derived from the ticket's own VENUE_ rates so the schedule
 * and the order preview cannot disagree — and that constraint is why this file
 * changed when the ticket did. The ticket now shows one all-in fee rather than a
 * wholesale pair plus the venue's own row; a schedule still quoting the wholesale
 * numbers would have been the same leak in a second place, and worse, a trader
 * comparing the two would find them contradicting each other.
 *
 * The venue's fee is flat and does not tier: volume discounts the part of the rate
 * the exchange charges, and the operator's own cut is a fixed price they set. So the
 * ladder scales the wholesale component and adds the venue fee to every rung.
 *
 * Tier 0 is the rate a new account actually pays; the ladder below it is the shape
 * their tiers have.
 */
const TIERS = [
  { tier: 0, from: "≤ $5M", t: 1, m: 1 },
  { tier: 1, from: "> $5M", t: 0.86, m: 0.75 },
  { tier: 2, from: "> $25M", t: 0.71, m: 0.5 },
  { tier: 3, from: "> $100M", t: 0.57, m: 0.25 },
  { tier: 4, from: "> $500M", t: 0.5, m: 0 },
  { tier: 5, from: "> $2B", t: 0.43, m: 0 },
  { tier: 6, from: "> $7B", t: 0.36, m: 0 },
] as const;

const MARKET_TYPES = ["Perps", "Spot"] as const;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "9px 12px",
        border: `1px solid ${L2}`,
        borderRadius: R_MD,
        background: TERM,
        fontFamily: MONO,
        fontSize: 11.5,
      }}
    >
      <span style={{ color: FAINT }}>{label}</span>
      <span style={{ color: TXT }}>{value}</span>
    </div>
  );
}

export function FeeScheduleModal({ open, onClose, compact = false }: { open: boolean; onClose: () => void; compact?: boolean }) {
  const [market, setMarket] = useState<(typeof MARKET_TYPES)[number]>("Perps");
  if (!open) return null;
  // Spot is dearer than perps on their schedule; ours keeps the same relationship.
  const scale = market === "Spot" ? 1.4 : 1;

  const section = (title: string, body: ReactNode, note?: string) => (
    <div style={{ marginTop: 16 }}>
      <div style={{ ...monoLabel(9.5, "0.1em"), color: AMBER, marginBottom: 8 }}>{title}</div>
      {body}
      {note && (
        <div style={{ marginTop: 7, fontFamily: MONO, fontSize: 10.5, color: FAINT }}>{note}</div>
      )}
    </div>
  );

  return (
    <Dialog title="Fee Schedule" onClose={onClose} width={470} compact={compact}>
      {section(
        "Referral discount",
        <Field label="Referral Status" value="No referral discount" />,
        "This account does not have an active referral discount",
      )}
      {section(
        "Staking discount",
        <Field label="Staking Tier" value="No stake" />,
        "This account does not have an active stake",
      )}
      {section("Maker rebate", <Field label="Maker Rebate Tier" value="No rebate" />)}
      {section(
        "Volume tier",
        <>
          {/* The one live control in this dialog. Theirs is a select; ours is the same
              two values, because we list perps and the spot side is the comparison. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "7px 12px",
              border: `1px solid ${L2}`,
              borderRadius: R_MD,
              background: TERM,
              fontFamily: MONO,
              fontSize: 11.5,
            }}
          >
            <span style={{ color: FAINT }}>Market Type</span>
            <span style={{ display: "flex", gap: 4 }}>
              {MARKET_TYPES.map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  aria-pressed={market === m}
                  className="nx-inline-control"
                  style={{
                    padding: "3px 9px",
                    borderRadius: R_MD,
                    border: "none",
                    background: market === m ? "#141414" : "transparent",
                    color: market === m ? TXT : FAINT,
                    fontFamily: MONO,
                    fontSize: 11,
                    cursor: "pointer",
                    transition: "background .14s ease-out, color .14s ease-out",
                  }}
                >
                  {m}
                </button>
              ))}
            </span>
          </div>

          {/* role="table" is not decoration here: a bare role="row" has no required
              parent and its children have no required role, which is exactly the
              aria-required-children / aria-required-parent pair axe raises. The
              fourth instance of this on the project — a row is a table part, and
              declaring one without the other is declaring half a contract. */}
          <div
            role="table"
            aria-label="Volume tier fee schedule"
            style={{ marginTop: 10, border: `1px solid ${L1}`, borderRadius: R_MD, overflow: "hidden" }}
          >
            <div
              role="row"
              style={{
                display: "grid",
                gridTemplateColumns: "0.4fr 1fr 0.7fr 0.7fr",
                gap: 8,
                padding: "7px 11px",
                background: TERM,
                ...monoLabel(9, "0.06em"),
                color: DIM,
              }}
            >
              <span role="columnheader">Tier</span>
              <span role="columnheader">14 Day Volume</span>
              <span role="columnheader" style={{ textAlign: "right" }}>Taker*</span>
              <span role="columnheader" style={{ textAlign: "right" }}>Maker*</span>
            </div>
            {TIERS.map((r) => {
              /* The venue's flat fee is the difference between the wholesale rate
                 and what this venue charges. It does not tier — volume discounts the
                 exchange's part of the price, and the operator's own cut is a fixed
                 number they set — so it rides on every rung untouched. */
              const venueFee = VENUE_TAKER_RATE - TAKER_RATE;
              const taker = (TAKER_RATE * scale * r.t + venueFee) * 100;
              const maker = (Math.abs(MAKER_RATE) * scale * r.m + venueFee) * 100;
              return (
                <div
                  key={r.tier}
                  role="row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "0.4fr 1fr 0.7fr 0.7fr",
                    gap: 8,
                    padding: "6px 11px",
                    borderTop: `1px solid ${L1}`,
                    fontFamily: MONO,
                    fontSize: 11,
                    color: r.tier === 0 ? TXT : MUT,
                    background: r.tier === 0 ? SUNK : undefined,
                  }}
                >
                  <span role="cell">{r.tier}</span>
                  <span role="cell">{r.from}</span>
                  <span role="cell" style={{ textAlign: "right" }}>{taker.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%</span>
                  {/* Not green any more. Green meant "a rebate you receive", and with
                      the venue's fee folded in this column is a charge like the one
                      beside it — a fee wearing the colour of a credit is the single
                      way this consolidation could mislead. */}
                  <span role="cell" style={{ textAlign: "right", color: maker === 0 ? FAINT : TXT }}>
                    {maker === 0 ? "0%" : `${maker.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`}
                  </span>
                </div>
              );
            })}
          </div>
        </>,
        "* Rates given after referral, staking and maker rebate",
      )}

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${L1}`, fontFamily: MONO, fontSize: 11, color: FAINT }}>
        You can read more about fees in the{" "}
        <span style={{ color: AMBER, cursor: "pointer" }}>Nexus documentation</span>.
      </div>
    </Dialog>
  );
}
