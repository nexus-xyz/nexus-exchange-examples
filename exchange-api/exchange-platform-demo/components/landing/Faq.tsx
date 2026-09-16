/*
 * FAQ — every question the page answers, in one place.
 *
 * WHAT THIS ABSORBED. There used to be a separate Objections band ("the second half
 * of the call") sitting immediately before this one. The split was defensible on
 * paper — that section answered questions about *us* rather than about the product —
 * but on the page it read as two accordions of hard questions with a headline in
 * between, and a reader with a specific worry had to guess which of the two lists it
 * had been filed under. One list, ordered by what a reader wants first.
 *
 * THE BLUNT LINE SURVIVED THE MERGE, and it is the part worth protecting. Six of
 * these answers lead with a single sentence that refuses to hedge, because the
 * paragraph is where hedging hides. Three of them are answers a competitor would use
 * against us — custody is ours, the book is genuine lock-in, and you do not take the
 * book with you if we fail. Those are marked, in the same amber this page uses for
 * every other caveat, and they are stated in their own entries rather than qualified
 * into the middle of someone else's.
 *
 * Native <details>/<summary>, so this section still costs no JavaScript and works
 * before hydration — the rest of the page is server-rendered and it would be strange
 * for the accordion to be the one thing that needs a bundle.
 */

import type { ReactNode } from "react";

import { AMBER, DIM, L1, L2, MONO, SUNK, TXT } from "@/lib/theme";

import { Band, Head, Strong, css as s, body, display } from "./primitives";

type Item = {
  q: string;
  /**
   * The blunt answer, one line. If it does not fit on one line it is not blunt
   * enough. Optional — a question about mechanics does not need one; a question
   * about what you are signing up to does.
   */
  short?: string;
  /** True where the honest answer is the one a competitor would use against us. */
  costly?: boolean;
  a: ReactNode;
};

/*
 * Ordered by what a reader wants first, not by which section they used to live in:
 * what it does, what you build on it, what you earn, what it costs you, and then the
 * four questions about depending on us at all.
 */
const QA: Item[] = [
  {
    q: "Do I have to bootstrap liquidity?",
    short: "No, and that is the reason to be here.",
    a: (
      <>
        One order book per market, in one sequencer, and every branded venue matches against it — so your first trader
        sees the depth ours does.
      </>
    ),
  },
  {
    q: "Do I have to use your terminal, or can I just call the API?",
    short: "Call it directly if you are building a bot.",
    a: (
      <>
        The API is public and ungated, so an agent, a strategy or a backend integration needs nothing from this
        platform. It earns its place when you want the other four things: a branded interface, a fee of your own, an
        admin console, and per-venue attribution.{" "}
        <Strong>Those are tedious rather than hard, which is why it is worth not writing them twice.</Strong>
      </>
    ),
  },
  {
    q: "Can I pay for better matching priority?",
    short: "No, and there is no price at which that changes.",
    a: (
      <>
        {/* The Enterprise "Dedicated compute" cell already lists isolated books, reserved
            throughput and a regional gateway. The refusal is what this entry is for. */}
        What Enterprise does not buy is a better position in the queue on a book other venues share. That would be front-running with an invoice, and the venues already on that book are the reason
        your first trader sees any depth at all.{" "}
        <Strong>The one-book claim only means anything if it is the same book for everyone.</Strong>
      </>
    ),
  },
  {
    q: "Can I self-host?",
    short: "The whole venue, yes. The engine, no.",
    a: (
      <>
        {/* The enumeration was the you-run column of the Stack table, four rows of it, verbatim.
            Pointing at the table beats restating it. */}
        Everything in the you-run column of the stack is ordinary software, and it is short: a frontend, its config and
        its hosting. Deploy it where you like, in your own account — it builds to static files, and the only thing that
        has to reach us is an HTTPS call from your trader&rsquo;s browser. What is not self-hostable
        is the matching engine and the shared book, which is the same sentence as &ldquo;you do not have to bootstrap
        liquidity&rdquo; read from the other end.
      </>
    ),
  },
  {
    q: "Can I embed trading inside my existing app?",
    short: "Yes, with delegated keys rather than a full account.",
    a: (
      <>
        The integration primitive is delegated agent keys: trade-only, capped in number, and unable to withdraw. That
        is enough for a constrained embed inside your own product, and it keeps the trader's collateral under their own
        account rather than pooled under yours.
      </>
    ),
  },
  {
    q: "Can I list my own markets?",
    a: (
      <>
        You pick from the shared registry, which is the exchange's rather than yours — a market has to exist for every
        venue or for none, because they all match on one book.
      </>
    ),
  },
  /* This limitation used to live in one sentence under the Testing section's quality
     floor. The floor came off the page and took the only statement of it with it, so it
     lands here — which is the better home anyway: it is a question a reader asks, not a
     footnote on a list of CI checks. */
  {
    q: "Does the venue ship in other languages?",
    short: "English only.",
    a: (
      <>
        The template ships in English, and its formatting is currency-aware rather than locale-aware — a price renders
        in the market&rsquo;s currency rather than in the reader&rsquo;s convention for numbers and dates. There is no
        locale switch in the config; translating it is a change to the template, which is yours.
      </>
    ),
  },
  {
    q: "How do I actually make money?",
    a: (
      <>
        A fee on top of the Nexus schedule, kept in full, up to a ceiling of 10 bps.{" "}
        <Strong>Your traders never see it as a separate line.</Strong> The ticket quotes one maker/taker pair with your
        fee already inside it, and the split stays in your console.
      </>
    ),
  },
  /* The consent mechanic gets its own entry rather than a clause inside the earnings
     answer above. It is the reason the fee is trustworthy, and a reader who has just
     been told "kept in full, up to 10 bps" is asking exactly this next. */
  {
    q: "What stops a venue charging whatever it likes?",
    short: "A ceiling we set, and a maximum your trader signs.",
    a: (
      <>
        Two things, and each covers the other&rsquo;s failure. The ceiling is 10 bps — 0.1% of notional — enforced
        wherever the fee is derived, so no venue can price above it. Underneath that, a trader approves a maximum for
        your venue by name before you can charge anything.{" "}
        <Strong>That approval is signed by their main wallet and never by the key that trades.</Strong> The credential
        that can place an order must not be able to authorise being charged. In practice it is one signature at the
        start: it mints the delegated key, binds it to your builder code, and sets the ceiling you may charge under —
        &ldquo;trade on Acme, up to 3.2 bps, this key cannot touch your funds, expires in 90 days.&rdquo;
      </>
    ),
  },
  {
    q: "What does it cost?",
    a: (
      <>
        {/* This used to say "there is no published price yet" while Enterprise renders a
            0.8 → 0.2 ladder and Economics hardcodes 0.8 bps as our take. The page was arguing
            with itself. Our take IS published; what is open is everything around it. */}
        Our take is published: 0.8 bps, falling to 0.2 at enterprise volume. What is not settled is the shape around it
        — minimums, term, and what a dedicated deployment costs — and we are not going to invent those on a landing
        page.
      </>
    ),
  },
  {
    q: "What do my traders actually deposit?",
    a: (
      <>
        {/* The Deposits section answers this with a capture, a seven-rail grid and a USDX
            paragraph. This entry only needs to exist for the reader who searched for it. */}
        USDX, and a trader never has to know that — see Deposits. The test environment has a faucet: one call, its own
        balances, its own keys.
      </>
    ),
  },
  {
    q: "Do I have to handle payments, or hold fiat?",
    a: (
      <>
        No. The onramp providers settle onward and the exchange receives a token transfer; your venue never touches
        fiat. What that does not do is answer your own regulatory question — a partner venue is a separate legal entity
        with its own posture, and nothing in this arrangement is a substitute for your counsel&rsquo;s view of what you
        are operating.
      </>
    ),
  },
  {
    q: "Who holds customer funds?",
    short: "We do. You never touch them, which cuts both ways.",
    costly: true,
    a: (
      <>
        Collateral sits with the exchange and settles there. Your venue never custodies a trader&rsquo;s money, never
        moves it, and cannot — the only credential in play is the trader&rsquo;s own delegated key, which places orders
        and reads state, and there is no path through it that transfers a balance to anyone. For most builders that is the feature: custody is the licence-shaped part of running
        a venue and you are not taking it on. It also means you are accepting a counterparty, and you should diligence
        that the way you would any other.
      </>
    ),
  },
  {
    q: "What latency should I expect?",
    short: "We do not publish a number, so we are not going to invent one here.",
    a: (
      <>
        {/* The preamble announced the answer before giving it, and the closing hedge doubled
            the `short` line above. The refusal lands harder said once, bluntly. */}
        There is no hop of yours to account for: the browser signs and calls the API directly, so what a trader
        experiences is their own network plus ours. You can measure it, because the console reports submit latency as a
        distribution rather than an average. If latency decides your product, ask for the measurement methodology and
        run your own against the sandbox.
      </>
    ),
  },
  {
    q: "Whose data is the venue analytics?",
    a: (
      <>
        Yours, and you do not have to keep it alive to keep it. Every order carries your builder code, so the rollup is
        computed on our side from the fills it produced — exact rather than reconstructed, and exportable as JSON or CSV
        from the console and the admin API. The reason it is not in your database is the same reason there is no proxy:
        a venue that runs nothing has nothing to lose.
      </>
    ),
  },
  {
    q: "Will you compete with me for my users?",
    a: (
      <>
        Our position is that we are infrastructure: one stable API, and the UI is a thin client on top of it. You own
        the brand, the domain, the distribution and the customer relationship. We are aware this is a promise rather
        than a proof, which is why it is stated as an invariant we can be held to.
      </>
    ),
  },
  {
    q: "What is the lock-in, honestly?",
    short: "The book. Everything else is a JSON file and a published contract.",
    costly: true,
    a: (
      <>
        The integration surface is an OpenAPI document and SDKs published as packages you can pin, vendor or fork; the
        venue contract is one committed config file; your brand assets never enter our systems. If you left, the rewrite
        is your transport layer, not your product. The liquidity is the part you cannot pack up — which is exactly the
        commitment you make to any venue you route order flow to, and the reason to be honest about it rather than to
        claim there is none.
      </>
    ),
  },
  {
    q: "What happens to my venue if you shut down?",
    short: "You keep the code. You do not keep the book.",
    costly: true,
    a: (
      <>
        {/* Both the licensing sentence and the closing mitigation are carried by the two
            neighbouring entries — lock-in above, ledger ownership below. */}
        The venue is your repository, deployed into your hosting account, under your domain.
        What you cannot take with you is the order book, the risk engine and the collateral, because those are the
        things you came here not to build.{" "}
        <Strong>That is a real dependency and there is no version of this where it is not.</Strong>
      </>
    ),
  },
  {
    q: "Who is the legal entity my traders are dealing with?",
    a: (
      <>
        You are. A partner venue is a different legal entity and does not inherit our regulatory posture or our
        disclosures.
      </>
    ),
  },
];

export function Faq() {
  return (
    <Band id="faq">
      <Head
        eyebrow="Questions"
        title="The questions that come up on the call."
        /* The blurb used to open by describing the list as having two halves — an artefact of
           merging the objections in. A reader sees one list and never knew there were two. */
        blurb="Three of these answers are bad for us; those three are the reason to publish the list."
      />

      <div
        className={s.reveal}
        style={{ background: SUNK, border: `1px solid ${L2}`, borderRadius: 8, overflow: "hidden" }}
      >
        {QA.map((item, i) => (
          <details
            key={item.q}
            /* `open` toggles the class via the sibling selector in the module, which is
               how the marker rotates without a client component. */
            className={s.faqOpen}
            style={{ borderTop: i === 0 ? undefined : `1px solid ${L1}` }}
          >
            <summary
              className={s.faqItem}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "15px 18px",
                /* The submit tier from lib/theme's tap scale — a phone reader opens
                   these with a thumb. */
                minHeight: 44,
                ...display.xs,
                fontSize: 14.5,
              }}
            >
              <span style={{ minWidth: 0 }}>{item.q}</span>
              {/* A drawn mark, not the browser's triangle: the native one is the only
                  piece of chrome on this page from someone else's design system. */}
              <span aria-hidden className={s.faqSign} style={{ marginLeft: "auto", color: DIM, fontSize: 15, lineHeight: 1 }}>
                +
              </span>
            </summary>
            <div style={{ padding: "0 18px 18px", maxWidth: "72ch" }}>
              {item.short ? (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    margin: "0 0 12px",
                    fontFamily: MONO,
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    /* Amber where the honest answer costs us something — the same
                       colour the rest of the page uses for a caveat, so a reader who
                       has been scanning has already learned what it means. The others
                       are plain ink rather than green: an answer is not a direction. */
                    color: item.costly ? AMBER : TXT,
                  }}
                >
                  <span style={{ color: DIM }}>→</span>
                  <span style={{ minWidth: 0 }}>{item.short}</span>
                </div>
              ) : null}
              <div style={{ ...body, fontSize: 13.5 }}>{item.a}</div>
            </div>
          </details>
        ))}
      </div>

      <div style={{ ...body, fontSize: 13, color: TXT, opacity: 0.75, marginTop: 18 }}>
        A question this page does not answer honestly is a bug. Tell us and we will fix the page.
      </div>
    </Band>
  );
}
