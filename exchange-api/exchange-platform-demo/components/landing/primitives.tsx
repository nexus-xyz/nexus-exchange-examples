/*
 * The platform page's shared vocabulary.
 *
 * Four things drive every decision in this file.
 *
 * BUILD STATUS IS A FIRST-CLASS TYPE. Most of what this page describes is not
 * shipped, and the offering spec (docs/SPEC.md §5, §7) makes
 * labelling it a requirement rather than a courtesy. So `Status` is a union that
 * every card, row and table cell accepts, and there is exactly one component that
 * renders it — a claim without a pill has to be a deliberate omission, not a
 * component someone forgot to pass a prop to.
 *
 * COLOUR MEANS DIRECTION, AND NOTHING ELSE. A trading venue has two semantic
 * accents that carry information — bid and ask — and this page spends them only
 * where they mean that, or where they carry a build status. Buttons, rules,
 * eyebrows, active tabs and section marks are achromatic: they get their emphasis
 * from the surface ladder (BG → CHROME → SUNK → PANEL → TERM → SEL) and the
 * hairline ladder (L0 → L1 → L2 → L3) instead. The whole page is therefore
 * greyscale except in the places where green and red are load-bearing, which is
 * what makes them legible when they appear.
 *
 * ONE TYPE SCALE. Every heading on the page is one of five steps below, and the
 * scale tightens its tracking as it grows — Archivo at 88px with the letterspacing
 * that suits it at 16px is the single most common way display type reads as
 * default. Mono is annotation and eyebrow only, never body.
 *
 * NO COLOUR LITERALS ANYWHERE. Everything is either a token from lib/theme.ts or a
 * `--nx-*` custom property derived from one (see `landingVars`), because the same
 * build serves more than one brand and a hex is a thing that cannot re-skin.
 */

import type { CSSProperties, ReactNode } from "react";

import { NEXUS } from "@/lib/tenant";

import { TOKEN_COLOR, TOKEN_WEIGHT, detectLang, tokenizeWithDim, type Lang } from "@/lib/highlight";

import {
  AMBER,
  ARCHIVO,
  BG,
  CHROME,
  DIM,
  FAINT,
  GREEN,
  HI,
  L1,
  L2,
  L3,
  MONO,
  MUT,
  PANEL,
  R_SM,
  R_XS,
  RED,
  SEL,
  SUNK,
  TERM,
  TXT,
} from "@/lib/theme";

import s from "./landing.module.css";

/**
 * The colours the stylesheet is allowed to use.
 *
 * A CSS module cannot import a TypeScript token, and a marketing page that is
 * also a tenant cannot hardcode one. So the page root spreads this, and every
 * `var(--nx-*)` in landing.module.css resolves to whatever the active tenant's
 * palette says. Adding a colour to the stylesheet means adding it here first.
 */
/*
 * THIS PAGE IS NEXUS'S, NOT THE TENANT'S.
 *
 * Every other surface in this app re-skins with ACTIVE_TENANT, and this one must
 * not: it is the platform's own marketing, the arm that SELLS the ability to build
 * a venue. Rendering it as "Acme · Exchange-as-a-Service" said that Acme sells this
 * offering, which is exactly backwards — Acme is the customer.
 *
 * So identity and palette are pinned to the Nexus tenant here regardless of which
 * build serves the route. In production this page only ever ships from Nexus's own
 * deployment; the partner builds serving it at all is an artifact of one app
 * standing in for both sides of the relationship.
 *
 * The tenant still appears on this page — as the EXAMPLE. The hero shows a venue
 * somebody built, which is the offering demonstrated rather than described.
 */
export const PLATFORM = NEXUS;
/** The page's accent, from the platform's palette and never the tenant's. */
export const ACCENT = NEXUS.palette.green;
export const ACCENT_DOWN = NEXUS.palette.red;

export const landingVars: CSSProperties = {
  ["--nx-bg" as string]: NEXUS.palette.bg,
  ["--nx-chrome" as string]: CHROME,
  ["--nx-panel" as string]: PANEL,
  /* The slider thumb's ring is drawn in the surface it sits on, so the stylesheet
     needs that surface as a token like every other colour it reads. */
  ["--nx-sunk" as string]: SUNK,
  ["--nx-sel" as string]: SEL,
  ["--nx-l1" as string]: L1,
  ["--nx-l2" as string]: L2,
  ["--nx-l3" as string]: L3,
  ["--nx-hi" as string]: NEXUS.palette.hi,
  ["--nx-txt" as string]: TXT,
  /*
   * The muted greys, the same three steps the components use.
   *
   * These were missing, so the one stylesheet rule that needed a recessive ink —
   * the inactive tab label on the segmented switch — approximated one with
   * `color-mix(in srgb, var(--nx-txt) 58%, transparent)`. That is wrong twice
   * over: a mix against transparency depends on whatever surface happens to be
   * behind it, and 58% of the text colour is a number chosen to LOOK like DIM
   * rather than to BE it. A tenant re-skin reaches a custom property and cannot
   * reach a percentage of a different one, which is the whole reason this object
   * exists. Three steps rather than one because the stylesheet will want the
   * others the next time it needs an ink, and a scale with a hole in it is how
   * the color-mix got written in the first place.
   */
  ["--nx-mut" as string]: MUT,
  ["--nx-dim" as string]: DIM,
  ["--nx-faint" as string]: FAINT,
  /* The flash a level makes when an order lands on it. Deliberately colourless:
     a level accepting an order is an event, not a direction — the direction is
     already carried by which half of the book it is in. */
  ["--nx-hit" as string]: "rgba(255,255,255,0.07)",
};

/** Re-exported so sections can reach the stylesheet without importing it twice. */
export { s as css };

/* ============================== type ============================== */

/*
 * The scale. Five display steps and two text steps, and the only place any of
 * these numbers is written down.
 *
 * Tracking tightens as size grows because optical letterspacing is a function of
 * size and Archivo is drawn tight already: -0.042em at 68px is the same apparent
 * fit as -0.012em at 15px. The old page used -0.035em at every display size, so
 * the hero read loose while the card titles read cramped.
 */
export const display = {
  /** The hero, once per page. */
  xl: {
    fontFamily: ARCHIVO,
    fontWeight: 800,
    fontSize: "clamp(38px, 5.4vw, 68px)",
    lineHeight: 0.96,
    letterSpacing: "-0.042em",
    color: HI,
    margin: 0,
  } as CSSProperties,
  /** The closing call to action, and nothing else. */
  lg: {
    fontFamily: ARCHIVO,
    fontWeight: 800,
    fontSize: "clamp(30px, 5vw, 58px)",
    lineHeight: 1.0,
    letterSpacing: "-0.04em",
    color: HI,
    margin: 0,
  } as CSSProperties,
  /** A section title. */
  md: {
    fontFamily: ARCHIVO,
    fontWeight: 700,
    fontSize: "clamp(25px, 3.6vw, 42px)",
    lineHeight: 1.06,
    letterSpacing: "-0.032em",
    color: HI,
    margin: 0,
  } as CSSProperties,
  /** A pull-quote or an argument slab. */
  sm: {
    fontFamily: ARCHIVO,
    fontWeight: 600,
    fontSize: "clamp(18px, 2.3vw, 26px)",
    lineHeight: 1.24,
    letterSpacing: "-0.022em",
    color: HI,
    margin: 0,
  } as CSSProperties,
  /** A card title. */
  xs: {
    fontFamily: ARCHIVO,
    fontWeight: 600,
    fontSize: 15,
    lineHeight: 1.3,
    letterSpacing: "-0.012em",
    color: HI,
  } as CSSProperties,
};

/** Body copy. */
export const body: CSSProperties = {
  fontFamily: ARCHIVO,
  fontWeight: 500,
  fontSize: 14,
  lineHeight: 1.62,
  color: MUT,
  margin: 0,
};

/**
 * The two mono voices.
 *
 * `eyebrow` names a section or a field — uppercase, tracked, faint, and never more
 * than four words. `annotation` is the voice of a caveat, a unit, a path, a
 * measurement: sentence case, untracked, and always attached to something it
 * qualifies. Using the first where the second belongs is how a page ends up
 * shouting its footnotes.
 */
export function eyebrow(color = FAINT): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: "0.2em",
    textTransform: "uppercase",
    color,
  };
}

export function annotation(color = DIM, size = 11.5): CSSProperties {
  return { fontFamily: MONO, fontSize: size, lineHeight: 1.55, color };
}

/* ============================== status ============================== */

/*
 * BUILD STATUS LIVED HERE, AND DELIBERATELY NO LONGER DOES.
 *
 * This page is a picture of the finished product — the surface a builder is shown
 * to understand what they would be buying. A per-claim shipped/partial/roadmap
 * pill answered a different question ("what runs today?") on a surface that is not
 * asking it, and it made the page read as a status report.
 *
 * The honest answer still exists and is not softened; it moved to where it is
 * load-bearing. `docs/SPEC.md` §5 keeps the build-status table so nobody on the
 * team builds to a fiction. The console keeps a provenance label on every figure
 * (live / estimate) because an operator reading a number has to know whether it
 * was measured or projected — a fee accrual IS an estimate before settlement, so
 * that label is a product fact rather than a disclosure about our own progress.
 * External vision, internal truth.
 */

/* ============================== layout ============================== */

/** The content column. Exported so full-bleed bands can inset their own contents. */
export function Wrap({
  children,
  wide = false,
  style,
}: {
  children: ReactNode;
  /** 1560 instead of the 1180 reading measure — the nav and the hero only. */
  wide?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={wide ? s.wrapWide : s.wrap} style={style}>
      {children}
    </div>
  );
}

/**
 * A band.
 *
 * `tone` is the page's rhythm instrument. A page whose every section is the same
 * background at the same padding is a stack no matter what is inside it, so bands
 * alternate: `page` is the ground plane, `raised` is chrome-dark and reads as a
 * shelf, `sunk` reads as a well and is where the dense tabular sections live.
 * Full-bleed is the default — the inset happens on the `Wrap` inside, so a band's
 * background always reaches both edges of the viewport.
 */
export function Band({
  id,
  children,
  tone = "page",
  tight = false,
  divided = true,
  style,
}: {
  id?: string;
  children: ReactNode;
  tone?: "page" | "raised" | "sunk";
  tight?: boolean;
  divided?: boolean;
  style?: CSSProperties;
}) {
  const background = tone === "raised" ? CHROME : tone === "sunk" ? SUNK : undefined;
  return (
    <section
      id={id}
      className={tight ? `${s.band} ${s.bandTight}` : s.band}
      style={{ background, borderTop: divided ? `1px solid ${L1}` : undefined, ...style }}
    >
      <Wrap>{children}</Wrap>
    </section>
  );
}

/**
 * The section header.
 *
 * Two columns with a rule between them, collapsing to one below 860px. The right
 * column is the qualifying sentence, and it is optional — a section whose title
 * says the whole thing gets a left column and a lot of air, which is a different
 * texture from the sections that need a paragraph, and that difference is the
 * point.
 */
export function Head({
  eyebrow: kicker,
  title,
  blurb,
  aside,
}: {
  eyebrow: string;
  title: ReactNode;
  blurb?: ReactNode;
  /** Overrides `blurb` when the right column needs structure rather than a sentence. */
  aside?: ReactNode;
}) {
  return (
    <header className={`${s.headSplit} ${s.reveal}`}>
      <div>
        <div style={{ ...eyebrow(), display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          {kicker}
        </div>
        <h2 style={display.md}>{title}</h2>
      </div>
      {(blurb || aside) && (
        <div className={s.headAside}>{aside ?? <p style={{ ...body, fontSize: 14.5 }}>{blurb}</p>}</div>
      )}
    </header>
  );
}

/** Body copy at the page's one measure. */
export function Prose({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ ...body, maxWidth: "62ch", ...style }}>{children}</p>;
}

/* ============================== surfaces ============================== */

/**
 * Raised card.
 *
 * Radius 8 rather than the terminal's 7, and one step of elevation rather than
 * two: at marketing sizes a card is 3-4x the area of a terminal panel and the same
 * corner reads sharper on the bigger box.
 */
export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: PANEL,
        border: `1px solid ${L2}`,
        borderRadius: 8,
        padding: 20,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Auto-fitting grid. `min` is the width below which a column collapses. */
export function Grid({
  min = 260,
  gap = 14,
  children,
  style,
}: {
  min?: number;
  gap?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`,
        gap,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * A hairline-ruled slab.
 *
 * The page's densest structure: cells divided by rules with no gaps, on one
 * surface, inside one border. Used wherever the content is a set rather than a
 * sequence — the capability grid, the promises — because a set wants to be read
 * as one object and a row of floating cards reads as six.
 */
export function Slab({
  min = 300,
  children,
  tone = "panel",
  /**
   * Force a stated column count instead of auto-fit.
   *
   * Auto-fit picks whatever fits, which is right for a list of unknown length and
   * wrong for one you can count: sixteen capability cells in a three-column grid
   * leave one alone on the last row, and the reader sees a card that failed to load
   * rather than the end of a list. `columns` hands the decision back to the caller,
   * who knows how many items there are.
   */
  columns,
  style,
}: {
  min?: number;
  children: ReactNode;
  tone?: "panel" | "sunk";
  columns?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={columns ? `${s.reveal} ${s.quad}` : s.reveal}
      style={{
        display: "grid",
        gridTemplateColumns: columns ? undefined : `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`,
        gap: 0,
        background: tone === "sunk" ? SUNK : PANEL,
        border: `1px solid ${L2}`,
        borderRadius: 8,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * One cell of a `Slab`. Rules on the top and right; the container clips the strays.
 *
 * IT TAKES A CLASS AS WELL AS A STYLE, and that is not decoration. An inline
 * `display: flex` cannot be overridden from a stylesheet, so a caller that needed a
 * class to select on — the capability grid, whose phone-width group switch hides
 * three groups of cells with `display: none` — used to wrap every cell in a `div`
 * that existed for no reason but to carry the class. Sixteen extra elements to hold
 * one attribute. A caller putting layout on the class instead of in `style` gets
 * both the hook and a rule the switch can beat on specificity.
 */
export function Cell({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{
        padding: "18px 20px 20px",
        borderTop: `1px solid ${L1}`,
        borderRight: `1px solid ${L1}`,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Title + body + status, the shape most of this page is made of. */
export function FeatureCard({
  title,
  children,
  caveat,
}: {
  title: string;
  children: ReactNode;
  /** The sentence that keeps the card honest. Rendered in the caveat voice, always last. */
  caveat?: string;
}) {
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <span style={display.xs}>{title}</span>
      </div>
      <div style={{ ...body, fontSize: 13.5 }}>{children}</div>
      {caveat && (
        <div
          style={{
            marginTop: "auto",
            paddingTop: 12,
            borderTop: `1px solid ${L1}`,
            ...annotation(DIM, 11),
          }}
        >
          {caveat}
        </div>
      )}
    </Card>
  );
}

/**
 * A qualifier that belongs to a whole section rather than one card.
 *
 * NOT A CALLOUT BOX. This was a rounded card with a tinted fill and a 2px amber
 * rail down its left edge — which is the single most recognisable shape in
 * machine-generated interface design, and it appeared four times on one page.
 * A reader who has seen a hundred of those reads the shape before the sentence
 * and discounts both.
 *
 * What replaces it is the oldest device in print: a rule, a label set in the
 * margin, and the text. It borrows the same two-column-over-a-hairline geometry
 * the section heads use, so a qualifier now looks like it belongs to this page
 * rather than to a documentation generator. No fill, no border, no accent — the
 * hairline does the separating and the label does the naming.
 */
export function Note({ label = "Note", children }: { label?: string; children: ReactNode }) {
  return (
    /* The label column is fixed so consecutive notes align down the page, and it goes
       above the prose below 620px, where a third of the viewport spent on a margin cuts
       the measure beside it in half. Both live in `.note`, because neither is a value a
       media query could reach from here. */
    <div
      className={s.note}
      style={{
        borderTop: `1px solid ${L2}`,
        paddingTop: 16,
        maxWidth: "82ch",
      }}
    >
      <div style={{ ...eyebrow(FAINT), paddingTop: 3 }}>{label}</div>
      <div style={{ ...body, fontSize: 13, color: MUT }}>{children}</div>
    </div>
  );
}

/**
 * The argument slab.
 *
 * One claim per page-movement, set at display.sm on a raised surface.
 *
 * It used to carry a 2px green left edge. That was the same left-rail device as
 * the old Note, and two different components wearing one shape in two colours is
 * how a page stops meaning anything by it. The emphasis here comes from the raised
 * surface and the type scale, which is what a slab is for; the accent survives
 * only in the kicker, where it is one word rather than a bar.
 */
export function Argument({
  kicker,
  claim,
  children,
}: {
  kicker: string;
  claim: string;
  children: ReactNode;
}) {
  return (
    <div
      className={s.reveal}
      style={{
        background: PANEL,
        border: `1px solid ${L2}`,
        borderRadius: 8,
        padding: "clamp(22px, 3vw, 32px)",
      }}
    >
      <div style={{ ...eyebrow(ACCENT), marginBottom: 14 }}>{kicker}</div>
      <div style={{ ...display.sm, maxWidth: "20ch" }}>{claim}</div>
      <div style={{ ...body, fontSize: 14, marginTop: 14, maxWidth: "62ch" }}>{children}</div>
    </div>
  );
}

/* ============================== controls ============================== */

/**
 * The phone-width group switch: four radios wearing a tab strip.
 *
 * Two sections use it — the capability grid and the customization inventory — which
 * is why it lives here rather than in either of them. It renders at every width and
 * hides itself above 639px, because the alternative is a viewport query in JavaScript
 * and neither caller has, or should acquire, a client boundary. Everything visual is
 * in `landing.module.css` under "the segmented group switch", including why the state
 * is a radio group.
 *
 * `name` has to be unique per instance: two strips sharing a name would be one radio
 * group, and selecting Money in the capability grid would deselect Brand three
 * sections down.
 */
export function GroupTabs({ name, groups }: { name: string; groups: readonly string[] }) {
  return (
    <div className={s.segTabs} style={{ fontFamily: MONO }}>
      {groups.map((g, i) => (
        <label key={g} className={s.segTab}>
          <input
            className={s.segInput}
            type="radio"
            name={name}
            /* Uncontrolled on purpose. The browser owns this state exactly the way it
               owns `[open]` on the FAQ's `<details>`, and nothing on the page reads
               it back. */
            defaultChecked={i === 0}
          />
          <span className={s.segLabel}>{g}</span>
        </label>
      ))}
    </div>
  );
}

/** Primary / secondary call to action. An anchor, because every destination is a route. */
export function Cta({
  href,
  label,
  variant = "primary",
}: {
  href: string;
  label: string;
  variant?: "primary" | "secondary";
}) {
  return (
    <a
      href={href}
      className={variant === "primary" ? s.ctaPrimary : s.ctaSecondary}
      style={{ fontFamily: ARCHIVO, fontWeight: 600, fontSize: 13.5, letterSpacing: "-0.005em" }}
    >
      {label}
    </a>
  );
}

/**
 * A link to something a reader can go and check for themselves.
 *
 * It exists as a component because the page's credibility argument is "every claim
 * is verifiable", and a verifiable claim that does not visibly leave the site is
 * indistinguishable from a claim we made up. `rel` is set here so no call site can
 * forget it.
 */
export function LinkOut({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={s.linkQuiet} style={{ color: TXT }}>
      {children}
      <span style={{ color: FAINT }}> ↗</span>
    </a>
  );
}

/** Emphasis inside body copy, at the same weight the terminal gives a live value. */
export function Strong({ children }: { children: ReactNode }) {
  return <strong style={{ color: TXT, fontWeight: 600 }}>{children}</strong>;
}

/* ============================== code ============================== */

/* The dim marker and the tokenizer both live in lib/highlight.ts now, so the
   consoles and this page cannot drift into two different ideas of what a comment
   looks like. `[dim]` still greys the remainder of a line. */

/**
 * The lines of a code block, without the frame.
 *
 * Split out from `Code` so the tabbed variant can reuse the dim-marker rule instead
 * of reimplementing it — two renderers for one syntax is how the two drift apart.
 */
export function CodeBody({
  lines,
  lang = "plain",
  fit = false,
}: {
  lines: string[];
  lang?: Lang;
  /**
   * Shrink one step at phone width so the block fits instead of scrolling.
   *
   * For the block whose right-hand column is ANNOTATION rather than code — the
   * repository tree — where a clipped line is a clipped sentence and not a line
   * anyone would drag to finish. See `.codeFit`.
   */
  fit?: boolean;
}) {
  return (
    <pre
      className={fit ? s.codeFit : undefined}
      style={{
        margin: 0,
        /* The one thing on a marketing page that legitimately exceeds 390px. Let
           the block scroll rather than wrap a config file at an arbitrary column
           or push the whole page sideways. */
        overflowX: "auto",
        fontFamily: MONO,
        /* `fit` puts the size in the stylesheet, because it changes at a breakpoint
           and an inline value would outrank the query that changes it. */
        fontSize: fit ? undefined : 12,
        padding: fit ? undefined : "16px",
        lineHeight: 1.75,
        color: TXT,
      }}
    >
      {lines.map((line, i) => {
        const tokens = tokenizeWithDim(line, lang);
        return (
          /* `whiteSpace` is inline only when the line is not a fitted one; `.codeFitLine`
             has to be able to fold it at phone width, and an inline `pre` outranks the
             query that would. */
          <div
            key={i}
            className={fit ? s.codeFitLine : undefined}
            style={fit ? undefined : { whiteSpace: "pre" }}
          >
            {/* An empty line still needs a glyph or the block collapses its height. */}
            {tokens.length === 1 && tokens[0]!.text === "" ? (
              " "
            ) : (
              tokens.map((t, j) => (
                <span
                  key={j}
                  style={{ color: TOKEN_COLOR[t.kind], fontWeight: TOKEN_WEIGHT[t.kind] }}
                >
                  {t.text}
                </span>
              ))
            )}
          </div>
        );
      })}
    </pre>
  );
}

export function Code({
  title,
  lines,
  lang,
  fit = false,
  style,
}: {
  title?: string;
  /** Pre-split lines; `[dim]` anywhere in one greys the remainder of it. */
  lines: string[];
  /** Overrides the grammar inferred from `title`. */
  lang?: Lang;
  /** See `CodeBody` — for the block that must fit at 375px rather than scroll. */
  fit?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: SUNK,
        border: `1px solid ${L2}`,
        borderRadius: 8,
        overflow: "hidden",
        minWidth: 0,
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            padding: "10px 14px",
            borderBottom: `1px solid ${L1}`,
            background: CHROME,
            ...eyebrow(),
          }}
        >
          {title}
        </div>
      )}
      <CodeBody lines={lines} lang={lang ?? detectLang(title)} fit={fit} />
    </div>
  );
}

/* ============================== misc ============================== */

/** The direction pair, for anything that needs to name a side. */
export const side = { bid: GREEN, ask: RED };

/** Small rounded tag used by the source labels and the tape. */
export const tagStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 7px",
  border: `1px solid ${L2}`,
  borderRadius: R_XS,
  background: CHROME,
  fontFamily: MONO,
  fontSize: 9.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: DIM,
  whiteSpace: "nowrap",
};
