/*
 * Deposits — deliberately the simplest section on the page.
 *
 * IT WAS CALLED "FUNDING", which is the word an operator uses. A partner reading this
 * page is asking one question on their users' behalf — how does money get in — and
 * "deposits" is the word those users would use, the word on the button in the product,
 * and the word the console's own screen is about. Naming the section after the thing
 * rather than after the category it belongs to is also what lets the headline stop
 * hedging: this is every way the exchange takes money, and they all ship.
 *
 * WHAT THIS REPLACED. A four-step diagram of origin rails, an aggregator, an
 * ERC-20 terminus and a bridge credit. Every box was true and the whole thing
 * answered a question nobody asked: a builder does not want the plumbing, they
 * want to know whether their users can get money in. So the argument is now one
 * sentence and a row of marks, and the plumbing is a footnote.
 *
 * THE ROW MIRRORS THE PRODUCT. Every entry below is a method on the deposit screen
 * captured above it, named as that screen names it. The two used to drift — the
 * screen said "From an exchange" and this said "Exchange withdrawal", the screen
 * offered SEPA and this said ACH — which is exactly the gap a reader notices when
 * they finally open the product.
 *
 * THE SCREEN, THEN THE MARKS. The section led with the rail row alone, which is a
 * claim about breadth with no evidence that any of it reaches a product. The
 * deposit capture goes first now — a real surface on a real venue, every row an
 * asset over the network it arrives on — and the marks beneath it are what that
 * screen is made of rather than a substitute for it. A reader still scans seven
 * glyphs faster than seven labels, which is why they stay (see RailMarks.tsx,
 * including the trademark note there).
 *
 * NO VENDOR IN THE BODY. Naming the aggregator in the headline would make the
 * reader learn a third party's name to understand our product. It appears once,
 * at the bottom, which is where a dependency belongs.
 *
 * ONE MORE THING THIS SECTION MUST NOT DO. It must not mention chains as a
 * feature count. The breadth is a property of the funding rails, not of a
 * settlement path — so "any chain" is a rail, and the number of chains is never
 * a number on this page.
 */

import { ARCHIVO, DIM, FAINT, HI, MUT, TXT } from "@/lib/theme";

import { Band, Head, Strong, Wrap, annotation, body, css as s } from "./primitives";
import { Frame, Shot, type ShotSpec } from "./Frame";
import { RailMark, type RailId } from "@/components/RailMarks";

/** The rails, in the order a reader ranks them: crypto-native first, then fiat. */
const RAILS: { id: RailId; label: string; detail: string }[] = [
  { id: "stablecoin", label: "Stablecoins", detail: "USDC, USDT, PayPal's PYUSD" },
  { id: "chain", label: "Any chain", detail: "routed and swapped en route" },
  { id: "cex", label: "From an exchange", detail: "straight off Coinbase, Kraken or Binance" },
  { id: "card", label: "Cards", detail: "debit and credit" },
  { id: "applepay", label: "Apple Pay", detail: "on the phone they hold" },
  { id: "ach", label: "Bank transfer", detail: "ACH and SEPA" },
  { id: "wire", label: "Wires", detail: "domestic and international" },
];

/**
 * The screen the rails below turn into. Every row is an asset over the network it
 * arrives on, which is the half of "any chain" a ticker list would lose.
 */
const DEPOSIT: ShotSpec = {
  src: "/product/terminal-deposit.png",
  alt: "The deposit screen on the Acme Perps terminal: a search field over a list of fundable assets, each row naming the asset and the network it arrives on — USDX on Nexus, USDC on Arbitrum, BTC on Bitcoin, ETH on Ethereum, SOL on Solana, ARB on Arbitrum.",
};

export function Deposits() {
  return (
    <Band id="deposits" tone="raised">
      <Wrap>
        <Head
          eyebrow="Deposits"
          title="Every deposit rail, already built."
          blurb="Every venue accepts all of it on the day it deploys. You integrate none of it, contract with no processor, and hold no fiat."
        />

        {/* THE SCREEN FIRST. This section used to argue breadth with seven glyphs and
            no evidence that any of them reached a product. The capture is the
            deposit surface a venue's first trader actually meets, and the rails
            underneath it are the list it is built from rather than a claim about
            one. */}
        <div style={{ marginTop: 30 }}>
          <Frame label="Acme Perps · the deposit screen" meta="every method, on every venue">
            <Shot spec={DEPOSIT} />
          </Frame>
        </div>

        {/* A paragraph stood here, between the blurb and the rails grid, and lost to both: its
            middle sentence is the seven-cell grid immediately below, and its closing clause is
            the blurb reworded forty words earlier. */}

        {/* The row is the argument. Marks are large enough to read at a glance and
            the labels sit under them, so the eye takes breadth first and detail
            second. */}
        {/* The column count is in the stylesheet rather than here, because it is the
            one thing on this row that has to change with the viewport and seven does
            not divide by whatever auto-fit picks. See `.rails`. */}
        <ul
          className={s.rails}
          style={{
            listStyle: "none",
            margin: "28px 0 0",
            padding: 0,
            background: "var(--nx-l1)",
            border: "1px solid var(--nx-l2)",
          }}
        >
          {RAILS.map((rail, i) => (
            <li
              key={rail.id}
              /* Seven cells never fill a grid of two or of four, and the gap between
                 them is a hairline the container paints — so the cell that is never
                 filled renders as a rectangle of rule colour rather than as nothing.
                 The last card widens by a track to close it. See `.railsLast`. */
              className={i === RAILS.length - 1 ? s.railsLast : undefined}
              style={{
                background: "var(--nx-panel)",
                padding: "22px 18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                minWidth: 0,
              }}
            >
              <span style={{ color: TXT, display: "inline-flex" }}>
                <RailMark id={rail.id} size={24} />
              </span>
              <span style={{ fontFamily: ARCHIVO, fontSize: 13.5, fontWeight: 600, color: HI }}>
                {rail.label}
              </span>
              <span style={{ ...annotation(DIM, 11), margin: 0 }}>{rail.detail}</span>
            </li>
          ))}
        </ul>

        {/* USDX gets a short block rather than one line now. A builder hears
            "proprietary stablecoin" and reaches for the risk question immediately —
            what backs it, and does my user have to hold it — and both answers are
            good, so burying them was leaving an objection unanswered to save four
            lines. The trader still never learns the word. */}
        <p style={{ ...body, color: MUT, margin: "32px 0 0", maxWidth: "62ch" }}>
          {/* The stablecoin list is the first cell of the grid directly above; it now carries
              the PayPal expansion. This paragraph's job is what backs USDX, and the 80/20
              split is Economics' to state. */}
          Your users see balances in dollars. USDX is the collateral every Nexus venue settles in, and it is{" "}
          <Strong>backed 1:1 by cash and short-dated US Treasuries</Strong>; deposits convert on the way in and
          margin, PnL and withdrawals are all denominated in it from the first screen.{" "}
          <span style={{ color: FAINT }}>Your traders never see the word.</span> You will, once: the float those
          deposits create earns the T-bill rate — see the economics.
        </p>

        <p style={{ ...annotation(FAINT, 11), margin: "18px 0 0", maxWidth: "76ch" }}>
          Onramp, cross-chain routing and swaps are provided by Halliday, bundled into the Nexus API so
          every venue inherits them.
        </p>
      </Wrap>
    </Band>
  );
}
