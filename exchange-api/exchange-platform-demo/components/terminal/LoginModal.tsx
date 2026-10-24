"use client";

/*
 * The wallet picker — `session=pending`.
 *
 * Structure from a captured screenshot of the reference venue's desktop login
 * surface: a centred modal, the venue mark, "Log in or sign
 * up", a short list of named wallets, an "Other wallets" escape hatch, and a
 * "Protected by …" attribution line at the bottom. Theirs is Privy-backed; the shape is
 * the same whichever connector you put behind it, which is the whole reason it is worth
 * specifying separately from the vendor.
 *
 * Two details of theirs worth copying, and one worth not:
 *
 *   · The detected wallet is marked. Theirs shows a green dot on the icon and a "Last
 *     used" chip. A picker that lists five wallets with no indication of which one you
 *     have is a quiz.
 *   · The attribution line is at the bottom, small. Whoever ends up behind this, the
 *     reader is entitled to know who is handling their signature.
 *   · NOT copied: their modal is centred at every width. Ours becomes a sheet on a
 *     phone, like every other modal in this app — see FeeModals for why a centred
 *     dialog on a phone has no origin.
 */

import { useHotkey } from "@/hooks/useHotkey";
import {
  ARCHIVO,
  DIM,
  FAINT,
  GREEN,
  HI,
  L1,
  L2,
  L3,
  MONO,
  MUT,
  PANEL,
  R_LG,
  R_MD,
  R_XL,
  SUNK,
  TXT,
  TAP_PRIMARY,
  monoLabel,
} from "@/lib/theme";

type Wallet = {
  id: string;
  name: string;
  /** A single glyph stands in for the wallet's mark. No third-party logos in the repo. */
  glyph: string;
  tint: string;
  /** Detected in this browser — the thing that makes a picker a shortlist. */
  detected?: boolean;
  /** The last one used on this device. Theirs surfaces it; it is the fastest path. */
  lastUsed?: boolean;
};

const WALLETS: Wallet[] = [
  { id: "metamask", name: "MetaMask", glyph: "🦊", tint: "#f6851b", detected: true, lastUsed: true },
  { id: "phantom", name: "Phantom", glyph: "◍", tint: "#ab9ff2", detected: true },
  { id: "coinbase", name: "Coinbase Wallet", glyph: "◉", tint: "#0052ff" },
  { id: "walletconnect", name: "Other wallets", glyph: "▦", tint: "#3b99fc" },
];

export function LoginModal({
  open,
  onClose,
  onConnect,
  compact = false,
}: {
  open: boolean;
  onClose: () => void;
  onConnect: () => void;
  compact?: boolean;
}) {
  useHotkey("Escape", onClose);
  if (!open) return null;

  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden="true"
        className={compact && !reduced ? "nx-scrim" : undefined}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.72)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Log in or sign up"
        className={reduced ? undefined : compact ? "nx-sheet" : "nx-dialog"}
        style={{
          position: "fixed",
          zIndex: 71,
          ...(compact
            ? { left: 0, right: 0, bottom: 0, borderRadius: `${R_XL}px ${R_XL}px 0 0` }
            : {
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: 380,
                maxWidth: "94vw",
                borderRadius: R_LG,
              }),
          background: PANEL,
          border: `1px solid ${L3}`,
          boxShadow: "0 30px 80px rgba(0,0,0,0.86)",
          padding: compact ? "10px 18px 26px" : "22px 22px 18px",
        }}
      >
        {compact && (
          <div
            aria-hidden="true"
            style={{ width: 36, height: 4, borderRadius: 2, background: L3, margin: "0 auto 16px" }}
          />
        )}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: 32,
            height: 32,
            border: "none",
            background: "transparent",
            color: DIM,
            fontFamily: MONO,
            fontSize: 15,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ✕
        </button>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginBottom: 18 }}>
          <div
            aria-hidden="true"
            style={{
              width: 62,
              height: 62,
              borderRadius: 14,
              border: `1px solid ${L2}`,
              background: SUNK,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: ARCHIVO,
              fontWeight: 800,
              fontSize: 22,
              letterSpacing: "0.12em",
              color: GREEN,
            }}
          >
            NX
          </div>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: 17, color: HI }}>Log in or sign up</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {WALLETS.map((w) => (
            <button
              key={w.id}
              /* Every option connects the same mock session. Which wallet was chosen is
                 the vendor's business; what this specifies is that all four paths land
                 in `session=in` and nothing else about the app branches on it. */
              onClick={onConnect}
              className="nx-hover-border"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minHeight: TAP_PRIMARY,
                padding: "0 12px",
                border: `1px solid ${L2}`,
                borderRadius: R_MD,
                background: SUNK,
                color: TXT,
                cursor: "pointer",
                textAlign: "left",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <span style={{ position: "relative", flex: "0 0 auto" }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: `${w.tint}1f`,
                    border: `1px solid ${w.tint}44`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 15,
                  }}
                >
                  {w.glyph}
                </span>
                {/* Detected in this browser. Theirs marks it the same way, and without
                    it a list of four wallets is a quiz rather than a shortlist. */}
                {w.detected && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: -2,
                      right: -2,
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: GREEN,
                      border: `1.5px solid ${PANEL}`,
                    }}
                  />
                )}
              </span>
              <span style={{ flex: 1, fontFamily: ARCHIVO, fontSize: 13.5 }}>
                {w.name}
                {w.detected && <span style={{ ...monoLabel(8.5), color: FAINT, marginLeft: 8 }}>detected</span>}
              </span>
              {w.lastUsed && (
                <span
                  style={{
                    ...monoLabel(8.5, "0.06em"),
                    color: MUT,
                    background: L1,
                    border: `1px solid ${L2}`,
                    borderRadius: 5,
                    padding: "2px 6px",
                  }}
                >
                  last used
                </span>
              )}
            </button>
          ))}
        </div>

        {/*
         * Two lines of honesty, and they are the reason this modal is worth building
         * rather than faking with a button that flips a boolean.
         *
         * The first says who handles the signature — the reader is entitled to know, and
         * theirs says it too. The second says this venue never asks for a seed phrase,
         * which is the single most useful sentence any wallet-connect screen can carry.
         */}
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
          <span style={{ ...monoLabel(9, "0.06em"), color: FAINT }}>
            SIGNATURE HANDLED BY YOUR WALLET · <span style={{ color: MUT }}>NEXUS NEVER SEES YOUR KEYS</span>
          </span>
          <span style={{ fontFamily: ARCHIVO, fontSize: 10.5, color: FAINT, textAlign: "center" }}>
            Connecting signs a message to prove the address is yours. It does not move funds.
          </span>
        </div>
      </div>
    </>
  );
}
