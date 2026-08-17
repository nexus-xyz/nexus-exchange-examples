"use client";

/*
 * The controls with a consequence.
 *
 * Everything else in this console reads. These four write, and each one is framed
 * by what it does to a trader who is mid-position — because that is the fact an
 * operator needs at the moment they reach for the control, not in a runbook.
 *
 * Two design rules, both from PACKAGING.md §5 and §6:
 *
 *   THE TEST-USDX CONTROL IS ABSENT ON MAINNET, NOT DISABLED. Test USDX is a
 *   testnet instrument. A greyed-out button implies the control exists on mainnet
 *   and is merely unavailable to you, which is a worse lie than saying nothing. So
 *   the control is derived from the network value and simply is not rendered on
 *   live.
 *
 *   HALT AND CANCEL-ALL ARE SEPARATE. Halting stops new orders; cancelling
 *   withdraws resting ones. An operator reaching for one usually wants exactly one
 *   of them, and a combined "emergency stop" would take the choice away — most
 *   incidents want the halt without wiping every maker quote on the book.
 *
 * Each control posts to /api/admin/actions and prints the response, so what an
 * operator sees after a halt is the API's own account of what changed — not this
 * component's guess at it.
 */

import { useState, type ReactNode } from "react";

import { L1, MUT, TXT, titleLabel } from "@/lib/theme";
import { ActionButton, ConfirmAction, postAdmin } from "./interactive";
import { SIZE, body } from "./type";
import { Pill } from "./shell";

export function OpsControls({ env, openOrders }: { env: "test" | "live"; openOrders: number | null }) {
  const [halted, setHalted] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Control
        title={halted ? "Resume order acceptance" : "Halt order acceptance"}
        status={halted ? <Pill tone="bad">HALTED</Pill> : <Pill tone="good">ACCEPTING</Pill>}
      >
        <ConfirmAction
          label={halted ? "RESUME VENUE" : "HALT VENUE"}
          phrase={halted ? "RESUME" : "HALT"}
          danger={!halted}
          consequence={
            halted ? (
              <>
                New orders start being accepted again immediately. Nothing about open positions changes — they
                were never affected by the halt.
              </>
            ) : (
              <>
                Your venue stops accepting new orders <strong style={{ color: TXT }}>immediately</strong>. Open
                positions stay open and keep accruing funding, and existing resting orders stay on the book and
                can still fill. This stops the flow; it does not flatten anybody.
              </>
            )
          }
          onConfirm={async () => {
            const message = await postAdmin("/api/admin/actions", { action: halted ? "resume" : "halt" });
            setHalted((h) => !h);
            return message;
          }}
        />
      </Control>

      <Control
        title="Cancel every open order"
        status={openOrders === null ? <Pill tone="mute">COUNT UNKNOWN</Pill> : <Pill tone="mute">{openOrders} open</Pill>}
      >
        <ConfirmAction
          label="CANCEL ALL ORDERS"
          phrase="CANCEL ALL"
          danger
          consequence={
            <>
              Withdraws every resting order this venue has on the book, across all markets, in one call. It does
              not close positions and it does not stop new orders — a market maker whose quotes you cancel can
              and will replace them a second later.{" "}
              <strong style={{ color: TXT }}>Halt first if you mean to stop the flow.</strong>
            </>
          }
          onConfirm={() => postAdmin("/api/admin/actions", { action: "cancel-all" })}
        />
      </Control>

      {/* Derived from the network, not disabled by it — see the header note. */}
      {env === "test" && (
        <Control title="Claim testnet USDX" status={<Pill tone="good">TESTNET ONLY</Pill>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span style={{ ...body(SIZE.body, 1.6), color: MUT }}>
              Credits test USDX to the venue&apos;s testnet account, for exercising the order path against a
              balance that is not a trader&apos;s. Testnet keeps its own balances, so nothing here touches
              mainnet collateral.
            </span>
            <ActionButton label="CLAIM FAUCET" onRun={() => postAdmin("/api/admin/actions", { action: "faucet", env })} />
          </div>
        </Control>
      )}
    </div>
  );
}

function Control({
  title,
  status,
  children,
}: {
  title: string;
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 16, borderBottom: `1px solid ${L1}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ ...titleLabel(SIZE.title, 600), color: TXT }}>{title}</span>
        {status}
      </div>
      {children}
    </div>
  );
}

/*
 * OpsStatusNote removed. It labelled the whole panel with a build status and then
 * listed what each control was waiting on. Each control now states its own
 * consequence, which is the only thing an operator reads at the moment they reach
 * for one.
 */
