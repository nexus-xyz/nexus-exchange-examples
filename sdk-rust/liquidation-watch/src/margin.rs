//! The margin arithmetic: how far can the mark move before maintenance margin
//! is breached?
//!
//! Pure — no network, no clock, no mutable state. Every number that reaches the
//! screen is computed here, from one snapshot, in exact decimal.
//!
//! # What is being computed
//!
//! Under the engine's cross-margin model an account is liquidatable once its
//! **equity** falls below its **maintenance margin**:
//!
//! ```text
//! E  = total_equity                         (collateral + Σ unrealized PnL)
//! MM = Σ_j notional_j × maintenance_rate_j
//! H  = E − MM                               ("headroom"; liquidatable at H ≤ 0)
//! ```
//!
//! Shock **one** market's mark by `d` and hold the rest still. Position `i` has
//! signed size `s` (long positive, short negative) and its market's maintenance
//! rate is `r`:
//!
//! ```text
//! E(d)  = E  + s·d                 equity moves with the position
//! MM(d) = MM + |s|·r·d             the notional it is charged on moves too
//! H(d)  = H  + d·(s − |s|·r)
//! ```
//!
//! Solving `H(d) = 0`:
//!
//! ```text
//! long  (s = +q):  the price must FALL by  H / (q · (1 − r))
//! short (s = −q):  the price must RISE by  H / (q · (1 + r))
//! ```
//!
//! The asymmetry is real and not a sign slip. A falling price on a long destroys
//! equity *and* releases maintenance margin, so the two partly offset; a rising
//! price on a short destroys equity *and* demands more maintenance margin, so
//! they compound. A short is always nearer liquidation than the naive `H / q`
//! suggests, and a long always further.
//!
//! # Why this is an estimate, and is labelled as one everywhere it is printed
//!
//! It is the cross-margin model over the fields the indexer mirrors. It is not
//! the venue's own number — the venue does not publish one here, because
//! `Position::liquidation_price` comes back `null` with
//! `liquidation_price_error: margin_state_not_mirrored`. Three specific ways it
//! can be wrong, all of them printed next to the estimate rather than hidden:
//!
//! 1. **Only one market moves.** A real liquidation is usually several marks
//!    moving together. The single-factor shock is optimistic exactly when the
//!    rest of the book is correlated with the leg being shocked.
//! 2. **The client cannot see margin mode.** The wire carries `margin_mode`; the
//!    SDK's `Position` has no such field, so it is dropped in deserialization.
//!    For an isolated position this is the wrong model altogether — see the
//!    crate docs.
//! 3. **Fees, funding and the liquidation penalty are not in it.** Each of them
//!    moves the true trigger *closer* than this number, never further.
//!
//! # The three outcomes
//!
//! A position is `Fragile` (a computed distance), `Breached` (the account is
//! provably at or past maintenance already), or `Unknown` — and `Unknown` is
//! never rendered, sorted or summarised as "safe".
//!
//! What makes `Unknown` usable rather than a shrug is the same asymmetry
//! `risk-guard` leans on. Every maintenance term is `notional × rate` with both
//! factors non-negative, so a missing term can only make `MM` **larger**. The
//! terms that do report therefore give a lower bound on `MM` and hence an upper
//! bound on `H`. If even that upper bound is `≤ 0`, the account is liquidatable
//! whatever is missing — a provable breach stays provable, and is reported
//! ahead of everything else. If the bound is positive but incomplete, the true
//! headroom lies somewhere below it, so every distance derived from it would
//! overstate safety: those rows report `Unknown` and name the markets that did
//! not report, rather than a number nobody should act on.

use std::collections::HashMap;

use nexus_exchange::types::Position;
use rust_decimal::{Decimal, RoundingStrategy};

/// One market's risk inputs, from `GET /markets/{market_id}/risk-params`.
#[derive(Debug, Clone)]
pub struct RiskParams {
    pub maintenance_margin_rate: Decimal,
    pub initial_margin_rate: Decimal,
    pub max_leverage: u32,
}

/// Risk parameters by market id.
pub type RiskParamsByMarket = HashMap<String, RiskParams>;

/// Why a maintenance term could not be computed. Always the machine-readable
/// reason the server gave when it gave one: "the mark price is unavailable for
/// BTC-USDX-PERP" is a different conversation from "the tool is confused".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Missing {
    /// `notional_value` was `null`; the payload is its paired `*_error`.
    Notional(String),
    /// No `risk-params` read succeeded for this market.
    RiskParams,
    /// `side` was neither long nor short. Guessing inverts the whole answer.
    UnrecognisedSide(String),
}

impl std::fmt::Display for Missing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Missing::Notional(reason) => write!(f, "{reason}"),
            Missing::RiskParams => f.write_str("risk_params_unavailable"),
            Missing::UnrecognisedSide(side) => write!(f, "unrecognised side {side:?}"),
        }
    }
}

/// What this app can say about one position.
#[derive(Debug, Clone, PartialEq)]
pub enum Health {
    /// Computable: the mark must move this far, this way, to reach liquidation.
    Fragile(Distance),
    /// The **account** is provably at or past maintenance margin on the terms
    /// that do report. Liquidation in cross margin is an account-level event, so
    /// this is reported against every open leg, not one of them.
    Breached,
    /// Not decidable from this snapshot. Never "safe".
    Unknown(Unproven),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unproven {
    /// This position's own inputs are missing.
    Position(Missing),
    /// This position reports, but another one's maintenance term does not, so
    /// the headroom this estimate would divide is only an upper bound. Carries
    /// the markets at fault.
    AccountHeadroom(Vec<String>),
    /// `summary.total_equity` was not reported. Substituting zero would read an
    /// unfunded account as flat, so nothing is computed at all.
    EquityNotReported,
    /// A flat position has no liquidation price to be distant from.
    FlatPosition,
}

impl std::fmt::Display for Unproven {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unproven::Position(missing) => write!(f, "{missing}"),
            Unproven::AccountHeadroom(markets) => write!(
                f,
                "account headroom is only an upper bound — no maintenance term for {}",
                markets.join(", ")
            ),
            Unproven::EquityNotReported => {
                f.write_str("the server did not report total_equity, and zero is not a substitute")
            }
            Unproven::FlatPosition => f.write_str("flat position — no liquidation price"),
        }
    }
}

/// How far the mark must move, and which way.
#[derive(Debug, Clone, PartialEq)]
pub struct Distance {
    /// Mark implied by this snapshot (`notional / |size|`).
    pub mark: Decimal,
    /// Estimated liquidation price, rounded **towards** the mark, so the printed
    /// number is never further away than the exact one.
    pub liquidation_price: Decimal,
    /// Absolute move to liquidation, rounded down for the same reason.
    pub move_to_liquidation: Decimal,
    /// That move as a fraction of the mark, rounded down.
    pub fraction_of_mark: Decimal,
    /// `true` when the price must fall (a long), `false` when it must rise.
    pub falls: bool,
}

/// One row of the report.
#[derive(Debug, Clone)]
pub struct Assessment {
    pub market_id: String,
    pub side: String,
    pub size: Decimal,
    pub notional: Option<Decimal>,
    pub maintenance_margin: Option<Decimal>,
    pub health: Health,
}

/// The account-level picture the rows are derived from.
#[derive(Debug, Clone)]
pub struct AccountView {
    pub equity: Option<Decimal>,
    /// Sum of the maintenance terms that reported. A **lower bound** on the true
    /// requirement whenever `missing` is non-empty.
    pub maintenance_margin: Decimal,
    /// Markets whose maintenance term could not be computed, each with its
    /// reason.
    pub missing: Vec<String>,
    /// `equity − maintenance_margin`. An **upper bound** on true headroom
    /// whenever `missing` is non-empty; `None` when equity was not reported.
    pub headroom: Option<Decimal>,
    /// `true` when headroom is provably `≤ 0` whatever is missing.
    pub provably_breached: bool,
}

/// Displayed precision. Past every tick size the venue lists, and well short of
/// the 28 significant digits `Decimal` carries — so a report stays readable
/// without the rounding ever being what decides an answer. Every comparison
/// above happens on unrounded values.
const DISPLAY_DP: u32 = 8;

/// Signed size: positive long, negative short.
///
/// The wire spells the side `"Long"` / `"Short"` (measured on testnet) while the
/// spec's examples use lowercase, so the comparison is case-insensitive.
/// Anything else is refused rather than defaulted: reading a short as a long
/// inverts the direction of the entire answer.
fn signed_size(position: &Position) -> Result<Decimal, Missing> {
    let magnitude = position.size.abs();
    if position.side.eq_ignore_ascii_case("long") {
        Ok(magnitude)
    } else if position.side.eq_ignore_ascii_case("short") {
        Ok(-magnitude)
    } else {
        Err(Missing::UnrecognisedSide(position.side.clone()))
    }
}

/// This position's maintenance requirement, or why it could not be computed.
///
/// Deliberately `notional × rate` from the *same* `/account/state` read, and not
/// `|size| × mark` from a separate mark-price call. The equity this is
/// subtracted from embeds the unrealized PnL computed at the snapshot's own
/// mark, so pairing it with a mark from a later read makes the two halves of
/// `E − MM` disagree by an amount nobody has bounded.
fn maintenance_term(position: &Position, params: Option<&RiskParams>) -> Result<Decimal, Missing> {
    let params = params.ok_or(Missing::RiskParams)?;
    match position.notional_value {
        Some(notional) => Ok(notional * params.maintenance_margin_rate),
        None => Err(Missing::Notional(
            position
                .notional_value_error
                .clone()
                .unwrap_or_else(|| "reason not reported".to_string()),
        )),
    }
}

/// Roll the account up: what is the maintenance requirement, and is the headroom
/// a number or only a bound?
pub fn account_view(
    positions: &[Position],
    equity: Option<Decimal>,
    params: &RiskParamsByMarket,
) -> AccountView {
    let mut maintenance_margin = Decimal::ZERO;
    let mut missing = Vec::new();
    for position in positions {
        // A flat position charges nothing whatever the mark is, so it can never
        // hide a maintenance term. Counting it as missing would let one dust
        // position in an unmirrored market poison the account's headroom on
        // every run — strictness belongs where exposure can hide, and none can
        // hide here.
        if position.size.is_zero() {
            continue;
        }
        match maintenance_term(position, params.get(&position.market_id)) {
            Ok(term) => maintenance_margin += term,
            Err(reason) => missing.push(format!("{} ({reason})", position.market_id)),
        }
    }
    let headroom = equity.map(|equity| equity - maintenance_margin);
    AccountView {
        // `MM` can only grow, so `H` can only shrink: an upper bound at or below
        // zero is a breach nothing missing can undo.
        provably_breached: headroom.is_some_and(|headroom| headroom <= Decimal::ZERO),
        equity,
        maintenance_margin,
        missing,
        headroom,
    }
}

/// Assess one position against the account view.
pub fn assess(position: &Position, params: Option<&RiskParams>, view: &AccountView) -> Assessment {
    Assessment {
        market_id: position.market_id.clone(),
        side: position.side.clone(),
        size: position.size,
        notional: position.notional_value,
        maintenance_margin: maintenance_term(position, params).ok(),
        health: health_of(position, params, view),
    }
}

fn health_of(position: &Position, params: Option<&RiskParams>, view: &AccountView) -> Health {
    if position.size.is_zero() {
        return Health::Unknown(Unproven::FlatPosition);
    }
    // A provable breach is reported next and unconditionally: it is the one
    // answer that stays true no matter what else is missing, and burying it
    // under a "cannot compute" is the failure this module is arranged to avoid.
    if view.provably_breached {
        return Health::Breached;
    }
    let Some(headroom) = view.headroom else {
        return Health::Unknown(Unproven::EquityNotReported);
    };
    let signed = match signed_size(position) {
        Ok(signed) => signed,
        Err(missing) => return Health::Unknown(Unproven::Position(missing)),
    };
    let Some(params) = params else {
        return Health::Unknown(Unproven::Position(Missing::RiskParams));
    };
    let Some(notional) = position.notional_value else {
        return Health::Unknown(Unproven::Position(Missing::Notional(
            position
                .notional_value_error
                .clone()
                .unwrap_or_else(|| "reason not reported".to_string()),
        )));
    };
    // This position reports, but somebody else's maintenance term does not, so
    // `headroom` is only an upper bound. Dividing by it yields a distance that is
    // too large — the optimistic direction — which is precisely the answer this
    // app must not print.
    if !view.missing.is_empty() {
        return Health::Unknown(Unproven::AccountHeadroom(view.missing.clone()));
    }

    let quantity = signed.abs();
    let rate = params.maintenance_margin_rate;
    let falls = signed > Decimal::ZERO;
    // `(1 − r)` for a long, `(1 + r)` for a short. A maintenance rate at or above
    // 1 would describe a position that can never be solvent; refuse rather than
    // divide by zero or flip the sign.
    let coefficient = if falls {
        Decimal::ONE - rate
    } else {
        Decimal::ONE + rate
    };
    if coefficient <= Decimal::ZERO {
        return Health::Unknown(Unproven::Position(Missing::RiskParams));
    }
    if notional <= Decimal::ZERO {
        return Health::Unknown(Unproven::Position(Missing::Notional(
            "notional is not positive".to_string(),
        )));
    }
    let exact_move = headroom / (quantity * coefficient);
    // The mark implied by the snapshot itself: one division over two exact values
    // from the same read. Never an f64, and never a mark from another request.
    let mark = notional / quantity;
    // Every rounding below goes the same way — towards liquidation. The printed
    // distance is never larger than the exact one and the printed liquidation
    // price is never further from the mark, so display precision can only make
    // the report read more urgent, never less.
    Health::Fragile(Distance {
        mark: mark.round_dp(DISPLAY_DP),
        liquidation_price: if falls {
            (mark - exact_move)
                .round_dp_with_strategy(DISPLAY_DP, RoundingStrategy::ToPositiveInfinity)
        } else {
            (mark + exact_move)
                .round_dp_with_strategy(DISPLAY_DP, RoundingStrategy::ToNegativeInfinity)
        },
        move_to_liquidation: exact_move
            .round_dp_with_strategy(DISPLAY_DP, RoundingStrategy::ToZero),
        fraction_of_mark: (exact_move / mark)
            .round_dp_with_strategy(DISPLAY_DP, RoundingStrategy::ToZero),
        falls,
    })
}

/// Rank key: most fragile first. A provable breach outranks every number,
/// computed distances sort ascending, and everything unproven sorts last — an
/// `Unknown` mixed in among the numbers would be read as a position of that
/// fragility.
pub fn fragility_key(assessment: &Assessment) -> (u8, Decimal) {
    match &assessment.health {
        Health::Breached => (0, Decimal::ZERO),
        Health::Fragile(distance) => (1, distance.fraction_of_mark),
        Health::Unknown(_) => (2, Decimal::ZERO),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A verbatim capture of one element of
    /// `GET https://api.testnet.nexus.xyz/indexer/demo/positions`, taken
    /// 2026-09-09. It does two jobs.
    ///
    /// It pins the **wire types**: every monetary field here is a JSON string,
    /// and the SDK decodes them with `rust_decimal::serde::str`, which hard-fails
    /// on a JSON number. If the indexer ever starts emitting these as numbers —
    /// the divergence ENG-8439 records on the portfolio-history series — this
    /// test fails loudly rather than the app quietly losing precision.
    ///
    /// And it records the fields the wire carries that the SDK's `Position` does
    /// not: `margin_mode`, `liquidation_price_error`, `mark_price`, `collateral`.
    /// Serde drops unknown fields in silence, which is exactly why this app
    /// cannot tell a cross position from an isolated one — see the crate docs.
    const WIRE_POSITION: &str = r#"{
        "collateral": null,
        "collateral_error": "cross_margin_no_allocation",
        "contract_size": "1",
        "entry_price": "78348.254927880413162012254774",
        "funding_paid": "-0",
        "last_price": null,
        "last_price_error": "no_trades_yet",
        "leverage": null,
        "leverage_error": "margin_state_not_mirrored",
        "liquidation_price": null,
        "liquidation_price_error": "margin_state_not_mirrored",
        "margin_mode": "cross",
        "margin_used": "2467.43752500",
        "mark_price": "78331.350",
        "market_id": "BTC-USDX-PERP",
        "max_leverage": 50,
        "notional_value": "123371.876250",
        "opened_at": 1789013745087,
        "realized_pnl": "620.69698858834926983069876696",
        "roe": "0.0107906527082791002658927581",
        "side": "Short",
        "size": "1.575",
        "unrealized_pnl": "26.625261411650730169301269050",
        "updated_at": 1789013838310
    }"#;

    fn dec(text: &str) -> Decimal {
        Decimal::from_str_exact(text).expect("test literal must parse exactly")
    }

    fn position(market: &str, side: &str, size: &str, notional: Option<&str>) -> Position {
        let notional = match notional {
            Some(value) => format!(r#""notional_value": "{value}""#),
            None => r#""notional_value": null, "notional_value_error": "mark_price_unavailable""#
                .to_string(),
        };
        serde_json::from_str(&format!(
            r#"{{
                "market_id": "{market}",
                "side": "{side}",
                "size": "{size}",
                "entry_price": "0",
                "unrealized_pnl": "0",
                "realized_pnl": "0",
                {notional}
            }}"#
        ))
        .expect("fixture must decode through the SDK type")
    }

    fn params(rate: &str) -> RiskParams {
        RiskParams {
            maintenance_margin_rate: dec(rate),
            initial_margin_rate: dec("0.02"),
            max_leverage: 50,
        }
    }

    fn every_market(positions: &[Position], rate: &str) -> RiskParamsByMarket {
        positions
            .iter()
            .map(|p| (p.market_id.clone(), params(rate)))
            .collect()
    }

    #[test]
    fn wire_capture_decodes_with_money_as_decimal_strings() {
        let decoded: Position =
            serde_json::from_str(WIRE_POSITION).expect("wire capture must decode");
        assert_eq!(decoded.size, dec("1.575"));
        assert_eq!(decoded.notional_value, Some(dec("123371.876250")));
        assert_eq!(
            decoded.unrealized_pnl,
            dec("26.625261411650730169301269050")
        );
        assert_eq!(decoded.side, "Short");
        // The venue publishes no liquidation price here, which is the reason this
        // app exists: `liquidation_price` is null, and the wire's paired
        // `liquidation_price_error` (a field the SDK does not carry) reads
        // `margin_state_not_mirrored`.
        assert_eq!(decoded.liquidation_price, None);
    }

    #[test]
    fn a_money_field_sent_as_a_json_number_is_refused_not_rounded() {
        // The ENG-8439 shape, applied to a field that decides a liquidation
        // distance. A loud decode failure beats an f64 quietly deciding it.
        let numeric = WIRE_POSITION.replace(r#""size": "1.575""#, r#""size": 1.575"#);
        assert!(serde_json::from_str::<Position>(&numeric).is_err());
    }

    #[test]
    fn long_liquidates_on_a_fall_and_short_on_a_rise() {
        // One unit at a mark of 100, maintenance 10%, equity 20 ⇒ MM = 10, H = 10.
        let long = position("BTC-USDX-PERP", "Long", "1", Some("100"));
        let short = position("ETH-USDX-PERP", "Short", "1", Some("100"));

        let view = account_view(
            std::slice::from_ref(&long),
            Some(dec("20")),
            &every_market(std::slice::from_ref(&long), "0.1"),
        );
        let Health::Fragile(distance) = assess(&long, Some(&params("0.1")), &view).health else {
            panic!("a fully-reporting long must be computable");
        };
        assert!(distance.falls);
        // 10 / (1 × 0.9) = 11.111…, so liquidation at 88.888…
        assert_eq!(distance.move_to_liquidation, dec("11.11111111"));
        assert_eq!(distance.liquidation_price, dec("88.88888889"));

        let view = account_view(
            std::slice::from_ref(&short),
            Some(dec("20")),
            &every_market(std::slice::from_ref(&short), "0.1"),
        );
        let Health::Fragile(distance) = assess(&short, Some(&params("0.1")), &view).health else {
            panic!("a fully-reporting short must be computable");
        };
        assert!(!distance.falls);
        // 10 / (1 × 1.1) = 9.0909…, so liquidation at 109.0909…
        assert_eq!(distance.move_to_liquidation, dec("9.09090909"));
        assert_eq!(distance.liquidation_price, dec("109.09090909"));
    }

    #[test]
    fn rounding_moves_the_printed_answer_towards_liquidation() {
        // H = 40 − 30 = 10; move = 10 / (3 × 0.9) = 3.703703…; mark = 100. The
        // exact liquidation price is 96.296296…, and the printed one is rounded
        // *up* — nearer the mark, so nearer liquidation.
        let long = position("BTC-USDX-PERP", "Long", "3", Some("300"));
        let view = account_view(
            std::slice::from_ref(&long),
            Some(dec("40")),
            &every_market(std::slice::from_ref(&long), "0.1"),
        );
        let Health::Fragile(distance) = assess(&long, Some(&params("0.1")), &view).health else {
            panic!("computable");
        };
        assert_eq!(distance.move_to_liquidation, dec("3.70370370"));
        assert_eq!(distance.liquidation_price, dec("96.29629630"));
        // Rounded up, past the exact value truncated at the same precision —
        // which is the direction that matters: nearer the mark, nearer the
        // trigger.
        assert!(distance.liquidation_price > dec("96.29629629"));
    }

    #[test]
    fn a_provable_breach_survives_a_missing_mark_price() {
        // One leg reports and already exhausts the headroom on its own; the other
        // has no notional at all. A missing term can only make MM larger, so the
        // breach is proven and must be reported as such, not as "cannot compute".
        let reporting = position("BTC-USDX-PERP", "Long", "1", Some("1000"));
        let dark = position("ETH-USDX-PERP", "Long", "1", None);
        let positions = vec![reporting.clone(), dark.clone()];
        let params_by_market = every_market(&positions, "0.1");
        let view = account_view(&positions, Some(dec("50")), &params_by_market);
        assert!(
            view.provably_breached,
            "MM of 100 already exceeds equity of 50 on the reporting leg alone"
        );
        assert_eq!(view.missing.len(), 1);
        assert_eq!(
            assess(&reporting, Some(&params("0.1")), &view).health,
            Health::Breached
        );
        assert_eq!(
            assess(&dark, Some(&params("0.1")), &view).health,
            Health::Breached
        );
    }

    #[test]
    fn a_missing_mark_price_makes_a_healthy_account_unknown_not_safe() {
        let reporting = position("BTC-USDX-PERP", "Long", "1", Some("100"));
        let dark = position("ETH-USDX-PERP", "Long", "1", None);
        let positions = vec![reporting.clone(), dark.clone()];
        // Equity 500 against a *known* MM of 10: healthy on what reports, while
        // the dark leg could be arbitrarily large.
        let view = account_view(
            &positions,
            Some(dec("500")),
            &every_market(&positions, "0.1"),
        );
        assert!(!view.provably_breached);
        match assess(&reporting, Some(&params("0.1")), &view).health {
            Health::Unknown(Unproven::AccountHeadroom(markets)) => {
                assert_eq!(markets, vec!["ETH-USDX-PERP (mark_price_unavailable)"]);
            }
            other => panic!("an incomplete headroom must not yield a distance: {other:?}"),
        }
    }

    #[test]
    fn a_missing_risk_param_is_unknown_not_a_zero_maintenance_rate() {
        // The dangerous default: no maintenance rate reads as "no margin
        // required", which would report an account as maximally healthy.
        let long = position("BTC-USDX-PERP", "Long", "1", Some("100"));
        let view = account_view(
            std::slice::from_ref(&long),
            Some(dec("500")),
            &RiskParamsByMarket::new(),
        );
        assert_eq!(view.maintenance_margin, Decimal::ZERO);
        assert_eq!(
            view.missing,
            vec!["BTC-USDX-PERP (risk_params_unavailable)"]
        );
        assert_eq!(
            assess(&long, None, &view).health,
            Health::Unknown(Unproven::Position(Missing::RiskParams))
        );
    }

    #[test]
    fn unreported_equity_is_never_read_as_zero() {
        let long = position("BTC-USDX-PERP", "Long", "1", Some("100"));
        let view = account_view(
            std::slice::from_ref(&long),
            None,
            &every_market(std::slice::from_ref(&long), "0.1"),
        );
        assert!(
            !view.provably_breached,
            "no equity is an unknown, not a breach"
        );
        assert_eq!(
            assess(&long, Some(&params("0.1")), &view).health,
            Health::Unknown(Unproven::EquityNotReported)
        );
    }

    #[test]
    fn a_flat_position_neither_charges_margin_nor_poisons_the_account() {
        let flat = position("BTC-USDX-PERP", "Long", "0", None);
        let live = position("ETH-USDX-PERP", "Long", "1", Some("100"));
        let positions = vec![flat.clone(), live.clone()];
        let view = account_view(
            &positions,
            Some(dec("500")),
            &every_market(&positions, "0.1"),
        );
        assert!(
            view.missing.is_empty(),
            "a flat leg has no maintenance term to be missing"
        );
        assert_eq!(view.maintenance_margin, dec("10"));
        assert!(matches!(
            assess(&flat, Some(&params("0.1")), &view).health,
            Health::Unknown(Unproven::FlatPosition)
        ));
        assert!(matches!(
            assess(&live, Some(&params("0.1")), &view).health,
            Health::Fragile(_)
        ));
    }

    #[test]
    fn an_unrecognised_side_is_refused_rather_than_assumed_long() {
        let odd = position("BTC-USDX-PERP", "sideways", "1", Some("100"));
        let view = account_view(
            std::slice::from_ref(&odd),
            Some(dec("500")),
            &every_market(std::slice::from_ref(&odd), "0.1"),
        );
        assert_eq!(
            assess(&odd, Some(&params("0.1")), &view).health,
            Health::Unknown(Unproven::Position(Missing::UnrecognisedSide(
                "sideways".to_string()
            )))
        );
    }

    #[test]
    fn the_most_fragile_position_sorts_first() {
        let near = position("BTC-USDX-PERP", "Long", "10", Some("1000"));
        let far = position("ETH-USDX-PERP", "Long", "1", Some("100"));
        let positions = vec![near.clone(), far.clone()];
        let params_by_market = every_market(&positions, "0.1");
        let view = account_view(&positions, Some(dec("200")), &params_by_market);
        let mut rows: Vec<Assessment> = positions
            .iter()
            .map(|p| assess(p, params_by_market.get(&p.market_id), &view))
            .collect();
        rows.sort_by_key(fragility_key);
        assert_eq!(rows[0].market_id, "BTC-USDX-PERP");
    }

    /// The published demo mirror's own account, decoded and run through the
    /// maths: equity 27.90 against a maintenance requirement of 1,233.72 at the
    /// live 1% rate — a breach the engine would already act on.
    #[test]
    fn the_public_demo_snapshot_is_provably_past_maintenance() {
        let position: Position =
            serde_json::from_str(WIRE_POSITION).expect("wire capture must decode");
        let positions = std::slice::from_ref(&position);
        let params_by_market = every_market(positions, "0.01");
        let view = account_view(
            positions,
            Some(dec("27.904948911650730169301269050")),
            &params_by_market,
        );
        assert_eq!(view.maintenance_margin, dec("1233.71876250"));
        assert!(view.provably_breached);
        assert_eq!(
            assess(&position, params_by_market.get(&position.market_id), &view).health,
            Health::Breached
        );
    }
}
