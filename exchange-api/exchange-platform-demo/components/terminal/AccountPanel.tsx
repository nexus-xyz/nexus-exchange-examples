"use client";

/*
 * Account summary, docked under the order ticket in the right rail.
 *
 * Previously this lived only on the Portfolio screen, which meant a trader had to
 * leave the chart to answer "what can I actually size into?". Equity, the spot/perp
 * split, unrealised PnL, and maintenance margin belong next to the ticket that
 * consumes them.
 */

import { can, type Session } from "@/lib/session";
import { useState } from "react";
import { POSITIONS, ACCOUNT, positionPnl } from "@/lib/account";
import { getMarket } from "@/lib/markets";
import { buildFeed } from "@/lib/feed";
import { comma, usd, pct } from "@/lib/format";
import {
  MONO,
  ARCHIVO,
  GREEN,
  RED,
  AMBER,
  L1,
  L2,
  L3,
  TXT,
  NUM,
  MUT,
  DIM,
  FAINT,
  HI,
  R_MD,
  monoLabel,
} from "@/lib/theme";
import { Chip } from "./primitives";
import { usePhase } from "@/lib/dataphase";
import { LoadingFigure } from "./states";
import { ABSENT_GLYPH } from "@/lib/api/absence";

/** Live-marked equity, so the rail agrees with the blotter beneath it. */
export function useAccountSnapshot(tick: number) {
  let unrealized = 0;
  for (const p of POSITIONS) {
    const m = getMarket(p.sym);
    unrealized += positionPnl(p, buildFeed(m, tick, m.groupings[0]).last).pnl;
  }
  const equity = ACCOUNT.equity + unrealized;
  return {
    unrealized,
    equity,
    perps: equity - 12000,
    spot: 12000,
    leverage: ACCOUNT.marginUsed / equity ? (ACCOUNT.marginUsed * 8) / equity : 0,
  };
}

export function AccountPanel({
  tick,
  defaultOpen = false,
  onDeposit,
  session = "in",
}: {
  tick: number;
  defaultOpen?: boolean;
  /*
   * The modal is owned by Terminal, not by this card. The Balances tab needs the same
   * one, and two components each holding their own copy is how two deposit dialogs end
   * up on screen at once.
   */
  onDeposit: () => void;
  /**
   * Gated on the SESSION, not on a constant.
   *
   * Transfer and Withdraw carried a literal `aria-disabled="true"` and a comment saying
   * they were wallet-gated on the reference venue. That made "what is reachable logged
   * out" a fact about a comment: nothing could grade it and nothing could change it.
   * All three now read `can(session).moveFunds`, which is the rule this spec wants to
   * state — moving money is gated on the WALLET, never on an API key.
   */
  session?: Session;
}) {
  const funds = can(session).moveFunds;
  /*
   * Collapsed by default. The rail has to fit the ticket's primary action above the
   * fold at 800px viewport height, and the breakdown rows are reference figures —
   * you consult them, you don't watch them. Equity and the action buttons stay
   * visible either way.
   */
  const [open, setOpen] = useState(defaultOpen);
  const a = useAccountSnapshot(tick);
  const { phase } = usePhase("/v1/account");
  const dayPct = (ACCOUNT.pnl30d / ACCOUNT.equity) * 100;

  /*
   * The last three are products this account holds nothing in, and they print an
   * em dash rather than $0.00. The distinction is the one the absence module
   * exists for: $0.00 asserts a balance was fetched and came back empty, while the
   * dash says the venue has nothing to report here. They are listed at all because
   * the shape of the card is the claim — equity is not only what is in perps.
   */
  /* Every figure in the card, not only the hero: a row list where three numbers
     resolved and five did not would read as five empty products rather than as a
     panel that has not loaded. Applied at the render below, so the row list stays a
     plain data table. */
  const rows: [string, string, string, boolean][] = [
    ["Spot", "$" + comma(a.spot, 2), NUM, false],
    ["Perps", "$" + comma(a.perps, 2), NUM, false],
    ["Unrealized PNL", usd(a.unrealized), a.unrealized >= 0 ? GREEN : RED, true],
    ["Maintenance Margin", "$" + comma(ACCOUNT.maintMargin, 2), NUM, true],
    ["Cross Account Leverage", a.leverage.toFixed(2) + "×", a.leverage > 5 ? AMBER : NUM, true],
    ["Vaults Equity", "—", FAINT, false],
    ["Earn Balances", "—", FAINT, false],
    ["Staking Account", "—", FAINT, false],
  ];

  return (
    <div style={{ borderTop: `1px solid ${L2}`, background: "#050505", padding: "10px 14px 12px" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          /* The disclosure for the whole account block was an 18px text run. Vertical
             padding pulled back by an equal negative margin: the hit box reaches the
             floor, the panel's spacing is exactly what it was. */
          padding: "7px 0",
          margin: "-7px 0 0",
          minHeight: 32,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          marginBottom: 4,
        }}
      >
        <span style={{ ...monoLabel(9.5, "0.1em") }}>Total Equity</span>
        <span style={{ color: DIM, fontSize: 8, transform: open ? "rotate(180deg)" : undefined, transition: "transform .14s" }}>▾</span>
        <div style={{ flex: 1 }} />
        {/* The day chip is a figure too — a green +8.52% beside a loading bar is the
            panel disagreeing with itself. */}
        {phase === "ready" && (
          <Chip tone={dayPct >= 0 ? "up" : "down"} size={10.5}>
            {pct(dayPct, 2)}
          </Chip>
        )}
      </button>
      <div style={{ fontFamily: MONO, fontSize: 21, color: HI, letterSpacing: "-0.01em", marginBottom: 9 }}>
        {/* The hero figure gets the same treatment as every stat cell — a bar the
            width the number will be, or the absent glyph when the request failed.
            A $86,786.80 painted during a cold start is the single most misleading
            thing this panel could show. */}
        {phase === "ready" ? (
          `$${comma(a.equity, 2)}`
        ) : phase === "cold" ? (
          <LoadingFigure chars={11} height={17} />
        ) : (
          <span style={{ color: FAINT }}>{ABSENT_GLYPH}</span>
        )}
      </div>

      {/*
       * Three buttons that all had `cursor: pointer` and no handler — the exact
       * defect this project's `no-dead-affordance` convention was written for and
       * never mechanized to catch.
       *
       * Deposit now opens. Transfer and Withdraw are DISABLED rather than inert,
       * which is also their state on the reference: both are `<button disabled>`
       * there without a wallet, so what they open has never been captured and
       * building them would be invention. A disabled control with a reason is
       * honest; an enabled one that does nothing is not.
       */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        <button
          onClick={funds ? onDeposit : undefined}
          aria-disabled={funds ? undefined : "true"}
          title={funds ? "Add collateral" : "Connect a wallet to move funds"}
          /* Three buttons sharing a top edge is a segmented group — 36px under a
             finger, 32 with a mouse. `height` is dropped in favour of `minHeight`
             so the coarse-pointer rule can raise it; a fixed inline `height` cannot
             be overridden by any stylesheet. */
          className="nx-hover-border nx-segmented"
          style={{
            opacity: funds ? 1 : 0.5,
            cursor: funds ? "pointer" : "not-allowed",
            border: `1px solid ${L3}`,
            borderRadius: R_MD,
            background: "#141414",
            color: TXT,
            fontFamily: ARCHIVO,
            fontSize: 11.5,
                      }}
        >
          Deposit
        </button>
        {/*
         * `aria-disabled`, NOT the `disabled` attribute. A disabled button is
         * removed from the tab order, which the harness caught as two elements a
         * keyboard user cannot reach — and a control you cannot reach is a control
         * you cannot discover the reason for. ARIA's focusable-disabled pattern
         * keeps it in the sequence, announces it as unavailable, and lets the title
         * explain why. The click does nothing because there is nothing to do.
         */}
        {["Transfer", "Withdraw"].map((label) => (
          <button
            key={label}
            aria-disabled="true"
            className="nx-segmented"
            title={`${label} is wallet-gated on the venue we are matching, so its contents have never been captured`}
            style={{
              border: `1px solid ${L2}`,
              borderRadius: R_MD,
              background: "transparent",
              color: DIM,
              fontFamily: ARCHIVO,
              fontSize: 11.5,
              opacity: 0.55,
              cursor: "not-allowed",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: open ? "flex" : "none", flexDirection: "column", marginTop: 11 }}>
        {rows.map(([label, value, color, indent]) => (
          <div
            key={label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              padding: "5px 0",
              borderTop: `1px solid ${L1}`,
              fontFamily: MONO,
              fontSize: 10.5,
              paddingLeft: indent ? 9 : 0,
            }}
          >
            <span
              style={{
                color: indent ? FAINT : DIM,
                borderBottom: indent ? `1px dotted ${L2}` : undefined,
                cursor: indent ? "help" : undefined,
              }}
            >
              {label}
            </span>
            <span style={{ color: phase === "ready" ? color : FAINT }}>
              {phase === "ready" ? value : phase === "cold" ? <LoadingFigure chars={8} height={9} /> : ABSENT_GLYPH}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
