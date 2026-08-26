"use client";

/*
 * Competitions — the Seasons incentive programme.
 *
 * Renders the three surfaces specified in seasons-prd.md §10:
 *
 *   1. Live season card    — the competition. Pool, points, rank, live estimate.
 *   2. Unlock matrix       — seasons down, months-after-settlement across.
 *   3. Settlement record   — every closed season's conversion ratio, permanently.
 *
 * The second is the one that is easy to get wrong. A user accrues an entitlement
 * from every season they participate in, each on its own ladder, so by the second
 * year a dozen-plus schedules are running at once. An earlier version listed every
 * unlock by absolute date: it answered "what arrives next" and hid the structure —
 * you could not see that S1 was a four-tranche short ladder and S6 a five-tranche
 * long one. The matrix indexes columns on months AFTER SETTLEMENT instead, which
 * aligns the ladders so they can be compared, and encodes distribution state in
 * colour — a choice carried over from the growth-programme model this feature
 * was designed against.
 *
 * The settlement record deliberately does NOT repeat the ladder — the matrix above
 * carries it, and an expandable per-season schedule here was pure duplication. What
 * it uniquely holds is points, the NEX/point ratio each season actually settled at,
 * and the granted total: the audit trail, not the forecast.
 *
 * Two honesty rules from the PRD are enforced here rather than left to copy:
 *
 *   • The open season's figure is an ESTIMATE — pro-rata genuinely moves with
 *     everyone else's activity — and is labelled as one everywhere it appears.
 *   • USD is a derived figure. The API returns NEX only; we multiply by a mock
 *     mark and say so. A dollar number on an unvested balance is a price promise.
 */

import { useMemo, useState } from "react";
import {
  R_XS,
  R_SM,
  ARCHIVO,
  DIM,
  FAINT,
  GREEN,
  HI,
  L0,
  L1,
  L2,
  MONO,
  MUT,
  NUM,
  PANEL,
  R_LG,
  R_MD,
  SUNK,
  TERM,
  TXT,
  AMBER,
  monoLabel,
} from "@/lib/theme";
import {
  Panel,
  SectionHeader,
  Segmented,
  StatCell,
  Surface,
  Tabs,
  type TabDef,
} from "@/components/terminal/primitives";
import { SeasonLeaderboard } from "@/components/terminal/SeasonLeaderboard";
import { AbsentValue } from "@/components/terminal/states";
import { absent, isPresent, unwrapOr } from "@/lib/api/absence";
import {
  SEASONS_ENDPOINTS,
  type AccountSeason,
  type RewardUnlock,
  type Season,
} from "@/lib/api/seasons";
import { loadSeasons, NEX_MARK_USD, NOW } from "@/lib/seasons";
import { comma } from "@/lib/format";
import { ShareBySeason, type SeasonPoint } from "@/components/charts/SeasonAnalytics";

/**
 * USDX gets its own hue. Track A is a different programme in a different asset
 * that happens to settle on the same event, and colouring it like the NEX ladder
 * would imply it is part of the pool. Sits away from GREEN (distributed) and
 * AMBER (paused) so the three never read as a severity scale.
 */
const ACCENT_USDX = "#5aa9e6";

/**
 * Unsigned dollars. `lib/format.usd` is deliberately SIGNED for PnL ("+$809"),
 * which is wrong for a balance — a holding is not a gain.
 */
const dollars = (n: number) =>
  "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

const nex = (n: number) => comma(n, n < 100 ? 2 : 0);
const day = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const shortDay = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

/**
 * Sub-tabs. The leaderboard is a peer of the account view, not a section inside
 * it: it answers a different question (where do I stand?) against a different
 * subject (everyone else), and burying it under four account panels would mean
 * scrolling past your own settled history to see a board that is still live.
 */
type CompetitionsTab = "overview" | "leaderboard";

function daysLeft(to: Date) {
  const ms = to.getTime() - NOW.getTime();
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return `${d}d ${h}h`;
}

export function CompetitionsScreen({ mobile }: { mobile: boolean }) {
  const snap = useMemo(() => loadSeasons(), []);
  const [showApi, setShowApi] = useState(false);
  const [tab, setTab] = useState<CompetitionsTab>("overview");

  const live = snap.seasons.find((s) => s.status === "open");
  const liveAcct = snap.accountSeasons.find((a) => a.seasonId === live?.id);
  const settled = snap.seasons.filter((s) => s.status === "settled");

  const vested = snap.accountSeasons.reduce((a, s) => a + s.vestedNex, 0);
  const unvested = snap.accountSeasons.reduce((a, s) => a + s.unvestedNex, 0);
  const upcoming = snap.unlocks.filter((u) => u.unlockAt > NOW);
  const next = upcoming.find((u) => u.status !== "paused") ?? null;
  const lastUnlock = snap.unlocks.length ? snap.unlocks[snap.unlocks.length - 1] : null;

  /* Chart model. Derived from the same snapshot the tables read, so a figure can
   * never disagree between a chart and a row. */
  const points: SeasonPoint[] = useMemo(
    () =>
      snap.seasons
        .filter((x) => x.status !== "upcoming")
        .map((x) => {
          const a = snap.accountSeasons.find((y) => y.seasonId === x.id);
          return {
            id: x.id,
            label: x.name,
            share: unwrapOr(a?.shareOfPool ?? 0, 0),
            open: x.status === "open",
          };
        }),
    [snap],
  );

  /* Boards exist per season and default to the open one — the board a trader can
   * still act on. Seasons without a board (unranked, or no participants yet) are
   * not offered, so the selector can never lead to an empty table. */
  const boardIds = snap.seasons.filter((s) => snap.leaderboards[s.id]).map((s) => s.id);
  const [boardId, setBoardId] = useState(live?.id ?? boardIds[boardIds.length - 1] ?? "");
  const board = snap.leaderboards[boardId];
  const boardSeason = snap.seasons.find((s) => s.id === boardId);

  const tabs: readonly TabDef<CompetitionsTab>[] = [
    { id: "overview", label: "Overview" },
    { id: "leaderboard", label: "Leaderboard" },
  ];

  return (
    /* The screen's own vertical scroller. The shell is `overflow: hidden` at
     * desktop and hands each screen a flex slot, so a screen that does not scroll
     * itself simply clips — which this one did until the content outgrew the
     * viewport. `tabIndex` + `aria-label` follow PortfolioScreen: the region is
     * scrollable but its contents are largely not focusable, which is
     * axe scrollable-region-focusable, so it needs to be a named focus stop. */
    <div
      tabIndex={0}
      aria-label="Competitions"
      style={{
        /* Same bounded slot as every other screen — see PortfolioScreen. `auto` here scrolled
         the shell instead, and hid the last 49px of the page behind the nav. */
        height: "100%",
        overflowY: "auto",
        padding: mobile ? "14px 12px 28px" : "18px 20px 40px",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          maxWidth: 1180,
          margin: "0 auto",
          width: "100%",
        }}
      >
      {/* ---------------------------------------------------------- summary */}
      <Panel ticked style={{ padding: mobile ? 14 : "16px 18px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(4, 1fr)",
            gap: mobile ? 14 : 24,
          }}
        >
          <StatCell surface="account" label="TOTAL EARNED" value={`${nex(vested + unvested)} NEX`} color={HI} valueSize={17} />
          <StatCell surface="account" label="VESTED" value={`${nex(vested)} NEX`} color={GREEN} valueSize={17} />
          <StatCell surface="account" label="UNVESTED" value={`${nex(unvested)} NEX`} color={TXT} valueSize={17} />
          <StatCell
            surface="account"
            label="TRACK A REBATE (LIFETIME)"
            value={`${comma(snap.trackARebateUsdx, 2)} USDX`}
            color={TXT}
            valueSize={17}
          />
        </div>
        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: `1px solid ${L1}`,
            display: "flex",
            flexWrap: "wrap",
            gap: 18,
            alignItems: "center",
          }}
        >
          <span style={{ ...monoLabel(9, "0.11em"), color: FAINT }}>
            ≈ {dollars((vested + unvested) * NEX_MARK_USD)} at a mock mark of ${NEX_MARK_USD.toFixed(2)}
            /NEX — indicative only, not a commitment
          </span>
          <div style={{ flex: 1 }} />
          {lastUnlock && (
            <span style={{ ...monoLabel(9, "0.11em"), color: FAINT }}>
              FULLY VESTED BY {day(lastUnlock.unlockAt).toUpperCase()}
            </span>
          )}
        </div>
      </Panel>


      {/* ------------------------------------------------------- sub-tabs */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding: "0 16px",
          borderBottom: `1px solid ${L1}`,
        }}
      >
        <Tabs tabs={tabs} active={tab} onSelect={setTab} height={38} gap={20} size={12.5} />
      </div>

      {tab === "overview" && (
        <>
      {/* ------------------------------------------------- 1. live season */}
      {live && (
        <Panel ticked style={{ overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "13px 16px",
              borderBottom: `1px solid ${L1}`,
              background: TERM,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: 15, color: HI }}>
              {live.name}
            </span>
            <span
              style={{
                ...monoLabel(9, "0.12em"),
                color: GREEN,
                border: `1px solid ${GREEN}44`,
                borderRadius: R_SM,
                padding: "3px 7px",
              }}
            >
              OPEN
            </span>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: MONO, fontSize: 12, color: AMBER }}>
              ends in {daysLeft(live.closesAt)}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(5, 1fr)",
              gap: mobile ? 14 : 20,
              padding: mobile ? 14 : "16px 18px",
            }}
          >
            <StatCell surface="account" label="POOL" value={`${nex(live.poolNex)} NEX`} color={HI} valueSize={15} />
            <StatCell surface="account" label="YOUR POINTS" value={comma(liveAcct?.points ?? 0, 1)} color={TXT} valueSize={15} />
            <StatCell
              surface="account"
              label="RANK"
              value={
                <AbsentValue
                  value={liveAcct ? liveAcct.rank : absent("missing", undefined, "rank")}
                  format={(r) => `#${r}`}
                  color={TXT}
                />
              }
              color={TXT}
              valueSize={15}
            />
            <StatCell
              surface="account"
              label="YOUR SHARE"
              value={
                liveAcct && isPresent(liveAcct.shareOfPool)
                  ? `${(liveAcct.shareOfPool * 100).toFixed(3)}%`
                  : "—"
              }
              color={TXT}
              valueSize={15}
            />
            <StatCell
              surface="account"
              label="ESTIMATED"
              value={`~${nex(unwrapOr(liveAcct?.estimatedNex ?? 0, 0))} NEX`}
              color={GREEN}
              valueSize={15}
            />
          </div>

          <div
            style={{
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
              alignItems: "center",
              padding: "11px 16px",
              borderTop: `1px solid ${L1}`,
              background: SUNK,
            }}
          >
            <span style={{ ...monoLabel(9, "0.11em"), color: DIM }}>EARNING THIS SEASON</span>
            {(
              [
                ["maker depth", live.weights.depth],
                ["volume", live.weights.volume],
                ["avg balance", live.weights.balance],
              ] as const
            )
              .filter(([, w]) => w > 0)
              .map(([label, w]) => (
                <span key={label} style={{ fontFamily: MONO, fontSize: 11, color: NUM }}>
                  {label} <span style={{ color: GREEN }}>{w.toFixed(2)}×</span>
                </span>
              ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: MONO, fontSize: 11, color: MUT }}>
              streak ×{(liveAcct?.streakMultiplier ?? 1).toFixed(2)}
            </span>
          </div>

          <div style={{ padding: "10px 16px", borderTop: `1px solid ${L1}` }}>
            <span style={{ ...monoLabel(9, "0.11em"), color: FAINT, letterSpacing: "0.08em" }}>
              Estimate. Your share is pro-rata against{" "}
              {isPresent(live.totalPoints) ? comma(live.totalPoints, 0) : "—"} points from{" "}
              {isPresent(live.participants) ? live.participants : "—"} participants and moves with
              everyone else&apos;s activity until the season closes.
            </span>
          </div>
        </Panel>
      )}

      {/* ------------------------------------------- 2. rewards calendar */}
      <Surface>
        <SectionHeader
          title="Unlock matrix"
          right={
            next ? (
              <span style={{ fontFamily: MONO, fontSize: 11, color: GREEN }}>
                next {nex(next.amountNex)} NEX · {shortDay(next.unlockAt)}
              </span>
            ) : undefined
          }
        />
        <RewardMatrix
          seasons={[...snap.seasons].filter((x) => x.status !== "upcoming").reverse()}
          accounts={snap.accountSeasons}
          unlocks={snap.unlocks}
          mobile={mobile}
        />
        <div style={{ padding: "10px 16px", borderTop: `1px solid ${L1}`, background: SUNK }}>
          <span style={{ ...monoLabel(9, "0.1em"), color: FAINT, letterSpacing: "0.06em" }}>
            Track A is a separate programme — 50% of the net fees you paid, rebated in USDX and liquid the
            moment the season closes. It is shown here because both tracks settle on the same event, but it is
            never part of the pool and never affects the pro-rata. The NEX columns are months after each
            season SETTLED, so the ladders line up and can be compared.
            Hover a cell for its calendar date. A tranche shown as paused is not forfeited — the schedule
            advances once the activity threshold is met again.
          </span>
        </div>
      </Surface>

      {/* --------------------------------------------- 3. season history */}
      <Surface>
        <SectionHeader
          title="Settlement record"
          right={
            <span style={{ ...monoLabel(9, "0.1em"), color: FAINT }}>
              EVERY CONVERSION RATIO, PERMANENTLY
            </span>
          }
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: mobile ? "1fr 1fr" : "1.6fr 1fr 1fr 1fr 1fr 0.7fr",
            gap: 0,
            padding: "7px 16px",
            borderBottom: `1px solid ${L1}`,
            ...monoLabel(9, "0.11em"),
            color: DIM,
          }}
        >
          <span>SEASON</span>
          {!mobile && <span style={{ textAlign: "right" }}>YOUR POINTS</span>}
          {!mobile && <span style={{ textAlign: "right" }}>NEX / POINT</span>}
          <span style={{ textAlign: "right" }}>GRANTED</span>
          <span style={{ textAlign: "right" }}>VESTED</span>
          {!mobile && <span />}
        </div>
        {settled.map((s) => {
          const a = snap.accountSeasons.find((x) => x.seasonId === s.id);
          if (!a) return null;
          const granted = unwrapOr(a.entitlementNex, 0);
          const pctVested = granted > 0 ? (a.vestedNex / granted) * 100 : 0;
          const ratio =
            isPresent(s.totalPoints) && s.totalPoints > 0 ? s.poolNex / s.totalPoints : null;
          return (
            <div key={s.id} style={{ borderBottom: `1px solid ${L0}` }}>
              <div
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: mobile ? "1fr 1fr" : "1.6fr 1fr 1fr 1fr 1fr 0.7fr",
                  alignItems: "center",
                  gap: 0,
                  padding: "11px 16px",
                }}
              >
                <span style={{ fontFamily: ARCHIVO, fontSize: 12.5, color: TXT }}>{s.name}</span>
                {!mobile && (
                  <span style={{ fontFamily: MONO, fontSize: 12, color: NUM, textAlign: "right" }}>
                    {comma(a.points, 1)}
                  </span>
                )}
                {!mobile && (
                  <span style={{ fontFamily: MONO, fontSize: 12, color: MUT, textAlign: "right" }}>
                    {ratio !== null ? ratio.toFixed(6) : "—"}
                  </span>
                )}
                <span style={{ fontFamily: MONO, fontSize: 12, color: HI, textAlign: "right" }}>
                  {comma(granted, 2)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: GREEN, textAlign: "right" }}>
                  {pctVested.toFixed(0)}%
                </span>
                {!mobile && <span />}
              </div>
            </div>
          );
        })}
      </Surface>

      {/* ---------------------------------------------------- 4. analytics */}
      <Surface>
        <SectionHeader
          title="Analytics"
          right={
            <span style={{ ...monoLabel(9, "0.1em"), color: FAINT }}>YOUR HISTORY</span>
          }
        />
        <div style={{ padding: mobile ? "16px 14px 6px" : "18px 20px 8px" }}>
          <ShareBySeason seasons={points} />
        </div>
        <div style={{ padding: "10px 16px", borderTop: `1px solid ${L1}`, background: SUNK }}>
          <span style={{ ...monoLabel(9, "0.1em"), color: FAINT, letterSpacing: "0.06em" }}>
            Your own account only. Share is measured against each season&apos;s settled point total,
            so the open season will move until it closes.
          </span>
        </div>
      </Surface>

      {/* ------------------------------------------------------ the API */}
      <Surface>
        <SectionHeader
          title="API"
          right={
            <button
              onClick={() => setShowApi((v) => !v)}
              className="nx-inline-control"
              style={{
                ...monoLabel(9, "0.11em"),
                color: DIM,
                background: "transparent",
                border: `1px solid ${L2}`,
                borderRadius: R_MD,
                padding: "4px 9px",
                cursor: "pointer",
                // 45.6×22 against a 32px default floor. The width was fine; the
                // height was the label's own line box.
                minHeight: 32,
              }}
            >
              {showApi ? "HIDE" : "SHOW"}
            </button>
          }
        />
        {showApi && (
          <div style={{ padding: "4px 0 10px" }}>
            {SEASONS_ENDPOINTS.map((e) => (
              <div
                key={e.path}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "baseline",
                  padding: "8px 16px",
                  borderBottom: `1px solid ${L0}`,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ ...monoLabel(9, "0.1em"), color: GREEN, minWidth: 30 }}>
                  {e.method}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: TXT }}>{e.path}</span>
                <span
                  style={{
                    ...monoLabel(8.5, "0.1em"),
                    color: e.auth ? AMBER : FAINT,
                    border: `1px solid ${L2}`,
                    borderRadius: R_XS,
                    padding: "2px 5px",
                  }}
                >
                  {e.auth ? "SIGNED" : "PUBLIC"}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>{e.note}</span>
              </div>
            ))}
            <div style={{ padding: "10px 16px" }}>
              <span style={{ ...monoLabel(9, "0.1em"), color: FAINT, letterSpacing: "0.06em" }}>
                Read-only by design. Distribution is pushed, so there is nothing for a client to
                write. Amounts are decimal strings in NEX; the USD figures on this page are the
                client multiplying by a mark it fetched separately.
              </span>
            </div>
          </div>
        )}
        </Surface>
        </>
      )}

      {/* ------------------------------------------------- leaderboard */}
      {tab === "leaderboard" && (
        <Surface>
          <SectionHeader
            title="Leaderboard"
            right={
              boardIds.length > 1 ? (
                <Segmented options={boardIds} active={boardId} onSelect={setBoardId} />
              ) : undefined
            }
          />
          {board ? (
            <SeasonLeaderboard
              board={board}
              mobile={mobile}
              open={boardSeason?.status === "open"}
            />
          ) : (
            <div style={{ padding: "18px 16px" }}>
              <span style={{ ...monoLabel(9, "0.1em"), color: FAINT }}>
                NO STANDING IN THIS SEASON
              </span>
            </div>
          )}
        </Surface>
      )}
      </div>
    </div>
  );
}

/**
 * The unlock matrix.
 *
 * Rows are seasons, newest first. Columns are months AFTER that season settled —
 * not absolute dates — so every ladder is aligned on its own settlement and the
 * shapes can be read against each other. The flat by-date list this replaced
 * showed what was arriving next but hid the structure entirely: you could not see
 * that S1 was a four-tranche short ladder and S6 a five-tranche long one.
 *
 * Colour encodes distribution state, which is the other thing the list buried:
 * green is already in the account, plain text is scheduled, amber is paused.
 */
function RewardMatrix({
  seasons,
  accounts,
  unlocks,
  mobile,
}: {
  seasons: Season[];
  accounts: AccountSeason[];
  unlocks: RewardUnlock[];
  mobile: boolean;
}) {
  // Column set is the union of every ladder in play, so it follows the data.
  const offsets = useMemo(
    () => [...new Set(seasons.flatMap((s) => s.schedule.map((t) => t.offsetMonths)))].sort((a, b) => a - b),
    [seasons],
  );

  // Paused state is carried on the by-date unlock feed; index it so a cell can
  // ask "what happened on my date?" rather than re-deriving the rule.
  const byDay = useMemo(() => {
    const m = new Map<number, RewardUnlock>();
    for (const u of unlocks) m.set(new Date(u.unlockAt).setUTCHours(12, 0, 0, 0), u);
    return m;
  }, [unlocks]);

  const template = `minmax(${mobile ? 112 : 158}px, 1.3fr) minmax(88px, 1fr) repeat(${offsets.length}, minmax(70px, 1fr)) minmax(78px, 0.9fr)`;

  return (
    /* A horizontal scroller whose contents are all static text cannot be reached
       or moved by keyboard — axe scrollable-region-focusable. The same fix the two
       screen-level scrollers already carry: make the region itself a named focus
       stop, since there is nothing inside it to focus. */
    <div tabIndex={0} aria-label="Unlock matrix" style={{ overflowX: "auto" }}>
      <div style={{ minWidth: mobile ? 560 : undefined }}>
        {/* header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: template,
            gap: 0,
            padding: "8px 16px",
            borderBottom: `1px solid ${L1}`,
            ...monoLabel(9, "0.11em"),
            color: DIM,
          }}
        >
          <span>SEASON</span>
          <span style={{ textAlign: "right", color: ACCENT_USDX, paddingRight: 12 }}>
            TRACK A · USDX
          </span>
          {offsets.map((o, i) => (
            <span
              key={o}
              style={{
                textAlign: "right",
                paddingLeft: i === 0 ? 12 : 0,
                borderLeft: i === 0 ? `1px solid ${L2}` : undefined,
              }}
            >
              {o === 0 ? "AT CLOSE" : `+${o}M`}
            </span>
          ))}
          <span style={{ textAlign: "right" }}>TOTAL NEX</span>
        </div>

        {seasons.map((season) => {
          const acct = accounts.find((a) => a.seasonId === season.id);
          if (!acct) return null;
          const open = season.status === "open";
          const total = open
            ? unwrapOr(acct.estimatedNex, 0)
            : unwrapOr(acct.entitlementNex, 0);

          return (
            <div
              key={season.id}
              style={{
                display: "grid",
                gridTemplateColumns: template,
                alignItems: "center",
                gap: 0,
                padding: "10px 16px",
                borderBottom: `1px solid ${L0}`,
                background: open ? TERM : "transparent",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 3, paddingRight: 10 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: ARCHIVO, fontSize: 12.5, color: open ? HI : TXT }}>
                    {season.name.replace("Season ", "S")}
                  </span>
                  {open && (
                    <span
                      style={{
                        ...monoLabel(8, "0.1em"),
                        color: GREEN,
                        border: `1px solid ${GREEN}44`,
                        borderRadius: R_XS,
                        padding: "1px 4px",
                      }}
                    >
                      OPEN
                    </span>
                  )}
                </span>
              </span>

              <span
                title={
                  open
                    ? "Accrued so far this season. Track A settles in full at close."
                    : "Track A — 50% of the net fees you paid, rebated in USDX at close. Liquid on arrival, no ladder."
                }
                style={{
                  textAlign: "right",
                  paddingRight: 12,
                  fontFamily: MONO,
                  fontSize: 12,
                  color: ACCENT_USDX,
                  /* An open season's figure is an estimate, and dimming is how that
                     is said without a second label. 0.6 said it at 3.4:1, which is
                     below AA — the estimate was legible to me and not to everyone.
                     0.75 is the lowest value on this blue that clears 4.5:1, so the
                     signal survives at the strongest form the contrast floor allows
                     rather than being dropped. The leading `~` carries it anyway. */
                  opacity: open ? 0.75 : 1,
                  fontVariantNumeric: "tabular-nums",
                  cursor: "help",
                }}
              >
                {open ? "~" : ""}
                {comma(unwrapOr(acct.trackARebateUsdx, 0), 2)}
              </span>

              {offsets.map((o, ci) => {
                const tr = season.schedule.find((t) => t.offsetMonths === o);
                if (!tr) {
                  return (
                    <span
                      key={o}
                      title="This season's ladder has no tranche at this offset"
                      style={{
                        textAlign: "right",
                        color: FAINT,
                        fontFamily: MONO,
                        fontSize: 11,
                        paddingLeft: ci === 0 ? 12 : 0,
                        borderLeft: ci === 0 ? `1px solid ${L2}` : undefined,
                      }}
                    >
                      ·
                    </span>
                  );
                }
                const amount = total * tr.share;
                const at = season.settledAt
                  ? new Date(season.settledAt.getTime() + o * 30.44 * 86_400_000)
                  : null;
                const key = at ? new Date(at).setUTCHours(12, 0, 0, 0) : -1;
                const feed = byDay.get(key);
                const distributed = !!at && at <= NOW;
                const paused = feed?.status === "paused";
                const color = open ? MUT : distributed ? GREEN : paused ? AMBER : TXT;
                return (
                  <span
                    key={o}
                    title={
                      open
                        ? `Projected from a live estimate — this season has not settled`
                        : `${day(at as Date)} · ${(tr.share * 100).toFixed(0)}% of the season${
                            paused ? " · paused: activity threshold not met" : ""
                          }`
                    }
                    style={{
                      textAlign: "right",
                      fontFamily: MONO,
                      fontSize: 12,
                      color,
                      fontVariantNumeric: "tabular-nums",
                      cursor: "help",
                      paddingLeft: ci === 0 ? 12 : 0,
                      borderLeft: ci === 0 ? `1px solid ${L2}` : undefined,
                    }}
                  >
                    {open ? "~" : ""}
                    {comma(amount, 2)}
                    {paused && <span style={{ color: AMBER }}> ⏸</span>}
                  </span>
                );
              })}

              <span
                style={{
                  textAlign: "right",
                  fontFamily: MONO,
                  fontSize: 12.5,
                  color: open ? MUT : HI,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {open ? "~" : ""}
                {comma(total, 2)}
              </span>
            </div>
          );
        })}

        {/* legend */}
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            padding: "9px 16px",
            ...monoLabel(8.5, "0.1em"),
          }}
        >
          {(
            [
              ["DISTRIBUTED", GREEN],
              ["SCHEDULED", TXT],
              ["PAUSED", AMBER],
              ["PROJECTED (SEASON OPEN)", MUT],
              ["TRACK A — USDX, LIQUID AT CLOSE", ACCENT_USDX],
            ] as const
          ).map(([label, c]) => (
            <span key={label} style={{ display: "flex", alignItems: "center", gap: 5, color: DIM }}>
              <span style={{ width: 7, height: 7, borderRadius: R_XS, background: c }} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
