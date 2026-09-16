import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/*
 * THE FONTS ARE IN THE REPOSITORY, and that is a build decision rather than a preference.
 *
 * These were `next/font/google`, which downloads at build time and self-hosts the result —
 * so the runtime claim on the landing page ("no external fonts") was already true. The
 * BUILD, though, had a hard dependency on fonts.gstatic.com, and it broke: Google rotated
 * the hashed file URLs, the cached CSS pointed at the old ones, and the deployment failed
 * on six 404s after three retries each. A retry would only have deferred it.
 *
 * `next/font/local` over vendored files makes the build hermetic — no network, no cache to
 * go stale, no third party who can break a deploy by shipping a new font version. It also
 * makes the page's own claim true at build time and not just at runtime, and it adds no
 * npm dependency, so the dependency count the Stack section invites a reader to check
 * stays at three.
 *
 * Latin subset only, which is exactly what `subsets: ["latin"]` requested before.
 *
 * ONE FILE PER FAMILY, because these are VARIABLE fonts. Google serves one file covering the
 * whole weight axis and returns it for every weight you ask for — the five Archivo downloads
 * came back byte-identical, as did the three Geist Mono. Declaring them as five static
 * instances shipped four redundant copies and described the file as something it is not; a
 * weight RANGE is what a variable font actually has.
 */
const archivo = localFont({
  src: "./fonts/archivo.woff2",
  weight: "500 900",
  variable: "--font-archivo",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geistmono.woff2",
  weight: "400 600",
  variable: "--font-geist-mono",
  display: "swap",
})

export const metadata: Metadata = {
  title: "Nexus Exchange — Terminal",
  description:
    "Trade the Nexus Exchange. CLOB perpetuals across crypto, FX, commodities, and index — API-first, agent-native.",
  metadataBase: new URL("https://nexus.xyz"),
};

export const viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
