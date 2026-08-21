//! The decision: given a snapshot of the account, is any limit breached?
//!
//! This module is deliberately pure — no network, no clock, no mutable state.
//! Everything that decides whether the guard fires lives in one function you
//! can read top to bottom, which is the property that makes a guard
//! trustworthy.
//!
//! # The rule that matters
//!
//! A limit has **three** outcomes here, not two: within, breached, and
//! *unknown*. That third one is the whole point.
//!
//! The exchange reports a position's risk fields as nullable, each paired with
//! a machine-readable reason it is missing ([`Position::notional_value`] and
//! [`Position::notional_value_error`], and friends). The mark price may not be
//! mirrored yet; market params may be unavailable. A guard that treats a
//! missing notional as zero quietly concludes "exposure is under the limit" at
//! the exact moment it has no idea what the exposure is — it would go green
//! during the outage that most warrants attention.
//!
//! So a limit whose inputs are incomplete reports `Unknown`, never `Within`,
//! and the caller treats that as "cannot prove safe" rather than "safe".

use nexus_exchange::types::Position;
use rust_decimal::Decimal;

use crate::config::Limits;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Within,
    Breached,
    /// Inputs were incomplete, so this limit could not be proven either way.
    Unknown,
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub limit: &'static str,
    pub state: State,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct Verdict {
    pub findings: Vec<Finding>,
}

impl Verdict {
    /// Any limit breached. The only state that fires the guard.
    pub fn breached(&self) -> bool {
        self.findings.iter().any(|f| f.state == State::Breached)
    }

    /// Any limit that could not be proven within.
    pub fn indeterminate(&self) -> bool {
        self.findings.iter().any(|f| f.state == State::Unknown)
    }
}

/// Total notional across open positions.
///
/// Returns `Err` with the offending markets — not a partial sum — when any
/// position that could contribute cannot report its notional. A partial sum is
/// the dangerous answer: it is smaller than the truth and therefore likelier to
/// sit under the limit. Either every position counts or the total is unknown.
///
/// The one exception is a position with zero size, and it is not a softening of
/// that rule. `notional_value` is defined as `|size| × mark price`, so a flat
/// position contributes provably nothing whatever the mark price is, and its
/// missing mark price says nothing about the account's exposure. Without this,
/// a single flat or dust position in a market the indexer has stopped mirroring
/// would pin `max-notional` to `Unknown` on every tick from then on — and a
/// limit that is permanently unprovable is a limit that never checks anything,
/// including the genuine breach happening elsewhere in the account. Strictness
/// is kept exactly where it can hide exposure.
fn total_notional(positions: &[Position]) -> Result<Decimal, Vec<String>> {
    let mut total = Decimal::ZERO;
    let mut missing = Vec::new();
    for position in positions {
        if position.size.is_zero() {
            continue;
        }
        match position.notional_value {
            Some(value) => total += value,
            None => {
                // The paired `*_error` field names the reason; surfacing it is
                // the difference between "the guard is confused" and "the mark
                // price is unavailable for BTC-USDX-PERP".
                let reason = position
                    .notional_value_error
                    .as_deref()
                    .unwrap_or("reason not reported");
                missing.push(format!("{} ({reason})", position.market_id));
            }
        }
    }
    if missing.is_empty() {
        Ok(total)
    } else {
        Err(missing)
    }
}

/// Total unrealized PnL. Non-nullable in the API, so this is always exact.
fn total_unrealized(positions: &[Position]) -> Decimal {
    positions.iter().map(|p| p.unrealized_pnl).sum()
}

pub fn evaluate(
    positions: &[Position],
    available_margin: Decimal,
    limits: &Limits,
) -> Verdict {
    let mut findings = Vec::new();

    if let Some(cap) = limits.max_notional {
        match total_notional(positions) {
            Ok(total) => findings.push(Finding {
                limit: "max-notional",
                state: if total > cap { State::Breached } else { State::Within },
                detail: format!("notional {total} vs limit {cap}"),
            }),
            Err(missing) => findings.push(Finding {
                limit: "max-notional",
                state: State::Unknown,
                detail: format!(
                    "cannot total notional — no mark price for {}. \
                     Treating exposure as unproven rather than as zero.",
                    missing.join(", ")
                ),
            }),
        }
    }

    if let Some(cap) = limits.max_loss {
        let unrealized = total_unrealized(positions);
        // A loss is negative PnL. Compare magnitudes so the limit reads as a
        // positive number in configuration, which is how people think about it.
        let loss = if unrealized < Decimal::ZERO {
            -unrealized
        } else {
            Decimal::ZERO
        };
        findings.push(Finding {
            limit: "max-loss",
            state: if loss > cap { State::Breached } else { State::Within },
            detail: format!("unrealized {unrealized} (loss {loss}) vs limit {cap}"),
        });
    }

    if let Some(floor) = limits.min_available_margin {
        findings.push(Finding {
            limit: "min-available-margin",
            state: if available_margin < floor {
                State::Breached
            } else {
                State::Within
            },
            detail: format!("available {available_margin} vs floor {floor}"),
        });
    }

    Verdict { findings }
}
