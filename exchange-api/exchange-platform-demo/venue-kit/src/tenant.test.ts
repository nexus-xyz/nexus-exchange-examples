import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveTenant } from "./tenant.ts";
import { ACME, NEXUS, TENANTS } from "./tenants.ts";

describe("resolveTenant", () => {
  it("resolves a known id", () => {
    assert.equal(resolveTenant(TENANTS, "acme", "nexus"), ACME);
  });

  it("falls back when the id is absent or blank", () => {
    assert.equal(resolveTenant(TENANTS, undefined, "nexus"), NEXUS);
    assert.equal(resolveTenant(TENANTS, "   ", "nexus"), NEXUS);
  });

  it("throws on an unknown id rather than serving the wrong brand", () => {
    // The failure this prevents: a typo'd tenant id silently shipping a partner
    // venue under Nexus's palette, disclosures, and legal entity.
    assert.throws(() => resolveTenant(TENANTS, "acmee", "nexus"), /unknown tenant "acmee"/);
  });

  it("names the known tenants in the error, so the typo is obvious", () => {
    assert.throws(() => resolveTenant(TENANTS, "nope", "nexus"), /acme, nexus/);
  });
});

describe("the shipped tenants", () => {
  it("takes no builder fee on the first-party venue", () => {
    assert.equal(NEXUS.builder.feeBps, 0);
    assert.equal(NEXUS.builder.code, "");
  });

  it("gives every tenant its own legal entity", () => {
    // A white-label venue is a different legal entity and cannot inherit
    // Nexus's disclosures. Distinctness is the cheap half of that check.
    const entities = Object.values(TENANTS).map((tenant) => tenant.legal.entity);
    assert.equal(new Set(entities).size, entities.length);
    for (const tenant of Object.values(TENANTS)) {
      assert.ok(tenant.legal.entity.length > 0, `${tenant.id} must name a legal entity`);
      assert.ok(tenant.legal.disclosure.length > 0, `${tenant.id} must carry disclosure copy`);
    }
  });

  it("points at testnet, where the funds are play funds", () => {
    for (const tenant of Object.values(TENANTS)) {
      assert.ok(
        !tenant.venue.apiBase.startsWith("https://api.nexus.xyz"),
        `${tenant.id} must not default to the real-funds base`,
      );
    }
  });
});
