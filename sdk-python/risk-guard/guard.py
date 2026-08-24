"""A standing risk guard for one Nexus Exchange account.

    python guard.py              # watch and report
    python guard.py --arm        # also cancel resting orders on a breach

It polls the account, checks it against limits you set, and -- only when armed --
cancels every resting order the moment a limit is breached. That is the entire
write surface: **this app can only ever reduce exposure.** It never places an
order, never amends one, and deliberately does not flatten positions, because
flattening means sending a market order and a market order is a new risk, not the
removal of one.

What this example is for
-----------------------
``exchange-api/trading-terminal`` builds a trading app on the raw REST +
WebSocket API and spends ~2,700 lines doing it: HMAC signing, retry policy,
bounded response reads, clock-skew detection, exact decimal handling. This app is
a few hundred lines because the SDK already owns all of that. What is left is the
part that is actually yours -- deciding what "too much risk" means and what to do
about it.

Concurrency, in full
--------------------
There is none. ``nexus_exchange.Client`` is synchronous, so the loop is what it
looks like: fetch, evaluate, act, sleep, in that order, on one thread. A tick
cannot overlap the previous one, nothing is shared between ticks, and there is
nothing to deadlock on. The Rust and TypeScript siblings fetch the account and
the open orders concurrently and have to say why that is safe; here the question
does not arise, which is the honest version of the same answer.

The one lifecycle rule: **an in-flight cancel is never interrupted.** A signal
sets a flag and the loop notices it between steps; it never raises into a request
in flight, because a shutdown that aborts the risk-reducing action is a shutdown
that made things worse. That is also why the handler sets an event rather than
raising ``KeyboardInterrupt``: under PEP 475 Python retries a syscall interrupted
by a signal *after* running the handler, so a handler that raises would tear down
the very request this app exists to complete.
"""

from __future__ import annotations

import os
import signal
import sys
import threading
from types import FrameType
from typing import NoReturn, assert_never

from nexus_exchange import (
    ApiError,
    AuthError,
    Client,
    Funds,
    MissingCredentialsError,
    Network,
    NetworkConfig,
    NexusExchangeError,
    Order,
)

import risk
from config import USAGE, Config, ConfigError, HelpRequested, load
from risk import State

#: Per-request ceiling, and the whole bound on one call.
#:
#: `nexus_exchange` 0.4.0 does not retry: `Client._request` sends once and
#: decodes, so unlike SDKs with a retry layer there is no attempt-vs-call
#: distinction to get wrong here. This is simply how long one request may take.
#:
#: Deliberately tighter than the SDK's own 30s default, because the shutdown
#: bound below is derived from it and that is the number an operator feels.
REQUEST_TIMEOUT_SECONDS = 5.0

#: The longest a shutdown signal can wait, because no request is interruptible.
#:
#: A tick makes at most three sequential requests: the two reads, then a cancel
#: those reads may have triggered. Derived rather than written down twice, so it
#: cannot drift from the timeout above, and comfortably inside the 30s that
#: Kubernetes' `terminationGracePeriodSeconds` defaults to.
MAX_SHUTDOWN_WAIT_SECONDS = 3 * REQUEST_TIMEOUT_SECONDS

#: Label for a `NEXUS_EXCHANGE_API_URL` target.
#:
#: Required by `NetworkConfig.custom` and given no default there, because the
#: label names the stage in diagnostics and is the key sibling clients namespace
#: stored credentials under. Named after the variable it came from rather than
#: something invented, so anyone reading it can tell where the target was chosen
#: -- the same label `sdk-mcp/risk-review` gives the same override.
OVERRIDE_LABEL = "api-url-override"

#: `sysexits.h` codes, matching the Rust and TypeScript siblings so a supervisor
#: sees the same number whichever one it is running.
EX_DATAERR = 65
EX_NOPERM = 77


def signal_exit_code(signum: int) -> int:
    """The shell's `128 + signum` code for "killed by a signal".

    Not a `sysexits.h` code and not a constant: SIGINT gives 130, SIGTERM 143.
    Derived from the signal actually received rather than fixed at 130, because
    the forced-exit path is reachable by either, and telling a supervisor that a
    double SIGTERM was a Ctrl-C is the kind of small lie that costs someone an
    hour of looking in the wrong place.
    """
    return 128 + signum


class Fatal(Exception):
    """A failure that retrying cannot fix, and the exit code that says why."""

    def __init__(self, code: int, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def log(message: str) -> None:
    print(message, flush=True)


def one_line(value: object, limit: int = 200) -> str:
    """Collapse anything printable to one bounded line.

    Not cosmetic. Point this at a host whose root serves a web app and the error
    body is a full HTML document; without this it takes over the terminal and
    buries the line that said what failed. Seen for real -- an edge proxy answers
    an invalid signature with an HTML 403.
    """
    flat = " ".join(str(value).split())
    return f"{flat[:limit]}…" if len(flat) > limit else flat


def is_transient(error: NexusExchangeError) -> bool:
    """Whether retrying the same request could succeed.

    Mostly the SDK's own `transient` flag -- with one correction that matters.
    `ApiError.transient` is `status >= 500 or status == 408`, so a **429 is
    reported terminal**, and a guard that stops on terminal errors would shut
    itself down the first time it got rate limited. A rate limit is the textbook
    retryable failure: the same request succeeds once the budget refills. So 429
    is treated as transient here regardless of what the flag says.

    Deliberately a small, named exception rather than a blanket "retry
    everything": the whole value of the distinction is that a revoked credential
    still stops the guard.
    """
    if isinstance(error, ApiError) and error.status == 429:
        return True
    return error.transient


def classify(error: NexusExchangeError) -> Fatal | None:
    """`Fatal` when this error will fail identically forever, else `None`.

    The distinction is the whole point. A guard whose credentials were revoked
    protects nothing, and treating that as transient is the worst failure
    available to this app: it stays alive, logs the same 401 every tick, and
    exits 0 if anyone ever stops it -- so no supervisor restarts it and no
    operator is told the account is now unwatched. Same rule as `UNKNOWN` in
    `risk.py`: never let a failure read as a clean bill of health.
    """
    if is_transient(error):
        return None
    auth = isinstance(error, (AuthError, MissingCredentialsError)) or (
        isinstance(error, ApiError) and error.status in (401, 403)
    )
    return Fatal(EX_NOPERM if auth else EX_DATAERR, one_line(error))


def failure_key(error: NexusExchangeError) -> str:
    """A stable identity for a failing poll, so one outage reports once.

    Keys on failure *class*, never on the message: the two reads fail through
    whichever request is reached first, so one outage produces messages that
    differ only in their path, and comparing printed text would reprint both
    forever -- 5,760 lines a day at the default interval. A transport error and a
    named server rejection are different news and both print. The prefix keeps a
    failure key from ever comparing equal to a verdict summary.
    """
    if isinstance(error, ApiError):
        return f"poll failed: api {error.status} {error.code or ''}"
    return f"poll failed: {type(error).__name__}"


def describe_funds(funds: Funds) -> str:
    """What the target's funds actually are -- never an assumption.

    A caller-supplied base URL declares nothing, so it arrives as
    ``Funds.UNKNOWN``, and printing "play funds" over an undeclared target is the
    one lie a risk tool must not tell.

    Exhaustive, with `assert_never` rather than a catch-all string. The catch-all
    is the tempting version and it is the worse one: a classification added by a
    later SDK would quietly print "funds not recognised" and carry on, whereas
    this makes the same event a **type error at build time** -- mypy rejects the
    missing branch before anyone runs it. The runtime `AssertionError` behind it
    only fires against an SDK the pin does not match, and refusing to start is
    the right answer there: a risk tool should not guess whose money it is
    looking at.
    """
    match funds:
        case Funds.PLAY:
            return "play funds"
        case Funds.REAL:
            return "REAL FUNDS"
        case Funds.UNKNOWN:
            return "funds not declared"
    assert_never(funds)


def build_client(config: Config) -> Client:
    """Construct the client, and get the funds classification right.

    Testnet is named rather than left to the default: an example should never
    leave a reader guessing whose money it watches. ``Network.MAINNET`` needs no
    guard of our own -- the SDK refuses to resolve a base for it, locally, before
    any bytes leave the process.

    The override is the subtle part, and it is worth copying carefully. Passing
    ``Network.TESTNET`` *and* ``base_url=`` does route requests at the override --
    but ``client.network`` keeps the testnet descriptor, so the client goes on
    reporting ``label='Testnet'`` and ``funds=PLAY`` for a host the caller
    supplied. Measured against a local server: both forms send to the override,
    and only one of them tells the truth about it afterwards.

    So the override has to arrive as a *described* target rather than a bare URL,
    and it is spelled out with :meth:`NetworkConfig.custom`. A lone ``base_url=``
    resolves to the same thing -- the SDK builds exactly this config from it --
    but that selector is deprecated (ENG-10955) and an example should not teach a
    form that is scheduled to warn and then disappear. Writing it out is also the
    better lesson: the funds classification becomes something this app states
    rather than something it inherits from a helper.

    ``funds=UNKNOWN`` is the honest answer and it costs nothing here, because a
    URL on its own says nothing about whose money is behind it and this app only
    reads and cancels -- neither is funds-guarded. ``has_faucet`` stays ``False``
    for the same reason: a faucet is a property of the deployment, and this app
    has not been told. ``direct_base_url`` is left to fall back to ``base_url``,
    which is what a single override has always meant; a deployment that keeps the
    gateway/direct split is the case that has to name both.
    """
    if config.base_url is None:
        return Client(
            Network.TESTNET,
            api_key=config.api_key,
            api_secret=config.api_secret,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    return Client(
        NetworkConfig.custom(
            label=OVERRIDE_LABEL,
            funds=Funds.UNKNOWN,
            base_url=config.base_url,
        ),
        api_key=config.api_key,
        api_secret=config.api_secret,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )


def summarise(verdict: risk.Verdict, resting: int) -> str:
    if verdict.breached:
        state = "BREACHED"
    elif verdict.indeterminate:
        state = "UNPROVEN"
    else:
        state = "ok"
    detail = " ".join(f"{f.limit}={f.state.value}" for f in verdict.findings)
    return f"{state}  {detail}  resting={resting}"


def describe_limits(config: Config) -> str:
    parts = [
        name
        for name, value in (
            ("max-notional", config.limits.max_notional),
            ("max-loss", config.limits.max_loss),
            ("min-available-margin", config.limits.min_available_margin),
        )
        if value is not None
    ]
    return f"limits: {', '.join(parts)} — polling every {config.interval_seconds}s"


class Shutdown:
    """Two-stage shutdown, without ever raising into a request.

    First signal sets the event; the loop finishes what it is doing and stops.
    Second signal means the operator is done waiting, and says what that costs.
    """

    def __init__(self) -> None:
        self._event = threading.Event()

    def install(self) -> None:
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, self._handle)

    def _handle(self, signum: int, frame: FrameType | None) -> None:
        if self._event.is_set():
            # `os._exit` skips interpreter cleanup on purpose: this path exists
            # because the operator asked twice, and anything that unwinds could
            # block on the very request they are trying to escape.
            sys.stderr.write("forcing exit — a cancel may still have been in flight\n")
            sys.stderr.flush()
            os._exit(signal_exit_code(signum))
        self._event.set()
        sys.stderr.write(
            f"shutting down — finishing the current check "
            f"(up to {MAX_SHUTDOWN_WAIT_SECONDS:.0f}s)\n"
        )
        sys.stderr.flush()

    @property
    def requested(self) -> bool:
        return self._event.is_set()

    def wait(self, seconds: float) -> None:
        """The only interruptible wait in the process."""
        self._event.wait(seconds)


def on_breach(
    client: Client,
    config: Config,
    orders: list[Order],
    changed: bool,
) -> None:
    """Act on a breach: cancel every resting order, once there is one to cancel.

    There is no "already fired" latch, and there does not need to be. The
    condition is *breached and orders exist*, so a successful cancel makes the
    next tick a no-op by itself, while an order placed during a still-live breach
    is caught on the tick after it appears. A latch would have to be cleared by
    something, and every rule for clearing it is a rule that can be wrong.

    ``changed`` gates the watch-only advisory -- a standing breach should not
    print the same line 5,760 times a day -- but never the outcome of a cancel,
    because that is a write this app performed.
    """
    if not orders:
        return
    if not config.armed:
        if changed:
            log(f"  would cancel {len(orders)} resting order(s) — re-run with --arm")
        return
    try:
        client.cancel_all_orders()
    except NexusExchangeError as error:
        log(f"  cancel failed: {one_line(error)}")
        # Cancelling is idempotent, so a transient failure just means the next
        # tick tries again -- the right behaviour while a limit is still
        # breached. A terminal one will fail the same way forever, and an armed
        # guard that cannot cancel is not a guard.
        fatal = classify(error)
        if fatal is not None:
            raise fatal from error
        log("  will retry next tick")
        return
    # Deliberately not "cancelled N": this is the account-wide cancel and it runs
    # *after* the read above, so an order placed in between is cancelled too. The
    # count is what this app saw, and the audit line for its only write says
    # exactly that rather than implying a total it cannot know.
    log(f"  cancelled every resting order on this account ({len(orders)} seen this tick)")


def run(config: Config) -> None:
    client = build_client(config)
    shutdown = Shutdown()
    shutdown.install()

    log(f"risk-guard on {config.base_url or 'the testnet default host'} "
        f"({describe_funds(client.network.funds)})")
    log(describe_limits(config))
    log(
        "--arm: a breach will cancel every resting order on this account"
        if config.armed
        else "watch-only. Pass --arm to let a breach cancel resting orders."
    )

    # A key for the last status reported, so a steady state does not reprint
    # itself every interval. See `failure_key` for why it is a key and not the
    # printed line.
    last_reported = ""

    while not shutdown.requested:
        try:
            account = client.fetch_balance()
            orders = client.fetch_open_orders()
        except NexusExchangeError as error:
            # A failed poll is not evidence of safety. Report it, and stop
            # outright if retrying cannot help -- see `classify`.
            key = failure_key(error)
            if key != last_reported:
                last_reported = key
                log(f"poll failed: {one_line(error)}")
            fatal = classify(error)
            if fatal is not None:
                log(
                    "this cannot succeed by retrying, so the guard is stopping "
                    "rather than pretending to watch"
                )
                raise fatal from error
            shutdown.wait(config.interval_seconds)
            continue

        verdict = risk.evaluate(account.positions, account.available_margin, config.limits)
        line = summarise(verdict, len(orders))
        changed = line != last_reported
        if changed:
            last_reported = line
            log(line)
            for finding in verdict.findings:
                if finding.state is not State.WITHIN:
                    log(f"  {finding.limit}: {finding.detail}")

        if verdict.breached:
            on_breach(client, config, orders, changed)
        elif verdict.indeterminate and changed:
            # Reported, never acted on. Cancelling because a mark price is
            # temporarily unavailable would make an indexer hiccup into a trading
            # decision. The honest posture is to say the limit cannot be proven
            # and let a human look.
            log("  a limit could not be proven — not acting on data this app does not trust")

        shutdown.wait(config.interval_seconds)


def main(argv: list[str]) -> int:
    try:
        config = load(argv)
    except HelpRequested:
        print(USAGE)
        return 0
    except ConfigError as error:
        print(f"\n{error}", file=sys.stderr)
        return 1
    try:
        run(config)
    except Fatal as fatal:
        # Already reported on stdout where it happened; the exit code is what
        # carries the reason to whatever is supervising this process.
        return fatal.code
    return 0


def _entry() -> NoReturn:
    sys.exit(main(sys.argv[1:]))


if __name__ == "__main__":
    _entry()
