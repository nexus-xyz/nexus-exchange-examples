//! The one order this app places, and the proof that it cannot fill.
//!
//! Pure functions over what the venue reported, so every refusal here is unit
//! tested rather than discovered against a live book.

use nexus_exchange::markets::Rounding;
use nexus_exchange::types::Market;
use rust_decimal::Decimal;

/// Never rest closer to the mark than this, whatever the band allows. 50 bps is
/// already far more than testnet moves between a place and its cancel; the
/// point is that "far from the market" has a floor this file states.
pub const MIN_OFFSET_BPS: u32 = 50;

/// With no explicit offset, rest at this share of the venue's band. Near the
/// edge (as far from a fill as the venue allows) but with slack left for the
/// mark to drift inside the run without the order falling outside the collar.
const DEFAULT_BAND_SHARE_PCT: u32 = 80;

const BPS: i64 = 10_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub price: Decimal,
    pub size: Decimal,
    pub offset_bps: u32,
    pub band_bps: u32,
    /// The lowest price the band admits right now: `mark × (1 − band)`.
    pub band_floor: Decimal,
    /// How far the order sits below the best ask, in bps of the ask. `None`
    /// when the book has no asks, which is itself worth printing.
    pub below_best_ask_bps: Option<Decimal>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanError(pub String);

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn bps_below(reference: Decimal, bps: u32) -> Decimal {
    reference * Decimal::from(BPS - i64::from(bps)) / Decimal::from(BPS)
}

/// Build the resting **buy**.
///
/// A buy rather than a sell because a buy can only fill if the asks come down
/// to it, and a far-below-mark bid is the last thing a falling market reaches.
/// Post-only is set by the caller; this function makes sure it never has to do
/// any work, by refusing any price that would cross.
///
/// Rounding goes **up** onto the tick: towards the mark, so the rounded price
/// can only move further *inside* the band it was checked against. Rounding
/// down would push it towards the band edge instead — the one direction that
/// turns a safe order into a rejected one.
pub fn plan_order(
    market: &Market,
    band_bps: u32,
    mark: Decimal,
    best_ask: Option<Decimal>,
    offset_bps: Option<u32>,
) -> Result<Plan, PlanError> {
    if mark <= Decimal::ZERO {
        return Err(PlanError(format!("mark price {mark} is not positive")));
    }
    if band_bps == 0 || i64::from(band_bps) >= BPS {
        return Err(PlanError(format!(
            "price band of {band_bps} bps is not usable"
        )));
    }
    let offset = offset_bps.unwrap_or(band_bps * DEFAULT_BAND_SHARE_PCT / 100);
    if offset < MIN_OFFSET_BPS {
        return Err(PlanError(format!(
            "offset {offset} bps is closer to the mark than the {MIN_OFFSET_BPS} bps floor \
             (band is {band_bps} bps) — too tight to rest an order that cannot fill"
        )));
    }
    if offset >= band_bps {
        return Err(PlanError(format!(
            "offset {offset} bps is at or outside the venue's {band_bps} bps band; \
             the venue would reject the order"
        )));
    }

    let band_floor = bps_below(mark, band_bps);
    let price = market.round_price(bps_below(mark, offset), Rounding::Up);
    if price < band_floor {
        return Err(PlanError(format!(
            "rounded price {price} is below the band floor {band_floor}"
        )));
    }
    if price > bps_below(mark, MIN_OFFSET_BPS) {
        return Err(PlanError(format!(
            "tick size {} rounds the price up to {price}, within {MIN_OFFSET_BPS} bps of the mark {mark}",
            market.tick_size
        )));
    }
    if let Some(ask) = best_ask {
        if price >= ask {
            return Err(PlanError(format!(
                "price {price} would cross the best ask {ask}; refusing rather than \
                 relying on post-only to reject it"
            )));
        }
    }

    let size = market.round_size(market.min_order_size, Rounding::Up);
    market
        .validate_order(price, size)
        .map_err(|e| PlanError(format!("venue rules refuse the order: {e}")))?;

    let below_best_ask_bps = best_ask
        .filter(|ask| *ask > Decimal::ZERO)
        .map(|ask| ((ask - price) / ask * Decimal::from(BPS)).round_dp(1));

    Ok(Plan {
        price,
        size,
        offset_bps: offset,
        band_bps,
        band_floor,
        below_best_ask_bps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn market(tick: &str, lot: &str, min: &str) -> Market {
        serde_json::from_value(serde_json::json!({
            "market_id": "BTC-USDX-PERP", "base_asset": "BTC", "quote_asset": "USDX",
            "tick_size": tick, "lot_size": lot, "min_order_size": min,
            "max_order_size": "100", "initial_margin_rate": "0.05",
            "maintenance_margin_rate": "0.03", "max_leverage": 20
        }))
        .unwrap()
    }

    #[test]
    fn default_offset_is_eighty_percent_of_the_band_and_rounds_towards_the_mark() {
        let m = market("0.5", "0.001", "0.001");
        let plan = plan_order(&m, 500, d("78000"), Some(d("78010")), None).unwrap();
        assert_eq!(plan.offset_bps, 400);
        // 78000 × 0.96 = 74880 exactly, already on tick.
        assert_eq!(plan.price, d("74880"));
        assert_eq!(plan.size, d("0.001"));
        assert_eq!(plan.band_floor, d("74100"));
        assert!(plan.price >= plan.band_floor);
    }

    #[test]
    fn off_tick_price_rounds_up_never_down() {
        let m = market("7", "0.001", "0.001");
        let plan = plan_order(&m, 500, d("1000"), None, Some(400)).unwrap();
        // 960 is not a multiple of 7; the neighbours are 959 and 966. Up wins.
        assert_eq!(plan.price, d("966"));
        assert_eq!(plan.below_best_ask_bps, None);
    }

    #[test]
    fn refuses_an_offset_at_or_beyond_the_band() {
        let m = market("0.5", "0.001", "0.001");
        assert!(plan_order(&m, 500, d("78000"), None, Some(500)).is_err());
        assert!(plan_order(&m, 500, d("78000"), None, Some(900)).is_err());
    }

    #[test]
    fn refuses_a_band_too_tight_to_be_far_from_the_market() {
        let m = market("0.5", "0.001", "0.001");
        // 80% of 60 bps is 48, under the 50 bps floor.
        assert!(plan_order(&m, 60, d("78000"), None, None).is_err());
        assert!(plan_order(&m, 0, d("78000"), None, None).is_err());
    }

    #[test]
    fn refuses_a_price_that_would_cross_the_ask() {
        let m = market("0.5", "0.001", "0.001");
        // An ask far below the mark: a broken book. Do not rely on post-only.
        assert!(plan_order(&m, 500, d("78000"), Some(d("70000")), None).is_err());
    }

    #[test]
    fn refuses_a_tick_so_coarse_that_rounding_lands_near_the_mark() {
        let m = market("1000", "0.001", "0.001");
        assert!(plan_order(&m, 500, d("1000"), None, Some(100)).is_err());
    }

    #[test]
    fn size_is_the_market_minimum_on_the_lot_grid() {
        let m = market("0.5", "0.01", "0.015");
        let plan = plan_order(&m, 500, d("78000"), None, None).unwrap();
        assert_eq!(plan.size, d("0.02"));
    }

    #[test]
    fn non_positive_mark_is_refused() {
        let m = market("0.5", "0.001", "0.001");
        assert!(plan_order(&m, 500, Decimal::ZERO, None, None).is_err());
    }
}
