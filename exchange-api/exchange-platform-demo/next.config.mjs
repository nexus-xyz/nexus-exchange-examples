/** @type {import('next').NextConfig} */

/*
 * The audit harness builds into its own directory.
 *
 * `next dev` and `next start` share `.next`. So the moment anyone runs `npm run dev`
 * to look at the app — which is exactly what happens while a design review is going
 * on — the dev compiler overwrites the production build the harness is serving. The
 * server keeps running and keeps serving HTML that references the previous chunk
 * hashes; every one of them 400s; React never hydrates.
 *
 * The failure is quiet and it is expensive. A non-hydrated page still RENDERS: the
 * server HTML paints, text is readable, screenshots look plausible. What is gone is
 * every event handler — and `useMediaQuery` reads false before mount, so a 390px
 * viewport gets the DESKTOP shell. It has cost this project two runs on one
 * afternoon: an affordance sweep that reported a live control dead, and a spacing
 * audit that measured an 89px-wide desktop table at phone width.
 *
 * `NEXT_DIST_DIR=.next-audit` gives the harness its own build output, so a dev server
 * and a graded server can run at the same time and neither can corrupt the other. It
 * has to be set for both the build and the server — they must agree.
 */
/*
 * `@nexus-eaas/venue-kit` is a source-only package — TypeScript, no build step,
 * linked from ./venue-kit, inside this project. It is the single source of the
 * fee math and the builder-code ledger, and vendoring a second copy in here is
 * exactly the drift this avoids. Next has to transpile it because it ships .ts.
 */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: ["@nexus-eaas/venue-kit"],
};

export default nextConfig;
