/*
 * The hero.
 *
 * THE BOOK IS THE HERO IMAGE. The offering's argument is structural — every branded
 * venue trades into ONE central order book — so the hero is that book, live, with
 * orders arriving from four labelled sources and landing in one ladder. It replaces
 * a config-file screenshot, which sold the file rather than the thing the file buys
 * you, and it replaces the alternative of a big number with a small label, which is
 * the template answer and which this product has no honest number for.
 *
 * The layout is asymmetric on purpose: argument left, book right, no centred column
 * anywhere. Below 1080px the book moves under the copy and drops its fan — see
 *
 * THE FACTS RAIL IS DELIBERATELY SMALL. Four checkable facts (one book, a versioned
 * spec, a package on npm, the funding reach) set as annotations on a hairline rather
 * than as four big numbers. We have no TVL, no volume and no customer count, and the
 * genre of number that usually goes here would have to be invented — so the rail is
 * sized like a footnote you can verify rather than a statistic you cannot.
 *
 * The product link sits ABOVE the fold, because the product is the argument and it
 * cannot be the thing you scroll to find.
 */

import { ARCHIVO, DIM, FAINT, HI, L1, L2, MONO, MUT, TXT } from "@/lib/theme";

import { Frame, Shot, type ShotSpec } from "./Frame";
import { HeroStage } from "./HeroStage";
import { css as s, Cta, PLATFORM, Wrap, annotation, display, eyebrow } from "./primitives";

/*
 * The example venue is always Acme, on every build.
 *
 * The claim is "your brand on our terminal", and the only capture that shows that
 * is a customer's. Nexus's own terminal in Nexus's own palette would demonstrate
 * the platform running itself, which is not the offering.
 */
const HERO_SHOT: ShotSpec = {
  src: "/product/terminal-acme.png",
  alt: "A venue built on the platform: the Acme Perps trading terminal in the venue's own palette, with a market header, a candle chart, a live order book, an order ticket quoting a single all-in fee rate, and a positions blotter.",
};

const FACTS: { value: string; label: string; href?: string }[] = [
  { value: "One book", label: "one central CLOB per market, behind every venue" },
  {
    value: "96 operations",
    label: "OpenAPI 0.8.1, versioned and published",
    href: "https://github.com/nexus-xyz/nexus-exchange-api",
  },
  {
    value: "On npm",
    label: "@nexus-xyz/exchange-ts, plus Rust, Python, CLI, MCP",
    href: "https://www.npmjs.com/package/@nexus-xyz/exchange-ts",
  },
  /* Deposits earn a slot in the hero rail because it is the objection that kills a
     venue before its first trade: a builder whose users cannot get money in has no
     venue, whatever else is true. */
  { value: "Any rail", label: "card, bank transfer, exchange, any token", href: "#deposits" },
];

export function Hero() {
  return (
    <section style={{ padding: "clamp(32px, 4.5vw, 56px) 0 clamp(32px, 4vw, 52px)" }}>
      <Wrap wide>
        {/*
         * Centred, and the product sits BELOW the words rather than beside them.
         *
         * Side by side, the headline and the capture were each competing for the
         * same glance and each getting half a screen. Stacked, the sentence is read
         * first and the product is met at full width — which is the order the
         * argument actually runs in, and the width a dense trading UI needs before
         * its density reads as anything but noise.
         */}
        <div style={{ textAlign: "center", display: "grid", justifyItems: "center", gap: 0 }}>
          <div className={s.animRise} style={{ ...eyebrow(DIM), marginBottom: 16 }}>
            {PLATFORM.name} · Exchange-as-a-Service
          </div>

          <h1
            className={s.animRise}
            style={{ ...display.xl, ["--d" as string]: "0.06s", maxWidth: "18ch", margin: 0 }}
          >
            Deploy your own perpetuals exchange.
          </h1>

          <p
            className={s.animRise}
            style={{
              ...display.sm,
              ["--d" as string]: "0.12s",
              fontWeight: 500,
              color: MUT,
              margin: "18px 0 0",
              maxWidth: "52ch",
            }}
          >
            An <span style={{ color: HI }}>onchain perpetuals exchange</span> under your brand, trading into the same
            central order book as every other venue. No liquidity to bootstrap, no market maker to hire.
          </p>

          <p
            className={s.animRise}
            style={{ ...annotation(DIM, 12.5), ["--d" as string]: "0.18s", margin: "12px 0 0", maxWidth: "66ch" }}
          >
            We run the engine, the risk and the settlement. You own the interface, the customer, and the fee on top.
          </p>

          <div
            className={s.animRise}
            style={{
              ["--d" as string]: "0.24s",
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              marginTop: 24,
              justifyContent: "center",
            }}
          >
            <Cta href="#start" label="Start building" />
            <Cta href="#terminal" label="See the product" variant="secondary" />
          </div>
        </div>

        {/* The product, not a diagram of it. A reader deciding whether to keep
            reading is deciding whether this looks like something they would ship,
            and no illustration answers that as fast as the thing itself. Tenant-
            aware: each venue's hero shows its own build, which is also the page
            quietly making its central claim before the headline is finished. */}
        <div className={s.animFade} style={{ ["--d" as string]: "0.34s", marginTop: "clamp(28px, 3vw, 40px)" }}>
          <HeroStage>
            <Frame label="Acme Perps · a venue built on this platform" meta="the running app">
              <Shot spec={HERO_SHOT} priority sizes="(min-width: 2250px) 1800px, (min-width: 1080px) 80vw, 96vw" />
            </Frame>
          </HeroStage>
        </div>

        {/* Rules on the LEFT of each cell. This rail has no container border to absorb
            a trailing edge, and an auto-fit grid cannot know which cell ends a row — so
            a right rule leaves a stray line at every wrap point and at 390px, where all
            four stack. */}
        <div
          className={s.animRise}
          style={{
            ["--d" as string]: "0.36s",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 0,
            marginTop: "clamp(40px, 6vw, 72px)",
            borderTop: `1px solid ${L2}`,
          }}
        >
          {FACTS.map((f) => {
            const inner = (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span
                    style={{ fontFamily: ARCHIVO, fontWeight: 600, fontSize: 15, letterSpacing: "-0.015em", color: HI }}
                  >
                    {f.value}
                  </span>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 10.5, lineHeight: 1.55, color: FAINT, marginTop: 8 }}>
                  {f.label}
                  {f.href && !f.href.startsWith("#") && <span style={{ color: DIM }}> ↗</span>}
                </div>
              </>
            );
            const cell = { padding: "18px 18px 20px 20px", borderLeft: `1px solid ${L1}` };
            /* An internal anchor keeps the page; the two registry links leave it, and
               `rel` is set here rather than trusted to a call site. */
            return f.href ? (
              <a
                key={f.value}
                href={f.href}
                className={s.cellLink}
                target={f.href.startsWith("#") ? undefined : "_blank"}
                rel={f.href.startsWith("#") ? undefined : "noreferrer noopener"}
                style={cell}
              >
                {inner}
              </a>
            ) : (
              <div key={f.value} style={cell}>
                {inner}
              </div>
            );
          })}
        </div>
      </Wrap>
    </section>
  );
}
