"use client";

/*
 * Deposit.
 *
 * Built from `audit/reference/shots/account/account.deposit.desktop.png` — the one
 * account surface on the reference venue that opens without a wallet. Transfer and
 * Withdraw are `<button disabled>` there, so their contents are unknown and are not
 * guessed at; see findings.ticket.md §7.
 *
 * ASSET, THEN CHAIN. The captured list is not a list of tickers — every row is a
 * symbol over the network it arrives on (`USDC / Arbitrum`, `SOL / Solana`,
 * `VIRTUAL / Base`). That pairing is the product statement: the venue takes value
 * from wherever it already lives and settles it internally, so the thing a
 * depositor picks is not "an asset" but "this asset, on this chain". A flat ticker
 * list would lose the half that decides where they send funds.
 *
 * STEP 2 IS OURS, NOT THEIRS. Selecting a row on the reference requires a
 * connected wallet, so the address screen below is the ordinary shape every venue
 * uses — asset, network, address, minimum, confirmations — and not a capture. It
 * is marked MOCK for the same reason the price data is.
 */

import { Fragment, useMemo, useState } from "react";
import { useHotkey } from "@/hooks/useHotkey";
import { RailMark, type RailId } from "@/components/RailMarks";
import { BrandStack, type BrandId } from "@/components/BrandMarks";
import {
  ARCHIVO,
  MONO,
  GREEN,
  L1,
  L2,
  L3,
  PANEL,
  SUNK,
  TERM,
  HI,
  TXT,
  NUM,
  MUT,
  DIM,
  FAINT,
  R_MD,
  R_LG,
  R_XL,
  monoLabel,
} from "@/lib/theme";

/**
 * Supported deposit assets. MOCK — the venue's real set is a bridge configuration,
 * not something the terminal derives. USDX leads because it is the collateral every
 * market on this venue settles in; everything below it has to be converted, which is
 * a cost the ordering should reflect rather than hide.
 */
type DepositAsset = {
  symbol: string;
  chain: string;
  glyph: string;
  /** MOCK. Minimum that survives the bridge, in the asset's own units. */
  min: number;
  /** MOCK. Confirmations before the balance is credited. */
  confirmations: number;
};

const ASSETS: DepositAsset[] = [
  { symbol: "USDX", chain: "Nexus", glyph: "◈", min: 1, confirmations: 1 },
  { symbol: "USDC", chain: "Arbitrum", glyph: "$", min: 1, confirmations: 12 },
  { symbol: "BTC", chain: "Bitcoin", glyph: "₿", min: 0.0002, confirmations: 2 },
  { symbol: "ETH", chain: "Ethereum", glyph: "Ξ", min: 0.005, confirmations: 12 },
  { symbol: "SOL", chain: "Solana", glyph: "◎", min: 0.05, confirmations: 32 },
  { symbol: "ARB", chain: "Arbitrum", glyph: "◬", min: 1, confirmations: 12 },
  { symbol: "AVAX", chain: "Avalanche", glyph: "▲", min: 0.1, confirmations: 12 },
  { symbol: "TIA", chain: "Celestia", glyph: "◆", min: 1, confirmations: 6 },
  { symbol: "INJ", chain: "Injective", glyph: "τ", min: 0.5, confirmations: 6 },
  { symbol: "SUI", chain: "Sui", glyph: "◇", min: 1, confirmations: 6 },
  { symbol: "AAVE", chain: "Ethereum", glyph: "Ⓐ", min: 0.02, confirmations: 12 },
];

/**
 * MOCK deposit address, deterministic per asset+chain.
 *
 * Shaped by CHAIN, not emitted as one hex string for everything. A Bitcoin deposit
 * address that reads `0x…` is the kind of detail a trader spots in a second, and in
 * a document whose whole job is to be copied it would get built that way. Prefix
 * and alphabet per family: bech32 for Bitcoin and the Cosmos chains, base58 for
 * Solana, 20-byte hex for the EVM/Move chains.
 */
const ADDRESS_SHAPE: Record<string, { prefix: string; alphabet: string; length: number }> = {
  Bitcoin: { prefix: "bc1q", alphabet: "023456789acdefghjklmnpqrstuvwxyz", length: 38 },
  Solana: { prefix: "", alphabet: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", length: 44 },
  Celestia: { prefix: "celestia1", alphabet: "023456789acdefghjklmnpqrstuvwxyz", length: 38 },
  Injective: { prefix: "inj1", alphabet: "023456789acdefghjklmnpqrstuvwxyz", length: 38 },
};
const EVM_SHAPE = { prefix: "0x", alphabet: "0123456789abcdef", length: 40 };

function addressFor(a: DepositAsset): string {
  const shape = ADDRESS_SHAPE[a.chain] ?? EVM_SHAPE;
  let h = 2166136261;
  for (const ch of a.symbol + a.chain) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const body = Array.from({ length: shape.length }, () => {
    h = Math.imul(h ^ (h >>> 13), 16777619);
    return shape.alphabet[(h >>> 8) % shape.alphabet.length];
  }).join("");
  return shape.prefix + body;
}

function Glyph({ a }: { a: DepositAsset }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flex: "0 0 auto",
        width: 26,
        height: 26,
        borderRadius: "50%",
        border: `1px solid ${L2}`,
        background: TERM,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: MONO,
        fontSize: 12,
        color: MUT,
      }}
    >
      {a.glyph}
    </span>
  );
}

/**
 * How money gets in — the funding-method step.
 *
 * From Lighter's Halliday-backed deposit modal, screenshotted by Daniel and recorded in
 * decisions.json. The shape worth specifying is not the vendor's widget, it is the
 * decision tree it presents: destination token → CRYPTO or CASH → a method, each with
 * the two facts that actually decide it — the limit, and how long it takes.
 *
 * That pairing is the whole insight. "Transfer Crypto · No limit · Instant" against
 * "Connect Exchange · No limit · 2 min" against a card that clears in a minute but caps
 * at a few thousand: a funding screen is a latency-versus-ceiling choice, and every one
 * of these that hides the ceiling until the last step wastes the user's time.
 *
 * Wired to a provider later, each row becomes their widget. The contract this states is
 * what the app must know before handing over — token, rail, amount — and what it needs
 * back: a reference it can poll, because none of these are synchronous.
 */
type FundingRail = "crypto" | "cash";
type FundingMethod = {
  id: string;
  rail: FundingRail;
  /** The glyph, shared with the platform page's deposit row so the two agree. */
  mark: RailId;
  title: string;
  /** The ceiling. Stated up front, because it is half the decision. */
  limit: string;
  /** The wait. The other half. */
  speed: string;
  /**
   * The brands a depositor would recognise for this method. A HINT rather than a
   * catalogue — three is enough to answer "are the ones I have supported", and a
   * fourth makes the stack read as a list the reader is meant to audit.
   *
   * See components/BrandMarks.tsx for the trademark note. It matters most for the
   * bank pair, which are examples rather than integrations.
   */
  logos?: BrandId[];
  /** Prose fallback, used where a stack would be dishonest or unnecessary. */
  via?: string;
  /**
   * True where the method ends at a chain address, and therefore needs the asset
   * step. A card does not — the amount is denominated in the card's currency and the
   * asset that lands is always the collateral.
   */
  needsAsset?: boolean;
};

/*
 * SEVEN METHODS, and the split between the first two is the one worth explaining.
 * Stablecoins and other crypto both end at an address on a chain, so they are one
 * mechanism — but they are two different decisions for a depositor. Somebody holding
 * USDC wants to know their dollar arrives as a dollar; somebody holding ETH wants to
 * know it will be converted and at what cost. One row for both hid the first answer
 * behind the second.
 */
const METHODS: FundingMethod[] = [
  {
    id: "stable", rail: "crypto", mark: "stablecoin", title: "Stablecoins",
    limit: "no limit", speed: "instant", needsAsset: true,
    logos: ["usdc", "usdt", "usdx"],
  },
  {
    id: "crypto", rail: "crypto", mark: "chain", title: "Transfer crypto",
    limit: "no limit", speed: "instant", needsAsset: true,
    logos: ["btc", "eth", "sol"],
  },
  {
    id: "cex", rail: "crypto", mark: "cex", title: "From an exchange",
    limit: "no limit", speed: "~2 min", needsAsset: true,
    logos: ["binance", "coinbase", "bybit"],
  },
  {
    id: "card", rail: "cash", mark: "card", title: "Debit or credit card",
    limit: "$2,000 / day", speed: "~1 min",
    logos: ["visa", "mastercard"],
  },
  {
    id: "wallet", rail: "cash", mark: "applepay", title: "Apple Pay & Google Pay",
    limit: "$2,000 / day", speed: "~1 min",
    logos: ["applepay", "googlepay"],
  },
  {
    id: "bank", rail: "cash", mark: "ach", title: "Bank transfer",
    limit: "$50,000 / day", speed: "1–2 days",
    logos: ["chase", "mercury"],
  },
  {
    id: "wire", rail: "cash", mark: "wire", title: "Wire",
    limit: "no limit", speed: "1–3 days",
    /* No stack. A wire is not a brand you pick — it is an instruction you give your
       own bank, and any logo here would be an example masquerading as a rail. */
    via: "domestic and international",
  },
];

export function DepositModal({
  open,
  onClose,
  /*
   * A sheet on a phone, like every other modal here.
   *
   * This one was the exception, and not on purpose: it predates the modals-as-sheets
   * pass and nobody looked at it on a phone afterwards, because its capture was filed
   * against the wrong screen and never actually opened it. It rendered as a 476px card
   * floating mid-viewport over the Account sheet, with the sheet visible above and
   * below it — a dialog with no origin, which is the whole reason FeeModals became
   * sheets.
   */
  compact = false,
}: {
  open: boolean;
  onClose: () => void;
  compact?: boolean;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<DepositAsset | null>(null);
  const [method, setMethod] = useState<FundingMethod | null>(null);

  useHotkey("Escape", onClose);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return ASSETS;
    // Chain matches too: somebody holding USDC on Arbitrum searches for either half.
    return ASSETS.filter(
      (a) => a.symbol.toLowerCase().includes(t) || a.chain.toLowerCase().includes(t),
    );
  }, [q]);

  if (!open) return null;

  /* prefers-reduced-motion is honoured globally for keyframes (see globals.css), but
     the class is dropped here too so the element is not put on its own layer for an
     animation that will not run. */
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const close = () => {
    setQ("");
    setPicked(null);
    setMethod(null);
    onClose();
  };

  return (
    <>
      <div
        onClick={close}
        /* aria-hidden, like every other scrim here. Without it this is an unlabelled
           clickable div in the accessibility tree — and the popups-visible floor,
           which recognises a scrim structurally, could not tell it from page content
           covering the sheet underneath. */
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.62)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Deposit"
        className={compact ? "nx-sheet" : reduced ? undefined : "nx-dialog"}
        style={{
          position: "fixed",
          zIndex: 61,
          ...(compact
            ? { left: 0, right: 0, bottom: 0, maxHeight: "92vh", borderRadius: `${R_XL}px ${R_XL}px 0 0` }
            : {
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: 476,
                maxWidth: "94vw",
                borderRadius: R_LG,
              }),
          background: PANEL,
          border: `1px solid ${L3}`,
          boxShadow: "0 30px 80px rgba(0,0,0,0.86)",
          overflow: "hidden",
        }}
      >
        {/* The grab handle every other sheet here carries — it is what says "this came
            up from the bottom edge and goes back down there". */}
        {compact && (
          <div
            aria-hidden="true"
            style={{ width: 36, height: 4, borderRadius: 2, background: L3, margin: "10px auto 0" }}
          />
        )}
        {/* header */}
        <div style={{ padding: "18px 20px 0", position: "relative" }}>
          <button
            onClick={close}
            aria-label="Close deposit"
            style={{
              position: "absolute",
              top: 12,
              right: 12,
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
          <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: 17, color: HI }}>
            {picked ? `Deposit ${picked.symbol}` : "Deposit"}
          </div>
          <div
            style={{
              marginTop: 6,
              fontFamily: MONO,
              fontSize: 11,
              lineHeight: 1.5,
              color: FAINT,
              maxWidth: 380,
            }}
          >
            {picked ? (
              <>
                Send only {picked.symbol} on{" "}
                <span style={{ color: MUT }}>{picked.chain}</span> to this address. Anything else
                sent here is not recoverable.
              </>
            ) : (
              <>
                Deposit funds to start trading immediately. You can{" "}
                <span style={{ color: DIM, textDecoration: "underline", cursor: "pointer" }}>
                  withdraw
                </span>{" "}
                at any time.
              </>
            )}
          </div>
        </div>

        {!method ? (
          /*
           * ─── step 1: how ───
           *
           * METHODS BEFORE ASSETS, and that order used to be the other way round. A
           * funding screen that opens on eleven tickers has already assumed the
           * answer to the only question most depositors have — "can I use a card" —
           * and a trader who cannot is made to read a token list to find out. It also
           * meant the venue's whole funding story lived one click behind a screen
           * that looked crypto-only, which is precisely the impression it exists to
           * correct.
           */
          <div style={{ padding: "16px 20px 20px" }}>
            {/* NO CRYPTO/CASH TOGGLE. It was two segmented buttons that hid four of
                seven methods behind the one a depositor had not picked yet — and the
                whole point of this screen is that the answer to "can I use a card"
                is visible without asking. Seven rows fit; a toggle that exists to
                save three of them costs the message. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {METHODS.map((m, i) => (
                <Fragment key={m.id}>
                  {/* A quiet caption where the rail changes, rather than a control.
                      It names the division without making the reader operate it. */}
                  {(i === 0 || METHODS[i - 1]!.rail !== m.rail) && (
                    <div style={{ ...monoLabel(9, "0.1em"), color: FAINT, marginTop: i === 0 ? 0 : 6 }}>
                      {m.rail === "crypto" ? "CRYPTO — ANY CHAIN" : "CASH"}
                    </div>
                  )}
                <button
                  onClick={() => setMethod(m)}
                  className="nx-hover-border"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 54,
                    padding: "10px 12px",
                    border: `1px solid ${L2}`,
                    borderRadius: R_MD,
                    background: TERM,
                    cursor: "pointer",
                    textAlign: "left",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {/* The same glyph the platform page uses for this rail. A row of
                      marks is read faster than a column of titles, and sharing the
                      set means the marketing page and the product cannot drift. */}
                  <span style={{ color: MUT, display: "inline-flex", flex: "0 0 auto" }}>
                    <RailMark id={m.mark} size={20} />
                  </span>
                  <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <span style={{ fontFamily: ARCHIVO, fontSize: 13, color: TXT }}>{m.title}</span>
                    {/* The limit and the wait, together and up front. A funding screen is
                        a latency-versus-ceiling choice, and hiding the ceiling until the
                        last step wastes the trip. */}
                    <span style={{ ...monoLabel(9, "0.06em"), color: FAINT }}>
                      {m.limit} · {m.speed}
                    </span>
                  </span>
                  {/* The stack sits where the prose did. A depositor scanning this
                      list is matching shapes against what is in their pocket, and a
                      row of discs answers that faster than a line naming providers. */}
                  {m.logos ? (
                    <BrandStack ids={m.logos} ring={TERM} />
                  ) : (
                    <span style={{ ...monoLabel(8.5, "0.06em"), color: MUT, textAlign: "right", maxWidth: 130 }}>
                      {m.via}
                    </span>
                  )}
                </button>
                </Fragment>
              ))}
            </div>

            <div style={{ marginTop: 14, ...monoLabel(9, "0.06em"), color: FAINT, lineHeight: 1.6 }}>
              EACH ROW IS A PROVIDER WIDGET WHEN WIRED · THE APP SENDS TOKEN, RAIL AND AMOUNT
              <br />
              AND NEEDS A REFERENCE BACK — NONE OF THESE SETTLE SYNCHRONOUSLY
            </div>
          </div>
        ) : method.needsAsset && picked ? (
          /* ─── step 3: where to send it ─── */
          <div style={{ padding: "16px 20px 20px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                border: `1px solid ${L2}`,
                borderRadius: R_MD,
                background: TERM,
                marginBottom: 12,
              }}
            >
              <Glyph a={picked} />
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontFamily: ARCHIVO, fontSize: 13, color: TXT }}>
                  {picked.symbol}
                </span>
                <span style={{ ...monoLabel(9, "0.1em"), color: FAINT }}>{picked.chain}</span>
              </span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => setPicked(null)}
                style={{
                  ...monoLabel(9, "0.1em"),
                  color: DIM,
                  background: "transparent",
                  border: `1px solid ${L2}`,
                  borderRadius: R_MD,
                  padding: "6px 10px",
                  minHeight: 32,
                  cursor: "pointer",
                }}
              >
                CHANGE
              </button>
            </div>

            <div style={{ ...monoLabel(9, "0.1em"), color: FAINT, marginBottom: 6 }}>
              DEPOSIT ADDRESS
            </div>
            <div
              style={{
                padding: "11px 12px",
                border: `1px solid ${L2}`,
                borderRadius: R_MD,
                background: SUNK,
                fontFamily: MONO,
                fontSize: 11,
                color: NUM,
                wordBreak: "break-all",
                lineHeight: 1.6,
                marginBottom: 12,
              }}
            >
              {addressFor(picked)}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontFamily: MONO,
                fontSize: 10.5,
                color: FAINT,
              }}
            >
              <span>
                Minimum <span style={{ color: NUM }}>{picked.min}</span> {picked.symbol}
              </span>
              <span>
                Credited after <span style={{ color: NUM }}>{picked.confirmations}</span>{" "}
                confirmations
              </span>
            </div>
          </div>
        ) : !method.needsAsset ? (
          /*
           * ─── step 2, cash ───
           *
           * A card, Apple Pay, a bank transfer and a wire all end at somebody else's
           * hosted widget, and this app never sees the pan, the account number or the
           * billing address — which is the reason to hand off rather than to build a
           * form. MOCK: the amount and the quote below are illustrative and no
           * provider is wired.
           */
          <div style={{ padding: "16px 20px 20px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                border: `1px solid ${L2}`,
                borderRadius: R_MD,
                background: TERM,
                marginBottom: 12,
              }}
            >
              <span style={{ color: MUT, display: "inline-flex" }}>
                <RailMark id={method.mark} size={20} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontFamily: ARCHIVO, fontSize: 13, color: TXT }}>{method.title}</span>
                <span style={{ ...monoLabel(9, "0.1em"), color: FAINT }}>
                  {method.limit} · {method.speed}
                </span>
              </span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => setMethod(null)}
                style={{
                  ...monoLabel(9, "0.1em"),
                  color: DIM,
                  background: "transparent",
                  border: `1px solid ${L2}`,
                  borderRadius: R_MD,
                  padding: "6px 10px",
                  minHeight: 32,
                  cursor: "pointer",
                }}
              >
                CHANGE
              </button>
            </div>

            <div style={{ ...monoLabel(9, "0.1em"), color: FAINT, marginBottom: 6 }}>AMOUNT</div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                padding: "11px 12px",
                border: `1px solid ${L2}`,
                borderRadius: R_MD,
                background: SUNK,
                marginBottom: 12,
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 18, color: NUM }}>$500.00</span>
              <div style={{ flex: 1 }} />
              <span style={{ ...monoLabel(9, "0.1em"), color: FAINT }}>USD</span>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontFamily: MONO,
                fontSize: 10.5,
                color: FAINT,
                marginBottom: 14,
              }}
            >
              <span>
                You receive <span style={{ color: NUM }}>498.50</span> USDX
              </span>
              <span>
                Arrives in <span style={{ color: NUM }}>{method.speed}</span>
              </span>
            </div>

            <div style={{ ...monoLabel(9, "0.06em"), color: FAINT, lineHeight: 1.6 }}>
              MOCK · CONTINUING HANDS OFF TO THE ONRAMP PROVIDER · THIS APP NEVER SEES A CARD
              NUMBER, A BANK ACCOUNT OR A BILLING ADDRESS
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: "14px 20px 12px" }}>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search a supported asset"
                aria-label="Search a supported asset"
                style={{
                  width: "100%",
                  height: 38,
                  background: SUNK,
                  border: `1px solid ${L2}`,
                  borderRadius: R_MD,
                  padding: "0 12px",
                  color: TXT,
                  fontFamily: MONO,
                  fontSize: 12,
                  outline: "none",
                }}
              />
            </div>

            <div
              tabIndex={0}
              aria-label="Supported deposit assets"
              style={{ maxHeight: 316, overflowY: "auto", borderTop: `1px solid ${L1}` }}
            >
              {rows.length === 0 && (
                <div
                  style={{
                    padding: "26px 20px",
                    fontFamily: MONO,
                    fontSize: 11.5,
                    color: FAINT,
                    textAlign: "center",
                  }}
                >
                  No supported asset matches “{q}”
                </div>
              )}
              {rows.map((a) => (
                <button
                  key={a.symbol + a.chain}
                  onClick={() => setPicked(a)}
                  className="nx-row"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    width: "100%",
                    minHeight: 52,
                    padding: "9px 20px",
                    border: "none",
                    borderBottom: `1px solid ${L1}`,
                    background: "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <Glyph a={a} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontFamily: ARCHIVO, fontSize: 13, color: TXT }}>{a.symbol}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{a.chain}</span>
                  </span>
                  <div style={{ flex: 1 }} />
                  <span style={{ color: GREEN, fontFamily: MONO, fontSize: 11 }}>→</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
