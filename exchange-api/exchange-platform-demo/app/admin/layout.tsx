/*
 * The console's frame, rendered once for every route under /admin.
 *
 * WHAT THIS FIXES. Thirteen pages each constructed their own `<ConsoleShell>`
 * with the same six props, and so did `loading.tsx`, `error.tsx` and the market
 * `not-found.tsx`. The duplication was the small half of the problem. The real
 * one was that a navigation replaced the ENTIRE subtree: the sidebar was
 * unmounted, the loading boundary drew a second copy of it, and then the page
 * drew a third — which is why `loading.tsx` had to become a client component
 * reading `usePathname`, just so the highlight in its throwaway sidebar landed
 * on the row you had clicked. A layout is the App Router's answer to exactly
 * this: React keeps it mounted across the route change, so the sidebar is now
 * one element with a continuous lifetime and only the content column swaps.
 *
 * WHAT IT COSTS, stated plainly. A layout is handed `children` and `params` and
 * NOT `searchParams` — verified empirically, not inferred from the docs — and
 * this console keeps its environment in `?env=live`. Env has to reach the
 * sidebar or every nav link silently drops it and lands the operator on TEST
 * data, which is the one bug this console spends its whole warning budget
 * preventing. So `components/admin/console-nav.tsx` reads the URL from the
 * client, and the static chrome (wordmark, section headings, the operating
 * entity) is passed into it as server-rendered nodes. That file's header comment
 * carries the full reasoning.
 *
 * The tenant is a build-time constant, so this layout has no data to await and
 * never blocks the page's own read.
 */

import type { ReactNode } from "react";

import { ACTIVE_TENANT } from "@/lib/tenant";
import { ConsoleShell } from "@/components/admin/shell";

/*
 * The sidebar reads `useSearchParams()`, which forces its subtree to render at
 * request time. Declaring it here is the honest version of a fact that is
 * already true of every page under this layout — all thirteen are
 * `force-dynamic`, because each one reads the live testnet.
 */
export const dynamic = "force-dynamic";

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <ConsoleShell wordmark={ACTIVE_TENANT.wordmark} entity={ACTIVE_TENANT.legal.entity}>
      {children}
    </ConsoleShell>
  );
}
