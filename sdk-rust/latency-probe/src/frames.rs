//! Reading `orders` frames without assuming their shape.
//!
//! The channel's semantics changed on 2026-09-22 (nexus#12163 projects an
//! STP-cancelled maker's `OrderUpdate`; nexus#12198 publishes a filled maker's
//! order state), and the SDK forwards payloads verbatim as JSON. So this module
//! does not decode into a struct that could silently fail to match. It
//! searches: a frame belongs to an order if the order's id or client id appears
//! anywhere in it, and its status is whatever `status` field it carries. What
//! the venue actually sent is then catalogued and printed, as observed.

use serde_json::Value;

/// What a frame says happened to the order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    /// The order is live on the book: `Open`, `New`, `Accepted`, `Resting`.
    Resting,
    /// It is gone because it was cancelled.
    Cancelled,
    /// Any fill. For an order priced to never fill, this is an alarm.
    Filled,
    /// Rejected or expired, or a status this app does not recognise.
    Other,
}

/// Depth-first search for a string equal to `needle`, anywhere in `value`.
pub fn mentions(value: &Value, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    match value {
        Value::String(s) => s == needle,
        Value::Array(items) => items.iter().any(|v| mentions(v, needle)),
        Value::Object(map) => map.values().any(|v| mentions(v, needle)),
        _ => false,
    }
}

/// The first value under `key`, searching depth-first.
fn find<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map
            .get(key)
            .or_else(|| map.values().find_map(|v| find(v, key))),
        Value::Array(items) => items.iter().find_map(|v| find(v, key)),
        _ => None,
    }
}

/// The engine event name when the payload is externally tagged — a single key
/// whose value is an object, as in `{"OrderUpdate": {...}}`.
pub fn tag(payload: &Value) -> Option<&str> {
    match payload {
        Value::Object(map) if map.len() == 1 => {
            let (key, inner) = map.iter().next()?;
            inner.is_object().then_some(key.as_str())
        }
        _ => None,
    }
}

pub fn status(payload: &Value) -> Option<&str> {
    find(payload, "status").and_then(Value::as_str)
}

/// `emitted_at` from inside the payload, when the SDK's envelope did not carry
/// one. nexus#12198 documents it inside the tagged body.
pub fn emitted_at(payload: &Value) -> Option<i64> {
    find(payload, "emitted_at")
        .and_then(Value::as_i64)
        .filter(|ms| *ms > 0)
}

pub fn classify(payload: &Value) -> Kind {
    let status = status(payload).unwrap_or("").to_ascii_lowercase();
    let tag = tag(payload).unwrap_or("").to_ascii_lowercase();
    if status.contains("cancel") || tag.contains("cancel") {
        Kind::Cancelled
    } else if status.contains("fill") || tag == "fill" {
        Kind::Filled
    } else if ["open", "new", "accepted", "resting"].contains(&status.as_str())
        || tag.contains("placed")
    {
        Kind::Resting
    } else {
        Kind::Other
    }
}

/// A one-line description of the frame's shape for the catalogue:
/// `OrderUpdate status=Open`. Never the payload itself — it carries the
/// account id.
pub fn shape(payload: &Value) -> String {
    let tag = tag(payload).unwrap_or("(untagged)");
    match status(payload) {
        Some(s) => format!("{tag} status={s}"),
        None => format!("{tag} (no status field)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shape nexus#12198 documents for the `orders` channel.
    fn order_update(status: &str) -> Value {
        json!({"OrderUpdate": {
            "order": {"id": "ord-1", "client_order_id": "lp-x-1", "status": status,
                      "market_id": "BTC-USDX-PERP", "side": "Buy"},
            "epoch": 3, "sequence": 99, "emitted_at": 1_790_000_000_123_i64
        }})
    }

    #[test]
    fn matches_by_id_or_client_id_anywhere() {
        let f = order_update("Open");
        assert!(mentions(&f, "ord-1"));
        assert!(mentions(&f, "lp-x-1"));
        assert!(!mentions(&f, "ord-2"));
        assert!(!mentions(&f, ""));
    }

    #[test]
    fn classifies_the_documented_statuses() {
        assert_eq!(classify(&order_update("Open")), Kind::Resting);
        assert_eq!(classify(&order_update("Cancelled")), Kind::Cancelled);
        assert_eq!(classify(&order_update("PartiallyFilled")), Kind::Filled);
        assert_eq!(classify(&order_update("Filled")), Kind::Filled);
        assert_eq!(classify(&order_update("Rejected")), Kind::Other);
        assert_eq!(
            classify(&json!({"OrderCancelled": {"order_id": "ord-1"}})),
            Kind::Cancelled
        );
    }

    #[test]
    fn reads_tag_status_and_emitted_at() {
        let f = order_update("Open");
        assert_eq!(tag(&f), Some("OrderUpdate"));
        assert_eq!(shape(&f), "OrderUpdate status=Open");
        assert_eq!(emitted_at(&f), Some(1_790_000_000_123));
        assert_eq!(shape(&json!({"id": "x"})), "(untagged) (no status field)");
    }
}
