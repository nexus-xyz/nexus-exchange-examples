"use client";

/*
 * The economics calculator.
 *
 * WHAT IT IS SELLING, in one sentence: a cash-generating product whose income scales
 * with two things the venue already controls — the volume it routes and the deposits
 * it holds. Everything here serves that sentence.
 *
 * ONE CALCULATOR, NOT TWO. This was two stacked panels — a fee model and a deposit
 * model — each with its own inputs, its own preset chips and its own row of figures.
 * It cost two and a half screens and printed "fees per year" twice, once in each
 * panel, because neither knew about the other. But nobody runs a venue for the fee
 * income or for the yield income; they run it for the income. Four controls in one
 * strip and one payoff underneath says that, in a third of the height.
 *
 * ONE NUMBER, THEN ITS PARTS. The total is the hero because the total is the
 * business. The two lines under it exist so a reader can see that one of them pays
 * even in a quiet month — which is the whole argument for the deposit share, and an
 * argument that disappears the moment the two are drawn as separate businesses.
 *
 * SIX FIGURES BECAME THREE. Monthly and annualised are the same fact twice and a
 * business plans on the year. The per-ticket figure went with them: the split bar
 * already states the all-in price in basis points, which is how a trader's cost is
 * quoted anyway.
 *
 * It is a client component and one of three on the page. State is four numbers and
 * every figure is derived at render, so the server output and the first client
 * render are byte-identical and there is nothing to hydrate incorrectly.
 */

import { useState } from "react";

import { AMBER, ARCHIVO, CHROME, DIM, FAINT, GREEN, HI, L1, L2, L3, MONO, MUT, PANEL, SEL, SUNK, TXT } from "@/lib/theme";

import { Band, Head, Strong, css as s, annotation, body, eyebrow } from "./primitives";

/**
 * The top of the slider, and a real ceiling this time.
 *
 * It was 25 — a range rather than a cap, from when a venue could charge anything and
 * the slider only had to end somewhere. The fee is now capped at 10 bps
 * (see venue-kit's `MAX_FEE_BPS`), so the slider ends where the product ends and the
 * field beside it refuses more, because the model does. A calculator that lets a
 * reader price a venue at 20 bps is selling them a number they cannot charge.
 *
 * The recommendation is unaffected: 3.2 bps sits at a third of the ceiling, which is
 * the more useful thing for the slider to show than a rate nobody runs.
 */
const SLIDER_MAX_BPS = 10;

/**
 * Two constraints fix these between them: the trader pays about 4 bps all-in, which
 * is where a competitive perp venue prices, and the split is 20/80 in the venue's
 * favour from the first order rather than something they grow into. That leaves
 * exactly one answer — we take 0.8 and they take 3.2.
 *
 * Enterprise takes it from there: our 0.8 falls to 0.2 with volume, so the venue's
 * share climbs 80 → 95 without them ever raising their own price.
 */
const BASE_BPS = 0.8;
const RECOMMENDED_BPS = 3.2;

/**
 * The second line. Idle collateral is not idle to us — USDX is backed 1:1 by cash
 * and short-dated Treasuries, and that backing earns the T-bill rate. 80/20 in the
 * venue's favour like the fee, but FLAT: a venue earns its share of the float on day
 * one, with no volume to reach first.
 *
 * The rate is an input rather than a constant. Nobody can promise a T-bill rate, and
 * a number frozen into a page goes stale the first time the curve moves.
 */
const YIELD_SHARE_TO_VENUE = 0.8;
const DEFAULT_TBILL_PCT = 4.0;

const VOLUME_PRESETS = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000];
const DEPOSIT_PRESETS = [5_000_000, 25_000_000, 100_000_000, 500_000_000];

/* Explicit locale, not the visitor's: the server renders this markup too, and a
   formatter that reads the browser's locale would disagree with it on the client. */
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** $1M, $500M, $1B — a preset label a reader parses without counting zeros. */
function short(n: number): string {
  if (n >= 1e9) return `$${n / 1e9}B`;
  if (n >= 1e6) return `$${n / 1e6}M`;
  return usd.format(n);
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        /* 32px is the default control tier in the tap scale; these sit in a row a
           finger will use, so they carry it rather than shrinking to fit. */
        minHeight: 32,
        padding: "0 10px",
        borderRadius: 5,
        /* Achromatic: a preset is a selection, not a direction. Green on this page
           means bid or positive, and a chip that is neither borrows the meaning. */
        border: `1px solid ${on ? L3 : L2}`,
        background: on ? SEL : "transparent",
        color: on ? HI : MUT,
        fontFamily: MONO,
        fontSize: 11,
        letterSpacing: "0.04em",
        cursor: "pointer",
        transition: "border-color 0.15s, color 0.15s, background 0.15s",
      }}
    >
      {children}
    </button>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 38,
  padding: "0 11px",
  background: CHROME,
  border: `1px solid ${L2}`,
  borderRadius: 6,
  color: HI,
  fontFamily: MONO,
  fontSize: 14,
};

/** One cell of the control strip: a label, a field, and whatever sits under it. */
function Control({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: "15px 16px 16px", borderRight: `1px solid ${L1}`, minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ ...eyebrow(), display: "block", marginBottom: 9 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * The split bar — the section's argument, drawn.
 *
 * The thing that needs explaining is not either fee, it is the RELATIONSHIP: our cut
 * is fixed, theirs is the part that grows, and the sum is what the trader actually
 * pays. One bar with two segments says all three at once, and it moves as the fee
 * does, so the model is learned by operating it rather than by being told.
 */
function SplitBar({ bps }: { bps: number }) {
  const total = BASE_BPS + bps;
  const yoursPct = total > 0 ? (bps / total) * 100 : 0;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "6px 12px" }}>
        <span style={{ ...eyebrow(TXT) }}>What the trader pays</span>
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: MUT }}>
          {Number(total.toFixed(1))} bps all-in
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: ARCHIVO,
            fontWeight: 700,
            fontSize: 15,
            color: GREEN,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(yoursPct)}% to you
        </span>
      </div>

      {/* Percentages of the track rather than flex-grow: the percentage is the
          quantity being communicated, and the two always sum to 100 because both
          come from the same total. */}
      <div style={{ display: "flex", height: 32, borderRadius: 5, overflow: "hidden", border: `1px solid ${L2}` }}>
        <div
          style={{
            width: `${(BASE_BPS / total) * 100}%`,
            background: L3,
            display: "flex",
            alignItems: "center",
            paddingLeft: 10,
            minWidth: 0,
            transition: "width 0.25s cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 10, color: MUT, whiteSpace: "nowrap" }}>{BASE_BPS}</span>
        </div>
        <div
          style={{
            width: `${(bps / total) * 100}%`,
            background: `linear-gradient(90deg, ${GREEN}3d, ${GREEN}66)`,
            borderLeft: `1px solid ${L2}`,
            display: "flex",
            alignItems: "center",
            paddingLeft: 10,
            minWidth: 0,
            transition: "width 0.25s cubic-bezier(0.32, 0.72, 0, 1)",
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 10, color: GREEN, whiteSpace: "nowrap" }}>
            {Number(bps.toFixed(1))}
          </span>
        </div>
      </div>
    </div>
  );
}

export function Earnings() {
  /*
   * $100M against $25M of deposits, because the two have to be plausible TOGETHER.
   * The defaults were $10M and $25M, which is a venue whose users hold two and a
   * half months of turnover in idle collateral — nothing like a perp venue, where
   * leverage means deposits turn over several times a month. It also drew the fee
   * line as five per cent of the total, which sells the wrong product: the fee is
   * the business and the yield is the floor under it.
   */
  const [volume, setVolume] = useState(100_000_000);
  const [bps, setBps] = useState(RECOMMENDED_BPS);
  const [deposits, setDeposits] = useState(25_000_000);
  const [tbill, setTbill] = useState(DEFAULT_TBILL_PCT);

  const feesYearly = ((volume * bps) / 10_000) * 12;
  const yieldYearly = deposits * (tbill / 100) * YIELD_SHARE_TO_VENUE;
  const totalYearly = feesYearly + yieldYearly;
  const feeShare = totalYearly > 0 ? (feesYearly / totalYearly) * 100 : 0;

  return (
    <Band id="earnings" tone="raised">
      <Head
        eyebrow="Economics"
        title="Two revenue lines, both yours."
        blurb="You earn on the volume you route and on the deposits you hold. We take 0.8 bps of the first and a fifth of the second — and our share of the fee falls as you grow."
      />

      <div
        className={s.reveal}
        style={{ background: SUNK, border: `1px solid ${L2}`, borderRadius: 8, padding: "16px 18px 15px", marginTop: 26 }}
      >
        <SplitBar bps={bps} />
      </div>

      {/* ONE STRIP, FOUR CONTROLS. Two panels of inputs became this. */}
      <div
        className={s.reveal}
        style={{
          background: SUNK,
          border: `1px solid ${L2}`,
          borderRadius: 8,
          overflow: "hidden",
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 235px), 1fr))",
        }}
      >
        <Control label="Monthly volume routed" htmlFor="nx-volume">
          <input
            id="nx-volume"
            type="text"
            inputMode="numeric"
            value={volume.toLocaleString("en-US")}
            onChange={(e) => setVolume(Math.min(1e12, Number(e.target.value.replace(/[^0-9]/g, "")) || 0))}
            style={fieldStyle}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
            {VOLUME_PRESETS.map((v) => (
              <Chip key={v} on={volume === v} onClick={() => setVolume(v)}>
                {short(v)}
              </Chip>
            ))}
          </div>
        </Control>

        <Control label="Your fee (bps)" htmlFor="nx-bps">
          <input
            id="nx-bps"
            type="text"
            inputMode="decimal"
            value={bps}
            /* Clamped, not just floored: the cap is a property of the product, so the
               field cannot be talked into a rate the venue could not charge. */
            onChange={(e) =>
              setBps(Math.max(0, Math.min(SLIDER_MAX_BPS, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)))
            }
            style={fieldStyle}
          />
          {/* The slider is how a reader disagrees with the recommendation, which is
              the interaction the split bar above is waiting for. */}
          <input
            aria-label="Your fee in basis points"
            type="range"
            min={0}
            max={SLIDER_MAX_BPS}
            step={0.1}
            value={bps}
            onChange={(e) => setBps(Number(e.target.value))}
            className={s.range}
            style={{ width: "100%", marginTop: 10 }}
          />
          <div style={{ ...annotation(DIM, 10.5), margin: "2px 0 0" }}>
            {RECOMMENDED_BPS} recommended · {SLIDER_MAX_BPS} bps ceiling
          </div>
        </Control>

        <Control label="Idle deposits held" htmlFor="nx-deposits">
          <input
            id="nx-deposits"
            type="text"
            inputMode="numeric"
            value={deposits.toLocaleString("en-US")}
            onChange={(e) => setDeposits(Math.min(1e12, Number(e.target.value.replace(/[^0-9]/g, "")) || 0))}
            style={fieldStyle}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
            {DEPOSIT_PRESETS.map((v) => (
              <Chip key={v} on={deposits === v} onClick={() => setDeposits(v)}>
                {short(v)}
              </Chip>
            ))}
          </div>
        </Control>

        <Control label="T-bill rate (%)" htmlFor="nx-tbill">
          <input
            id="nx-tbill"
            type="text"
            inputMode="decimal"
            value={tbill}
            onChange={(e) => setTbill(Math.max(0, Math.min(20, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)))}
            style={fieldStyle}
          />
          <div style={{ ...annotation(DIM, 10.5), margin: "10px 0 0" }}>
            yours to set — we are not forecasting the curve
          </div>
        </Control>
      </div>

      {/* THE PAYOFF. One number, then the two lines that make it. */}
      <div
        className={s.reveal}
        style={{
          background: SUNK,
          border: `1px solid ${L2}`,
          borderRadius: 8,
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 290px), 1fr))",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "19px 20px 21px", borderRight: `1px solid ${L1}`, minWidth: 0 }}>
          <div style={eyebrow()}>Your revenue, per year</div>
          <div
            style={{
              fontFamily: ARCHIVO,
              fontWeight: 700,
              fontSize: "clamp(30px, 4.4vw, 46px)",
              letterSpacing: "-0.03em",
              fontVariantNumeric: "tabular-nums",
              color: GREEN,
              margin: "10px 0 6px",
              overflowWrap: "anywhere",
            }}
          >
            {usd.format(totalYearly)}
          </div>
          <div style={{ ...body, fontSize: 12.5, color: DIM }}>kept in full — not a share of ours</div>
        </div>

        <div style={{ padding: "19px 20px 21px", display: "grid", gap: 13, alignContent: "center", minWidth: 0 }}>
          {/* The composition, as one bar. It is the reason both lines are on this
              page: in a quiet month the yield half keeps paying. */}
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ ...annotation(MUT, 11), margin: 0 }}>
                Fees <span style={{ color: TXT }}>{usd.format(feesYearly)}</span>
              </span>
              <span style={{ ...annotation(MUT, 11), margin: 0, textAlign: "right" }}>
                <span style={{ color: TXT }}>{usd.format(yieldYearly)}</span> deposit yield
              </span>
            </div>
            <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", border: `1px solid ${L2}` }}>
              <div
                style={{
                  width: `${feeShare}%`,
                  background: `${GREEN}66`,
                  transition: "width 0.25s cubic-bezier(0.32, 0.72, 0, 1)",
                }}
              />
              <div style={{ flex: 1, background: L3 }} />
            </div>
          </div>
          <p style={{ ...annotation(FAINT, 11), margin: 0 }}>
            {/* The composition bar directly above is labelled "Fees" and "deposit yield" with
                live figures. The first sentence was a caption for it. */}
            A quiet month is not a month without income.
          </p>
        </div>
      </div>

      {/* Caveats, three cells, where there used to be three paragraphs. */}
      <div className={s.trio} style={{ marginTop: 12, background: L1, border: `1px solid ${L2}` }}>
        <div style={{ background: PANEL, padding: "13px 16px 15px", display: "grid", gap: 5 }}>
          <span style={{ ...eyebrow(HI), fontSize: 9.5 }}>A projection, not an offer</span>
          <span style={{ ...annotation(MUT, 11), margin: 0 }}>
            {/* The second clause was our own delivery status — "nothing moves USDX today". The
                caveat that earns this cell is that these are the reader's own numbers, not a
                quote. */}
            Arithmetic on numbers you typed, at the volumes you chose. Your own flow will not look like it.
          </span>
        </div>
        <div style={{ background: PANEL, padding: "13px 16px 15px", display: "grid", gap: 5 }}>
          <span style={{ ...eyebrow(HI), fontSize: 9.5 }}>Backed 1:1</span>
          <span style={{ ...annotation(MUT, 11), margin: 0 }}>
            USDX is held in cash and short-dated US Treasuries, and 80% of what it earns is yours.
          </span>
        </div>
        <div style={{ background: PANEL, padding: "13px 16px 15px", display: "grid", gap: 5 }}>
          <span style={{ ...eyebrow(AMBER), fontSize: 9.5 }}>Additive, capped, approved</span>
          <span style={{ ...annotation(MUT, 11), margin: 0 }}>
            Your fee sits on top of the schedule, up to 10 bps, and your trader approves a maximum for your venue with
            their own wallet before you can charge a basis point. Trade against your own venue and you pay both — there
            is no extraction path.
          </span>
        </div>
      </div>

      {/* This paragraph used to describe the Enterprise ladder in prose, one section before
          the ladder draws it — 0.8 → 0.2, 80% → 94%, computed on screen there. It keeps one
          line rather than a bare cross-reference: a reader who has just typed a volume into a
          calculator is the reader for whom "this improves" is load-bearing, and sending them
          two sections away to learn it is worse than saying it. */}
      <p style={{ ...annotation(FAINT, 11), margin: "14px 0 0", maxWidth: "84ch" }}>
        <Strong>Both lines scale with you.</Strong> Our 0.8 bps falls as your volume rises, and your share rises with
        it — the ladder is under Enterprise.
      </p>
    </Band>
  );
}
