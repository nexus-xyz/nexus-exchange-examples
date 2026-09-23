// Regenerate `spec-weights.json` from the pinned API spec.
//
//   npm run sync-weights
//
// Why a generated file, and not a table typed into the source: the spec says
// operations costing more than one unit "carry `x-nexus-rate-limit-weight`
// (an integer) ... Absence of the marker means weight 1", and calls those
// markers "the machine-readable form ... for client-side limiters". So the
// weights are read from the markers, at the tag the SDK is compiled against,
// and the file records which tag and which bytes they came from. When the SDK
// pin moves, bump `SPEC_TAG`, re-run this, and review the diff like any other
// dependency bump.
//
// The app never fetches the spec at runtime. It would put GitHub on the
// critical path of an order, and CI runs offline.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { SPEC_TAG } from "./weights.js";

const SPEC_URL = `https://raw.githubusercontent.com/nexus-xyz/nexus-exchange-api/${SPEC_TAG}/openapi.json`;
const METHODS = ["get", "put", "post", "delete", "patch"] as const;

interface Marker {
  readonly method: string;
  readonly path: string;
  readonly weight: number;
  readonly formula: string | null;
  readonly rateLimitClass: string | null;
}

const response = await fetch(SPEC_URL);
if (!response.ok) throw new Error(`GET ${SPEC_URL}: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const spec = JSON.parse(new TextDecoder().decode(bytes)) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

const markers: Marker[] = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (op === undefined) continue;
    const weight = op["x-nexus-rate-limit-weight"];
    const formula = op["x-nexus-rate-limit-weight-formula"];
    const cls = op["x-nexus-rate-limit-class"];
    // Only operations that carry a marker are recorded. Absence means 1, and
    // writing 1 for every other operation would turn the spec's rule into a
    // table this file then has to keep in sync.
    if (typeof weight !== "number" && typeof formula !== "string") continue;
    markers.push({
      method: method.toUpperCase(),
      path,
      weight: typeof weight === "number" ? weight : 1,
      formula: typeof formula === "string" ? formula : null,
      rateLimitClass: typeof cls === "string" ? cls : null,
    });
  }
}
markers.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const out = {
  source: SPEC_URL,
  specTag: SPEC_TAG,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  rule: "An operation absent from `markers` has weight 1 (spec, \"Rate limits\").",
  markers,
};
const target = new URL("./spec-weights.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${markers.length} marker(s) from ${SPEC_TAG} to ${target.pathname}`);
