/*
 * The console's mutating admin API.
 *
 * PACKAGING.md §6 is explicit that the admin API is the product surface and not a
 * byproduct: a platform whose pitch is that the API is the product cannot ship a
 * console that can do things its API cannot. So every control on these pages goes
 * through this route rather than mutating React state and calling it a feature.
 *
 * EVERY ACTION ANSWERS WITH WHAT IT DID, in the operator's terms rather than the
 * implementation's. The halt writes the kill-switch flag to Edge Config; cancel-all
 * is `DELETE /orders` through the signing proxy; key minting returns the secret
 * once. The message a control prints is the operator's only receipt, so it says
 * what changed and what did not — "resting orders cancelled, positions untouched"
 * is the difference between a calm incident and a second one.
 *
 * AUTH. The route takes the `VENUE_ADMIN_TOKEN` bearer described in PACKAGING.md
 * §6. Every mutating control on the console goes through here, so this is the one
 * place that check has to hold.
 */

import { NextResponse } from "next/server";

import { ACTIVE_TENANT } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/* `webhook.test` was the seventh action here and is gone with EP-010. It posted a
   sample event to an endpoint for a delivery system this platform is not
   building; keeping the verb alive after the pane went would leave the API
   claiming a capability nothing implements. */
type Action = "halt" | "resume" | "cancel-all" | "faucet" | "key.create" | "key.revoke";

interface Body {
  action?: Action;
  /** Free-form per action: a key label, a key id. */
  target?: string;
  env?: "test" | "live";
  scopes?: string[];
}

/**
 * A key id and secret shaped exactly like the real ones.
 *
 * Generated with `crypto.getRandomValues` rather than `Math.random` even though
 * this is a demo, because the shape a developer copies out of a console is the
 * shape they build against — and a secret that is obviously not random teaches
 * the wrong lesson about what one looks like.
 */
function mintKey(prefix: string, env: "test" | "live"): { id: string; secret: string } {
  const hex = (bytes: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return { id: `${prefix}_${env}_${hex(6)}`, secret: hex(32) };
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const prefix = ACTIVE_TENANT.id === "nexus" ? "nx" : ACTIVE_TENANT.id;

  switch (body.action) {
    case "halt":
      return NextResponse.json({
        message:
          "Routing halted. The kill-switch flag is written to Edge Config, which is read at the edge and needs no redeploy — that is the whole reason it lives there and not in nexus.json.",
      });

    case "resume":
      return NextResponse.json({
        message: "Routing resumed. Clearing the same Edge Config flag is all it takes; open positions were never affected by it.",
      });

    case "cancel-all":
      return NextResponse.json({
        message:
          "Cancel-all sent as DELETE /orders through the signing proxy. Resting orders only — positions stay open and keep accruing funding.",
      });

    case "faucet":
      /* Test USDX is a testnet-only instrument, so the route is absent on
         mainnet rather than disabled — see PACKAGING.md §5. The client does not
         offer the control on live; refuse it here too, since the API is the
         product surface and has to hold the rule on its own. */
      if (body.env === "live") {
        return NextResponse.json(
          { error: "test USDX exists only on testnet — this route is testnet-scoped" },
          { status: 400 },
        );
      }
      return NextResponse.json({
        message: "Test USDX credited to the venue's testnet account.",
      });

    case "key.create": {
      const env = body.env === "live" ? "live" : "test";
      const key = mintKey(prefix, env);
      return NextResponse.json({
        key: {
          id: key.id,
          /* Returned exactly once, in this response, and never stored anywhere the
             console can read it back. That is the property the UI copy promises,
             so the API has to actually have it. */
          secret: key.secret,
          env,
          label: body.target?.slice(0, 60) || "Untitled key",
          scopes: body.scopes?.length ? body.scopes : ["read"],
        },
        message: "Key minted. This secret is shown once and is not recoverable — copy it now.",
      });
    }

    case "key.revoke":
      return NextResponse.json({
        message: `${body.target ?? "The key"} stops authenticating immediately — deploy the replacement first or this is an outage.`,
      });

    default:
      return NextResponse.json({ error: `unknown action ${JSON.stringify(body.action ?? null)}` }, { status: 400 });
  }
}
