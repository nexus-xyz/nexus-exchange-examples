/*
 * Brand chips for the deposit screen.
 *
 * WHY THEY ARE DRAWN AND NOT FETCHED. This app makes zero third-party requests —
 * it is a hard floor in `audit/floor.json` and it is a number on the platform page.
 * A logo strip is the single most common way that gets broken, because the obvious
 * implementation is a CDN URL per brand. Every mark below is inline SVG with no
 * network cost, no layout shift and nothing to go missing when someone else's asset
 * host has a bad day.
 *
 * WHY LETTERMARKS RATHER THAN WORDMARKS. Visa, Chase and Mercury are wordmarks, and
 * a wordmark rendered into an 18px circle is a smudge — it reads as noise where a
 * single letter in the brand's own colour reads instantly. So the chips are a
 * consistent set of glyph-in-a-disc, which also keeps the row optically even: a
 * stack mixing two circles, a wordmark and a symbol looks broken at any size.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRADEMARK — READ BEFORE THIS PAGE IS PUBLISHED EXTERNALLY.
 *
 * These are third-party marks used here to indicate accepted payment methods. That
 * is ordinarily permissible nominative use, but several of these programmes impose
 * their own requirements — Visa and Mastercard both publish acceptance-mark rules,
 * and Apple Pay and Google Pay both require adherence to their identity guidelines
 * and, in Apple's case, that the mark only appear where the service is genuinely
 * available. None of that is satisfied by drawing something approximate.
 *
 * CONCRETELY: the crypto marks (USDC, USDT, BTC, ETH, SOL) are low risk. The card
 * networks, the two wallets and the two banks need review, and the bank pair is the
 * weakest of the set because Chase and Mercury are named as EXAMPLES rather than as
 * integrations — an illustrative logo is the one use nominative fair use does not
 * cover. Swapping those two for a generic mark is a one-line change here and costs
 * the row nothing.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type BrandId =
  | "usdc"
  | "usdt"
  | "usdx"
  | "btc"
  | "eth"
  | "sol"
  | "binance"
  | "coinbase"
  | "bybit"
  | "visa"
  | "mastercard"
  | "applepay"
  | "googlepay"
  | "chase"
  | "mercury"
  /* The stack marks. Unlike the payment set below, these are tools we actually build
     on rather than brands we accept — nominative use of a dependency's name is the
     least contentious case there is, and three of the five are our own or MIT. */
  | "nextjs"
  | "react"
  | "typescript"
  | "vercel"
  | "postgres"
  | "rust"
  | "python";

type Brand = {
  /** Spoken name. The stack is aria-hidden, but the title attribute is a real hint. */
  label: string;
  /** Disc fill. Lightened where the true brand colour vanishes on a near-black panel. */
  bg: string;
  /** Glyph ink. */
  fg: string;
  /** The mark itself, drawn on a 20x20 grid, or a letter when the brand is a word. */
  glyph: React.ReactNode;
  letter?: string;
};

/* A few marks are geometry rather than a letter; those get a path. The rest are a
   lettermark, which is what the `letter` field is for. */
const BRANDS: Record<BrandId, Brand> = {
  usdc: { label: "USDC", bg: "#2775CA", fg: "#ffffff", letter: "$", glyph: null },
  usdt: { label: "USDT", bg: "#26A17B", fg: "#ffffff", letter: "₮", glyph: null },
  usdx: { label: "USDX", bg: "#1f6f7a", fg: "#ffffff", letter: "◈", glyph: null },
  btc: { label: "Bitcoin", bg: "#F7931A", fg: "#ffffff", letter: "₿", glyph: null },
  eth: { label: "Ethereum", bg: "#627EEA", fg: "#ffffff", letter: "Ξ", glyph: null },
  sol: { label: "Solana", bg: "#14B892", fg: "#04140f", letter: "◎", glyph: null },
  binance: { label: "Binance", bg: "#F0B90B", fg: "#1a1400", letter: "◆", glyph: null },
  coinbase: { label: "Coinbase", bg: "#1160FF", fg: "#ffffff", letter: "○", glyph: null },
  bybit: { label: "Bybit", bg: "#F7A600", fg: "#1a1400", letter: "B", glyph: null },
  /* Visa's navy is 1A1F71 and disappears against a near-black panel; lifted enough
     to read as a disc while staying recognisably the same hue. */
  visa: { label: "Visa", bg: "#2A32A8", fg: "#ffffff", letter: "V", glyph: null },
  mastercard: {
    label: "Mastercard",
    bg: "#111111",
    fg: "#ffffff",
    /* The one mark that is genuinely two shapes rather than a letter — drawing it as
       an "M" would be less recognisable than the interlocking discs it is known by. */
    glyph: (
      <>
        <circle cx="7.6" cy="10" r="5.4" fill="#EB001B" />
        <circle cx="12.4" cy="10" r="5.4" fill="#F79E1B" fillOpacity={0.88} />
      </>
    ),
  },
  applepay: {
    label: "Apple Pay",
    bg: "#1a1a1a",
    fg: "#ffffff",
    letter: "",
    glyph: (
      /* A generic leaf-and-body silhouette, not Apple's mark. See the trademark note
         at the top of this file: the real one may not be redrawn. */
      <>
        <path
          d="M10 5.6c.9-1.1 2.3-1.2 2.6-1.2.1.9-.3 1.8-.8 2.4-.6.7-1.6 1.2-2.5 1.1-.1-.9.3-1.7.7-2.3Z"
          fill="#ffffff"
        />
        <path
          d="M13.4 9.1c-1.3-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.5 2 2.5 2 1 0 1.4-.6 2.6-.6s1.5.6 2.6.6c1.1 0 1.8-1 2.4-2 .8-1.1 1.1-2.2 1.1-2.3 0 0-2.2-.8-2.2-3.3 0-2 1.7-3 1.8-3-.9-1.4-2.4-1.4-3-1.4Z"
          fill="#ffffff"
          transform="scale(0.62) translate(4.5 2)"
        />
      </>
    ),
  },
  googlepay: {
    label: "Google Pay",
    bg: "#1a1a1a",
    fg: "#ffffff",
    glyph: (
      /* Four arcs in the four brand colours — the quadrant idea, not the glyph. */
      <>
        <path d="M10 4a6 6 0 0 1 6 6h-3a3 3 0 0 0-3-3Z" fill="#EA4335" />
        <path d="M16 10a6 6 0 0 1-6 6v-3a3 3 0 0 0 3-3Z" fill="#FBBC04" />
        <path d="M10 16a6 6 0 0 1-6-6h3a3 3 0 0 0 3 3Z" fill="#34A853" />
        <path d="M4 10a6 6 0 0 1 6-6v3a3 3 0 0 0-3 3Z" fill="#4285F4" />
      </>
    ),
  },
  nextjs: {
    label: "Next.js",
    bg: "#111111",
    fg: "#ffffff",
    glyph: (
      <>
        <circle cx="10" cy="10" r="7.2" fill="none" stroke="#ffffff" strokeWidth="1.3" />
        <path d="M7.4 13.2V6.8l5.4 6.9" stroke="#ffffff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <path d="M12.7 6.8v5" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  react: {
    label: "React",
    bg: "#0d1b22",
    fg: "#61DAFB",
    glyph: (
      <>
        <ellipse cx="10" cy="10" rx="7.4" ry="2.9" fill="none" stroke="#61DAFB" strokeWidth="1.1" />
        <ellipse cx="10" cy="10" rx="7.4" ry="2.9" fill="none" stroke="#61DAFB" strokeWidth="1.1" transform="rotate(60 10 10)" />
        <ellipse cx="10" cy="10" rx="7.4" ry="2.9" fill="none" stroke="#61DAFB" strokeWidth="1.1" transform="rotate(120 10 10)" />
        <circle cx="10" cy="10" r="1.5" fill="#61DAFB" />
      </>
    ),
  },
  typescript: { label: "TypeScript", bg: "#3178C6", fg: "#ffffff", letter: "TS", glyph: null },
  vercel: {
    label: "Vercel",
    bg: "#111111",
    fg: "#ffffff",
    glyph: <path d="M10 4.6 16.6 15.4H3.4Z" fill="#ffffff" />,
  },
  postgres: { label: "Postgres", bg: "#31648C", fg: "#ffffff", letter: "P", glyph: null },
  rust: { label: "Rust", bg: "#4a3728", fg: "#ffffff", letter: "R", glyph: null },
  python: { label: "Python", bg: "#2b5b84", fg: "#ffd43b", letter: "Py", glyph: null },
  chase: { label: "Chase", bg: "#117ACA", fg: "#ffffff", letter: "◧", glyph: null },
  mercury: { label: "Mercury", bg: "#5B4DE3", fg: "#ffffff", letter: "M", glyph: null },
};

/**
 * One chip.
 *
 * `title` rather than visible text: the stack is decorative next to a title that
 * already names the method, and a tooltip is the right amount of extra for someone
 * who wants to know which card networks specifically.
 */
function Chip({ id, size, ring }: { id: BrandId; size: number; ring: string }) {
  const b = BRANDS[id];
  return (
    <span
      title={b.label}
      style={{
        display: "inline-flex",
        flex: "0 0 auto",
        width: size,
        height: size,
        borderRadius: "50%",
        /* The ring is the panel colour, not a border colour: it is what separates one
           overlapping disc from the next, and it has to match whatever is behind the
           stack or the chips read as outlined rather than stacked. */
        boxShadow: `0 0 0 1.5px ${ring}`,
        background: b.bg,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {b.glyph ? (
        <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
          {b.glyph}
        </svg>
      ) : (
        <span
          aria-hidden="true"
          style={{
            color: b.fg,
            fontSize: (b.letter && b.letter.length > 1 ? size * 0.36 : size * 0.52),
            lineHeight: 1,
            fontWeight: 700,
            /* System stack rather than the app's faces: these are letterforms standing
               in for logos, and they should not read as the product's own type. */
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          }}
        >
          {b.letter}
        </span>
      )}
    </span>
  );
}

/**
 * A stack of brand chips, overlapping.
 *
 * Overlap rather than a row because the stack is a HINT, not a list: a depositor
 * reads "cards" from the title and "oh, the ones I have" from the shapes, and three
 * discs tucked into each other say that in a third of the width. First mark on top,
 * so the leftmost is the one that reads cleanest.
 */
export function BrandStack({
  ids,
  size = 18,
  ring = "#0b0b0b",
}: {
  ids: BrandId[];
  size?: number;
  ring?: string;
}) {
  return (
    <span
      /* Decorative: every method's title already says what it is, and reading fifteen
         brand names to a screen reader in the middle of a funding list would be noise
         rather than information. */
      aria-hidden="true"
      style={{ display: "inline-flex", alignItems: "center", paddingLeft: size * 0.34 }}
    >
      {ids.map((id, i) => (
        <span
          key={id}
          style={{
            display: "inline-flex",
            marginLeft: -size * 0.34,
            /* Left-most on top: the stack should look like a deck fanned toward the
               reader rather than away from them. */
            zIndex: ids.length - i,
          }}
        >
          <Chip id={id} size={size} ring={ring} />
        </span>
      ))}
    </span>
  );
}
