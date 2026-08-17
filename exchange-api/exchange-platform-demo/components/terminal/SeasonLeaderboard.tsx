/*
 * Season leaderboard — a window around the caller, not a top ten.
 *
 * A top-ten table is a list of accounts that are not you. At rank ~300 it is
 * decoration at best and discouraging at worst: it says the pool is already
 * captured and reading it changes nothing you would do. The window says the
 * opposite with the same data — the two rows above are within a few percent of
 * your points, and that is a reachable target. The API is windowed for the same
 * reason (`/seasons/{id}/leaderboard`), so this is the contract's shape, not a
 * client-side slice of a bigger board.
 *
 * IDENTITY. Every row is an account address and nothing else. There is no
 * display name, no handle, no avatar, no linked social — not hidden behind a
 * setting, but absent from the wire type, so no later change adds one by
 * accident. The blocky mark left of each address is derived from the address
 * itself: it is a checksum you can recognise at a glance across seasons, and it
 * carries no information the address does not already carry. What the venue
 * publishes about everyone else is the DISTRIBUTION — the decile line under the
 * table — which answers "is this pool captured?" without naming a single
 * account.
 *
 * NO REWARD COLUMN. Standings are points and share of pool; what those convert
 * to is not on this table. Share already implies the pro-rata NEX exactly, and a
 * combined figure across both tracks would leak the other account's fee volume,
 * since Track A is half the fees it paid. See `WireLeaderboardEntry`.
 */

import {
  R_XS,
  ARCHIVO,
  DIM,
  FAINT,
  GREEN,
  GREEN_WASH,
  HI,
  L0,
  L1,
  MONO,
  MUT,
  NUM,
  RED,
  SUNK,
  TERM,
  TXT,
  monoLabel,
} from "@/lib/theme";
import { comma } from "@/lib/format";
import { isPresent, unwrapOr } from "@/lib/api/absence";
import type { Leaderboard } from "@/lib/api/seasons";

/** `0x8d41f2…ac0e2d`. Head and tail both shown — the tail is what people match on. */
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/**
 * Identicon: a 5×5 grid, mirrored about the vertical axis, filled from the
 * address's own hex digits. Symmetry is what makes it memorable at 18px; the
 * mirror means only 15 cells carry data, which is plenty to separate ten rows.
 */
function Identicon({ address, self }: { address: string; self: boolean }) {
  const hex = address.slice(2);
  const bits = Array.from({ length: 15 }, (_, i) => parseInt(hex[i] ?? "0", 16) % 2 === 1);
  const cell = 3.4;
  return (
    <svg
      width={cell * 5}
      height={cell * 5}
      viewBox={`0 0 ${cell * 5} ${cell * 5}`}
      aria-hidden="true"
      style={{ flex: "0 0 auto", opacity: self ? 1 : 0.75 }}
    >
      {bits.map((on, i) => {
        if (!on) return null;
        const col = i % 3;
        const row = Math.floor(i / 3);
        return (
          <g key={i} fill={self ? GREEN : MUT}>
            <rect x={col * cell} y={row * cell} width={cell} height={cell} />
            <rect x={(4 - col) * cell} y={row * cell} width={cell} height={cell} />
          </g>
        );
      })}
    </svg>
  );
}

/** ▲12 / ▼4 / — . Absent (a new entrant) prints an em dash, never a zero. */
function RankDelta({ delta }: { delta: Leaderboard["entries"][number]["rankDelta7d"] }) {
  if (!isPresent(delta)) {
    return (
      <span title="No standing a week ago — new this season" style={{ color: FAINT }}>
        —
      </span>
    );
  }
  if (delta === 0) return <span style={{ color: DIM }}>0</span>;
  // A NEGATIVE delta is a numerically smaller rank number, which is an
  // IMPROVEMENT. Getting this backwards is the classic leaderboard bug.
  const up = delta < 0;
  return (
    <span style={{ color: up ? GREEN : RED }}>
      {up ? "▲" : "▼"}
      {Math.abs(delta)}
    </span>
  );
}

function Gap({ n, where }: { n: number; where: "above" | "below" }) {
  if (n <= 0) return null;
  return (
    <div
      style={{
        padding: "5px 16px",
        borderBottom: `1px solid ${L0}`,
        ...monoLabel(9, "0.1em"),
        color: FAINT,
        background: SUNK,
      }}
    >
      ⋯ {comma(n, 0)} accounts {where}
    </div>
  );
}

export function SeasonLeaderboard({
  board,
  mobile,
  open,
}: {
  board: Leaderboard;
  mobile: boolean;
  /** Open seasons move. The header says so rather than implying a final table. */
  open: boolean;
}) {
  const self = board.entries.find((e) => e.isSelf);
  /* A 7-day rank move only means something while the board is still moving. On a
   * settled season the column would be a week's worth of churn from whenever the
   * season closed — true of the data, useless to the reader, and easily misread as
   * current. The column is dropped rather than zeroed. */
  const showDelta = open && !mobile;
  /* The three numeric columns are FIXED and the address column takes the slack,
   * so points and share stay adjacent at the right edge instead of drifting apart
   * as the panel widens. Comparing your points to the row above is the whole job
   * of this table; a fr-sized gap between them makes it a scan. */
  const template = mobile
    ? "44px minmax(0, 1fr) 96px"
    : open
      ? "56px minmax(0, 1fr) 72px 108px 116px"
      : "56px minmax(0, 1fr) 108px 116px";
  const top = board.entries[0]?.rank ?? 1;
  const bottom = board.entries[board.entries.length - 1]?.rank ?? 0;
  const deciles = unwrapOr(board.pointsDistribution, [] as number[]);
  const topDecile = deciles.length ? deciles[deciles.length - 1] : null;

  return (
    <div>
      {/* your standing */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          flexWrap: "wrap",
          padding: mobile ? "12px 14px" : "14px 16px",
          borderBottom: `1px solid ${L1}`,
          background: TERM,
        }}
      >
        <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: 20, color: HI }}>
          #{comma(self?.rank ?? 0, 0)}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: MUT }}>
          of {comma(board.participants, 0)} ranked
        </span>
        {self && open && (
          <span style={{ fontFamily: MONO, fontSize: 12, color: MUT }}>
            <RankDelta delta={self.rankDelta7d} /> <span style={{ color: FAINT }}>7d</span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ ...monoLabel(9, "0.11em"), color: open ? GREEN : FAINT }}>
          {open ? "STANDINGS MOVE UNTIL CLOSE" : "FINAL"}
        </span>
      </div>

      {/* head */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: template,
          padding: "7px 16px",
          borderBottom: `1px solid ${L1}`,
          ...monoLabel(9, "0.11em"),
          color: DIM,
        }}
      >
        <span>RANK</span>
        <span>ACCOUNT</span>
        {showDelta && <span style={{ textAlign: "right" }}>7D</span>}
        <span style={{ textAlign: "right" }}>POINTS</span>
        {!mobile && <span style={{ textAlign: "right" }}>SHARE OF POOL</span>}
      </div>

      <Gap n={top - 1} where="above" />

      {board.entries.map((e) => (
        <div
          key={e.rank}
          style={{
            display: "grid",
            gridTemplateColumns: template,
            alignItems: "center",
            padding: "9px 16px",
            borderBottom: `1px solid ${L0}`,
            /* The wash is the whole marker. It used to carry a 2px green rail as
               well, which is one signal too many for "this row is you" — the tint
               already covers the row and the rail was the same accent stripe the
               console sidebars were using as decoration. */
            background: e.isSelf ? GREEN_WASH : "transparent",
          }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: 12,
              color: e.isSelf ? HI : NUM,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {e.rank}
          </span>

          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <Identicon address={e.address} self={e.isSelf} />
            <span
              title={e.address}
              style={{
                fontFamily: MONO,
                fontSize: 11.5,
                color: e.isSelf ? HI : MUT,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {short(e.address)}
            </span>
            {e.isSelf && (
              <span
                style={{
                  ...monoLabel(8, "0.1em"),
                  color: GREEN,
                  border: `1px solid ${GREEN}44`,
                  borderRadius: R_XS,
                  padding: "1px 4px",
                  flex: "0 0 auto",
                }}
              >
                YOU
              </span>
            )}
          </span>

          {showDelta && (
            <span
              style={{
                textAlign: "right",
                fontFamily: MONO,
                fontSize: 11,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <RankDelta delta={e.rankDelta7d} />
            </span>
          )}

          <span
            style={{
              textAlign: "right",
              fontFamily: MONO,
              fontSize: 12,
              color: e.isSelf ? HI : NUM,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {comma(e.points, 1)}
          </span>

          {!mobile && (
            <span
              style={{
                textAlign: "right",
                fontFamily: MONO,
                fontSize: 12,
                color: e.isSelf ? GREEN : MUT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {(e.shareOfPool * 100).toFixed(3)}%
            </span>
          )}

        </div>
      ))}

      <Gap n={board.participants - bottom} where="below" />

      <div style={{ padding: "10px 16px", borderTop: `1px solid ${L1}`, background: SUNK }}>
        <span style={{ ...monoLabel(9, "0.1em"), color: FAINT, letterSpacing: "0.06em" }}>
          Accounts are addresses. The venue publishes no names, handles or profiles
          {topDecile !== null && (
            <> · top decile holds {(topDecile * 100).toFixed(0)}% of this season&apos;s points</>
          )}
          {open && <> · standings move with everyone else&apos;s activity until close</>}
        </span>
      </div>
    </div>
  );
}
