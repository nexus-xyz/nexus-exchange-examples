"use client";

/*
 * When a console page throws.
 *
 * The default Next error screen is a blank page in production, which for an
 * operator surface is the worst possible answer — it is indistinguishable from a
 * venue that has gone quiet. This says which of the two it is and offers the
 * retry, because a failed upstream read usually succeeds on the second attempt.
 *
 * The sidebar is still there and this file no longer draws it. An error boundary
 * sits INSIDE its segment's layout, so `app/admin/layout.tsx` — and therefore the
 * whole shell — survives a page that throws. That is also why the shell must not
 * be constructed here any more: it would render a second console inside the
 * first.
 *
 * The digest is shown deliberately. It is the only handle a developer has to find
 * the corresponding server log, and hiding it costs an operator the one piece of
 * information worth pasting into a bug report.
 */

import { PageHead, Panel, primaryButtonStyle } from "@/components/admin/shell";
import { ErrorState, ARCHIVO, FAINT, MUT } from "@/components/admin/parts";
import { SIZE, body } from "@/components/admin/type";

export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <PageHead
        title="This page did not render"
        blurb="The console failed, which is not the same as the venue failing. Your traders are unaffected by anything on this screen — the operator surface and the order path share no process."
      />

      <Panel title="What happened">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ErrorState
            title={error.message || "An unhandled error"}
            detail={error.digest ? `digest ${error.digest}` : "no digest — this build has stack traces enabled"}
            retry={
              <button type="button" style={primaryButtonStyle} onClick={reset}>
                RETRY
              </button>
            }
          />
          <p style={{ ...body(SIZE.body, 1.65), color: MUT, margin: 0 }}>
            Most failures here are an upstream read that timed out. If the retry works, it was transient. If it
            does not, check whether the venue answers at all — the Overview header carries the health pill and
            the round-trip, and both are read on every request.
          </p>
          <span style={{ ...body(SIZE.note, 1.55), color: FAINT, lineHeight: 1.6 }}>
            Nothing on this page mutated anything. The console&apos;s reads are all GETs, so a failed render
            cannot have left a venue half-changed.
          </span>
        </div>
      </Panel>
    </>
  );
}
