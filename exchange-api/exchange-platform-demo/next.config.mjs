/** @type {import('next').NextConfig} */

/*
 * A configurable dist dir, because a single shared `.next` is a trap the moment
 * more than one Next process touches this project at once.
 *
 * `next dev` and `next start` share `.next` by default. So the moment a dev
 * server starts up while a separately-built production server is still
 * running against the same directory, the dev compiler overwrites the build
 * the other server is serving. That server keeps running and keeps serving
 * HTML that references the previous chunk hashes; every one of them 400s;
 * React never hydrates.
 *
 * The failure is quiet and it is expensive. A non-hydrated page still RENDERS:
 * the server HTML paints, text is readable, screenshots look plausible. What
 * is gone is every event handler — and `useMediaQuery` reads false before
 * mount, so a 390px viewport gets the DESKTOP shell. That is an easy thing to
 * miss if whatever is checking the page only looks at rendered output.
 *
 * `NEXT_DIST_DIR` lets a second process point at its own build output, so two
 * servers can run at once and neither corrupts the other. It has to be set
 * for both the build and the server that serves it — they must agree.
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
