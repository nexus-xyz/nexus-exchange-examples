"use client";

/*
 * The Portfolio screen — equity, margin, health, positions, and API keys.
 *
 * The API-keys panel is deliberately given equal weight to the positions table.
 * On this venue a key is a trader: it has its own fills, win rate, PnL, and rate
 * limit. Presenting keys as first-class accounts rather than as a settings page
 * is the screen's whole point.
 */

import { useMemo } from "react";
import { POSITIONS, API_KEYS, SUBACCOUNTS, FILLS, ACCOUNT, FEE_TIER, accountHealth, positionPnl } from "@/lib/account";
import { EPOCH_MS } from "@/lib/feed";
import { getMarket, fmtPrice } from "@/lib/markets";
import { buildFeed } from "@/lib/feed";
import { comma, usd, pct } from "@/lib/format";
import {
  R_XS,
  R_SM,
  TAP_CONTROL,
  R_MD,
  MONO,
  ARCHIVO,
  GREEN,
  RED,
  AMBER,
  L1,
  L2,
  TXT,
  NUM,
  MUT,
  DIM,
  FAINT,
  HI,
  monoLabel,
  titleLabel,
  sign,
} from "@/lib/theme";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MAKER_RATE, TAKER_RATE } from "../terminal/OrderTicket";
import { FeeScheduleModal, VolumeHistoryModal } from "../terminal/FeeModals";
import { Panel, Surface, SectionHeader, HeadRow, Row, Num, CornerTicks, Table } from "../terminal/primitives";
import { Sparkline } from "../charts/Sparkline";
import { EquityCurve } from "../charts/EquityCurve";
import { usePhase } from "@/lib/dataphase";
import { LoadingFigure, TableState } from "../terminal/states";
import { ABSENT_GLYPH } from "@/lib/api/absence";

/* Their three selectors, verbatim from the logged-in pass (findings.portfolio.md §2). */
const ACCOUNT_SCOPES = ["All", "Only Perps"] as const;
const PERIODS = ["24 Hours", "7 Days", "30 Days", "All-Time"] as const;
const CHART_METRICS = ["Account Value", "PNL", "Perps PNL"] as const;
type Period = (typeof PERIODS)[number];
type Metric = (typeof CHART_METRICS)[number];

/* Seed offsets, so switching metric or period actually redraws. The old 7D/30D/All
   chips were `<span>`s with a hardcoded active index and no handler — they moved
   nothing, which is the fourth dead affordance this project has found. */
const METRIC_SEED: Record<Metric, number> = { "Account Value": 0, PNL: 977, "Perps PNL": 2311 };
/** The left-hand time label. The right is always "now". */
/* Grid templates, one per table, so a header and its rows cannot drift apart. */
const KEY_COLS = "1.5fr 0.9fr 0.6fr 1.15fr 0.75fr 0.6fr";
const SUB_COLS = "1.6fr 0.85fr 0.8fr 0.8fr 0.9fr 0.75fr";

/** The fixtures' fixed clock. No `Date.now()` — see lib/api/README on determinism. */
const NOW_MS = EPOCH_MS;

/**
 * Account-wide rate-limit headroom.
 *
 * Per ACCOUNT, not per key: `GET /account/rate-limit` is the endpoint, and the old
 * per-key bars were specifying metering the venue does not have.
 */
const RATE_HEADROOM = 38;

/**
 * Unsigned money. `usd()` is deliberately SIGNED because it exists for PnL, and a
 * balance is not a gain — an equity of `+$62,180` claims a direction it does not have.
 */
const bal = (n: number) => "$" + comma(n, 0);

/** "4s ago", "2d ago" — a last-used column is read for recency, not for timestamps. */
function ago(ms: number) {
  const d = Math.max(0, NOW_MS - ms);
  const m = Math.floor(d / 60_000);
  if (m < 1) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compact money for a half-width card: $25.8m. */
const bn14 = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${comma(n, 0)}`;

/** The left-hand time label. The right is always "now". */
const PERIOD_AXIS: Record<Period, string> = {
  "24 Hours": "24h ago",
  "7 Days": "7d ago",
  "30 Days": "30d ago",
  "All-Time": "inception",
};
const PERIOD_SEED: Record<Period, number> = { "24 Hours": 41, "7 Days": 0, "30 Days": 613, "All-Time": 1289 };

/** The `View …` affordances on their cards: a link, not a button, in everything but role. */
const LINK: CSSProperties = {
  marginTop: 10,
  padding: 0,
  border: "none",
  background: "transparent",
  color: AMBER,
  fontFamily: MONO,
  fontSize: 11,
  cursor: "pointer",
  textAlign: "left",
};

/**
 * `Label value ▾` — the reference's selector idiom, used three times in this header.
 *
 * Fixed-positioned and clamped for the reason OverflowTabs and the blotter filter
 * both are: an absolutely positioned menu inside a panel gets clipped by it, and
 * this one sits in a card with its own bounds.
 */
function Picker<T extends string>({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onSelect: (v: T) => void;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ position: "relative" }}>
      <button
        ref={ref}
        onClick={() => {
          if (at) return setAt(null);
          const r = ref.current?.getBoundingClientRect();
          if (!r) return;
          const W = 150;
          const h = options.length * 30 + 8;
          setAt({
            top: r.bottom + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4,
            left: Math.min(Math.max(8, r.left), window.innerWidth - W - 8),
          });
        }}
        aria-haspopup="menu"
        aria-expanded={!!at}
        className="nx-inline-control"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
          fontFamily: MONO,
          fontSize: 11.5,
        }}
      >
        <span style={{ color: FAINT }}>{label}</span>
        <span style={{ color: TXT }}>{value}</span>
        <span style={{ fontSize: 8, color: DIM }}>▾</span>
      </button>
      {at && (
        <>
          <div onClick={() => setAt(null)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div
            role="menu"
            style={{
              position: "fixed",
              top: at.top,
              left: at.left,
              minWidth: 150,
              zIndex: 61,
              background: "#0d0d0d",
              border: `1px solid ${L2}`,
              borderRadius: R_MD,
              boxShadow: "0 18px 44px rgba(0,0,0,0.8)",
              overflow: "hidden",
              padding: "3px 0",
            }}
          >
            {options.map((o) => (
              <button
                key={o}
                role="menuitem"
                onClick={() => {
                  onSelect(o);
                  setAt(null);
                }}
                className="nx-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "6px 11px",
                  border: "none",
                  background: "transparent",
                  color: o === value ? GREEN : TXT,
                  fontFamily: MONO,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {o}
                {o === value && <span style={{ color: GREEN }}>✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}


export function PortfolioScreen({
  mobile,
  tick,
  onSelect,
  blotter,
}: {
  mobile: boolean;
  tick: number;
  onSelect: (sym: string) => void;
  /*
   * The blotter, passed in rather than constructed here. It needs the live ledger —
   * orders, fills, positions, twaps — all of which Terminal owns, and threading a
   * dozen props through this screen to rebuild it here would make Portfolio a second
   * place that knows how to assemble one.
   */
  blotter: ReactNode;
}) {
  const [accounts, setAccounts] = useState<(typeof ACCOUNT_SCOPES)[number]>("All");
  const [period, setPeriod] = useState<Period>("7 Days");
  const [metric, setMetric] = useState<Metric>("PNL");
  /* Two dialogs, owned here: both are reached only from this header's own links, so
     unlike the deposit modal there is no second caller to hoist them for. */
  const [sheet, setSheet] = useState<null | "volume" | "fees">(null);
  /*
   * Portfolio's own surfaces read the phase too.
   *
   * The first pass wired the trade screen and left this one, and the capture made the
   * case better than any argument would: the positions table said LOADING while a
   * $25,788,058.80 volume, a full fee schedule, an equity breakdown, a drawn PNL curve
   * and two populated tables sat around it. A screen that loads in one panel and not
   * the other seven does not read as loading — it reads as one broken panel.
   */
  const { phase, loading, error } = usePhase("/v1/account");
  const num = (v: ReactNode, chars = 8) =>
    phase === "ready" ? v : phase === "cold" ? <LoadingFigure chars={chars} height={11} /> : <span style={{ color: FAINT }}>{ABSENT_GLYPH}</span>;

  /*
   * Their row set, in their order. `Only Perps` drops the spot line rather than
   * zeroing it — a row that does not apply to the selected scope should not be
   * present, not be present and empty.
   *
   * Vault Equity, Earn Balance and Staking Account are em dashes for the reason the
   * trade rail's are: we have no such products, and `$0.00` would assert a balance
   * was fetched and came back empty.
   */
  const equityRows: { label: string; value: string; indent?: boolean; badge?: string; color?: string }[] = (() => {
    const perpsOnly = accounts === "Only Perps";
    const spot = perpsOnly ? 0 : 12000;
    const total = ACCOUNT.equity + (perpsOnly ? 0 : 0);
    return [
      { label: "PNL", value: usd(ACCOUNT.pnl30d), color: ACCOUNT.pnl30d >= 0 ? GREEN : RED },
      { label: "Volume", value: "$" + comma(ACCOUNT.volume24h, 2) },
      { label: "Total Equity", value: "$" + comma(perpsOnly ? total - spot : total, 2), badge: "Standard Mode" },
      ...(perpsOnly ? [] : [{ label: "Spot Equity", value: "$" + comma(spot, 2), indent: true }]),
      { label: "Perps Equity", value: "$" + comma(ACCOUNT.equity - 12000, 2), indent: true },
      {
        label: "uPNL",
        value: usd(ACCOUNT.unrealizedPnl),
        indent: true,
        color: ACCOUNT.unrealizedPnl >= 0 ? GREEN : RED,
      },
      { label: "Vault Equity", value: "—", indent: true, color: FAINT },
      { label: "Earn Balance", value: "—", indent: true, color: FAINT },
      { label: "Staking Account", value: "—", indent: true, color: FAINT },
    ];
  })();
  // Mark every position against its own market so equity and PnL move together.
  const marked = useMemo(
    () =>
      POSITIONS.map((p) => {
        const m = getMarket(p.sym);
        const mark = buildFeed(m, tick, m.groupings[0]).last;
        return { p, m, ...positionPnl(p, mark) };
      }),
    [tick],
  );
  const unrealized = marked.reduce((a, r) => a + r.pnl, 0);
  const equity = ACCOUNT.equity + unrealized;

  // 0-100 score → a point on the semicircle centred at (75,92), r=60, swept
  // left-to-right. 0% ends at (15,92), 100% at (135,92).

  return (
    <div
      tabIndex={0}
      aria-label="Portfolio"
      style={{
        /* The shell hands every screen a bounded slot between the fixed bars, so this fills
         it and scrolls inside it. `auto` made it grow to its content and pushed the
         scroll up to the shell, which then ran the page under the bottom nav. */
        height: "100%",
        overflowY: "auto",
        overscrollBehavior: "contain",
        padding: mobile ? "18px 16px 40px" : "18px 20px 32px",
      }}
    >
      {/* A page name, not a field name — see titleLabel in lib/theme. */}
      <div style={{ ...titleLabel(17, 700), color: HI, marginBottom: 14 }}>Portfolio</div>

      {/*
       * Three cards and a chart — the reference's whole portfolio above the blotter.
       *
       * What it replaces: a 34px account-value hero with an equity curve, four margin
       * tiles and a health radial. Losing the hero is the deliberate part. It was the
       * most legible thing on the screen and theirs has no equivalent: the big figure
       * lives on the trade rail and this page is a ledger, not a dashboard. Same call
       * as the market header's Mark, resolved the same way.
       */}
      <div
        style={{
          display: "grid",
          /*
           * Two columns on a phone, not one.
           *
           * Theirs pairs `14 Day Volume` and `Fees (Taker / Maker)` side by side at 390
           * — visible behind the modal sheets in
           * `shots/responsive/mobile.modal.volume.mobile.png` — and stacks only the
           * accounts block below them. Ours stacked all three full-width, which spent
           * roughly 200px of vertical on two cards holding one figure and four.
           *
           * The third child spans both columns: it is a nine-row table and it needs the
           * width, which is the same reason theirs gives it its own row.
           */
          gridTemplateColumns: mobile
            ? "minmax(0,1fr) minmax(0,1fr)"
            : "minmax(0,0.85fr) minmax(0,1.15fr) minmax(0,1.6fr)",
          gap: 12,
          marginBottom: 14,
          alignItems: "stretch",
        }}
      >
        {/* `display: contents` on a phone dissolves this wrapper so its two cards
            become grid items in their own right and sit side by side, which is theirs.
            At desktop it stays a stacked column in the first of three tracks. */}
        <div style={{ display: mobile ? "contents" : "flex", flexDirection: "column", gap: 12 }}>
          <Panel ticked style={{ padding: "14px 16px" }}>
            <div style={{ ...titleLabel(12), color: MUT }}>14 Day Volume</div>
            {/* Compact at phone width. Two cards side by side leave ~170px, and
                `$25,788,058.80` at 21px needs 250 — it was clipped mid-figure, which is
                the one thing a number must never be. */}
            <div style={{ fontFamily: MONO, fontSize: mobile ? 17 : 21, color: HI, marginTop: 8, minHeight: mobile ? 21 : 25, display: "flex", alignItems: "center" }}>
              {num(mobile ? bn14(ACCOUNT.volume24h * 14) : `$${comma(ACCOUNT.volume24h * 14, 2)}`, mobile ? 8 : 14)}
            </div>
            <button onClick={() => setSheet("volume")} className="nx-inline-control" style={LINK}>
              View Volume
            </button>
          </Panel>

          {/* The old Fee Tier panel, folded into their card. Taker first, as labelled. */}
          <Panel ticked style={{ padding: "14px 16px", flex: 1 }}>
            <div style={{ ...titleLabel(12), color: MUT }}>Fees (Taker / Maker)</div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
              {(
                [
                  ["Perps", TAKER_RATE, MAKER_RATE],
                  ["Spot", TAKER_RATE * 1.4, MAKER_RATE * 1.4],
                ] as const
              ).map(([label, taker, maker]) => (
                <div
                  key={label}
                  /* Stacked on a phone: at half width the label and the two rates ran
                     into each other with no gap, reading as "Perps0.0200%". */
                  style={{
                    display: "flex",
                    flexDirection: mobile ? "column" : "row",
                    justifyContent: "space-between",
                    gap: mobile ? 1 : 8,
                    fontFamily: MONO,
                    fontSize: mobile ? 11 : 12,
                  }}
                >
                  <span style={{ color: MUT }}>{label}</span>
                  <span style={{ color: TXT, whiteSpace: "nowrap" }}>
                    {(taker * 100).toFixed(4)}% <span style={{ color: FAINT }}>/</span>{" "}
                    {(Math.abs(maker) * 100).toFixed(4)}%
                  </span>
                </div>
              ))}
            </div>
            <button onClick={() => setSheet("fees")} className="nx-inline-control" style={LINK}>
              View Fee Schedule
            </button>
          </Panel>
        </div>

        {/* Accounts x Period over the equity breakdown — the same rows the trade
            rail's account card carries, which is where theirs repeats them too. */}
        {/* Nine rows of label/value — it needs the full width on a phone. */}
        <Panel ticked style={{ padding: 0, display: "flex", flexDirection: "column", gridColumn: mobile ? "1 / -1" : undefined }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: `1px solid ${L1}`,
            }}
          >
            <Picker label="Accounts" value={accounts} options={ACCOUNT_SCOPES} onSelect={setAccounts} />
            <Picker label="Period" value={period} options={PERIODS} onSelect={setPeriod} />
          </div>
          <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 7 }}>
            {equityRows.map((r) => (
              <div
                key={r.label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  fontFamily: MONO,
                  fontSize: 12,
                  paddingLeft: r.indent ? 10 : 0,
                  borderLeft: r.indent ? `1px solid ${L1}` : undefined,
                }}
              >
                <span style={{ color: r.indent ? FAINT : MUT, display: "flex", alignItems: "center", gap: 6 }}>
                  {r.label}
                  {r.badge && <span style={{ ...monoLabel(8.5, "0.08em"), color: FAINT }}>{r.badge}</span>}
                </span>
                <span style={{ color: r.color ?? NUM }}>{num(r.value, 9)}</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* One series chosen from three. Ours plots real data where theirs draws an
            empty axis, because our fixtures have a curve to draw. */}
        <Panel ticked style={{ padding: 0, display: "flex", flexDirection: "column", minHeight: 190, gridColumn: mobile ? "1 / -1" : undefined }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${L1}` }}>
            <Picker label="Chart" value={metric} options={CHART_METRICS} onSelect={setMetric} />
          </div>
          {/* Bottom padding for the time axis, right padding for the value axis —
              the labels are HTML overlays outside the plot box. */}
          <div style={{ flex: 1, minHeight: 0, padding: "10px 10px 16px", position: "relative" }}>
            {/* A drawn curve is an assertion about history. It waits. */}
            {phase !== "ready" && (
              <TableState count={0} surface="equityHistory" loading={loading} error={error} minHeight={140} />
            )}
            {phase === "ready" && <EquityCurve
              seed={ACCOUNT.curveSeed + METRIC_SEED[metric] + PERIOD_SEED[period]}
              base={ACCOUNT.equity}
              /* PNL and Perps PNL swing around zero and must show it; Account Value
                 moves around its own level and would waste the axis on the trip to 0. */
              signed={metric !== "Account Value"}
              span={[PERIOD_AXIS[period], "now"]}
            />}
          </div>
        </Panel>
      </div>

      {/*
       * The blotter, reused wholesale. Theirs on this page is the same component as
       * its trade screen, and so is ours — which is the entire reason this screen
       * shrank rather than grew. It replaces bespoke Open Positions and Recent Fills
       * tables that re-implemented two tabs with fewer columns, no sorting and no
       * filters.
       */}
      <Surface style={{ display: "flex", flexDirection: "column", minHeight: 320, marginBottom: 14 }}>
        {blotter}
      </Surface>

      {/* Ours, and kept. On this venue a key is an account: own fills, own win rate,
          own rate limit. Their Accounts selector is the same idea reached from the
          other end, which is why the two coexist rather than compete. */}
      <div style={{ display: "flex", flexDirection: mobile ? "column" : "row", gap: 14 }}>
        <Surface style={{ flex: 1 }}>
          <SectionHeader
            title="API Keys"
            right={
              /*
               * Headroom is ACCOUNT-level, and it is here rather than on each row
               * because that is where the venue meters it. The old panel drew a
               * rate-limit bar per key; this project's own API notes say limits are per
               * account and `GET /account/rate-limit` reports the headroom, so per-key
               * bars were specifying metering the venue does not have.
               */
              <span style={monoLabel(10, "0.06em")}>
                RATE LIMIT · <span style={{ color: RATE_HEADROOM > 70 ? AMBER : GREEN }}>{RATE_HEADROOM}%</span> USED ·
                ACCOUNT-WIDE
              </span>
            }
          />

          {/*
           * The invariant, stated once and prominently.
           *
           * A credential must be strictly less powerful than the account that issued
           * it — that is what makes it safe to put on a machine you do not physically
           * control, and it is the single most important thing this surface says.
           * Hyperliquid's API wallets make the same promise from the other side: they
           * sign trades and cannot withdraw.
           */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 18px",
              borderBottom: `1px solid ${L1}`,
              background: "rgba(14,203,129,0.045)",
              ...monoLabel(9.5, "0.06em"),
            }}
          >
            <span style={{ color: GREEN }}>▲</span>
            <span style={{ color: MUT, textTransform: "none", fontFamily: ARCHIVO, fontSize: 11.5, letterSpacing: 0 }}>
              Keys can trade and read. <span style={{ color: TXT }}>No key can withdraw or transfer</span> — those
              require the wallet that owns the account.
            </span>
          </div>

          {/* `Table` is not optional decoration: HeadRow and Row carry role="row", and a
              row with no grid/table/rowgroup ancestor is aria-required-parent (critical).
              Fifth time on this project — see the note on the component. */}
          <Table label="API keys">
          {/*
           * SIX COLUMNS DO NOT FIT IN 346px, and the grid did not say so — it wrapped.
           *
           * At 390 every cell broke mid-word: `mm-quoter-01` split across two lines at
           * its hyphen, `4s ago · eu-west-1` took three, `ap-southeast-1` took three,
           * the two scope chips stacked, and a row was ~124px of hyphenated fragments.
           * A table that wraps has not fitted into the width, it has hidden the fact
           * that it did not.
           *
           * The blotter solved this a while ago with density tiers and a rule worth
           * repeating: DROPPING A COLUMN IS LEGIBLE, a column you have to reassemble
           * from fragments is not. These two tables are hand-rolled rather than built
           * on ColumnSet, so they never inherited it.
           *
           * At phone width the row becomes a CARD instead: identity and the action on
           * one line, then a meta line carrying what the dropped columns held. Nothing
           * is lost — `fills`, `last used` and `expires` are all still there, labelled,
           * on a line with room for them.
           */}
          {!mobile && (
            <HeadRow
              template={KEY_COLS}
              cols={[
                { label: "KEY", align: "left" },
                { label: "SCOPES", align: "left" },
                "FILLS",
                { label: "LAST USED", align: "left" },
                { label: "EXPIRES", align: "left" },
                "",
              ]}
            />
          )}
          {(phase === "ready" ? API_KEYS : []).map((k) => {
            const expired = k.status === "expired";
            const tone = expired ? FAINT : TXT;
            const lastUsed = k.lastUsedAt === null ? "never" : ago(k.lastUsedAt);
            const expiry = expired
              ? "expired"
              : k.expiresAt === null
                ? "never"
                : `in ${Math.round((k.expiresAt - NOW_MS) / 86_400_000)}d`;
            const revoke = (
              <button
                className="nx-rowaction"
                title={expired ? "Already expired — remove from the list" : `Revoke ${k.label} immediately`}
                aria-label={expired ? `Remove ${k.label}` : `Revoke ${k.label}`}
                style={{
                  border: `1px solid ${L2}`,
                  borderRadius: R_SM,
                  background: "transparent",
                  color: expired ? MUT : RED,
                  fontFamily: MONO,
                  fontSize: 9.5,
                  /* 32 on a phone: this is the control that kills a live credential,
                     and it sat at 20px between two other rows' worth of it. */
                  minHeight: mobile ? TAP_CONTROL : undefined,
                  padding: mobile ? "0 10px" : "2px 8px",
                  cursor: "pointer",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  whiteSpace: "nowrap",
                }}
              >
                {expired ? "Remove" : "Revoke"}
              </button>
            );
            const chips = (
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {k.scopes.map((sc) => (
                  <span
                    key={sc}
                    style={{
                      ...monoLabel(8.5, "0.06em"),
                      color: expired ? FAINT : sc === "trade" ? GREEN : MUT,
                      border: `1px solid ${expired ? L2 : sc === "trade" ? "rgba(14,203,129,0.3)" : L2}`,
                      borderRadius: R_XS,
                      padding: "1px 5px",
                    }}
                  >
                    {sc}
                  </span>
                ))}
              </span>
            );

            if (mobile) {
              return (
                /* One column, two grid rows: identity line, then the meta line. The
                   `Row` primitive owns the role plumbing, so a card here is still a
                   `role="row"` with cells and not a div pretending. */
                <Row key={k.id} template="1fr" padding="11px 16px">
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span
                        style={{
                          color: tone,
                          fontFamily: ARCHIVO,
                          fontSize: 13,
                          fontWeight: 500,
                          /* The label is a name, and a name broken at its hyphen is a
                             different string. It gets the full row rather than a
                             1.5fr share of it. */
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {k.label}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{k.id}…</span>
                    </span>
                    {chips}
                    {revoke}
                  </span>
                  {/* What the dropped columns held, labelled. `Fills` is the one that
                      needs its name most — a bare `41.2k` next to a timestamp reads
                      as anything. */}
                  <span
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "2px 12px",
                      marginTop: 7,
                      fontFamily: MONO,
                      fontSize: 10.5,
                      color: expired ? FAINT : MUT,
                    }}
                  >
                    <span>
                      <span style={{ color: FAINT }}>fills </span>
                      {k.fills}
                    </span>
                    <span>
                      <span style={{ color: FAINT }}>used </span>
                      {lastUsed}
                      {k.lastUsedFrom && <span style={{ color: FAINT }}> · {k.lastUsedFrom}</span>}
                    </span>
                    <span style={{ color: expired ? RED : k.expiresAt === null ? AMBER : MUT }}>
                      <span style={{ color: FAINT }}>expires </span>
                      {expiry}
                    </span>
                  </span>
                </Row>
              );
            }

            return (
              <Row key={k.id} template={KEY_COLS}>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ color: tone, fontFamily: ARCHIVO, fontSize: 12.5, fontWeight: 500 }}>{k.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{k.id}…</span>
                </span>
                <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {k.scopes.map((sc) => (
                    <span
                      key={sc}
                      style={{
                        ...monoLabel(8.5, "0.06em"),
                        color: expired ? FAINT : sc === "trade" ? GREEN : MUT,
                        border: `1px solid ${expired ? L2 : sc === "trade" ? "rgba(14,203,129,0.3)" : L2}`,
                        borderRadius: R_XS,
                        padding: "1px 5px",
                      }}
                    >
                      {sc}
                    </span>
                  ))}
                </span>
                <Num color={expired ? FAINT : MUT}>{k.fills}</Num>
                <span style={{ fontFamily: MONO, fontSize: 11, color: expired ? FAINT : MUT }}>
                  {k.lastUsedAt === null ? "never" : ago(k.lastUsedAt)}
                  {k.lastUsedFrom && (
                    <span style={{ color: FAINT }}> · {k.lastUsedFrom}</span>
                  )}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: expired ? RED : k.expiresAt === null ? AMBER : MUT }}>
                  {/* A key with no expiry is flagged, not left blank. It is the one that
                      outlives whoever created it. */}
                  {expired ? "expired" : k.expiresAt === null ? "never" : `in ${Math.round((k.expiresAt - NOW_MS) / 86_400_000)}d`}
                </span>
                <span style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    className="nx-rowaction"
                    title={expired ? "Already expired — remove from the list" : `Revoke ${k.label} immediately`}
                    aria-label={expired ? `Remove ${k.label}` : `Revoke ${k.label}`}
                    style={{
                      border: `1px solid ${L2}`,
                      borderRadius: R_SM,
                      background: "transparent",
                      color: expired ? MUT : RED,
                      fontFamily: MONO,
                      fontSize: 9.5,
                      padding: "2px 8px",
                      cursor: "pointer",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    {expired ? "Remove" : "Revoke"}
                  </button>
                </span>
              </Row>
            );
          })}
          </Table>
          {/* Outside the table element — `role="table"` may not contain a
              `role="status"` or `role="alert"`. Same rule as the blotter. */}
          <TableState count={phase === "ready" ? 1 : 0} surface="apiKeys" loading={loading} error={error} minHeight={90} />
          <div style={{ padding: "11px 18px", display: "flex", justifyContent: "space-between", ...monoLabel(9.5, "0.08em") }}>
            {/* The creation contract, because it is a real requirement the team would
                otherwise miss: the secret is returned ONCE and never again. */}
            <span>NEW KEY · SECRET SHOWN ONCE</span>
            <span>
              <span style={{ color: MUT }}>POST</span> /v1/keys
            </span>
          </div>
        </Surface>

        {/*
         * Subaccounts — isolated margin buckets under one login.
         *
         * The reason to have them is risk containment: a strategy that blows up should
         * take its own bucket and not the account. Each row is a SEPARATE margin
         * account with its own equity, positions and maintenance margin — the table
         * totals to the login's whole balance, but liquidation is computed per row,
         * which is the entire point and the thing a reader must not miss.
         */}
        <Surface style={{ display: "flex", flexDirection: "column", marginBottom: 14 }}>
          <SectionHeader
            title="Subaccounts"
            right={
              <span style={monoLabel(10, "0.06em")}>
                {SUBACCOUNTS.length} ACCOUNTS · MARGIN ISOLATED PER ROW
              </span>
            }
          />
          <Table label="Subaccounts">
          {/*
           * Same six-into-346 problem as the keys table, plus one worse symptom: the
           * `master` badge OVERLAPPED the account name and the id line beneath it. The
           * name column had no `minWidth: 0` escape and the badge no `flex: 0 0 auto`,
           * so at 1.6fr of 346px the two laid out on top of each other — text over
           * text, which is not cramped, it is broken.
           *
           * Phone layout: name, badge and Transfer on one line; the four measurements
           * on a labelled meta line under it. Every figure survives; only the grid
           * does not.
           */}
          {!mobile && (
            <HeadRow
              template={SUB_COLS}
              cols={[
                { label: "ACCOUNT", align: "left" },
                "EQUITY",
                /* "MARGIN USED" wrapped onto two lines and collided with the next
                   header. The column is margin; "used" was doing no work. */
                "MARGIN",
                "POSITIONS",
                "UNREALIZED",
                "",
              ]}
            />
          )}
          {(phase === "ready" ? SUBACCOUNTS : []).map((a) => {
            const transfer = (
              <button
                className="nx-rowaction"
                title="Move collateral between this account and another"
                aria-label={`Transfer to or from ${a.name}`}
                style={{
                  border: `1px solid ${L2}`,
                  borderRadius: R_SM,
                  background: "transparent",
                  color: MUT,
                  fontFamily: MONO,
                  fontSize: 9.5,
                  minHeight: mobile ? TAP_CONTROL : undefined,
                  padding: mobile ? "0 10px" : "2px 8px",
                  cursor: "pointer",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  whiteSpace: "nowrap",
                }}
              >
                Transfer
              </button>
            );
            const badge = a.isMaster && (
              <span
                style={{
                  ...monoLabel(8.5, "0.06em"),
                  color: MUT,
                  border: `1px solid ${L2}`,
                  borderRadius: R_XS,
                  padding: "1px 5px",
                  /* Never shrink, never wrap. This is what was landing on top of the
                     account id. */
                  flex: "0 0 auto",
                  whiteSpace: "nowrap",
                }}
              >
                master
              </span>
            );

            if (mobile) {
              return (
                <Row key={a.id} template="1fr" padding="11px 16px">
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span
                          style={{
                            color: TXT,
                            fontFamily: ARCHIVO,
                            fontSize: 13,
                            fontWeight: 500,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {a.name}
                        </span>
                        {badge}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{a.id}</span>
                    </span>
                    {transfer}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "2px 12px",
                      marginTop: 7,
                      fontFamily: MONO,
                      fontSize: 10.5,
                      color: MUT,
                    }}
                  >
                    <span>
                      <span style={{ color: FAINT }}>equity </span>
                      {bal(a.equity)}
                    </span>
                    <span>
                      <span style={{ color: FAINT }}>margin </span>
                      {bal(a.marginUsed)}
                    </span>
                    <span>
                      <span style={{ color: FAINT }}>pos </span>
                      {a.positions || "—"}
                    </span>
                    <span style={{ color: a.upnl > 0 ? GREEN : a.upnl < 0 ? RED : FAINT }}>
                      <span style={{ color: FAINT }}>upnl </span>
                      {a.upnl ? usd(a.upnl) : "—"}
                    </span>
                  </span>
                </Row>
              );
            }

            return (
            <Row key={a.id} template={SUB_COLS}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      color: TXT,
                      fontFamily: ARCHIVO,
                      fontSize: 12.5,
                      fontWeight: 500,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.name}
                  </span>
                  {badge}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{a.id}</span>
              </span>
              <Num>{bal(a.equity)}</Num>
              <Num color={MUT}>{bal(a.marginUsed)}</Num>
              <Num color={a.positions ? MUT : FAINT}>{a.positions || "—"}</Num>
              <Num color={a.upnl > 0 ? GREEN : a.upnl < 0 ? RED : FAINT}>{a.upnl ? usd(a.upnl) : "—"}</Num>
              <span style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="nx-rowaction"
                  title="Move collateral between this account and another"
                  aria-label={`Transfer to or from ${a.name}`}
                  style={{
                    border: `1px solid ${L2}`,
                    borderRadius: R_SM,
                    background: "transparent",
                    color: MUT,
                    fontFamily: MONO,
                    fontSize: 9.5,
                    padding: "2px 8px",
                    cursor: "pointer",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Transfer
                </button>
              </span>
            </Row>
            );
          })}
          </Table>
          {/* Outside the table element — `role="table"` may not contain a
              `role="status"` or `role="alert"`. Same rule as the blotter. */}
          <TableState count={phase === "ready" ? 1 : 0} surface="balances" loading={loading} error={error} minHeight={90} />
          <div style={{ padding: "11px 18px", display: "flex", justifyContent: "space-between", ...monoLabel(9.5, "0.08em") }}>
            <span>LIQUIDATION IS PER SUBACCOUNT</span>
            <span>
              <span style={{ color: MUT }}>POST</span> /v1/accounts/transfer
            </span>
          </div>
        </Surface>
      </div>

      {/* Bottom sheets on a phone, centred dialogs at desktop — theirs, and see the
          Dialog shell in FeeModals for why the distinction is not cosmetic. */}
      <VolumeHistoryModal open={sheet === "volume"} onClose={() => setSheet(null)} compact={mobile} />
      <FeeScheduleModal open={sheet === "fees"} onClose={() => setSheet(null)} compact={mobile} />
    </div>
  );
}
