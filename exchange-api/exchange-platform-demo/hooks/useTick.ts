"use client";

import { useEffect, useState } from "react";

/**
 * The terminal's single clock. Every "live" panel derives from this one counter
 * rather than holding its own interval, so the whole screen advances in one
 * frame and there is exactly one timer to reason about.
 *
 * Starts at 0 on both server and client — the first paint matches the SSR output,
 * and motion begins after mount.
 */
export function useTick(ms = 1100): number {
  const [tick, setTick] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);

  /*
   * `?tick=N` freezes the clock. The capture harness pins it so that two captures
   * of the same state are byte-comparable — without this, every visual diff is
   * animation noise and regression detection is impossible.
   *
   * Read on mount rather than during render: reading the URL while rendering
   * would make the server and client disagree.
   */
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("tick");
    if (raw === null) return;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) setPinned(Math.floor(n));
  }, []);

  useEffect(() => {
    if (pinned !== null) return;
    const iv = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(iv);
  }, [ms, pinned]);

  return pinned ?? tick;
}
