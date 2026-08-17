"use client";

/*
 * Bottom status bar: network, transport, session, build, and the reference links.
 *
 * Cheap to build and it does a lot of work — a persistent readout of what you are
 * connected to is what separates a trading terminal from a dashboard. It also gives
 * the shortcuts sheet and the docs a permanent home instead of hiding them in a menu.
 */

import {
  R_SM, MONO, GREEN, RED, AMBER, L2, MUT, DIM, FAINT } from "@/lib/theme";

const LINKS = ["Changelog", "Status", "Docs", "Terms", "Privacy"];

function Indicator({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flex: "0 0 auto" }} />
      <span style={{ color: MUT }}>{label}</span>
    </span>
  );
}

export function StatusBar({
  fillsPerSec,
  latencyMs,
  compact = false,
}: {
  fillsPerSec: number;
  latencyMs: number;
  compact?: boolean;
}) {
  const latColor = latencyMs < 40 ? GREEN : latencyMs < 120 ? AMBER : RED;
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: compact ? 10 : 18,
        padding: "0 14px",
        // The bar itself must not be the thing that overflows a 390px viewport.
        overflow: "hidden",
        borderTop: `1px solid ${L2}`,
        background: "#030303",
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: "0.04em",
      }}
    >
      <Indicator label="TESTNET" color={GREEN} />
      <Indicator label="WEBSOCKET" color={GREEN} />
      {!compact && <Indicator label="WALLET CONNECTED" color={GREEN} />}
      {!compact && (
        <>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: FAINT }}>RTT</span>
            <span style={{ color: latColor }}>{latencyMs}ms</span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: FAINT }}>ENGINE</span>
            <span style={{ color: GREEN }}>{fillsPerSec.toFixed(1)} fills/s</span>
          </span>
          <span style={{ color: DIM }}>build 19d0b</span>
        </>
      )}

      <div style={{ flex: 1 }} />

      {!compact && (
        <span style={{ display: "flex", alignItems: "center", gap: 6, color: MUT }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 9.5,
              background: "#131313",
              border: `1px solid ${L2}`,
              borderRadius: R_SM,
              padding: "1px 5px",
            }}
          >
            ⌘/
          </span>
          Shortcuts
        </span>
      )}
      {/* Not at compact. Five links plus the indicators measured scrollWidth 597 in a
          390px viewport, which is most of the root's 207px horizontal overflow. The
          reference drops its footer at mobile too. */}
      {!compact &&
        LINKS.map((l) => (
          <span key={l} className="nx-hover-text" style={{ color: DIM, cursor: "pointer" }}>
            {l}
          </span>
        ))}
    </div>
  );
}
