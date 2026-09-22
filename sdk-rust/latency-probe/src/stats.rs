//! Percentiles that say how much they can be trusted, and a clock-offset
//! estimate that says how it was made.

use std::fmt::Write as _;

/// Below this, p95 and p99 are the maximum under nearest-rank and so say
/// nothing the `max` column does not. Printed as a warning, not hidden.
pub const MIN_MEANINGFUL_SAMPLES: usize = 20;

/// Nearest-rank percentile over an already-sorted slice: the smallest value
/// with at least `p`% of the sample at or below it. No interpolation, so every
/// number printed is a latency that was actually observed.
///
/// Returns the value and its 1-based rank, so the caller can say when a
/// percentile is really just the max.
pub fn nearest_rank(sorted: &[f64], p: f64) -> Option<(f64, usize)> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len();
    let rank = ((p / 100.0) * n as f64).ceil().clamp(1.0, n as f64) as usize;
    Some((sorted[rank - 1], rank))
}

/// One stage's samples in milliseconds, plus how many rounds produced none.
#[derive(Debug, Default, Clone)]
pub struct Stage {
    pub name: &'static str,
    pub samples: Vec<f64>,
    /// Rounds that reached this stage but got no measurement: for a WS stage,
    /// no matching frame inside the wait window. Never folded into the
    /// percentiles as a "timeout" value — that would invent a latency.
    pub missing: usize,
    /// Waits cut short by Ctrl-C. Neither a sample nor missing: the frame was
    /// not given its full window, so it proves nothing either way.
    pub interrupted: usize,
}

impl Stage {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            ..Self::default()
        }
    }

    /// One table row: `name  n  p50  p95  p99  max  missing`.
    pub fn row(&self) -> String {
        let mut sorted = self.samples.clone();
        sorted.sort_by(f64::total_cmp);
        let n = sorted.len();
        let cell = |p: f64| match nearest_rank(&sorted, p) {
            None => "—".to_string(),
            Some((v, rank)) if rank == n && p < 100.0 && n > 1 => format!("{v:.1}*"),
            Some((v, _)) => format!("{v:.1}"),
        };
        let attempted = n + self.missing;
        let mut missing = if self.missing == 0 {
            "0".to_string()
        } else {
            format!("{} of {attempted}", self.missing)
        };
        if self.interrupted > 0 {
            missing.push_str(&format!(
                " (+{} wait cut short by Ctrl-C)",
                self.interrupted
            ));
        }
        format!(
            "{:<22} {:>4} {:>9} {:>9} {:>9} {:>9}   {}",
            self.name,
            n,
            cell(50.0),
            cell(95.0),
            cell(99.0),
            cell(100.0),
            missing
        )
    }
}

pub fn table(stages: &[&Stage]) -> String {
    let mut out = format!(
        "{:<22} {:>4} {:>9} {:>9} {:>9} {:>9}   {}\n",
        "stage (ms)", "n", "p50", "p95", "p99", "max", "missing"
    );
    for stage in stages {
        let _ = writeln!(out, "{}", stage.row());
    }
    out
}

/// Warnings a reader must see next to the table, not in a footnote.
pub fn sample_warnings(stages: &[&Stage]) -> Vec<String> {
    let mut out = Vec::new();
    let smallest = stages.iter().map(|s| s.samples.len()).min().unwrap_or(0);
    if smallest < MIN_MEANINGFUL_SAMPLES {
        out.push(format!(
            "small sample: the smallest stage has n={smallest}. Under nearest-rank, p95 needs \
             n≥20 and p99 needs n≥100 to be anything other than the max (marked *). Treat \
             these as a sketch, not a distribution."
        ));
    } else if smallest < 100 {
        out.push(format!(
            "n={smallest} on the smallest stage: p99 is the max (marked *) until n≥100."
        ));
    }
    for stage in stages {
        if stage.missing > 0 {
            out.push(format!(
                "{}: {} round(s) produced no matching WebSocket frame inside the wait window. \
                 They are reported as missing and excluded from the percentiles, which are \
                 therefore over the frames that did arrive.",
                stage.name, stage.missing
            ));
        }
    }
    out
}

/// Bounds on `θ = venue clock − local clock`, in milliseconds, built from
/// constraints that each hold regardless of network delay.
///
/// Two kinds of evidence, and they bound different sides:
///
/// * **A REST ack carrying the venue's `created_at`.** The venue stamped it at
///   some local instant between our send `s` and our ack `a`, so
///   `created_at − a ≤ θ ≤ created_at − s`. A two-sided bracket whose width is
///   the round trip — the same reasoning NTP uses, without assuming the two
///   legs are equal.
/// * **A WebSocket frame carrying `emitted_at`.** It left the venue before we
///   received it at `r`, so `θ ≥ emitted_at − r`. One-sided: delivery delay
///   only ever makes that bound looser, never wrong.
///
/// Intersecting every constraint gives the tightest interval all of them agree
/// on. An empty intersection is reported as such: it means the timestamps are
/// not all from one clock (or one of them is not what its name says), and
/// printing a midpoint anyway would be making a number up.
#[derive(Debug, Default, Clone)]
pub struct ClockBounds {
    pub lo: Option<f64>,
    pub hi: Option<f64>,
    pub rest_samples: usize,
    pub ws_samples: usize,
    /// Narrowest single REST bracket seen: `(width_ms, lo, hi)`.
    pub best_rest: Option<(f64, f64, f64)>,
}

impl ClockBounds {
    pub fn add_rest(&mut self, venue_ms: i64, sent_ms: f64, acked_ms: f64) {
        if venue_ms <= 0 || acked_ms < sent_ms {
            return;
        }
        let v = venue_ms as f64;
        // The venue's stamp has 1 ms resolution: widen by it so truncation can
        // never produce a false inconsistency.
        let (lo, hi) = (v - acked_ms, v + 1.0 - sent_ms);
        self.lo = Some(self.lo.map_or(lo, |x| x.max(lo)));
        self.hi = Some(self.hi.map_or(hi, |x| x.min(hi)));
        self.rest_samples += 1;
        let width = hi - lo;
        if self.best_rest.is_none_or(|(w, _, _)| width < w) {
            self.best_rest = Some((width, lo, hi));
        }
    }

    pub fn add_ws(&mut self, venue_ms: i64, received_ms: f64) {
        if venue_ms <= 0 {
            return;
        }
        let lo = venue_ms as f64 - received_ms;
        self.lo = Some(self.lo.map_or(lo, |x| x.max(lo)));
        self.ws_samples += 1;
    }

    pub fn describe(&self) -> Vec<String> {
        let mut out = vec![format!(
            "method: every REST ack brackets θ = venue − local between (created_at − ack) and \
             (created_at − send); every WS frame bounds it below by (emitted_at − receive). \
             The interval below is the intersection of all {} REST and {} WS constraints.",
            self.rest_samples, self.ws_samples
        )];
        match (self.lo, self.hi) {
            (None, None) => out.push(
                "no venue timestamps were usable (created_at / emitted_at absent or zero), so \
                 no offset is reported."
                    .to_string(),
            ),
            (Some(lo), None) => out.push(format!(
                "only a lower bound: venue clock is at least {lo:+.1} ms from local. No REST \
                 bracket, so no upper bound."
            )),
            (lo, Some(hi)) if lo.is_some_and(|lo| lo > hi) => out.push(format!(
                "INCONSISTENT: the constraints do not intersect (lower {:+.1} ms > upper {hi:+.1} \
                 ms). The timestamps are not all from one clock, so no single offset explains \
                 them and none is reported.",
                lo.unwrap_or_default()
            )),
            (lo, Some(hi)) => {
                let lo = lo.unwrap_or(f64::NEG_INFINITY);
                out.push(format!(
                    "venue clock − local clock ∈ [{lo:+.1}, {hi:+.1}] ms → {:+.1} ± {:.1} ms",
                    (lo + hi) / 2.0,
                    (hi - lo) / 2.0
                ));
            }
        }
        if let Some((w, lo, hi)) = self.best_rest {
            out.push(format!(
                "tightest single REST bracket: [{lo:+.1}, {hi:+.1}] ms ({w:.1} ms wide — one \
                 round trip)."
            ));
        }
        out.push(
            "latencies above are measured on the local monotonic clock only; this offset is \
             reported, never used to adjust them."
                .to_string(),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank_matches_the_textbook_definition() {
        let v: Vec<f64> = (1..=10).map(f64::from).collect();
        assert_eq!(nearest_rank(&v, 50.0), Some((5.0, 5)));
        assert_eq!(nearest_rank(&v, 95.0), Some((10.0, 10)));
        assert_eq!(nearest_rank(&v, 100.0), Some((10.0, 10)));
        assert_eq!(nearest_rank(&[], 50.0), None);
        let hundred: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(nearest_rank(&hundred, 99.0), Some((99.0, 99)));
    }

    #[test]
    fn a_percentile_that_is_really_the_max_is_marked() {
        let mut s = Stage::new("place→ack");
        s.samples = vec![1.0, 2.0, 3.0];
        let row = s.row();
        assert!(row.contains("3.0*"), "{row}");
    }

    #[test]
    fn missing_frames_are_counted_not_timed() {
        let mut s = Stage::new("place→ws");
        s.samples = vec![5.0, 6.0];
        s.missing = 3;
        assert!(s.row().contains("3 of 5"));
        // The percentiles are over the two that arrived — no 3000 ms "timeouts".
        assert!(!s.row().contains("3000"));
        assert!(sample_warnings(&[&s]).iter().any(|w| w.contains("missing")));
    }

    #[test]
    fn small_samples_warn() {
        let mut s = Stage::new("x");
        s.samples = vec![1.0; 5];
        assert!(sample_warnings(&[&s])[0].contains("small sample"));
        s.samples = vec![1.0; 150];
        assert!(sample_warnings(&[&s]).is_empty());
    }

    #[test]
    fn clock_bounds_intersect_rest_brackets_and_ws_floors() {
        let mut c = ClockBounds::default();
        // Venue 100 ms ahead. Send at 1000, ack at 1040, stamped at local 1020.
        c.add_rest(1120, 1000.0, 1040.0);
        assert_eq!((c.lo, c.hi), (Some(80.0), Some(121.0)));
        // A frame emitted at venue 1150 (local 1050), received at local 1060.
        c.add_ws(1150, 1060.0);
        assert_eq!(c.lo, Some(90.0));
        let text = c.describe().join("\n");
        assert!(text.contains("[+90.0, +121.0]"), "{text}");
    }

    #[test]
    fn disjoint_constraints_are_reported_as_inconsistent() {
        let mut c = ClockBounds::default();
        c.add_rest(1000, 1000.0, 1010.0); // θ ∈ [-10, +1]
        c.add_ws(2000, 1000.0); // θ ≥ +1000
        assert!(c.describe().join("\n").contains("INCONSISTENT"));
    }

    #[test]
    fn zero_timestamps_are_ignored() {
        let mut c = ClockBounds::default();
        c.add_rest(0, 1.0, 2.0);
        c.add_ws(0, 1.0);
        assert!(c.lo.is_none() && c.hi.is_none());
    }
}
