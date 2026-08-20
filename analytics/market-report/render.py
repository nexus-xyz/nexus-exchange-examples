"""Output: a terminal report, a CSV, and a self-contained HTML page.

Three renderings of the same analysis, and they round differently on purpose.
The terminal and HTML views are for reading, so they quantize to a fixed number
of places; the CSV is a data artifact that something else will compute on, so it
carries the full Decimal. Rounding for display is fine. Rounding on the way into
a file someone will sum is how a report becomes the source of a discrepancy.
"""

from __future__ import annotations

import csv
import html
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
from pathlib import Path
from typing import Sequence

from analysis import MarketAnalysis, VenueStats

DASH = "—"


@dataclass(frozen=True)
class ReportMeta:
    """Everything about the run itself that belongs in its own output."""

    base_url: str
    api_version: str
    generated_at: str
    window_label: str
    timeframe: str
    buckets_requested: int
    requests_made: int
    cache_hits: int
    strict: bool


def fmt(value: Decimal | None, places: int = 2) -> str:
    if value is None:
        return DASH
    try:
        quantum = Decimal(1).scaleb(-places)
        return str(value.quantize(quantum, rounding=ROUND_HALF_EVEN))
    except (InvalidOperation, ValueError):
        return DASH


def fmt_pct(value: Decimal | None, places: int = 2) -> str:
    if value is None:
        return DASH
    return fmt(value * 100, places)


def fmt_int(value: int | None) -> str:
    return f"{value:,}" if value is not None else DASH


def exact(value: Decimal | None) -> str:
    """Full precision, for the CSV. No quantize, no float, no exponent games."""
    return format(value, "f") if value is not None else ""


# ── terminal ────────────────────────────────────────────────────────────────

_COLUMNS: tuple[tuple[str, int], ...] = (
    ("MARKET", 16),
    ("STATUS", 8),
    ("CLOSE", 12),
    ("RET%", 8),
    ("VOL%ann", 9),
    ("HIGH", 12),
    ("LOW", 12),
    ("BASEVOL", 12),
    ("VWAP~", 12),
    ("FUND%ann", 9),
    ("COV%", 6),
)


def text_report(
    meta: ReportMeta, stats: VenueStats, analyses: Sequence[MarketAnalysis]
) -> str:
    lines: list[str] = []
    rule = "─" * sum(width + 1 for _, width in _COLUMNS)

    lines.append(f"Nexus Exchange market report — {meta.generated_at}")
    lines.append(rule)
    lines.append(f"{'host':<14}{meta.base_url}  (spec {meta.api_version}, testnet, play funds)")
    lines.append(
        f"{'window':<14}{meta.window_label} at {meta.timeframe} "
        f"= {meta.buckets_requested} buckets requested"
    )
    lines.append(
        f"{'requests':<14}{meta.requests_made} fetched, {meta.cache_hits} served from cache"
    )
    lines.append(
        f"{'venue':<14}health {stats.health}, ingest lag {fmt_int(stats.lag_ms)} ms, "
        f"sequence gaps {fmt_int(stats.gap_count)}"
    )
    lines.append(
        f"{'activity':<14}{fmt_int(stats.fills_total)} fills, "
        f"{fmt_int(stats.liquidations_total)} liquidations, "
        f"traders {fmt_int(stats.unique_traders_24h)}/24h "
        f"{fmt_int(stats.unique_traders_7d)}/7d {fmt_int(stats.unique_traders_30d)}/30d"
    )
    lines.append(rule)

    header = " ".join(name.ljust(width) for name, width in _COLUMNS)
    lines.append(header)
    for analysis in analyses:
        lines.append(_text_row(analysis))
    lines.append(rule)

    lines.append(_quality_block(analyses))
    return "\n".join(lines)


def _text_row(analysis: MarketAnalysis) -> str:
    snapshot = analysis.snapshot
    funding = analysis.funding
    series = analysis.series
    coverage = fmt_pct(series.coverage, 0) if series is not None else DASH

    cells = (
        snapshot.market,
        snapshot.status[:8],
        fmt(analysis.window_close),
        fmt_pct(analysis.window_return),
        fmt_pct(analysis.volatility_annual, 1),
        fmt(analysis.window_high),
        fmt(analysis.window_low),
        fmt(analysis.window_base_volume, 3),
        fmt(analysis.window_vwap),
        fmt_pct(funding.annualized, 2) if funding is not None else DASH,
        coverage,
    )
    return " ".join(str(cell).ljust(width) for cell, (_, width) in zip(cells, _COLUMNS))


def _quality_block(analyses: Sequence[MarketAnalysis]) -> str:
    lines: list[str] = ["data quality"]
    any_issue = False
    for analysis in analyses:
        issues = analysis.issues
        if not issues:
            continue
        any_issue = True
        lines.append(f"  {analysis.market}")
        for issue in issues:
            marker = {"fatal": "!", "warn": "*", "info": "·"}[issue.severity]
            lines.append(f"    {marker} {issue.code}: {issue.detail}")
    if not any_issue:
        lines.append("  nothing to report — every series was complete and on-grid.")
    lines.append("")
    lines.append(
        "  `!` no figures could be derived from that series, so its row is dashes "
        "rather than zeros.  `*` the feed is degraded in a way that changes what "
        "the numbers mean.  `·` normal bookkeeping."
    )
    lines.append("  --strict exits non-zero for `!` and `*`, never for `·`.")
    lines.append(
        "  RET/VOL/VWAP cover the buckets that came back, never an interpolated "
        "window. FUND%ann is the mean funding rate over the samples fetched, "
        "annualised at the interval observed in their timestamps."
    )
    return "\n".join(lines)


# ── CSV ─────────────────────────────────────────────────────────────────────

CSV_HEADER = (
    "market",
    "status",
    "halt_reason",
    "timeframe",
    "buckets_used",
    "buckets_expected",
    "coverage",
    "window_open",
    "window_high",
    "window_low",
    "window_close",
    "window_return",
    "window_base_volume",
    "window_vwap_approx",
    "volatility_annual",
    "return_samples",
    "return_samples_skipped",
    "funding_mean",
    "funding_annualized",
    "funding_interval_ms",
    "volume_24h",
    "trade_count_24h",
    "issue_codes",
)


def write_csv(path: Path, analyses: Sequence[MarketAnalysis]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="" is required by the csv module, not optional style: without it,
    # Python's universal newlines and the writer's own \r\n produce blank lines
    # between rows on some platforms.
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(CSV_HEADER)
        for analysis in analyses:
            series = analysis.series
            funding = analysis.funding
            returns = analysis.returns
            writer.writerow(
                (
                    analysis.market,
                    analysis.snapshot.status,
                    analysis.snapshot.halt_reason or "",
                    series.requested_timeframe if series is not None else "",
                    len(series.candles) if series is not None else 0,
                    series.expected_buckets if series is not None else 0,
                    exact(series.coverage) if series is not None else "",
                    exact(analysis.window_open),
                    exact(analysis.window_high),
                    exact(analysis.window_low),
                    exact(analysis.window_close),
                    exact(analysis.window_return),
                    exact(analysis.window_base_volume),
                    exact(analysis.window_vwap),
                    exact(analysis.volatility_annual),
                    returns.count if returns is not None else 0,
                    returns.skipped_gaps if returns is not None else 0,
                    exact(funding.mean_rate) if funding is not None else "",
                    exact(funding.annualized) if funding is not None else "",
                    funding.step_ms if funding is not None and funding.step_ms else "",
                    exact(analysis.snapshot.volume_24h),
                    analysis.snapshot.trade_count if analysis.snapshot.trade_count else "",
                    " ".join(issue.code for issue in analysis.issues),
                )
            )


# ── HTML, with hand-rolled inline SVG ───────────────────────────────────────


def sparkline(values: Sequence[Decimal], width: int = 220, height: int = 40) -> str:
    """An inline SVG polyline. No chart library, no CDN, no external asset.

    The one place a float is legitimate: these are pixel coordinates, not money.
    A quarter-pixel of rounding error is invisible, and the Decimals are already
    safely rendered as text elsewhere in the page. Every other number in this
    program stays exact.
    """
    if len(values) < 2:
        return ""
    low = min(values)
    high = max(values)
    span = high - low
    step = width / (len(values) - 1)
    points: list[str] = []
    for index, value in enumerate(values):
        if span == 0:
            y = height / 2
        else:
            y = height - float((value - low) / span) * height
        points.append(f"{index * step:.2f},{y:.2f}")
    body = " ".join(points)
    return (
        f'<svg class="spark" viewBox="0 0 {width} {height}" width="{width}" '
        f'height="{height}" role="img" aria-label="sparkline" '
        f'preserveAspectRatio="none"><polyline points="{body}" fill="none" '
        f'stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"'
        f" /></svg>"
    )


_STYLE = """
:root { color-scheme: light dark; --fg: #16181d; --bg: #ffffff; --muted: #5c6370;
        --line: #e4e7ec; --warn: #8a5a00; --bad: #a11; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e8ec; --bg: #14161a; --muted: #9aa1ad; --line: #2a2e36;
          --warn: #e0b050; --bad: #ff8a80; }
}
body { margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 68rem; color: var(--fg);
       background: var(--bg); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system,
       "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
p.sub { color: var(--muted); margin: 0 0 1.5rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem;
          margin: 0 0 1.5rem; }
dl.meta dt { color: var(--muted); }
dl.meta dd { margin: 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: .4rem .55rem; border-bottom: 1px solid var(--line);
         white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
thead th { color: var(--muted); font-weight: 600; border-bottom-width: 2px; }
.spark { display: block; color: var(--fg); opacity: .8; }
ul.issues { margin: .35rem 0 1rem; padding-left: 1.1rem; color: var(--muted); }
ul.issues li { margin: .15rem 0; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.fatal { color: var(--bad); }
.warn { color: var(--warn); }
.info { color: var(--muted); }
footer { margin-top: 2.5rem; color: var(--muted); font-size: .9rem; }
"""


def html_report(
    meta: ReportMeta,
    stats: VenueStats,
    analyses: Sequence[MarketAnalysis],
    fill_history: Sequence[int],
) -> str:
    """A single file with no external requests, so it works from a file:// URL.

    Every string that came off the wire — a market id, a halt reason, an issue
    detail — goes through `html.escape`. None of them is under this program's
    control, and a report is exactly the sort of artifact that gets emailed
    around and opened later.
    """
    esc = html.escape
    out: list[str] = []
    out.append("<!doctype html>")
    out.append('<html lang="en"><head><meta charset="utf-8">')
    out.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    out.append("<title>Nexus Exchange market report</title>")
    out.append(f"<style>{_STYLE}</style></head><body>")
    out.append("<h1>Nexus Exchange market report</h1>")
    out.append(
        f'<p class="sub">{esc(meta.generated_at)} · testnet, play funds · '
        f"generated by <code>market-report</code></p>"
    )

    out.append('<dl class="meta">')
    for label, value in (
        ("host", f"{meta.base_url} (spec {meta.api_version})"),
        ("window", f"{meta.window_label} at {meta.timeframe}, {meta.buckets_requested} buckets requested"),
        ("requests", f"{meta.requests_made} fetched, {meta.cache_hits} from cache"),
        ("venue health", stats.health),
        (
            "activity",
            f"{fmt_int(stats.fills_total)} fills · "
            f"{fmt_int(stats.liquidations_total)} liquidations · "
            f"{fmt_int(stats.unique_traders_24h)} traders/24h",
        ),
    ):
        out.append(f"<dt>{esc(label)}</dt><dd>{esc(str(value))}</dd>")
    out.append("</dl>")

    if len(fill_history) >= 2:
        out.append("<h2>Venue fills per bucket</h2>")
        out.append(
            '<p class="sub">From <code>/stats/history</code>, which reports one row per '
            "event at irregular timestamps — bucketed here onto the report's own grid.</p>"
        )
        out.append(sparkline([Decimal(value) for value in fill_history], width=880, height=70))

    out.append("<h2>Markets</h2>")
    out.append('<div class="scroll"><table><thead><tr>')
    for column in (
        "Market",
        "Status",
        "Close",
        "Return",
        "Vol (ann.)",
        "High",
        "Low",
        "Base volume",
        "VWAP≈",
        "Funding (ann.)",
        "Coverage",
        "Closes",
    ):
        out.append(f"<th>{esc(column)}</th>")
    out.append("</tr></thead><tbody>")

    for analysis in analyses:
        series = analysis.series
        closes = [candle.close for candle in series.candles] if series is not None else []
        funding = analysis.funding
        status = analysis.snapshot.status
        if analysis.snapshot.halt_reason:
            status = f"{status} ({analysis.snapshot.halt_reason})"
        out.append("<tr>")
        out.append(f"<td>{esc(analysis.market)}</td>")
        out.append(f"<td>{esc(status)}</td>")
        out.append(f"<td>{esc(fmt(analysis.window_close))}</td>")
        out.append(f"<td>{esc(fmt_pct(analysis.window_return))}%</td>")
        out.append(f"<td>{esc(fmt_pct(analysis.volatility_annual, 1))}%</td>")
        out.append(f"<td>{esc(fmt(analysis.window_high))}</td>")
        out.append(f"<td>{esc(fmt(analysis.window_low))}</td>")
        out.append(f"<td>{esc(fmt(analysis.window_base_volume, 3))}</td>")
        out.append(f"<td>{esc(fmt(analysis.window_vwap))}</td>")
        out.append(
            f"<td>{esc(fmt_pct(funding.annualized, 2) if funding is not None else DASH)}%</td>"
        )
        out.append(
            f"<td>{esc(fmt_pct(series.coverage, 0) if series is not None else DASH)}%</td>"
        )
        out.append(f"<td>{sparkline(closes)}</td>")
        out.append("</tr>")
    out.append("</tbody></table></div>")

    out.append("<h2>Data quality</h2>")
    reported = False
    for analysis in analyses:
        if not analysis.issues:
            continue
        reported = True
        out.append(f"<p><strong>{esc(analysis.market)}</strong></p>")
        out.append('<ul class="issues">')
        for issue in analysis.issues:
            css = "fatal" if issue.fatal else ("warn" if issue.alertable else "info")
            out.append(
                f'<li><span class="{css}"><code>{esc(issue.code)}</code></span> '
                f"{esc(issue.detail)}</li>"
            )
        out.append("</ul>")
    if not reported:
        out.append('<p class="sub">Every series was complete and on-grid.</p>')

    out.append(
        "<footer>Volatility is the sample standard deviation of close-to-close "
        "simple returns over adjacent buckets only, annualised over a 365-day "
        "year. VWAP is approximated from candle typical prices. Figures cover "
        "the buckets returned, never an interpolated window.</footer>"
    )
    out.append("</body></html>")
    return "\n".join(out)
