//! The venue's auto-deleveraging record: what the engine actually did the last
//! time the insurance fund ran out in a market.
//!
//! Pure, like [`crate::margin`] — it summarises events, it does not fetch them.
//!
//! # This is history, not a forecast
//!
//! Nothing here predicts anything. An `AdlEvent` is a settled fact: a bankrupt
//! account, the price its position was settled at, the bad debt the insurance
//! fund absorbed before it gave out, and the opposite-side positions the engine
//! closed to absorb the rest. It sits next to the distance estimate for one
//! reason — the estimate answers "how close am I to being closed by the
//! engine?", and this answers "and what does being closed by this engine, in
//! this market, look like?". A market with a live ADL record is one where the
//! tail has already been reached at least once. A market with none has not been
//! observed to reach it, which is not the same as being safe.
//!
//! # Two counts, and they measure different things
//!
//! `GET /api/v1/markets/{id}/status` reports `adl_event_count` and needs no
//! credentials. `GET /markets/{id}/adl-events` returns the events themselves and
//! is HMAC-gated (measured: `401 UNAUTHORIZED` unsigned). The count is the
//! market's lifetime total; the event list is a bounded, most-recent-first page.
//! So the two disagree whenever the history is longer than the page, and the
//! report prints both rather than reconciling them into one number that would be
//! wrong in one of the two senses.

use nexus_exchange::types::AdlEvent;
use rust_decimal::Decimal;

/// What a page of ADL events says about a market.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdlRecord {
    /// Events on this page.
    pub events: usize,
    /// Opposite-side positions the engine closed across them.
    pub counterparty_closures: usize,
    /// Bad debt the insurance fund absorbed before counterparties were closed,
    /// summed exactly. Every term is a decimal string on the wire.
    pub bad_debt_absorbed_by_fund: Decimal,
    /// Size closed out of counterparties, summed exactly.
    pub position_closed: Decimal,
    /// Unix ms of the most recent event on the page, `None` when the page is
    /// empty.
    pub latest_timestamp_ms: Option<i64>,
    /// Engine sequence number of the most recent event.
    pub latest_sequence: Option<u64>,
    /// Bankruptcy price of the most recent event.
    pub latest_bankruptcy_price: Option<Decimal>,
}

impl AdlRecord {
    pub fn is_empty(&self) -> bool {
        self.events == 0
    }
}

/// Summarise a page of events.
///
/// The endpoint documents most-recent-first ordering, but "most recent" is read
/// off the events themselves rather than taken as position zero: an ordering
/// change server-side should degrade to a still-correct summary, not to a
/// silently wrong "latest".
pub fn summarise(events: &[AdlEvent]) -> AdlRecord {
    let latest = events
        .iter()
        .max_by_key(|event| (event.timestamp, event.sequence));
    AdlRecord {
        events: events.len(),
        counterparty_closures: events
            .iter()
            .map(|event| event.counterparty_closures.len())
            .sum(),
        bad_debt_absorbed_by_fund: events
            .iter()
            .map(|event| event.bad_debt_absorbed_by_fund)
            .sum(),
        position_closed: events
            .iter()
            .flat_map(|event| &event.counterparty_closures)
            .map(|closure| closure.position_closed)
            .sum(),
        latest_timestamp_ms: latest.map(|event| event.timestamp),
        latest_sequence: latest.map(|event| event.sequence),
        latest_bankruptcy_price: latest.map(|event| event.bankruptcy_price),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped to the spec's `AdlEventRecord`: `bankruptcy_price`,
    /// `bad_debt_absorbed_by_fund`, `position_closed` and `settlement_amount`
    /// are all `Decimal` — decimal strings, decoded exactly. No live capture is
    /// pinned here because the endpoint is HMAC-gated and this repo holds no
    /// credentials; the shape below is the SDK's own `AdlEvent` / `AdlClosure`,
    /// which is generated from the spec.
    fn events() -> Vec<AdlEvent> {
        serde_json::from_str(
            r#"[
                {
                    "market_id": "BTC-USDX-PERP",
                    "target_account": "0x1111111111111111111111111111111111111111",
                    "bankruptcy_price": "61234.5",
                    "bad_debt_absorbed_by_fund": "1200.25",
                    "counterparty_closures": [
                        {
                            "account_id": "0x2222222222222222222222222222222222222222",
                            "position_closed": "0.4",
                            "settlement_amount": "24493.8"
                        },
                        {
                            "account_id": "0x3333333333333333333333333333333333333333",
                            "position_closed": "0.1",
                            "settlement_amount": "6123.45"
                        }
                    ],
                    "sequence": 9002,
                    "timestamp": 1789000000000
                },
                {
                    "market_id": "BTC-USDX-PERP",
                    "target_account": "0x4444444444444444444444444444444444444444",
                    "bankruptcy_price": "58000.75",
                    "bad_debt_absorbed_by_fund": "0.75",
                    "counterparty_closures": [],
                    "sequence": 8100,
                    "timestamp": 1788000000000
                }
            ]"#,
        )
        .expect("fixture must decode through the SDK types")
    }

    fn dec(text: &str) -> Decimal {
        Decimal::from_str_exact(text).expect("test literal must parse exactly")
    }

    #[test]
    fn an_empty_record_is_empty_and_not_zero_risk() {
        let record = summarise(&[]);
        assert!(record.is_empty());
        assert_eq!(record.latest_timestamp_ms, None);
        assert_eq!(record.bad_debt_absorbed_by_fund, Decimal::ZERO);
    }

    #[test]
    fn bad_debt_and_closures_sum_exactly() {
        let record = summarise(&events());
        assert_eq!(record.events, 2);
        assert_eq!(record.counterparty_closures, 2);
        assert_eq!(record.bad_debt_absorbed_by_fund, dec("1201.00"));
        assert_eq!(record.position_closed, dec("0.5"));
    }

    #[test]
    fn the_latest_event_is_found_by_timestamp_not_by_position() {
        // Reversed into oldest-first. The summary must still name the newer one.
        let mut reversed = events();
        reversed.reverse();
        let record = summarise(&reversed);
        assert_eq!(record.latest_sequence, Some(9002));
        assert_eq!(record.latest_bankruptcy_price, Some(dec("61234.5")));
        assert_eq!(record.latest_timestamp_ms, Some(1789000000000));
    }
}
