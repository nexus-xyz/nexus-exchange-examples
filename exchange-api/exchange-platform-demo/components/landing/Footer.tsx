/*
 * Footer.
 *
 * The disclosure block is not boilerplate padding — the venue this page is rendered
 * under is a tenant, and a partner tenant is a different legal entity that cannot
 * inherit our disclosures. Sourcing the entity name from the tenant config rather
 * than hardcoding it is what keeps that true when the same page is built under
 * someone else's brand.
 */

import { ARCHIVO, DIM, FAINT, HI, L2, MONO } from "@/lib/theme";

import { Wrap, css as s, annotation, eyebrow, PLATFORM } from "./primitives";

const GROUPS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/trade", label: "Terminal" },
      { href: "/admin", label: "Venue console" },
      { href: "#terminal", label: "See the product" },
    ],
  },
  {
    title: "Build",
    links: [
      { href: "#stack", label: "The stack" },
      { href: "#customize", label: "Customization" },
      { href: "#dx", label: "Testing" },
      { href: "#deposits", label: "Deposits" },
      { href: "#earnings", label: "Economics" },
      { href: "#enterprise", label: "Enterprise" },
        ],
  },
  {
    title: "Diligence",
    links: [
      { href: "#capabilities", label: "Capabilities" },
      { href: "#faq", label: "Questions" },
    ],
  },
];

export function Footer() {
  return (
    <footer style={{ borderTop: `1px solid ${L2}`, padding: "52px 0 60px" }}>
      <Wrap
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))",
          gap: 30,
        }}
      >
        <div>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: 14, letterSpacing: "0.34em", color: HI }}>
            {PLATFORM.wordmark}
          </div>
          <div style={{ ...eyebrow(), marginTop: 12 }}>Exchange-as-a-Service</div>
        </div>

        {GROUPS.map((g) => (
          <nav key={g.title} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ ...eyebrow(), marginBottom: 10 }}>{g.title}</div>
            {g.links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                /* These sit inside a `<nav>`, so the tap floor grades them at the
                   navigation tier on a phone. `.footerLink` is where that height lives
                   — an inline one could not change at a breakpoint. */
                className={`${s.linkQuiet} ${s.footerLink}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  alignSelf: "flex-start",
                  border: "none",
                  fontFamily: ARCHIVO,
                  fontWeight: 500,
                  fontSize: 13,
                  color: DIM,
                }}
              >
                {l.label}
              </a>
            ))}
          </nav>
        ))}

        <div style={{ ...annotation(FAINT, 10.5), maxWidth: 320 }}>
          <div style={{ color: DIM }}>{PLATFORM.legal.entity}</div>
          <div style={{ marginTop: 10, fontFamily: MONO, lineHeight: 1.7 }}>
            Perpetual futures carry risk of total loss. Product captures are of the running application.
          </div>
        </div>
      </Wrap>
    </footer>
  );
}
