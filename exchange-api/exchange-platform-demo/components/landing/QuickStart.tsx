/*
 * The five-minute strip.
 *
 * A long page loses people between the architecture and the price, and the cheapest
 * way to keep them is to answer "what do I actually have, and when" before asking
 * them to read another section. So this is a clock, not a feature list: four marks,
 * each saying what exists at that minute rather than what the platform can do.
 *
 * IT KEEPS ITS NUMBERS, and it is the only section on the page that does. The
 * problem loop lost its 01/02/03 because a loop is not a sequence; a clock is, the
 * order carries information the reader needs, and 00:00 → 05:00 is the information.
 *
 * It is deliberately the shortest band on the page — a beat between two dense ones
 * only works if it reads as a beat.
 *
 * The last mark is the honest one. Minutes zero to three are things a developer can
 * do this afternoon; the branded venue on a URL is where our own tooling is missing,
 * and that mark carries the caveat rather than the strip carrying an average.
 */

import { DIM, FAINT, HI, L1, L2, MONO, SUNK, TXT } from "@/lib/theme";

import { Band, Strong, css as s, annotation, body, display } from "./primitives";

const MARKS: { at: string; title: string; have: string }[] = [
  {
    at: "00:00",
    title: "Install the SDK",
    have: "npm i @nexus-xyz/exchange-ts, then read markets, book and trades with no key at all.",
  },
  {
    at: "01:00",
    title: "Run the terminal",
    have: "A full trading UI on your machine. No backend, no account, no approval.",
  },
  {
    at: "03:00",
    title: "Make it yours",
    have: "Palette, wordmark, markets and your builder fee in one config file. Every surface follows it.",
  },
  {
    at: "05:00",
    title: "Point it at the book",
    have: "A registered builder code turns the same build into a venue routing real orders into the shared book. Your traders bring their own keys.",
  },
];

export function QuickStart() {
  return (
    <Band id="quickstart" tight>
      <div
        className={s.reveal}
        style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "8px 16px", marginBottom: 24 }}
      >
        <h2 style={{ ...display.md, fontSize: "clamp(21px, 2.6vw, 30px)" }}>A venue running in five minutes.</h2>
        <span style={annotation(FAINT, 11.5)}>what you have at each mark, not what the platform can do</span>
      </div>

      {/*
       * A rule with marks on it, not four cards. A clock is one object and the marks
       * are positions on it — four boxes would say these are four separate things.
       */}
      <div
        className={s.reveal}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))",
          gap: 0,
          borderTop: `1px solid ${L2}`,
        }}
      >
        {MARKS.map((m) => (
          <div key={m.at} style={{ padding: "16px 18px 20px", borderLeft: `1px solid ${L1}`, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* The mark itself, sitting on the rule above it. */}
              <span
                aria-hidden
                style={{ width: 5, height: 5, borderRadius: 1, background: TXT, marginTop: -19, flex: "0 0 auto" }}
              />
              <span
                className={s.tnum}
                style={{ fontFamily: MONO, fontSize: 13, letterSpacing: "0.06em", color: HI }}
              >
                {m.at}
              </span>
            </div>
            <div style={{ ...display.xs, fontSize: 14, margin: "12px 0 7px" }}>{m.title}</div>
            <div style={{ ...body, fontSize: 12.5 }}>{m.have}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 16,
          background: SUNK,
          border: `1px solid ${L2}`,
          borderRadius: 6,
          padding: "12px 14px",
          ...annotation(DIM, 11.5),
        }}
      >
        {/* The npm/clone recap was marks 00:00 and 01:00 verbatim, two inches above. */}
        <Strong>The five-minute mark is the honest one.</Strong> The last mark deploys into your own hosting account —
        your infrastructure, your account, your bill.
      </div>
    </Band>
  );
}
