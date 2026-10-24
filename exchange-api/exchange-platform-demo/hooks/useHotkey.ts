"use client";

import { useEffect } from "react";

/**
 * Binds a single key, optionally with ⌘/Ctrl. Used for the command palette (⌘K)
 * and its Escape dismissal — the terminal is pitched as keyboard-first, so the
 * shortcuts shown in the chrome have to actually work.
 */
export function useHotkey(
  key: string,
  handler: () => void,
  { meta = false }: { meta?: boolean } = {},
): void {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      if (meta && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [key, handler, meta]);
}
