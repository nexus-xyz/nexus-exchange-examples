/*
 * The stack — what you are actually running, and what running it costs you.
 *
 * WHY THE PAGE NEEDED THIS. Everything above says what the venue does; nothing said
 * what it IS. A reader evaluating "deploy your own exchange" is asking a question no
 * screenshot answers: how many moving parts am I taking on, what do I have to keep
 * alive at 3am, and what happens when you ship a new version. A page that shows a
 * product and never shows its shape is asking to be assumed heavier than it is.
 *
 * THE TREE IS THE ASSET. One repository, listed. It is a better answer than any
 * architecture diagram because a diagram invites the reader to imagine boxes we did
 * not draw, while a file listing has an end — the reader can see there is no service
 * mesh in it. Four runtime dependencies is the second fact, and it is a fact rather
 * than a boast: it is the number a security review asks for first.
 *
 * THE SPLIT TABLE IS THE HONEST HALF. "What you run" against "what we run" is the
 * same line the FAQ draws under self-hosting, drawn once as a table so a reader can
 * see how short their column is. Their column being short is the product; pretending
 * it is empty would be the lie.
 */

import { Fragment } from "react";

import { ARCHIVO, DIM, FAINT, HI, L1, L2, MONO, MUT, PANEL, TXT } from "@/lib/theme";

import { Band, Code, Head, Wrap, css as cx, annotation, body, eyebrow } from "./primitives";
import { BrandStack, type BrandId } from "@/components/BrandMarks";

/*
 * The actual layout of the template repository. Kept in sync with PACKAGING.md §1 —
 * if these disagree, the document is right and this is stale.
 *
 * The annotations are terse because the block must not need a horizontal scrollbar:
 * a code sample that scrolls is fine in documentation and is a clipped sentence on a
 * marketing page, where nobody drags.
 *
 * The annotation column sits at 25 and not at 27, which is one space after the longest
 * path rather than three. Two columns is two characters, and at 375px two characters is
 * the difference between the tree's longest lines fitting and folding — see `.codeFit`,
 * which spends everything else there is to spend on the same problem.
 */
/* The tree lost three lines when the order path lost its server: the signing proxy,
   the admin routes behind it, and the console — which is one application we host for
   every venue rather than one each venue deploys. What is left is a frontend. */
const TREE = [
  "nexus-venue-template/",
  "  nexus.json             [dim]the venue contract",
  "  app/",
  "    (venue)/             [dim]the terminal",
  "  lib/                   [dim]fee maths · decimals",
  "  vercel.json",
  "  .env.example           [dim]one variable, no secrets",
];

/** The runtime dependency list, in full. The point is that it fits on four lines. */
const DEPS: { name: string; why: string }[] = [
  { name: "next", why: "the framework the terminal is built with, and the only one you deploy" },
  { name: "react · react-dom", why: "the renderer" },
  { name: "lightweight-charts", why: "the candle pane, and the only thing here that draws" },
  /* A fourth line was `@nexus-xyz/venue-kit`. It is gone, and three separate things
     about it had become wrong: the package itself dissolves — the fee and decimal maths
     are template code and the config schema is published by the API — while "signing"
     belonged to a proxy the order path no longer has, and "the ledger" belonged to the
     venue before attribution moved to our side. The count in FACTS and the section title
     move with it: a dependency list whose whole point is that a reader can check it has
     to be countable. */
];

/**
 * Measured, not asserted. Every figure here comes from `next build` or from this
 * project's build-time checks, and the point of putting numbers on a marketing page
 * is that a reader can check them — 223 kB is a claim, "blazing fast" is not.
 */
const FACTS: { figure: string; label: string; detail: string }[] = [
  {
    figure: "223 kB",
    label: "First load, the whole terminal",
    detail: "Chart, book, ticket, blotter and portfolio. 102 kB of that is React and the framework itself.",
  },
  {
    figure: "3",
    label: "Runtime dependencies",
    detail: "Everything above, minus the framework, is code in the repository you can read.",
  },
  {
    figure: "0",
    label: "Third-party requests",
    detail: "No external fonts, scripts, tag managers or trackers — enforced as a build check, not a policy.",
  },
  /* A fifth cell advertised our own capture harness — "51 x 5 states by viewports,
     graded". It went with the verification product: internal QA apparatus is not a
     partner-facing fact, and the count came from the parity-era manifest. Four cells
     also close `.quad` exactly, which five never did. */
];

/**
 * The operating facts, as cells rather than paragraphs.
 *
 * These were five stacked Notes — roughly 250 words of body prose in a row, in the
 * one section a reader is scanning rather than reading. Two of them also said the
 * same thing twice: preview URLs and one-click rollback appeared under DEPLOYING and
 * again under ON THE EDGE. Six short cells carry every fact that survived, and the
 * count divides at 3, 2 and 1 so the grid never orphans one.
 */
const OPS: { k: string; v: string }[] = [
  // The section title already says "A git push."
  { k: "Deploy", v: "Every push gets a preview URL; every deploy is one click from rollback." },
  { k: "Config", v: "One committed JSON file, reviewed like code — so a venue change cannot drift from it." },
  { k: "Secrets", v: "None. There is no venue-side credential to rotate — the trader's key is the trader's." },
  { k: "Storage", v: "None. Per-venue attribution is computed against the fills your builder code produced." },
  { k: "Edge", v: "The whole trader surface is prerendered and served from cache. Nothing of yours runs per request." },
  { k: "Extend", v: "Ordinary React. No state library, no CSS framework, no component kit to learn first." },
];

/** The stack itself, as marks. Shared with the deposit screen's chip machinery. */
const TECH: { id: BrandId; label: string }[] = [
  { id: "nextjs", label: "Next.js" },
  { id: "react", label: "React" },
  { id: "typescript", label: "TypeScript" },
  { id: "vercel", label: "Vercel" },
  /* Postgres was here for the venue-side ledger. A venue that runs no server keeps no
     database, so the mark went with it. */
];

/** Where the line falls. Their column is short; it is not empty, and it says so. */
const SPLIT: { yours: string; ours: string }[] = [
  { yours: "The frontend, built to static files", ours: "The matching engine and the shared book" },
  { yours: "The venue config, committed and reviewed", ours: "Risk, margin and liquidation" },
  /* The signing proxy used to be the second row of the you-run column. It left the order
     path with the credential: the trader signs in their own browser with a key that
     cannot withdraw, so there is nothing of yours between the browser and the API. */
  { yours: "Hosting, region and uptime of that frontend", ours: "Custody, and the console your operators sign into" },
  { yours: "Your domain, your brand, your customers", ours: "The API contract and its versioning" },
];

export function Stack() {
  return (
    <Band id="stack" tone="raised">
      <Wrap>
        <Head
          eyebrow="The stack"
          title="The whole stack: one repository, three dependencies, a git push."
          blurb="What you are taking on, listed rather than described. It is a Next.js app that builds to static files and calls one API from the browser — no server of yours in the order path, no queue, no worker, nothing to keep warm."
        />

        {/* THE STACK, AS MARKS. The section is about what this is built with and it
            had no visual of any kind — a row of marks answers "what am I adopting"
            before a word of prose does, and it reuses the chip machinery the deposit
            screen already ships rather than inventing a second one. */}
        <div
          style={{
            marginTop: 26,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px 22px",
          }}
        >
          {TECH.map((t) => (
            <span key={t.id} style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
              <BrandStack ids={[t.id]} size={22} ring={PANEL} />
              <span style={{ fontFamily: ARCHIVO, fontSize: 13.5, fontWeight: 600, color: TXT }}>{t.label}</span>
            </span>
          ))}
          {/* The dependency panel four inches below lists the venue kit with "0 dependencies
              of its own". */}
        </div>

        {/* THE NUMBERS, SECOND. They used to sit fourth, behind two panels and a
            table — the most scannable thing in the section, placed where a reader
            arrives having already decided how they feel about it. */}
        <div className={cx.quad} style={{ marginTop: 26, background: L1, border: `1px solid ${L2}` }}>
          {FACTS.map((f) => (
            <div key={f.label} style={{ background: PANEL, padding: "18px 16px 20px", minWidth: 0 }}>
              <div style={{ fontFamily: ARCHIVO, fontSize: 26, fontWeight: 700, color: HI, letterSpacing: "-0.01em" }}>
                {f.figure}
              </div>
              <div style={{ ...eyebrow(TXT), margin: "9px 0 7px" }}>{f.label}</div>
              <div style={{ ...annotation(DIM, 11), margin: 0 }}>{f.detail}</div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 20,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))",
            gap: 20,
            alignItems: "start",
          }}
        >
          {/* `plain`, not `bash`. A file listing is not shell, and the bash grammar
              bolded `nexus` as a builtin inside a filename. */}
          <Code title="the whole repository" lines={TREE} />

          <div style={{ border: `1px solid ${L2}`, background: PANEL }}>
            <div
              style={{
                padding: "11px 14px",
                borderBottom: `1px solid ${L2}`,
                display: "flex",
                alignItems: "baseline",
                gap: 10,
              }}
            >
              <span style={eyebrow(MUT)}>Runtime dependencies</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginLeft: "auto" }}>the whole list</span>
            </div>
            {DEPS.map((d, i) => (
              <div
                key={d.name}
                style={{
                  padding: "12px 14px",
                  borderTop: i === 0 ? undefined : `1px solid ${L1}`,
                  display: "grid",
                  gap: 4,
                }}
              >
                <code style={{ fontFamily: MONO, fontSize: 11.5, color: HI }}>{d.name}</code>
                <span style={{ ...annotation(DIM, 11), margin: 0 }}>{d.why}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Where the line falls. Two columns rather than prose, because the shape of
            the answer — one short list, one long one — is the answer. */}
        <div style={{ marginTop: 26 }}>
          <div className={cx.pairs} style={{ background: L1, border: `1px solid ${L2}` }}>
            <div style={{ background: PANEL, padding: "13px 16px" }}>
              <span style={{ ...eyebrow(TXT) }}>You run</span>
            </div>
            <div style={{ background: PANEL, padding: "13px 16px" }}>
              <span style={{ ...eyebrow(TXT) }}>We run</span>
            </div>
            {SPLIT.map((row) => (
              <Fragment key={row.yours}>
                <div style={{ background: PANEL, padding: "13px 16px", ...body, fontSize: 13 }}>{row.yours}</div>
                <div style={{ background: PANEL, padding: "13px 16px", ...body, fontSize: 13, color: MUT }}>
                  {row.ours}
                </div>
              </Fragment>
            ))}
          </div>
        </div>

        {/* Operating it — six cells where five paragraphs used to be. */}
        <div style={{ marginTop: 26 }}>
          <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "6px 14px", marginBottom: 14 }}>
            <span style={eyebrow(TXT)}>Running it</span>
            <span style={{ ...annotation(FAINT, 11), margin: 0 }}>what the week after launch looks like</span>
          </div>
          <div className={cx.trio} style={{ background: L1, border: `1px solid ${L2}` }}>
            {OPS.map((o) => (
              <div key={o.k} style={{ background: PANEL, padding: "14px 16px 16px", display: "grid", gap: 5, minWidth: 0 }}>
                <span style={{ ...eyebrow(HI), fontSize: 9.5 }}>{o.k}</span>
                <span style={{ ...annotation(MUT, 11), margin: 0 }}>{o.v}</span>
              </div>
            ))}
          </div>
        </div>

      </Wrap>
    </Band>
  );
}
