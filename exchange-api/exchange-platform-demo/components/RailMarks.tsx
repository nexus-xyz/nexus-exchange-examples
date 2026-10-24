/*
 * Marks for the funding rails.
 *
 * WHY DRAWN AND NOT IMPORTED. A funding section wants to be read at a glance,
 * and a glance reads marks faster than words — but shipping real brand assets
 * means shipping someone else's trademark. These are simplified, single-path
 * glyphs drawn from primitive shapes: recognisable in a row of eight, and
 * nobody's registered artwork.
 *
 * BEFORE THIS PAGE IS PUBLISHED EXTERNALLY, the card networks and Apple Pay
 * marks need a licensing review. Visa, Mastercard and Apple all publish usage
 * rules, Apple's are the strictest, and "we drew our own" is not a defence if
 * the drawing is the mark. Internally, for a vision surface, this is fine.
 *
 * Everything inherits `currentColor`, so a rail is coloured by its container and
 * follows a re-skin. No hex in this file.
 */

export type RailId =
  | "stablecoin"
  | "chain"
  | "card"
  | "applepay"
  | "ach"
  | "wire"
  | "cex";

/** One 24x24 glyph per rail, on a shared grid so a row of them optically aligns. */
export function RailMark({ id, size = 22 }: { id: RailId; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (id) {
    /* A coin, because a stablecoin's whole promise is that it is a unit. */
    case "stablecoin":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.2v9.6M9.6 9.4h3.6a1.9 1.9 0 0 1 0 3.8H9.9h3.5a1.9 1.9 0 0 1 0 3.8H9.6" />
        </svg>
      );

    /* Linked nodes: any chain, which is the point — not one chain's logo. */
    case "chain":
      return (
        <svg {...common}>
          <circle cx="12" cy="5.4" r="2.1" />
          <circle cx="5.6" cy="16" r="2.1" />
          <circle cx="18.4" cy="16" r="2.1" />
          <path d="M10.4 7.2 7 13.9M13.6 7.2 17 13.9M7.7 16h8.6" />
        </svg>
      );

    case "card":
      return (
        <svg {...common}>
          <rect x="2.6" y="5.6" width="18.8" height="12.8" rx="2.2" />
          <path d="M2.6 10h18.8" />
          <path d="M6 14.4h3.4" />
        </svg>
      );

    /* A rounded glyph and a contactless arc — the gesture, not the wordmark. */
    case "applepay":
      return (
        <svg {...common}>
          <path d="M13.4 4.4c-.5.6-1.3 1-2 1-.1-.8.2-1.6.7-2.2.5-.6 1.4-1 2.1-1.1.1.9-.2 1.7-.8 2.3Z" />
          <path d="M14.1 6.6c1.1 0 2 .6 2.5 1.5-.9.5-1.5 1.4-1.5 2.5 0 1.2.7 2.2 1.8 2.7-.5 1.4-1.6 3.1-2.8 3.1-.7 0-1-.4-1.8-.4s-1.1.4-1.8.4c-1.3 0-2.9-2.6-2.9-5 0-2.3 1.5-3.6 2.9-3.6.8 0 1.4.5 2 .5s1.1-.5 1.6-.5Z" />
          <path d="M19.4 8.6a3.6 3.6 0 0 1 0 6.8" />
        </svg>
      );

    /* A bank: the rail an ACH transfer actually runs on. */
    case "ach":
      return (
        <svg {...common}>
          <path d="M3.4 9.6 12 4.8l8.6 4.8" />
          <path d="M5.4 9.6v8.8M18.6 9.6v8.8M9.6 12.4v6M14.4 12.4v6" />
          <path d="M3 19.2h18" />
        </svg>
      );

    /* A wire: a long-haul transfer, drawn as one. */
    case "wire":
      return (
        <svg {...common}>
          <circle cx="4.6" cy="12" r="2" />
          <circle cx="19.4" cy="12" r="2" />
          <path d="M6.6 12h10.8" />
          <path d="M14.6 9.2 17.4 12l-2.8 2.8" />
        </svg>
      );

    /* An exchange: two books, one withdrawal leaving. */
    case "cex":
      return (
        <svg {...common}>
          <rect x="3" y="4.4" width="7" height="15.2" rx="1.6" />
          <rect x="14" y="4.4" width="7" height="15.2" rx="1.6" />
          <path d="M10 9.4h4M14 14.6h-4" />
        </svg>
      );
  }
}
