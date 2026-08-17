/*
 * The console shell: sidebar, environment switcher, section chrome.
 *
 * RENDERED ONCE, BY `app/admin/layout.tsx`. Every page used to construct its own
 * `<ConsoleShell>` with the same six props, which meant the sidebar was torn down
 * and rebuilt on every navigation — and `app/admin/loading.tsx` had to become a
 * client component so that the shell it drew in the gap could put the highlight
 * on the right row. Owning it in the layout makes the sidebar survive the route
 * change: the loading boundary now replaces the content column and nothing else.
 *
 * The price of that is the query string. A layout receives `children` and
 * `params` and NOT `searchParams`, and `?env=live` is where this console keeps
 * the one distinction it spends its whole warning budget on. So the parts that
 * read the URL — the nav links and the environment switcher — live in
 * `console-nav.tsx` as a client component, and the static chrome below is passed
 * into it as already-rendered server nodes.
 *
 * Structured as a real developer platform rather than one long page, because the
 * audiences differ. An analyst lives in Analytics, a developer lives in API and
 * Keys, an owner visits Billing once a month. One scrolling page serves the
 * demo and none of them.
 *
 * The environment switcher sits at the TOP of the sidebar, above everything,
 * and it is the loudest control on the screen. That is deliberate: on this
 * platform the difference between test and live is the difference between play
 * money and real money, and the protocol will not save an operator who confuses
 * them — a signed request is byte-identical on both networks, and only the key
 * store differs.
 */

import Link from "next/link";

import { TOKEN_COLOR, TOKEN_WEIGHT, detectLang, tokenizeLine, type Lang } from "@/lib/highlight";
import type { CSSProperties, ReactNode } from "react";

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
  R_MD,
  R_SM,
  R_XS,
  RED,
  SEL,
  SUNK,
  TAP_CONTROL,
  TAP_FLOOR,
  TAP_PRIMARY,
  TERM,
  TXT,
  monoLabel,
  titleLabel,
} from "@/lib/theme";
import { SIZE, body } from "./type";
/* parts.tsx imports nothing from this file, so this direction is the acyclic one. */
import { Dot } from "./parts";
/* Same one-direction rule: console-nav.tsx imports only the `NavItem` TYPE from
   here, which TypeScript erases, so there is no runtime cycle. */
import { ConsoleSidebar } from "./console-nav";

export interface NavItem {
  href: string;
  label: string;
  /** Shown right-aligned — a count, or a state word. */
  badge?: string;
}

/*
 * OPERATE / BUILD / ORGANISATION — grouped by who is asking, not by what the
 * data is.
 *
 * The old grouping was Venue / Build / Organisation, and "Venue" was a bucket
 * rather than a question: it held the numbers an analyst reads and the settings
 * an operator changes, which are different jobs at different frequencies.
 * "Operate" names the job — the panes you open because the venue is running —
 * and leaves Build for the panes you open because you are integrating against
 * it. An operator who has never read this comment should still be able to guess
 * which of the three groups a pane is in, which is the only test a grouping has
 * to pass.
 *
 * EVERY ENTRY RESOLVES. A sidebar entry that 404s is worse than a missing one,
 * because it teaches the operator that this navigation lies — and that lesson is
 * not unlearned later. So this table holds routes and nothing else; anything that
 * is not a route is not a nav item.
 *
 * ONE RULE FOR THE ORDER. Within a group, the entries run from the widest
 * altitude to the narrowest: Overview is the venue, Markets is one row of it,
 * Analytics is the measurement of both.
 */
export const CONSOLE_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Operate",
    items: [
      { href: "/admin", label: "Overview" },
      /* Directly after Overview, and for the altitude rule above: Overview's
         markets table is the thing an operator clicks into, and
         the index is that table with the venue's own economics beside the
         exchange's. The drill-down `/admin/markets/[market]` lights this row up
         too — see isCurrent() in console-nav.tsx. */
      { href: "/admin/markets", label: "Markets" },
      { href: "/admin/analytics", label: "Analytics" },
      /* Deposits sits under Operate rather than under Build because it is an
         operator question — which rails do my traders arrive on — and not an
         integration the operator performs. They integrate no onramp and no
         bridge; the venue inherits both.

         The LABEL is Deposits, matching the landing page and the product. The
         ROUTE stays /admin/funding: `/api/admin/funding` is a documented
         contract in lib/venue/api-catalog.ts, and renaming a published endpoint
         to fix a label is the wrong trade. The badge is gone with the rename —
         a NEW badge with no expiry is decoration within a fortnight, and this
         pane has been shipped for a while. */
      { href: "/admin/funding", label: "Deposits" },
      /* Not in the §3a list, and kept anyway: /admin/config exists and is the
         one pane that changes the venue rather than reporting on it. Dropping
         its entry would orphan a live route, which is the same defect as a dead
         link seen from the other side. Operate is where it belongs — it is what
         you open because the venue is running. */
      { href: "/admin/config", label: "Configuration" },
    ],
  },
  {
    section: "Build",
    items: [
      { href: "/admin/api", label: "API reference" },
      /* "Keys", flatly. It was "Keys & webhooks", then "Keys" once webhooks took
         their own route, and now it is "Keys" because there are no webhooks: the
         `/admin/webhooks` entry that sat below this line is gone with EP-010.
         A venue is a static frontend with nothing to receive a delivery, polling
         the admin API is sufficient at this scale, and the four events that were
         modelled were trader account state a venue should not be told about. */
      { href: "/admin/keys", label: "Keys" },
      { href: "/admin/logs", label: "Logs" },
    ],
  },
  {
    section: "Organisation",
    items: [
      { href: "/admin/team", label: "Team & access" },
      { href: "/admin/billing", label: "Billing" },
      /* "Audit" now: earnings, payout and fee basis moved to /admin/billing, and
         this pane is the record — the log, what is NOT logged, and retention. */
      { href: "/admin/audit", label: "Audit" },
    ],
  },
];

export function ConsoleShell({
  entity,
  wordmark,
  children,
}: {
  entity: string;
  wordmark: string;
  children: ReactNode;
}) {
  return (
    <div className="nx-console" style={{ display: "flex", minHeight: "100dvh", background: BG }}>
      {/*
        Everything env-dependent is inside ConsoleSidebar, which is a client
        component; the two blocks below are static and are handed to it as
        server-rendered nodes rather than re-implemented there. `venueName` is
        gone with the refactor — it was a prop no version of this component ever
        rendered.
      */}
      <ConsoleSidebar
        groups={CONSOLE_NAV}
        head={
          <div className="nx-sidehead" style={{ padding: "16px 14px 12px", borderBottom: `1px solid ${L1}` }}>
            {/* The wordmark is also the way home, so it is a target and not just a
                mark — two lines of 9px type measured 29px tall, under the floor. */}
            <Link
              href="/"
              style={{ textDecoration: "none", display: "flex", flexDirection: "column", justifyContent: "center", gap: 3, minHeight: TAP_FLOOR }}
            >
              <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: SIZE.title, letterSpacing: "0.28em", color: HI }}>
                {wordmark}
              </span>
              <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>VENUE CONSOLE</span>
            </Link>
          </div>
        }
        foot={
          <div className="nx-sidefoot" style={{ padding: "14px 14px 44px", borderTop: `1px solid ${L1}`, display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>OPERATED BY</span>
            <span style={{ ...body(SIZE.note, 1.4), color: MUT }}>{entity}</span>
            <Link href="/trade" style={{ ...monoLabel(SIZE.micro), color: DIM, textDecoration: "none" }}>
              ← BACK TO TERMINAL
            </Link>
          </div>
        }
      />

      <main style={{ flex: 1, minWidth: 0, padding: "26px clamp(16px, 3vw, 36px) 72px", maxWidth: 1320 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>{children}</div>
      </main>
    </div>
  );
}

// ── page furniture ───────────────────────────────────────────────────────────

export function PageHead({
  title,
  blurb,
  eyebrow,
  right,
}: {
  title: string;
  blurb?: string;
  /**
   * ALTITUDE, stated rather than implied.
   *
   * Overview, Analytics and a market drill-down were the same page furniture with
   * different data in it, and an operator two clicks deep had nothing on screen
   * telling them how zoomed in they were. The eyebrow is that: a one-word altitude
   * above the title — VENUE, MEASUREMENT, ONE MARKET. Optional and additive, so a
   * page with only one altitude does not have to claim one.
   */
  eyebrow?: string;
  right?: ReactNode;
}) {
  return (
    <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        {eyebrow && <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>{eyebrow}</span>}
        <h1 style={{ ...titleLabel(SIZE.page, 700), color: HI, margin: 0, letterSpacing: "-0.015em" }}>{title}</h1>
        {blurb && (
          <p style={{ ...body(SIZE.body, 1.6), color: MUT, margin: 0, maxWidth: 760 }}>{blurb}</p>
        )}
      </div>
      {right}
    </header>
  );
}

export function Panel({
  title,
  blurb,
  right,
  children,
  style,
}: {
  title?: string;
  blurb?: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        background: PANEL,
        border: `1px solid ${L2}`,
        borderRadius: R_MD,
        overflow: "hidden",
        minWidth: 0,
        ...style,
      }}
    >
      {/* `right` alone is enough to earn a header now. A sub-pane's tab strip is
          a header with no title — the panel is named by the tabs in it — and
          gating the header on `title` silently dropped the whole strip. */}
      {(title || right) && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            /* WRAPS, because `right` is no longer always a pill or a count. A
               sub-pane strip of four tabs is ~230px, and beside a title on a
               375px phone it either squeezed the title to one word per line or
               pushed itself off the panel — invisible under Panel's
               `overflow: hidden`, which is the same way the Branded API input
               disappeared. Wrapping puts the strip on its own line at the width
               where it stops fitting and changes nothing at any width where it
               does. */
            flexWrap: "wrap",
            padding: "11px 15px",
            borderBottom: `1px solid ${L1}`,
            background: CHROME,
          }}
        >
          {/* Skipped entirely when there is no title, so a tabs-only header puts
              its strip on the left where the title would have been rather than
              pushing it right past an empty box. */}
          {title && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ ...titleLabel(SIZE.title, 600), color: TXT }}>{title}</span>
              {blurb && <span style={{ ...body(SIZE.note, 1.45), color: FAINT }}>{blurb}</span>}
            </div>
          )}
          {right}
        </header>
      )}
      <div style={{ padding: 16 }}>{children}</div>
    </section>
  );
}

export function Grid({ children, min = 300 }: { children: ReactNode; min?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
        gap: 18,
        /* Panels size to their own content. Stretching them to a shared height
           left ~150px of dead space under every short panel — most obviously
           under the API page's Quick start, beside a much longer sibling. */
        alignItems: "start",
      }}
    >
      {children}
    </div>
  );
}

/**
 * `info` IS NOT A STATUS, and it was wearing a series colour to pretend otherwise.
 *
 * The old map gave `info` the literal `#00a1ca`, which is `SERIES[0]` — the exact
 * hue that means "the first venue" or "the first market" in every chart in this
 * console. charts.tsx is explicit that status hues (red, amber, green) are reserved
 * and a series never wears them; the converse has to hold too, or a blue pill beside
 * a blue chart band reads as a legend entry. `bad` was a second copy of the RED
 * token besides.
 *
 * So `info` loses its hue rather than gaining a new one. Information is the absence
 * of a status: label ink, a slightly stronger edge, no tint. That removes a colour
 * from the console instead of adding one, and the tone union is unchanged so no
 * caller has to know.
 */
export function Pill({ tone, children }: { tone: "good" | "warn" | "bad" | "mute" | "info"; children: ReactNode }) {
  const map = {
    good: GREEN,
    warn: AMBER,
    bad: RED,
    info: MUT,
    mute: MUT,
  } as const;
  const color = map[tone];
  const neutral = tone === "info" || tone === "mute";
  return (
    <span
      style={{
        ...monoLabel(SIZE.micro),
        color: neutral ? MUT : color,
        border: `1px solid ${neutral ? L3 : `${color}33`}`,
        background: neutral ? "transparent" : `${color}0d`,
        borderRadius: R_XS,
        padding: "2px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        fontFamily: MONO,
        fontSize: SIZE.note,
        color: TXT,
        background: SUNK,
        border: `1px solid ${L2}`,
        borderRadius: R_XS,
        padding: "1.5px 5px",
      }}
    >
      {children}
    </code>
  );
}

export function CodeBlock({
  children,
  label,
  lang,
}: {
  children: string;
  label?: string;
  /** Overrides the grammar inferred from `label`. */
  lang?: Lang;
}) {
  const grammar = lang ?? detectLang(label);
  return (
    <div style={{ border: `1px solid ${L2}`, borderRadius: R_SM, overflow: "hidden", background: TERM }}>
      {label && (
        <div style={{ padding: "6px 10px", borderBottom: `1px solid ${L1}`, background: CHROME }}>
          <span style={{ ...monoLabel(SIZE.micro), color: DIM }}>{label}</span>
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: 12,
          fontFamily: MONO,
          fontSize: SIZE.data,
          lineHeight: 1.65,
          color: TXT,
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {/* Highlighted per line, from the label. A console that documents an API in
            monochrome makes its own reference the least readable code on the page. */}
        {children.split("\n").map((line, i) => (
          <div key={i}>
            {tokenizeLine(line, grammar).map((t, j) => (
              <span key={j} style={{ color: TOKEN_COLOR[t.kind], fontWeight: TOKEN_WEIGHT[t.kind] }}>
                {t.text}
              </span>
            ))}
            {line === "" ? " " : null}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** A label/value row, for settings and detail lists. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      /*
       * FLEX-WRAP RATHER THAN A TWO-COLUMN GRID, because the control is not
       * always narrower than the slack. `minmax(150px, 1fr) auto` has no way to
       * yield: the Branded API row's 190px domain field plus a 150px label plus
       * the gap is 354px, so on a 341px phone the input hung off the panel and
       * was clipped away by Panel's `overflow: hidden` — invisible to a
       * scrollWidth check and unusable to an operator. Wrapping puts the control
       * on its own line instead, and at any width where both fit the layout is
       * the one it was before.
       */
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 14,
        padding: "11px 0",
        borderBottom: `1px solid ${L1}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 150px", minWidth: 0 }}>
        <span style={{ ...titleLabel(SIZE.body, 500), color: TXT }}>{label}</span>
        {hint && <span style={{ ...body(SIZE.note, 1.5), color: FAINT }}>{hint}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * A range / view switch built from links, not state.
 *
 * The selection lives in the URL, so it survives a reload, can be bookmarked, and
 * can be sent to a colleague — which is what an operator actually does with a
 * chart that looks wrong. It also keeps the page a server component: the data is
 * recomputed for the window rather than filtered in the browser.
 */
export function LinkTabs({
  options,
  active,
  hrefFor,
  label,
}: {
  options: readonly string[];
  active: string;
  hrefFor: (option: string) => string;
  label?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {label && <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>{label}</span>}
      <div style={{ display: "flex", gap: 3, background: SUNK, padding: 3, borderRadius: R_SM, border: `1px solid ${L2}` }}>
        {options.map((option) => {
          const on = option === active;
          return (
            <Link
              key={option}
              href={hrefFor(option)}
              aria-current={on ? "true" : undefined}
              style={{
                ...monoLabel(SIZE.micro),
                color: on ? HI : DIM,
                background: on ? SEL : "transparent",
                borderRadius: R_XS,
                padding: "6px 11px",
                textDecoration: "none",
                /* Same 36–40 band as the env switcher and the terminal's own tab
                   strip. A range picker is the control an operator taps most on
                   a phone, and 9px type alone gave it a 24px box. */
                display: "inline-flex",
                alignItems: "center",
                minHeight: TAP_CONTROL,
              }}
            >
              {option}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Where you are, and the way back. Only earns its place below a drill-down. */
export function Breadcrumb({ trail }: { trail: { label: string; href?: string }[] }) {
  return (
    <nav style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
      {trail.map((step, i) => (
        <span key={step.label} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          {i > 0 && <span style={{ ...monoLabel(SIZE.micro), color: FAINT }}>/</span>}
          {step.href ? (
            <Link
              href={step.href}
              className="nx-hover-text"
              /* The way back out of a drill-down, and at 12px of line box it was
                 the smallest target on the page. Graded at the default floor
                 rather than the nav tier: this is orientation, not the console's
                 primary navigation, which is the strip above it. */
              style={{ ...monoLabel(SIZE.micro), color: DIM, textDecoration: "none", display: "inline-flex", alignItems: "center", minHeight: TAP_FLOOR }}
            >
              {step.label}
            </Link>
          ) : (
            <span style={{ ...monoLabel(SIZE.micro), color: MUT }}>{step.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** A framed aside. The caller supplies the claim; this supplies the frame. */
export function Note({ tone = "info", label, children }: { tone?: "info" | "warn" | "good"; label: string; children: ReactNode }) {
  /* `info` is the quiet case for the same reason as in `Pill`: it borrowed a series
     hue, and an aside is not a status. Warn and good keep their colour because they
     ARE one. The 3px dot is the console's shared provenance mark, so a framed aside
     announces itself in the same shape a figure does. */
  const info = tone === "info";
  const color = tone === "warn" ? AMBER : tone === "good" ? GREEN : MUT;
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        /* A rule above and a label beside, rather than a tinted rounded box. The
           tone still reaches the label — a warning still reads amber — but it no
           longer wraps the prose in the admonition shape that every generated
           interface uses for every aside. */
        borderTop: `1px solid ${info ? L2 : `${color}44`}`,
        paddingTop: 10,
        ...body(SIZE.note, 1.6),
        color: MUT,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          ...monoLabel(SIZE.micro),
          color: info ? DIM : color,
          paddingTop: 3,
          whiteSpace: "nowrap",
        }}
      >
        <Dot color={color} />
        {label}
      </span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

/*
 * THE THREE SHARED CONTROL STYLES CARRY THE TAP FLOOR, so no call site has to
 * remember it. 7px of padding around 9–11px type produced 28px buttons and 31px
 * inputs — a pixel or four under floor.json's 32px default tier, everywhere in
 * the console at once. Stating the height here fixes every one of them and
 * cannot drift when the type scale moves.
 */
export const inputStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: SIZE.data,
  color: HI,
  background: TERM,
  border: `1px solid ${L2}`,
  borderRadius: R_SM,
  padding: "7px 9px",
  minHeight: TAP_FLOOR,
  outline: "none",
};

export const buttonStyle: CSSProperties = {
  ...monoLabel(SIZE.micro),
  color: TXT,
  background: SUNK,
  border: `1px solid ${L3}`,
  borderRadius: R_SM,
  padding: "7px 11px",
  minHeight: TAP_FLOOR,
  cursor: "pointer",
};

/**
 * The one action on the panel that is meant to be taken, so it takes the 44px
 * budget rather than the 32px floor — the same tier the nav strip is on.
 */
export const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: GREEN,
  background: `${GREEN}14`,
  border: `1px solid ${GREEN}55`,
  minHeight: TAP_PRIMARY,
};
