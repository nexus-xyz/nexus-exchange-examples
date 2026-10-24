/*
 * The tape — the page's structural divider.
 *
 * A page this long needs breaks between its movements, and the default answer is a
 * rule and eighty pixels of air. A tape is better because it is a real artifact of
 * the subject: the printed record of what traded, which every venue in this
 * industry has had on a wall or a screen for a century. It divides the page with
 * something the page is about.
 *
 * It also restates the hero's argument in passing. Every print carries the venue
 * that sent it — Acme, Beta, an app, an agent — and they are all prints from one
 * book, which is the fan-in said again quietly rather than a second time loudly.
 *
 * ARIA-HIDDEN. The venue names and the shared-book claim are both made in prose
 * within a screenful of every tape on this page. A marquee of forty numbers read
 * aloud is noise, and the content is not lost by removing it.
 *
 * The prints are literals rather than generated:
 * server and client must render the same characters, and a tape that reshuffles on
 * reload is a decoration pretending to be data.
 */

import { DIM, FAINT, GREEN, L1, MONO, RED, TXT } from "@/lib/theme";

import { css as s } from "./primitives";

type Print = { venue: string; market: string; price: string; size: string; up: boolean };

const PRINTS: Print[] = [
  { venue: "ACME", market: "BTC", price: "64,250.0", size: "0.42", up: true },
  { venue: "BETA", market: "ETH", price: "3,118.40", size: "2.10", up: false },
  { venue: "AGENT", market: "SOL", price: "182.66", size: "14.00", up: true },
  { venue: "ACME", market: "BTC", price: "64,247.5", size: "1.06", up: false },
  { venue: "APP", market: "GOLD", price: "2,412.80", size: "0.75", up: true },
  { venue: "BETA", market: "BTC", price: "64,252.5", size: "0.18", up: true },
  { venue: "AGENT", market: "EUR", price: "1.0842", size: "50.00", up: false },
  { venue: "ACME", market: "ETH", price: "3,118.95", size: "0.60", up: true },
  { venue: "APP", market: "SOL", price: "182.71", size: "6.25", up: true },
  { venue: "BETA", market: "BTC", price: "64,245.0", size: "3.40", up: false },
];

function Run() {
  return (
    <>
      {/*
       * The tape says what it is, once per loop.
       *
       * Every other number on this page is either checkable or labelled, and a strip
       * of prices scrolling past a trading venue's landing page is exactly the thing
       * a reader would assume is a live feed. It is not one. The marker rides inside
       * the run rather than sitting fixed at the edge, so it is always visible
       * somewhere on the strip no matter where the loop happens to be.
       */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 20px",
          height: 34,
          borderRight: `1px solid ${L1}`,
          fontFamily: MONO,
          fontSize: 9.5,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: FAINT,
          whiteSpace: "nowrap",
        }}
      >
        Illustrative prints
      </span>
      {PRINTS.map((p, i) => (
        <span
          key={`${p.venue}-${i}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "0 20px",
            height: 34,
            borderRight: `1px solid ${L1}`,
            fontFamily: MONO,
            fontSize: 10.5,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: FAINT, letterSpacing: "0.14em" }}>{p.venue}</span>
          <span style={{ color: DIM }}>{p.market}</span>
          <span className={s.tnum} style={{ color: TXT }}>
            {p.price}
          </span>
          <span className={s.tnum} style={{ color: p.up ? GREEN : RED }}>
            {p.up ? "▲" : "▼"} {p.size}
          </span>
        </span>
      ))}
    </>
  );
}

export function Tape() {
  return (
    <div className={s.tape} aria-hidden>
      {/* Two identical runs, and the track translates by exactly -50% — which is one
          run's width — so the loop point lands on an identical frame and is invisible. */}
      <div className={s.tapeTrack}>
        <Run />
        <Run />
      </div>
    </div>
  );
}
