"""The decision: given a snapshot of the account, is any limit breached?

This module is deliberately pure -- no network, no clock, no mutable state.
Everything that decides whether the guard fires lives in one function you can
read top to bottom, which is the property that makes a guard trustworthy.

The rule that matters
--------------------
A limit has **three** outcomes here, not two: within, breached, and *unknown*.
That third one is the whole point.

The exchange reports a position's risk fields as nullable, each paired with a
machine-readable reason it is missing (:attr:`Position.notional_value` and
:attr:`Position.notional_value_error`, and friends). The mark price may not be
mirrored yet; market params may be unavailable. A guard that treats a missing
notional as zero quietly concludes "exposure is under the limit" at the exact
moment it has no idea what the exposure is -- it would go green during the
outage that most warrants attention.

So a limit whose inputs are incomplete reports ``UNKNOWN``, never ``WITHIN``,
and the caller treats that as "cannot prove safe" rather than "safe". ``UNKNOWN``
does not fire the guard either: acting on data this app does not trust is its own
failure mode. It reports, and leaves the call to a human.

`unknown` is not a licence to stop reasoning
--------------------------------------------
It is the answer when the missing inputs *could change the outcome*, and only
then. ``notional_value`` is ``|size| x mark price``, so it is never negative,
which makes a partial sum a **lower bound** on the true total. If that bound
already exceeds the limit, no missing value can bring it back under and the
breach is *proven* -- reporting ``UNKNOWN`` there would be the mirror image of
the bug this module exists to avoid: refusing to act on a fact the app already
has, at exactly the moment it matters.

The same argument run the other way covers flat positions. At ``size == 0`` the
notional is provably zero whatever the mark price is, so a missing mark on a flat
position says nothing at all about exposure -- and counting it as missing would
pin ``max-notional`` to ``UNKNOWN`` on every tick from then on, which is a limit
that never checks anything.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from decimal import Decimal

from nexus_exchange import Position

from config import Limits


class State(enum.Enum):
    """One limit's outcome."""

    WITHIN = "within"
    BREACHED = "breached"
    #: Inputs were incomplete, so this limit could not be proven either way.
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Finding:
    limit: str
    state: State
    detail: str


@dataclass(frozen=True)
class Verdict:
    findings: tuple[Finding, ...]

    @property
    def breached(self) -> bool:
        """Any limit breached. The only state that fires the guard."""
        return any(f.state is State.BREACHED for f in self.findings)

    @property
    def indeterminate(self) -> bool:
        """Any limit that could not be proven within."""
        return any(f.state is State.UNKNOWN for f in self.findings)


@dataclass(frozen=True)
class Notional:
    """The notional total, and whether it is the whole story.

    ``total`` is exact when ``missing`` is empty. Otherwise ``total`` is a
    *lower bound*: the sum of the positions that did report, which no absent
    position can reduce. Never a partial sum passed off as a total -- that is
    the dangerous answer, since it is smaller than the truth and therefore
    likelier to sit under a limit.
    """

    total: Decimal
    missing: tuple[str, ...]

    @property
    def exact(self) -> bool:
        return not self.missing


def total_notional(positions: list[Position]) -> Notional:
    """Sum notional across open positions, reporting what it could not read.

    Flat positions are skipped rather than counted as missing -- see the module
    docstring for why that is a proof and not a softening of the rule.
    """
    total = Decimal(0)
    missing: list[str] = []
    for position in positions:
        if position.size == 0:
            continue
        value = position.notional_value
        if value is None:
            # The paired `*_error` field names the reason; surfacing it is the
            # difference between "the guard is confused" and "the mark price is
            # unavailable for BTC-USDX-PERP".
            reason = position.notional_value_error or "reason not reported"
            missing.append(f"{position.market_id} ({reason})")
            continue
        total += value
    return Notional(total=total, missing=tuple(missing))


def total_unrealized(positions: list[Position]) -> Decimal:
    """Total unrealized PnL. Non-nullable in the API, so this is always exact."""
    return sum((p.unrealized_pnl for p in positions), Decimal(0))


def evaluate(
    positions: list[Position],
    available_margin: Decimal,
    limits: Limits,
) -> Verdict:
    findings: list[Finding] = []

    if limits.max_notional is not None:
        cap = limits.max_notional
        notional = total_notional(positions)
        if notional.exact:
            findings.append(
                Finding(
                    limit="max-notional",
                    state=State.BREACHED if notional.total > cap else State.WITHIN,
                    detail=f"notional {notional.total} vs limit {cap}",
                )
            )
        elif notional.total > cap:
            # The bound is a real fact even though the total is not. Already over
            # means the breach cannot be undone by whatever is missing, so act on
            # what can be proven.
            findings.append(
                Finding(
                    limit="max-notional",
                    state=State.BREACHED,
                    detail=(
                        f"notional is at least {notional.total} vs limit {cap} — "
                        f"already over on the positions that do report, so no mark "
                        f"price for {', '.join(notional.missing)} can bring it back under"
                    ),
                )
            )
        else:
            # The genuine unknown: the missing values could still land either
            # side of the limit, and this app does not act on data it cannot
            # trust.
            findings.append(
                Finding(
                    limit="max-notional",
                    state=State.UNKNOWN,
                    detail=(
                        f"cannot total notional — no mark price for "
                        f"{', '.join(notional.missing)}. Counted {notional.total} so "
                        f"far, which is not over the limit of {cap}, so the true total "
                        f"could fall either side. Treating exposure as unproven rather "
                        f"than as zero"
                    ),
                )
            )

    if limits.max_loss is not None:
        cap = limits.max_loss
        unrealized = total_unrealized(positions)
        # A loss is negative PnL. Compare magnitudes so the limit reads as a
        # positive number in configuration, which is how people think about it.
        loss = -unrealized if unrealized < 0 else Decimal(0)
        findings.append(
            Finding(
                limit="max-loss",
                state=State.BREACHED if loss > cap else State.WITHIN,
                detail=f"unrealized {unrealized} (loss {loss}) vs limit {cap}",
            )
        )

    if limits.min_available_margin is not None:
        floor = limits.min_available_margin
        findings.append(
            Finding(
                limit="min-available-margin",
                state=State.BREACHED if available_margin < floor else State.WITHIN,
                detail=f"available {available_margin} vs floor {floor}",
            )
        )

    return Verdict(findings=tuple(findings))
