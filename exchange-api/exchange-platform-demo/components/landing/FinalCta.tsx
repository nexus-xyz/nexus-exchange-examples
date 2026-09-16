/*
 * The closing call to action.
 *
 * Three steps, and the first two need nothing from us — no key, no call, no
 * approval. That ordering is the argument: a platform whose first step is "book a
 * demo" is asking for trust before it has given any. The sales conversation belongs
 * at step three, where the money is.
 *
 * NO 01 / 02 / 03 HERE EITHER. The numbers were the least interesting column in the
 * table; what the reader is actually scanning for is whether a step requires us. So
 * that is the column, set in the label voice, and the two steps that need nothing
 * say so twice as loudly by saying it identically.
 */

import { CHROME, DIM, FAINT, L1, L2, TXT } from "@/lib/theme";

import { Band, Code, Cta, css as s, body, display, eyebrow } from "./primitives";

/*
 * The commands, and the fourth block is not a footnote.
 *
 * Three sections of this page claim the exchange is legible to an agent — the
 * capability row, the client tabs, the MCP endpoint — and the one place a reader is
 * told what to actually type ended at `nexus deploy`. Somebody who works by handing
 * a task to a coding agent had to infer that the llms.txt and the MCP server they
 * read about earlier are the way in. Two lines, and the claim becomes an
 * instruction.
 */
const START = [
  "[dim]# 1 — install the SDK, hit the public surface, no key required",
  "$ npm i @nexus-xyz/exchange-ts",
  "",
  "[dim]# 2 — scaffold a branded venue and run it on your own machine",
  "$ npx create-nexus-venue my-venue",
  "$ cd my-venue && npm run dev",
  "",
  "[dim]# 3 — point it at the shared book and deploy where you like",
  "$ NEXUS_NETWORK=testnet npm run build",
  "",
  "[dim]# or hand the whole thing to an agent — the docs are machine-readable",
  "$ curl api.nexus.xyz/llms.txt",
  "$ npx @nexus-xyz/exchange-mcp",
];

/**
 * Titles and the needs-column only. Each step used to carry a `body` sentence, and the
 * code block beside them renders its own comments as page text — "# 1 — install the SDK,
 * hit the public surface, no key required" and so on. The three cards then said the same
 * three things in prose, side by side with them. What the block is actually for is the
 * needs column: two of the three steps need nothing from us.
 */
const STEPS: { title: string; needs: string; open: boolean }[] = [
  { title: "Read the contract", needs: "needs nothing from us", open: true },
  { title: "Stand a venue up locally", needs: "needs nothing from us", open: true },
  { title: "Point it at the shared book", needs: "talk to us", open: false },
];

export function FinalCta() {
  return (
    <Band id="start" tone="raised">
      <div className={s.split}>
        <div>
          <div style={{ ...eyebrow(DIM), marginBottom: 20 }}>Start</div>
          <h2 style={display.lg}>The first two steps need nothing from us.</h2>
          <p style={{ ...body, fontSize: 15, marginTop: 20, maxWidth: "44ch" }}>
            Read the contract, run a branded venue on your own machine, and only then ask us for a builder code. If the
            platform
            is any good you should be able to evaluate most of it before we know your name.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 28 }}>
            <Cta href="https://docs.nexus.xyz" label="Read the docs" />
            <Cta href="/trade" label="Open the terminal" variant="secondary" />
            <Cta href="/admin" label="View the console" variant="secondary" />
          </div>

          <Code title="ninety seconds" lines={START} lang="bash" style={{ marginTop: 28 }} />
        </div>

        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <div style={{ border: `1px solid ${L2}`, borderRadius: 8, overflow: "hidden", background: CHROME }}>
            {STEPS.map((step, i) => (
              <div
                key={step.title}
                className={s.rowHover}
                style={{ padding: "14px 16px", borderTop: i === 0 ? undefined : `1px solid ${L1}` }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 7 }}>
                  <span style={{ ...display.xs, fontSize: 14 }}>{step.title}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      ...eyebrow(step.open ? TXT : FAINT),
                      fontSize: 9,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {step.needs}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {/* The "only the exchange CLI ships today" caveat was said in three places. It
              survives in Testing, which also names what does exist, and in Quick start. */}
        </div>
      </div>
    </Band>
  );
}
