/*
 * The platform page's own chrome.
 *
 * Deliberately NOT the terminal's TopNav. That component carries trading state —
 * session, market ticker, screen switcher — and is a client component for all of
 * it; a marketing page that mounted it would ship the whole trading bundle to
 * render a wordmark. This is the same wordmark and the same hairline, statically.
 *
 * NOT sticky, and that is a mobile decision rather than a taste one. Even at two rows
 * a pinned bar eats a chunk of a phone viewport for the whole scroll, and the sticky
 * section rail directly below it already answers "where am I". At 390px the links
 * become one horizontally scrolling line and the call to action moves up beside the
 * wordmark — see `.navLinks` / `.navCta` in landing.module.css. Two rows, no link
 * hidden, nothing wrapping.
 *
 * The wordmark is set at the terminal's own tracking, because this page is a tenant
 * of the same config and looking like the product it sells is an argument.
 */

import { ARCHIVO, CHROME, DIM, HI, L2, MONO } from "@/lib/theme";

import { css as s, Cta, PLATFORM, Wrap } from "./primitives";

/*
 * Product destinations only. The section links live in the sticky rail below the
 * hero — the bar that actually follows you down the page — and repeating them here
 * made a seven-control row that wrapped to three lines on a phone.
 */
/*
 * Four links and two kinds. The first two move down this page; the last two leave it
 * for a running surface, which is the whole reason they are worth a slot — a
 * prospect who opens the terminal has stopped reading about the product and started
 * using it. `Start building` sits apart as the call to action and lands on the
 * commands.
 */
const LINKS: { href: string; label: string }[] = [
  { href: "#terminal", label: "Product" },
  { href: "#deposits", label: "Deposits" },
  { href: "/trade", label: "Terminal" },
  { href: "/admin", label: "Console" },
];

export function Nav() {
  return (
    <header style={{ background: CHROME, borderBottom: `1px solid ${L2}` }}>
      <Wrap
        wide
        style={{
          minHeight: 58,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px 18px",
          paddingTop: 9,
          paddingBottom: 9,
        }}
      >
        {/* `minHeight` on the anchor and not on the text inside it: the wordmark is a
            14px line, so without it the page's home link is a 15px-tall target — under
            the 32px default tier before the nav tier is even considered. */}
        <a href="/" style={{ display: "flex", alignItems: "center", minHeight: 44, textDecoration: "none" }}>
          {/* The baseline row is one level in, because the anchor itself has to be
              44px tall and a baseline-aligned flex box parks its content at the top of
              whatever height you give it. */}
          <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: 14, letterSpacing: "0.34em", color: HI }}>
              {PLATFORM.wordmark}
            </span>
            <span
              style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.2em", textTransform: "uppercase", color: DIM }}
            >
              Platform
            </span>
          </span>
        </a>

        <nav
          className={s.navLinks}
          /* nowrap, not wrap: at 390px this row becomes a horizontal scroller (see
             `.navLinks`), and a wrapping flex line inside a scroller wraps instead of
             scrolling. Above the breakpoint there is room for all five on one line. */
          style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", gap: 4, marginLeft: "auto" }}
        >
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              /* `.navLink` carries the height, because it is 34px with a mouse and
                 44px once the pointer is a finger — and an inline minHeight here could
                 never be raised by that query. */
              className={`${s.ctaSecondary} ${s.navLink}`}
              style={{
                flex: "0 0 auto",
                padding: "0 10px",
                border: "1px solid transparent",
                fontFamily: ARCHIVO,
                fontWeight: 500,
                fontSize: 13,
                color: DIM,
              }}
            >
              {l.label}
            </a>
          ))}
        </nav>
        <span className={s.navCta}>
          <Cta href="#start" label="Start building" />
        </span>
      </Wrap>
    </header>
  );
}
