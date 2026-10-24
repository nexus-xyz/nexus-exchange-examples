/*
 * The builder fee: what it is, and — more importantly — what it is not.
 *
 * WHAT IT IS. An *additive* fee a venue operator charges on top of the Nexus
 * schedule and keeps in full, capped at `MAX_FEE_BPS`. Additive is the
 * load-bearing word: a builder who self-deals pays the venue fee AND pays the
 * builder fee to itself, so there is no extraction path and no Sybil incentive.
 * Carved-out would invert that.
 *
 * WHAT IT IS NOT — and this is the honest part of an emulation. Nothing here
 * charges anybody. The exchange does not know this fee exists: openapi.json
 * 0.8.1 has no builder field on `OrderRequest`, no builder field on `Fill`, and
 * no crediting path. So this module computes a *receivable* — what the venue
 * would have earned had the fee been real — and the venue discloses it as an
 * estimate. No USDX moves. The cap below is a venue-side clamp, not an enforced
 * invariant; real enforcement has to live at fill time in the engine and
 * settlement path, where the fee is actually derived.
 *
 * Keeping that boundary crisp in code is deliberate. A number that looks
 * authoritative and is not is how a demo turns into a false claim.
 */

import { applyBps, formatDec, mulDec, parseDec, type Dec } from "../decimal.ts";

/**
 * The hard ceiling on a venue fee, in basis points. 10 bps is 0.1% of notional.
 *
 * THIS REVERSES A PREVIOUS DECISION, and the reversal is worth recording. The
 * cap was removed on the argument that a ceiling is the platform pricing its
 * partners' product for them, and that disclosure plus competition is the
 * discipline. Two things defeat that argument.
 *
 * First, disclosure is not consent. The fee is inside one blended maker/taker
 * pair on the ticket, so a trader reads a price and never reads a decision — and
 * a venue can present the onboarding approval as routine and slip in a rate no
 * informed trader would accept. Consent alone therefore rests on consent UX,
 * which is the weakest link in the chain.
 *
 * Second, the reputational cost of a venue charging 200 bps lands on the exchange
 * whose book it matched on, not on the venue. We carry the downside, so we set
 * the ceiling.
 *
 * The cap is one half. The other half is the trader's explicit approval of a
 * per-venue maximum underneath it, signed by their main wallet and never by the
 * delegated trading key — see `../tenant.ts`. Each half covers the other's
 * failure: a cap without consent charges a fee nobody agreed to, and consent
 * without a cap is only as strong as the dialog that collected it.
 *
 * 10 bps matches the closest living venue's perps cap. The number is a
 * commercial call; the shape — ceiling plus consent — is not.
 */
export const MAX_FEE_BPS = 10;

/**
 * Normalise a configured rate. Non-negative, at or under the cap, finite.
 *
 * CLAMPS RATHER THAN THROWS. A misconfigured `nexus.json` should render a venue
 * at the ceiling, not fail to render a venue at all — and a rate above the cap is
 * unenforceable anyway, so the clamp is what the settlement path would do.
 *
 * TENTHS, NOT WHOLE BASIS POINTS. This truncated to integers, which was fine while
 * the recommended fee was a whole number and became wrong the moment it was not: the
 * platform recommends 3.2 bps, and a store that silently turns that into 3 makes the
 * venue charge 6% less than it configured and the page recommend a price the product
 * cannot hold. A tenth of a basis point is one part in a million of notional, which
 * is finer than any venue will price and coarse enough to compare exactly.
 *
 * What remains is arithmetic hygiene: a negative fee is not a rebate we can honour,
 * and a rate with more precision than the ledger stores is a rounding difference
 * waiting to be discovered in a reconciliation.
 */
export function normaliseFeeBps(feeBps: number): number {
  if (!Number.isFinite(feeBps)) throw new RangeError(`feeBps must be a number, got ${feeBps}`);
  if (feeBps < 0) return 0;
  if (feeBps > MAX_FEE_BPS) return MAX_FEE_BPS;
  /* Round rather than truncate, so 3.19999 from a float path lands on 3.2. */
  return Math.round(feeBps * 10) / 10;
}

/** Notional of a fill, exactly: `price × size`. */
export function fillNotional(price: string, size: string): Dec {
  return mulDec(parseDec(price), parseDec(size));
}

/** The additive builder fee on a notional. */
export function builderFee(notional: Dec, feeBps: number): Dec {
  return applyBps(notional, normaliseFeeBps(feeBps));
}

/** What the order ticket discloses before submission. */
export interface FeeDisclosure {
  /** Notional the estimate is computed on. */
  readonly notional: string;
  /** The venue's fee, additive and kept by the operator. */
  readonly builderFee: string;
  /** Rate actually applied, in whole basis points. */
  readonly feeBps: number;
  /**
   * Always true today. The exchange cannot charge this fee, so every figure
   * derived from it is an estimate and must be rendered as one.
   */
  readonly estimate: true;
}

/**
 * Build the disclosure a trader sees at order time. Additive: this is charged
 * *on top of* whatever the venue's own taker/maker rate comes to, never carved
 * out of it, and the caller is expected to render it as a separate row for
 * exactly that reason.
 */
export function discloseFee(price: string, size: string, configuredBps: number): FeeDisclosure {
  const feeBps = normaliseFeeBps(configuredBps);
  const notional = fillNotional(price, size);
  return {
    notional: formatDec(notional),
    builderFee: formatDec(builderFee(notional, feeBps)),
    feeBps,
    estimate: true,
  };
}
