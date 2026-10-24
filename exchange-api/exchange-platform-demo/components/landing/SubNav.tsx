"use client";

/*
 * The sticky section rail.
 *
 * This page is long and the top nav deliberately scrolls away (see Nav.tsx: the
 * controls wrap to three rows at 390px, and a pinned bar that tall eats a fifth of a
 * phone viewport). This bar is the answer to the problem that decision leaves behind:
 * one row, 44px, that never wraps because it scrolls horizontally instead.
 *
 * FOUR THINGS MAKE IT A RAIL RATHER THAN A ROW OF BUTTONS.
 *
 * 1. TYPE. It was 10px mono, uppercase, tracked out to 0.14em — which is this page's
 *    language for a LABEL, and ten labels at equal weight and near-equal width read
 *    as a wall you scan letter by letter. Navigation is not a label; it is a set of
 *    names. Sentence-case Archivo at 12.5px gives each item its own silhouette, which
 *    is what the eye actually uses to find "Deposits" in a row of ten.
 *
 * 2. A SLIDING UNDERLINE, NOT A FILLED PILL. The pill was the loudest object in the
 *    bar and it marked a position rather than offering an action — a button shape for
 *    a thing you cannot press twice. One shared 1px underline slides between items
 *    instead, so the motion carries the information the pill only asserted: where you
 *    were, and where you are now. It is measured off the live element rather than
 *    animated per item, which is also what stops ten transitions firing at once.
 *
 * 3. SEPARATORS THAT MEAN SOMETHING. The page has four movements — the product, the
 *    two objections, the commercial case, the diligence — and the rail was flattening
 *    them into ten equal peers. A hairline between groups is not decoration; it is the
 *    only place in the rail where structure is visible, and it costs one pixel.
 *
 * 4. THE BOTTOM BORDER IS THE PROGRESS LINE. A sticky bar already draws a rule under
 *    itself; filling that rule from the left as the reader descends turns a border
 *    that was doing nothing into the answer to "how much of this is left". No extra
 *    element, no bar across the top of the viewport, nothing new on screen.
 *
 * The active mark is an IntersectionObserver rather than a scroll handler: the
 * question "which section am I in" is exactly what the observer answers, and it
 * answers it off the main thread. The band is the middle of the viewport so the mark
 * changes when a section takes over the screen, not when its first pixel appears.
 *
 * The mark is ACHROMATIC — brighter ink and a white hairline, not a green underline.
 * Green means bid on this page and a navigation item has no side.
 *
 * It renders its full markup on the server with the first item marked, so the bar is
 * correct before hydration and only the highlight and the progress line are
 * JavaScript.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ARCHIVO, DIM, HI, L2 } from "@/lib/theme";

import { Wrap, css as s } from "./primitives";

/*
 * Document order, and it has to STAY document order: the observer resolves two
 * simultaneously-visible sections by their position in this list, so a rail that
 * disagrees with the page marks the wrong one.
 *
 * `group` is the page movement each section belongs to — see Tape.tsx, which draws
 * the same four divisions in the page body. A change of group draws a separator.
 *
 * NOT EVERY SECTION IS IN HERE, and the ceiling is the reason. The bar scrolls
 * horizontally so it can never wrap — that is what makes it safe to pin — but a bar
 * that scrolls on a desktop is a bar whose last item is invisible to someone who does
 * not know to drag it. Quick start is a beat between two dense sections, and
 * what-you-get and build-vs-deploy are read on the way past rather than navigated to.
 *
 * A rail item is also a claim that a section exists: `status` once pointed at a
 * section that had been deleted, `getElementById` returned null, the filter dropped
 * it, and the link sat there scrolling nowhere.
 */
const ITEMS: { id: string; label: string; group: number }[] = [
  { id: "terminal", label: "The product", group: 1 },
  { id: "console", label: "The console", group: 1 },
  { id: "deposits", label: "Deposits", group: 1 },
  { id: "how", label: "How it works", group: 2 },
  { id: "capabilities", label: "Capabilities", group: 2 },
  { id: "customize", label: "Customization", group: 2 },
  { id: "earnings", label: "Economics", group: 3 },
  { id: "stack", label: "The stack", group: 3 },
  { id: "dx", label: "Testing", group: 3 },
  { id: "enterprise", label: "Enterprise", group: 3 },
  { id: "faq", label: "FAQ", group: 4 },
];

/*
 * Scroll the strip horizontally so `el` is visible in it. One axis, one element.
 *
 * NOT `scrollIntoView`. That walks every scrollable ancestor including the
 * document, so it also scrolls the *page* until the strip itself is in view —
 * and `block: "nearest"` does not save you, because at scroll 0 the strip sits
 * below the fold and "nearest" is therefore "scroll down to it". This bar
 * renders directly after the hero, so the effect on mount was that the landing
 * page loaded and immediately jumped the reader to the bottom of the hero.
 *
 * `console-nav.tsx` hit the identical bug and documents the identical fix.
 */
function revealInStrip(track: HTMLElement | null, el: HTMLElement) {
  if (!track) return;
  /* No overflow means nothing to reveal — the desktop case, where this is a
     no-op rather than a scroll of zero pixels. */
  if (track.scrollWidth <= track.clientWidth) return;
  const target = el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2;
  track.scrollLeft = Math.max(0, Math.min(target, track.scrollWidth - track.clientWidth));
}

export function SubNav() {
  const [active, setActive] = useState(ITEMS[0].id);
  const trackRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  /* The underline's geometry, in track coordinates. Width 0 until measured, so the
     server render has no misplaced mark to correct on hydration. */
  const [mark, setMark] = useState({ x: 0, w: 0 });

  /* Measure after paint, not during render: the label widths depend on the font, and
     a layout effect is the hook that runs once the browser has one. */
  useLayoutEffect(() => {
    const el = linkRefs.current.get(active);
    const track = trackRef.current;
    if (!el || !track) return;
    setMark({ x: el.offsetLeft, w: el.offsetWidth });

    /* Keep the marked item visible in the strip. On a phone the active section is
       routinely off the left edge, and a highlight nobody can see is a highlight that
       is not doing its job. */
    revealInStrip(track, el);
  }, [active]);

  /* Re-measure on resize — the labels reflow and a stale underline is worse than
     none, because it points at the wrong name rather than at nothing. */
  useEffect(() => {
    const onResize = () => {
      const el = linkRefs.current.get(active);
      if (el) setMark({ x: el.offsetLeft, w: el.offsetWidth });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

  useEffect(() => {
    const nodes = ITEMS.map((i) => document.getElementById(i.id)).filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return;

    /* Visibility is tracked as a set and resolved in document order, because two
       short sections can straddle the band at once and "the last callback wins"
       makes the mark jump backwards on an upward scroll. */
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = ITEMS.find((i) => visible.has(i.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-40% 0px -45% 0px" },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  /*
   * Reading progress, written to a custom property the stylesheet scales the bottom
   * border by. rAF-coalesced because scroll fires far more often than it paints, and
   * a passive listener so it can never delay the scroll itself.
   */
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const el = navRef.current;
      if (!el) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      el.style.setProperty("--nx-read", p.toFixed(4));
    };
    const onScroll = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  /* Smooth scrolling is opted into here rather than in globals.css — the terminal
     shares that stylesheet and a trading screen has no business animating a jump.
     The reduced-motion check is manual for the same reason: the CSS media query
     cannot reach a scroll call made in JavaScript. */
  const jump = useCallback((e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    /* The hash is still written, so a jump remains linkable and the back button works. */
    history.replaceState(null, "", `#${id}`);
    setActive(id);
  }, []);

  return (
    <nav ref={navRef} aria-label="Sections" className={s.rail}>
      <Wrap style={{ position: "relative" }}>
        {/* The scroller. Its own element rather than the Wrap, so the edge fades can
            sit on the Wrap and stay put while the content moves under them. */}
        <div ref={trackRef} className={s.railTrack}>
          {ITEMS.map((it, i) => {
            const on = it.id === active;
            const opensGroup = i > 0 && it.group !== ITEMS[i - 1]!.group;
            return (
              <a
                key={it.id}
                ref={(node) => {
                  if (node) linkRefs.current.set(it.id, node);
                  else linkRefs.current.delete(it.id);
                }}
                href={`#${it.id}`}
                onClick={(e) => jump(e, it.id)}
                aria-current={on ? "true" : undefined}
                className={s.railItem}
                style={{
                  fontFamily: ARCHIVO,
                  /* DIM, not FAINT. FAINT measures 4.78:1 on the opaque chrome, which
                     clears AA by a hair — and this bar is translucent, so a panel
                     scrolling under it lifts the effective background and eats that
                     margin. DIM is 5.56:1 and survives whatever passes beneath. */
                  color: on ? HI : DIM,
                  fontWeight: on ? 600 : 500,
                  /* The separator is a left border on the item that opens a movement,
                     plus the margin that gives the division room to read. */
                  borderLeft: opensGroup ? `1px solid ${L2}` : undefined,
                  marginLeft: opensGroup ? 12 : 0,
                  paddingLeft: opensGroup ? 20 : 10,
                }}
                onFocus={(e) => revealInStrip(trackRef.current, e.currentTarget)}
              >
                {it.label}
              </a>
            );
          })}

          {/* One underline for the whole rail, moved rather than redrawn. Inside the
              scroller so it travels with the content for free. */}
          <span
            aria-hidden="true"
            className={s.railMark}
            style={{ transform: `translateX(${mark.x}px)`, width: mark.w, opacity: mark.w ? 1 : 0 }}
          />
        </div>
      </Wrap>
    </nav>
  );
}
