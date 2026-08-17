/*
 * /platform — the Exchange-as-a-Service landing page.
 *
 * Server-rendered apart from five components, and the exception list is the design.
 * The sticky section rail, the tabbed code sample, the economics calculator, the
 * re-skin comparison and the console tour are `"use client"`; everything else —
 * including the animated hero order book, and including the FAQ, because `<details>`
 * is interactive without React — ships as markup. Each client component earns its
 * bundle by answering a question prose could not: where am I, what does this look
 * like in my language, what would my venue earn, and what does my brand look like on
 * it.
 *
 * The hero is deliberately NOT one of them. It animates entirely in CSS off literals
 * structurally no way to render one book on the server and a different one on the
 * client.
 *
 * SECTION ORDER IS AN ARGUMENT, NOT A CHECKLIST. The thing being sold, then the
 * two questions that decide whether it can exist, then how to start, then the
 * commercial case, then the diligence.
 *
 * THE PRODUCT IS SECOND, immediately under the hero. It used to sit third, behind
 * the architecture — which asked a reader to accept a shared-book design before
 * seeing what it produces, and put the page's only real evidence three screenfuls
 * down. The console follows it because "what it looks like" and "who runs it" are
 * one thought.
 *
 * DEPOSITS AND ARCHITECTURE ARE THE TWO OBJECTIONS, in the order they kill a venue.
 * Can a trader get money in — the one thing a builder cannot route around by
 * writing their own code — and will there be anything on the book when they do.
 * Both now land after the reader wants the product rather than before, and both are
 * answered with a capture rather than a diagram.
 *
 * TWO SECTIONS ANSWER THE QUESTIONS THE DEMONSTRATIONS PROVOKE. "How it works"
 * traces four keys into a terminal, which is enough to prove the loop and far too
 * few to answer how far it goes — so CUSTOMIZE follows it with the rest of the
 * fields. And nothing on the page said what the venue IS as software, which is the
 * question a reader asks before agreeing to operate one — so THE STACK sits in the
 * developer movement, immediately before the environment tiers that assume it.
 *
 * WHAT YOU GET, THEN WHAT IT COSTS YOU. The capability grid comes before the
 * build-vs-deploy comparison now, because the comparison's second column is what you
 * GIVE UP — and a reader cannot weigh what they are giving up until they know what
 * they are getting. It read as a warning ahead of the offer and now reads as the
 * qualifier on one.
 *
 * THE HARD QUESTIONS ARE ALL IN THE FAQ, and there used to be two lists of them —
 * an Objections band answering questions about us, and an FAQ answering questions
 * about the product. The split was defensible and unusable: a reader with a specific
 * worry had to guess which of two accordions it had been filed under. One list, and
 * it comes last, because a reader who has just been told what is hard is exactly the
 * reader who wants to check what is real first.
 *
 * THE TAPE IS THE DIVIDER between the page's four movements — the product, the two
 * objections and how to start, the commercial case, the diligence. See Tape.tsx for
 * why a tape rather than a rule.
 */

import type { Metadata } from "next";

import { BG } from "@/lib/theme";

import { Capabilities } from "@/components/landing/Capabilities";
import { DevExperience } from "@/components/landing/DevExperience";
import { Earnings } from "@/components/landing/Earnings";
import { Enterprise } from "@/components/landing/Enterprise";
import { Faq } from "@/components/landing/Faq";
import { FinalCta } from "@/components/landing/FinalCta";
import { Footer } from "@/components/landing/Footer";
import { Deposits } from "@/components/landing/Deposits";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Nav } from "@/components/landing/Nav";
import { Console, Product } from "@/components/landing/Product";
import { Customize } from "@/components/landing/Customize";
import { QuickStart } from "@/components/landing/QuickStart";
import { Stack } from "@/components/landing/Stack";
import { SubNav } from "@/components/landing/SubNav";
import { Tape } from "@/components/landing/Tape";
import { PLATFORM, css, landingVars } from "@/components/landing/primitives";

export const metadata: Metadata = {
  title: `${PLATFORM.name} — Deploy your own perpetuals exchange`,
  description:
    "Deploy a branded perpetual-futures venue from one config file. Every venue trades into the same central order book, so there is no liquidity to bootstrap. You own the interface, the customer, and the fee on top.",
};

export default function PlatformPage() {
  /* `landingVars` is what lets landing.module.css name a colour without hardcoding
     one: the tenant's palette arrives here as custom properties and the stylesheet
     reads them. A hex in the CSS would be a hex that cannot re-skin. `css.page` is
     the hook for one route-wide rule — the focus ring, which globals.css sets 1px
     thin in a literal green that cannot follow a tenant. */
  return (
    <main
      /* The hook the stylesheet uses to turn on smooth scrolling for this page and
         not for the terminal, which shares the same global stylesheet. */
      data-landing=""
      className={css.page}
      style={{ background: BG, minHeight: "100vh", ...landingVars }}
    >
      <Nav />
      <Hero />
      {/* Below the hero rather than above it: the rail is for navigating an argument
          the reader has already decided to read. */}
      <SubNav />

      {/* A — WHAT IT IS. Three surfaces, all of them captures of a running app. */}
      <Product />
      <Console />
      <Deposits />

      <Tape />

      {/* B — THE DEAL, AND WHAT YOU CONTROL. The mechanism, then everything that
          ships with it, then everything you can change about it.
          A build-vs-deploy comparison used to close this movement. It went because
          every row had found a better home: matching, risk and settlement are the
          you-run/we-run table in the stack section, liquidity is the whole of how it
          works, the UI is the product, the fee is economics, and the two rows where
          rolling your own genuinely wins — listing your own markets, changing the
          matching rules — are answered in the FAQ and bounded by the enterprise
          non-offer. A table restating eight sections is a table a reader has already
          read. */}
      <HowItWorks />
      <Capabilities />
      <Customize />

      <Tape />

      {/* C — WHAT YOU EARN, HOW YOU BUILD, AND WHERE IT GOES WHEN YOU ARE BIG.
          Enterprise closes the movement rather than opening one of its own: it is the
          upgrade path off everything above it, so the last thing before the hard
          questions is "and we scale with you" rather than a price list. */}
      <Earnings />
      <QuickStart />
      <Stack />
      <DevExperience />
      <Enterprise />

      <Tape />

      {/* D — THE HARD QUESTIONS. */}
      <Faq />

      <FinalCta />
      <Footer />
    </main>
  );
}
