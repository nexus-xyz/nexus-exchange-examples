"use client";

/*
 * The hero's product stage.
 *
 * WHAT THE INTERACTION IS FOR. A still of a dense trading UI reads as a picture of
 * software. The same still that leans toward the cursor and catches light as it
 * moves reads as a surface — and a reader who has moved something is a reader who
 * has engaged with it. That is the whole justification; there is no information in
 * the tilt, so it stays small enough to feel like material rather than a toy.
 *
 * WHY POINTER MATH AND NOT A LIBRARY. Six lines of arithmetic against the element's
 * own rect, written straight to CSS custom properties. The transform lives in the
 * stylesheet, so the component decides WHERE the cursor is and the CSS decides what
 * that looks like — which is also what lets `prefers-reduced-motion` switch the
 * whole thing off in one rule rather than in a branch here.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO.
 *
 * It does not animate on touch. `(hover: hover) and (pointer: fine)` gates every
 * rule; a tilt bound to a finger is a smudge that fights scrolling.
 *
 * It does not run on a timer. Every frame is a pointer event the reader caused, so
 * an idle hero costs nothing and a backgrounded tab does no work.
 *
 * It does not overlay fake activity. A pulsing dot or a scrolling ticker painted on
 * top of a screenshot would be inventing live data on a still — and this page's
 * whole argument is that the captures are the running product at a frozen tick.
 * The light moves; the numbers do not.
 */

import { useCallback, useRef } from "react";

import { css as s } from "./primitives";

export function HeroStage({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  /* rAF-coalesced: a pointermove can fire many times per frame, and writing a
     custom property on each one is layout thrash for frames nobody sees. */
  const frame = useRef<number | null>(null);
  const next = useRef({ x: 0.5, y: 0.5 });

  const flush = useCallback(() => {
    frame.current = null;
    const el = ref.current;
    if (!el) return;
    const { x, y } = next.current;
    el.style.setProperty("--px", x.toFixed(4));
    el.style.setProperty("--py", y.toFixed(4));
  }, []);

  const onMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      /* Normalised to 0..1 across the element, so the CSS can express the tilt as a
         fraction of a maximum and never needs to know the element's size. */
      next.current = {
        x: (event.clientX - rect.left) / Math.max(1, rect.width),
        y: (event.clientY - rect.top) / Math.max(1, rect.height),
      };
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    /* Back to centre, and the CSS transition carries it there — a snap on exit is
       the tell that a tilt is scripted rather than physical. */
    el.style.setProperty("--px", "0.5");
    el.style.setProperty("--py", "0.5");
  }, []);

  return (
    <div
      ref={ref}
      className={s.heroStage}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      /* Decorative motion only: the frame inside stays in the tab order and the
         image keeps its alt text, so nothing here is required to understand or
         operate the page. */
      aria-hidden={false}
    >
      <div className={s.heroStageInner}>
        {children}
        {/* The glare. A soft highlight tracking the cursor across the glass, drawn
            above the capture and inert to pointer events so it can never eat a
            click meant for the frame beneath it. */}
        <span className={s.heroStageGlare} aria-hidden="true" />
      </div>
    </div>
  );
}
