"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A one-shot up/down flash when a number changes.
 *
 * `nxflash-up` and `nxflash-down` have been in globals.css since the beginning and
 * were applied to nothing — every figure on the screen changed silently. On a
 * trading surface that is not a missing flourish, it is missing information: the
 * direction of the last move is the cheapest signal a price can carry, and a
 * terminal that repaints a number with no acknowledgement makes the trader diff it
 * against their own memory.
 *
 * Returns a `key`-able class name. `null` on the very first render, so nothing
 * flashes on mount — arriving at a screen is not a price move, and a wall of green
 * on load would teach the eye to ignore the signal.
 */
export function useFlash(value: number | null | undefined, enabled = true): string | undefined {
  const prev = useRef<number | null | undefined>(undefined);
  const [cls, setCls] = useState<string | undefined>(undefined);
  /* The class has to be REMOVED and re-added for the animation to restart, and two
     changes inside one animation window must not stack. A counter in the key does
     that without a timer per flash. */
  const [, bump] = useState(0);

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (!enabled) return;
    if (before === undefined || before === null || value === null || value === undefined) return;
    if (value === before) return;
    setCls(value > before ? "nx-flash-up" : "nx-flash-down");
    bump((n) => n + 1);
    const t = setTimeout(() => setCls(undefined), 520);
    return () => clearTimeout(t);
  }, [value, enabled]);

  return cls;
}
