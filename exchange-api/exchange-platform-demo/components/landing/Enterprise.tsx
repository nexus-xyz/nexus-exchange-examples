/*
 * Enterprise — what happens when a venue outgrows the default.
 *
 * WHY THE SECTION EXISTS. Everything above answers "can I start". A serious buyer's
 * second question is the one that kills deals late: "and what happens when I am big
 * — do you scale with me, or do I find out at the worst possible moment that I am on
 * a shared plan with a rate limit?" A platform selling shared infrastructure has to
 * answer that in writing or the answer is assumed to be no.
 *
 * THE MESSAGE IS READINESS, NOT A PRICE LIST. What a growing venue is actually
 * afraid of is not the invoice — it is the replatform: discovering at the worst
 * possible moment that scaling means a migration, a renegotiation and six months of
 * engineering. So the headline promises that the day they decide to scale, nothing
 * they have built gets rewritten, and everything below is evidence for that one
 * claim.
 *
 * CAPABILITIES BEFORE PRICE, for the same reason. The section used to open with the
 * fee ladder, which put a discount in front of a reader who had not been told what
 * they were buying — and a discount is only interesting once the thing is.
 *
 * ICONS, AND FEW WORDS. Four groups, four marks, four short lines each. The earlier
 * version ran a sentence per item and read as a contract summary; a reader at this
 * point in the page is checking whether their concern is on the list, which is a
 * scanning task and not a reading one.
 *
 * THE NON-OFFER CAME OUT. This carried a block refusing queue priority on the shared
 * book, which is still the policy and is still worth saying — but a section whose
 * job is "we are ready when you are" ended on a paragraph about what we will not
 * sell, and that is the wrong last note for the reader who has just decided they
 * might scale. The FAQ is where a reader goes looking for what the platform refuses
 * to do.
 */

import { ARCHIVO, DIM, FAINT, GREEN, HI, L1, L2, MONO, MUT, PANEL, TXT } from "@/lib/theme";

import { Band, Head, Strong, Wrap, annotation, body, css as cx, eyebrow } from "./primitives";

/**
 * Four marks, drawn rather than fetched — the same rule as every other glyph in this
 * app, and the reason the third-party-request count on the stack section is zero.
 * One 20x20 grid and one stroke weight, so a row of them optically aligns.
 */
function GroupMark({ id }: { id: "uptime" | "compute" | "markets" | "governance" }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (id === "uptime") {
    /* A trace that does not flatline — availability is a signal, not a shield. */
    return (
      <svg {...common}>
        <path d="M2 12h3l2.2-5.4L10.4 15l2-3h3.6" />
      </svg>
    );
  }
  if (id === "compute") {
    /* A die with pins: the only shape that reads as "your own silicon" at 22px. */
    return (
      <svg {...common}>
        <rect x="6" y="6" width="8" height="8" rx="1.2" />
        <path d="M8.4 6V3.4M11.6 6V3.4M8.4 16.6V14M11.6 16.6V14M6 8.4H3.4M6 11.6H3.4M16.6 8.4H14M16.6 11.6H14" />
      </svg>
    );
  }
  if (id === "markets") {
    /* A candle with a wick — the page's own subject, not a generic bar chart. */
    return (
      <svg {...common}>
        <path d="M6 3.5v13M14 3.5v13" />
        <rect x="3.6" y="7" width="4.8" height="6" rx="1" />
        <rect x="11.6" y="5" width="4.8" height="7.5" rx="1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="4" y="9" width="12" height="7.5" rx="1.6" />
      <path d="M7 9V6.6a3 3 0 0 1 6 0V9" />
    </svg>
  );
}

/** Four groups, four short lines each. Terse on purpose — this is a scan. */
const OFFERS: {
  id: "uptime" | "compute" | "markets" | "governance";
  group: string;
  items: string[];
}[] = [
  {
    id: "uptime",
    group: "Availability",
    items: [
      "99.9% uptime SLA, with credits",
      "A p99 latency commitment",
      "Published throttling order",
      "Named escalation, minutes to ack",
    ],
  },
  {
    id: "compute",
    group: "Dedicated compute",
    items: [
      "Isolated books for your markets",
      "Reserved ingress throughput",
      "A gateway in your region",
      "Capacity on a schedule, not a ticket",
    ],
  },
  {
    id: "markets",
    group: "Market rights",
    items: [
      "List markets nobody else carries",
      "Your parameters, your oracle",
      "Earn when other venues carry them",
      "Fund maker rebates to buy depth",
    ],
  },
  {
    id: "governance",
    group: "Governance",
    items: [
      "SSO, RBAC, IP allowlists",
      "Data residency you choose",
      "SOC 2, audit rights, exports",
      "Pinned versions, long deprecations",
    ],
  },
];

/*
 * The ladder, as an ILLUSTRATION rather than a rate card.
 *
 * OURS IS THE ONLY NUMBER IN IT. That is the correction this table needed twice
 * over. It used to be headed "the fee scales with volume", which does not say whose
 * — and it is ours, falling, not theirs rising. And it held all-in fixed at 4 bps,
 * which silently assumed the venue raises its own fee to fill the gap we vacate.
 * That is one possible behaviour and it is not the offer.
 *
 * The offer is simpler: our fee falls with volume and the venue's fee is whatever
 * the venue decides. So the ladder holds THEIR number at the recommended 3.2 and
 * lets ours fall underneath it — their share rises 80 → 94, and the all-in price
 * their trader pays falls from 4.0 to 3.4 at the same time.
 *
 * WHY THE PERCENTAGES ARE NOT A CEILING. 80% is what a venue keeps at the
 * RECOMMENDED fee on the entry rung, not the most it can keep there — a venue
 * charging 6 bps keeps 88% before it routes a dollar. Reading the table as a cap on
 * their share would be reading it exactly backwards, which is why the line under the
 * heading names the assumption instead of leaving it to be inferred.
 *
 * NO TIER NAMES. "Growth" and "Scale" invited a reader to work out which one they
 * are and then argue about the boundary — a sales conversation, not a landing page's
 * job. A volume and a share is the whole content.
 */
const RECOMMENDED_VENUE_BPS = 3.2;
const LADDER: { volume: string; ours: number }[] = [
  { volume: "Up to $250M", ours: 0.8 },
  { volume: "$250M – $1B", ours: 0.6 },
  { volume: "$1B – $5B", ours: 0.4 },
  { volume: "Above $5B", ours: 0.2 },
];

export function Enterprise() {
  return (
    <Band id="enterprise" tone="raised">
      <Wrap>
        <Head
          eyebrow="Enterprise"
          title="Enterprise scale, ready before you need it."
          /* "None of this is a migration" and "nothing you have built gets rewritten" were the
             same sentence at both ends of one blurb. */
          blurb="The day you decide to scale, none of this is a migration. Same API, same repository, same config file — capacity goes up, and our share of the fee goes down."
        />

        {/* WHAT SCALES, FIRST. */}
        <div className={cx.quad} style={{ marginTop: 28, background: L1, border: `1px solid ${L2}` }}>
          {OFFERS.map((g) => (
            <div key={g.group} style={{ background: PANEL, padding: "18px 16px 20px", minWidth: 0 }}>
              <span style={{ color: HI, display: "inline-flex" }}>
                <GroupMark id={g.id} />
              </span>
              <div style={{ ...eyebrow(TXT), margin: "12px 0 11px" }}>{g.group}</div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {g.items.map((it) => (
                  <li key={it} style={{ ...annotation(MUT, 11), margin: 0, display: "flex", gap: 7 }}>
                    <span aria-hidden style={{ color: FAINT }}>·</span>
                    <span style={{ minWidth: 0 }}>{it}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* WHAT IT COSTS, SECOND. */}
        <div style={{ marginTop: 28 }}>
          <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "6px 14px", marginBottom: 6 }}>
            <span style={eyebrow(TXT)}>And our fee falls as you grow</span>
            <span style={{ ...annotation(FAINT, 11), margin: 0 }}>illustrative — the shape, not a rate card</span>
          </div>
          <p style={{ ...body, fontSize: 13, color: MUT, margin: "0 0 16px", maxWidth: "80ch" }}>
            Ours is the only number here — <Strong>0.8 bps down to 0.2</Strong>. Shares assume you hold your own fee
            at the recommended {RECOMMENDED_VENUE_BPS}; charge more and every one of them is higher, at every volume.
          </p>

          <div style={{ display: "grid", gap: 10 }}>
            {LADDER.map((r) => {
              const allIn = r.ours + RECOMMENDED_VENUE_BPS;
              const pct = Math.round((RECOMMENDED_VENUE_BPS / allIn) * 100);
              return (
                <div
                  key={r.volume}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 2fr) auto",
                    alignItems: "center",
                    gap: 14,
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 11.5, color: MUT, whiteSpace: "nowrap" }}>
                    {r.volume}
                  </span>
                  {/* The same two-segment device the economics split bar uses, so the
                      two sections are visibly one argument at two scales. */}
                  <span style={{ display: "flex", height: 26, borderRadius: 5, overflow: "hidden", border: `1px solid ${L2}` }}>
                    {/* Ours is a flat neutral and yours is lit: at 26px tall the two
                        halves have to separate at a glance or the ladder is four
                        identical bars with numbers beside them. */}
                    <span style={{ width: `${(r.ours / allIn) * 100}%`, background: L2 }} />
                    <span
                      style={{
                        width: `${(RECOMMENDED_VENUE_BPS / allIn) * 100}%`,
                        background: `linear-gradient(90deg, ${GREEN}3d, ${GREEN}66)`,
                        borderLeft: `1px solid ${L2}`,
                      }}
                    />
                  </span>
                  <span
                    style={{
                      fontFamily: ARCHIVO,
                      fontWeight: 700,
                      fontSize: 14,
                      color: GREEN,
                      fontVariantNumeric: "tabular-nums",
                      width: 44,
                      textAlign: "right",
                    }}
                  >
                    {pct}%
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 10 }}>
            <span style={{ ...annotation(DIM, 10.5), margin: 0 }}>Ours — the only part that is fixed</span>
            <span style={{ ...annotation(GREEN, 10.5), margin: 0 }}>Yours — whatever you set</span>
          </div>

          <p style={{ ...annotation(FAINT, 11), margin: "14px 0 0", maxWidth: "84ch" }}>
            {/* The 80/20-from-day-one claim is stated in Deposits and in the Economics caveat
                cell. What is unique here — and is the section's actual promise — is that
                moving up a rung costs the venue nothing. */}
            The tier is a contract change and not a code change: it applies itself, and your venue does not redeploy to
            receive it.
          </p>
        </div>

      </Wrap>
    </Band>
  );
}
