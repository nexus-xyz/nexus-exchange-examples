/*
 * Customization — the depth behind the config file.
 *
 * WHY THIS EARNS A BAND OF ITS OWN. "How it works" shows four keys tracing into a
 * terminal: name, palette, fee, legal entity. Four keys is enough to prove the loop
 * and far too few to answer the question it provokes — a reader who believes the
 * mechanism immediately wants to know how far it goes, and "brand and a fee" is a
 * skin, not a venue. Everything below is a field that exists in `VenueConfig` today;
 * this section is an inventory, not a promise.
 *
 * GROUPED BY WHAT A DECISION IS ABOUT, not by where it sits in the JSON. An operator
 * choosing which markets to list and an operator setting a per-market fee override
 * are doing the same job an hour apart; the file nests them separately because JSON
 * has to nest something.
 *
 * THE ESCAPE HATCH IS THE LAST WORD ON PURPOSE. Every configuration surface ever
 * built runs out, and the honest thing to say about the field you did not expose is
 * that the repository is theirs. A config list that implies it covers everything is
 * a list that will be wrong for the first serious builder who reads it.
 */

import { DIM, FAINT, HI, L1, L2, MONO, MUT, PANEL, TXT } from "@/lib/theme";

import { Band, GroupTabs, Head, Note, Strong, Wrap, css as cx, annotation, body, eyebrow } from "./primitives";
import { Frame, Shot, type ShotSpec } from "./Frame";

/**
 * The console's configuration screen. It is a VIEW over the file rather than an
 * owner of state — the panel at its foot renders the nexus.json you commit — which
 * is the detail that makes this a developer product rather than a settings page.
 */
const CONSOLE: ShotSpec = {
  src: "/product/console-config.png",
  alt: "The venue configuration screen in the operator console: market selection grouped by asset class, a venue-wide builder fee with per-market overrides, leverage caps, order-type policy, and a live nexus.json panel showing the file these controls produce.",
};

/**
 * Every group is a real field on `VenueConfig` — see lib/venue/config-model.ts. If a
 * field is added there and not here, this list is the stale one.
 */
const GROUPS: { group: string; items: { k: string; v: string }[] }[] = [
  {
    group: "Listing",
    items: [
      { k: "markets", v: "Which of the shared registry your venue lists, grouped by asset class" },
      { k: "ui.defaultMarket", v: "What a first-time visitor lands on" },
      { k: "maxLeverageOverride", v: "Your own leverage ceiling per market, at or below the exchange maximum" },
      { k: "orderTypes", v: "Which order types your traders get — a venue can ship without TWAP" },
    ],
  },
  {
    group: "Money",
    items: [
      // The "folded into the one rate" half is the fee model, stated in Economics and on the
      // Product crop. A cell is a label, not a sentence.
      { k: "feeBps", v: "Your venue-wide fee, up to the 10 bps ceiling" },
      { k: "feeOverrides", v: "A different fee on individual markets — absent means inherit" },
      { k: "referral", v: "Your own referral programme, with your own split" },
      { k: "subBuilders", v: "Sub-codes under your builder code, so partners who route to you can be paid" },
    ],
  },
  {
    group: "Brand",
    items: [
      { k: "brand.palette", v: "Every accent, mark and control across terminal, console and disclosure" },
      { k: "brand.wordmark", v: "Your mark, top left, on every surface" },
      { k: "domains", v: "The origins this venue answers on" },
      { k: "legal.entity", v: "The entity your traders contract with — mandatory, never defaulted" },
    ],
  },
  {
    group: "Surface",
    items: [
      { k: "ui.allowGuestBrowsing", v: "Whether a visitor can read the book before connecting" },
      { k: "ui.showLeaderboard", v: "Whether your venue is competitive or quiet" },
      // This cell described the GROUP rather than the field, so a reader could not tell what
      // the key actually does.
      { k: "ui.showFundingCountdown", v: "Whether the funding clock is on screen" },
      // Was word-for-word the Capabilities "Your own API" cell.
      { k: "api.domain · api.keyPrefix", v: "Your hostname, your key prefix" },
    ],
  },
];

export function Customize() {
  return (
    <Band id="customize">
      <Wrap>
        <Head
          eyebrow="Customization"
          title="Sixteen fields you can change, and then the repository."
          /* The closing clause described the section's own construction. A reader sees four
             named groups and never sees the JSON's nesting, so there is no arrangement being
             contrasted with. */
          blurb="Four keys showed the loop. These are the rest — every one a real field on the venue config."
        />

        {/* THE SCREEN FIRST, as everywhere else on this page: the console's config
            editor is what the inventory below is an index of, and it is also the
            proof that these are controls rather than a table someone typed. */}
        <div style={{ marginTop: 30 }}>
          <Frame label="The console · configuration" meta="a view over the file, not an owner of it">
            <Shot spec={CONSOLE} />
          </Frame>
        </div>

        {/* Four groups of four is a matrix on a desktop and sixteen paragraphs on a
            phone. Below 640px the group names become a tab strip and one group shows
            at a time — the same switch the capability grid uses, and the same reason.
            The `.seg` wrapper is the scope its `:has()` rules are anchored on. */}
        <div className={cx.seg} style={{ marginTop: 24 }}>
          <GroupTabs name="nx-customize-group" groups={GROUPS.map((g) => g.group)} />

          <div
            className={cx.quad}
            style={{
              background: L1,
              border: `1px solid ${L2}`,
            }}
          >
            {GROUPS.map((g, i) => (
              <div
                key={g.group}
                className={cx[`segG${i + 1}`]}
                style={{ background: PANEL, padding: "16px 16px 18px", minWidth: 0 }}
              >
                {/* Hidden at phone width: the tab above already says `Listing`, and a
                    panel that repeats its own tab's label is a stutter. */}
                <div className={cx.segPanelTitle} style={{ ...eyebrow(TXT), marginBottom: 12 }}>
                  {g.group}
                </div>
                <div style={{ display: "grid", gap: 11 }}>
                  {g.items.map((it) => (
                    <div key={it.k} style={{ display: "grid", gap: 3, minWidth: 0 }}>
                      <code
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          color: HI,
                          /* A dotted path is the one string here that can exceed a
                             narrow column. */
                          overflowWrap: "anywhere",
                        }}
                      >
                        {it.k}
                      </code>
                      <span style={{ ...annotation(DIM, 10.5), margin: 0 }}>{it.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 26, display: "grid", gap: 18 }}>
          <Note label="No save">
            {/* The review-and-rollback half is the Stack section: "one committed JSON file,
                reviewed like code" and the Deploy cell's one-click rollback. */}
            The console has no Save button, and that is the design. Every control writes into the config, and the panel
            at the foot of the screen renders the nexus.json you commit.
          </Note>
          <Note label="Past the fields">
            {/* The kit's contract is listed in the Stack dependency panel — and listed there
                without the "capped fee" that the removal of the cap made wrong. */}
            <Strong>The template is your repository.</Strong> Every configuration surface runs out, and when this one
            does you are editing components rather than filing a feature request. A venue that needed a screen we never
            imagined is a venue that ships it.
          </Note>
        </div>

        <p style={{ ...body, fontSize: 13, color: MUT, margin: "22px 0 0", maxWidth: "76ch" }}>
          {/* Third statement of the shared-book argument, and the second use of "the part you
              came here not to build". The closing clause is said twice elsewhere. */}
          What you cannot configure is matching, margin, liquidation and the book —{" "}
          <span style={{ color: FAINT }}>a book that varied per tenant would be a book per tenant</span>.
        </p>
      </Wrap>
    </Band>
  );
}
