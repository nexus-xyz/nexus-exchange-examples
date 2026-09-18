"""Delegate trading to a scoped agent key, prove it exists, then take it back.

    python enroll.py              # enroll, list, prove, revoke
    python enroll.py --dry-run    # everything local; sends nothing

An **agent key** is an Ethereum-derived keypair that signs trading requests on a
wallet's behalf. The owning wallet authorizes it once, with an EIP-712 signature
made on the owner's machine; the bot then runs holding only the agent key. The
wallet's key never reaches the bot, and the delegation expires on its own.

This is how any of the catalog's other write examples should be run unattended,
and it is four calls end to end:

    GET    /agents                 what is delegated right now
    POST   /agents/register        authorize one more — unauthenticated, because
                                   the EIP-712 signature in the body *is* the
                                   credential
    GET    /agents                 it is there, and when it lapses
    DELETE /agents/{address}       take it back

The registration is the interesting one. It carries no session token and no API
key: the server recovers the owner's address from the signature, so the signature
is the authorization. Which makes the signed bytes the whole security surface,
and the EIP-712 domain the part of them that is easy to get wrong -- see
``domain.py``, which reads the domain's chain id from the target and refuses to
sign when it cannot.

Why it always revokes
---------------------
The registration is undone in a ``finally``, so the middle of this script failing
does not leave a live delegated key behind. Two things follow from that and both
are deliberate:

* **Shutdown signals are deferred** across the window where a key exists. A
  Ctrl-C between register and revoke is the one keystroke that turns this example
  into the thing it is teaching against, so the handler sets a flag and the
  revoke finishes first. Same rule as ``sdk-python/risk-guard``: never let a
  signal abort the *undo*.
* **A failed revoke is loud** -- its own exit code, and the address printed twice
  so it is in the scrollback either way. "Registered but not revoked" is the one
  outcome nobody should have to notice for themselves.
"""

from __future__ import annotations

import os
import secrets
import signal
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from types import FrameType
from typing import NoReturn, assert_never

from nexus_exchange import (
    AgentInfo,
    AgentRegistration,
    ApiError,
    AuthError,
    Client,
    EthSigner,
    Funds,
    MissingCredentialsError,
    Network,
    NetworkConfig,
    NexusExchangeError,
)

from config import USAGE, Config, ConfigError, HelpRequested, load
from domain import DomainUnavailable, metadata_url, read_chain_id

#: Per-request ceiling, and the whole bound on one call.
#:
#: ``nexus_exchange`` 0.4.0 does not retry -- ``Client._request`` sends once and
#: decodes -- so there is no attempt-vs-call distinction to get wrong here. Kept
#: tighter than the SDK's 30s default because a person is watching this run.
REQUEST_TIMEOUT_SECONDS = 10.0

#: Label for a ``NEXUS_EXCHANGE_API_URL`` target, matching the name
#: ``sdk-python/risk-guard`` and ``sdk-mcp/risk-review`` give the same override.
OVERRIDE_LABEL = "api-url-override"

#: ``sysexits.h`` codes, matching the siblings so a supervisor sees the same
#: number whichever example it ran.
EX_DATAERR = 65
#: Registered, and the revoke did not succeed. Its own code rather than
#: ``EX_DATAERR``, because it is the only exit from this program that leaves
#: state behind on someone's account, and it is specifically the one worth
#: alerting on: ``EX_TEMPFAIL`` is "the user is invited to retry", which is
#: exactly the instruction.
EX_TEMPFAIL = 75
EX_NOPERM = 77
#: Could not read the signing domain, so nothing was signed and nothing was sent.
#: ``EX_UNAVAILABLE``: a service this app depends on did not answer.
EX_UNAVAILABLE = 69

MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000


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
    buries the line that said what failed.
    """
    flat = " ".join(str(value).split())
    return f"{flat[:limit]}…" if len(flat) > limit else flat


def describe_funds(funds: Funds) -> str:
    """What the target's funds actually are -- never an assumption.

    Exhaustive, with ``assert_never`` rather than a catch-all: a classification
    added by a later SDK becomes a **type error at build time** instead of a
    reassuring string printed over a target nobody classified.
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
    """Construct the client against the base ``config`` already decided.

    Testnet is **named**, not left to the default, and the base is passed
    alongside it. Both halves matter:

    * naming the network is what keeps ``funds=PLAY`` truthful, so the banner can
      say whose money this is;
    * passing the base is what makes it reachable, because ``Network.TESTNET``
      resolves to the legacy ``exchange.nexus.xyz/api/exchange`` gateway in
      0.4.0 and that gateway is gone. See ``config.TESTNET_BASE_URL``.

    Naming a network *and* overriding the URL keeps that network's semantics --
    the SDK's documented behaviour, and the right one here, since the host being
    supplied is testnet's own durable base rather than something a caller
    handed us.

    A caller-supplied ``NEXUS_EXCHANGE_API_URL`` is the case where that stops
    being true, so it takes the other path: a described target with
    ``Funds.UNKNOWN``. Keeping ``Network.TESTNET`` there would print "play funds"
    over a host this app knows nothing about, which is the one lie a tool that
    delegates trading authority must not tell. ``NetworkConfig.custom`` rather
    than a bare ``base_url=`` for two reasons: the bare selector is deprecated
    (ENG-10955), and it makes the funds classification something this app
    inherits instead of something it states.
    """
    if config.base_url_overridden:
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
    return Client(
        Network.TESTNET,
        base_url=config.base_url,
        api_key=config.api_key,
        api_secret=config.api_secret,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )


def generate_agent_key() -> str:
    """A fresh agent key, from the OS CSPRNG.

    ``secrets``, never ``random``: this is a key. The loop is for the vanishingly
    rare draw that is not a valid secp256k1 scalar (zero, or >= the curve order)
    -- about 2**-128, so it will not run twice, but "retry" is the only correct
    handling and rejecting the draw is cheaper than reasoning about whether it
    can happen.
    """
    while True:
        candidate = secrets.token_bytes(32).hex()
        try:
            EthSigner.from_hex(candidate)
        except AuthError:  # pragma: no cover - ~2**-128 per draw
            continue
        return candidate


def signer_from_hex(private_key: str, variable: str) -> EthSigner:
    """Load a key, and keep the SDK's error from carrying the value.

    ``AuthError`` messages here are shape complaints ("private key must be 32
    bytes"), but this is the boundary where key material enters the program and
    the exception is re-raised rather than propagated so nothing downstream can
    widen what gets printed.
    """
    try:
        return EthSigner.from_hex(private_key)
    except AuthError as exc:
        raise ConfigError(f"{variable} is not a usable private key: {exc}") from exc


def iso(milliseconds: int) -> str:
    """Unix milliseconds as UTC ISO-8601.

    UTC explicitly. An expiry rendered in the reader's local zone is the kind of
    thing that reads fine and is wrong by an hour twice a year, and this number
    is the one bound on a delegation.
    """
    return (
        datetime.fromtimestamp(milliseconds / 1000, tz=UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def describe_agent(agent: AgentInfo) -> str:
    label = f" label={agent.label}" if agent.label else ""
    return f"{agent.address} expires {iso(agent.expires_at)}{label}"


@dataclass(frozen=True)
class Plan:
    """Everything decided locally, before anything is sent."""

    wallet: EthSigner
    agent: EthSigner
    #: True when the agent key was generated here rather than supplied.
    agent_key_is_ephemeral: bool
    chain_id: int
    registration: AgentRegistration


def plan(config: Config, now_ms: int) -> Plan:
    """Read the domain, load the keys, and sign the registration.

    The order is the lesson. The chain id is read **first**, from the host this
    run will register with, and a failure here stops the program before a key is
    even loaded -- so "could not read the domain" can never be followed by a
    signature made under a guessed one.
    """
    try:
        chain_id = read_chain_id(config.base_url, REQUEST_TIMEOUT_SECONDS)
    except DomainUnavailable as exc:
        raise Fatal(
            EX_UNAVAILABLE,
            f"{one_line(exc)}\n"
            f"Refusing to sign. The EIP-712 domain is per-network and only the "
            f"venue publishes it; signing under a guessed chain id either fails "
            f"verification or authorizes an agent on a network you did not mean "
            f"to. Nothing was signed and nothing was sent.",
        ) from exc

    wallet = signer_from_hex(config.wallet_private_key, "NEXUS_WALLET_PRIVATE_KEY")
    ephemeral = config.agent_private_key is None
    agent_key = config.agent_private_key or generate_agent_key()
    agent = signer_from_hex(agent_key, "NEXUS_AGENT_PRIVATE_KEY")

    if agent.address == wallet.address:
        # Not a theoretical mix-up: the two variables differ by one word, and a
        # wallet delegating to itself is a registration that buys nothing while
        # looking exactly like one that did.
        raise ConfigError(
            "NEXUS_AGENT_PRIVATE_KEY is the same key as NEXUS_WALLET_PRIVATE_KEY. "
            "An agent key exists so the bot can sign without holding the wallet's "
            "key; delegating a wallet to itself gives up that whole property."
        )

    registration = wallet.register_agent(
        agent=agent.address,
        expires_at_ms=now_ms + config.ttl_days * MILLISECONDS_PER_DAY,
        # The spec suggests the current Unix-ms timestamp as a safe starting
        # nonce: it is monotonic across runs on a sane clock, and it needs no
        # state kept between them.
        nonce=now_ms,
        chain_id=chain_id,
        label=config.label,
    )
    return Plan(
        wallet=wallet,
        agent=agent,
        agent_key_is_ephemeral=ephemeral,
        chain_id=chain_id,
        registration=registration,
    )


def report_plan(config: Config, ready: Plan) -> None:
    log(f"  EIP-712 domain: name='Nexus Exchange' version='1' chainId={ready.chain_id}")
    log(f"    read from {metadata_url(config.base_url)} — not guessed, not defaulted")
    log(f"  owner wallet:   {ready.wallet.checksum_address}")
    source = "generated here" if ready.agent_key_is_ephemeral else "from the environment"
    log(f"  agent key:      {ready.agent.checksum_address} ({source})")
    log(
        f"  expires:        {iso(ready.registration.expires_at)} "
        f"({config.ttl_days}d) — nonce {ready.registration.nonce}"
    )
    # The signature is withheld, and that is the point rather than prudishness:
    # `/agents/register` is unauthenticated, so these 65 bytes *are* the
    # credential. Anyone holding them can register this agent key against this
    # wallet until the nonce is spent. Printing the rest of the body is useful;
    # printing this would be handing out the authorization.
    log("  signature:      65 bytes, withheld — on this endpoint it is the credential")


class DeferredSignals:
    """Hold SIGINT/SIGTERM until the revoke has run.

    The window between ``POST /agents/register`` and ``DELETE /agents/{address}``
    is the only time this program has authorized anything, and a signal landing
    inside it is precisely how an example teaches the wrong habit. So the handler
    records the signal and returns; the ``finally`` revokes; then the process
    exits with the shell's ``128 + signum``.

    A handler that *raises* -- which the default ``KeyboardInterrupt`` does --
    would be the obvious version and the wrong one. Under `PEP 475
    <https://peps.python.org/pep-0475/>`_ the interpreter runs the handler before
    retrying a syscall a signal interrupted, so it can tear down the in-flight
    request, and the request it is most likely to tear down is the revoke.

    A second signal is honoured immediately and says what it cost. Asking twice
    is unambiguous, and the address of the still-live key has already been
    printed by then — which is why it is printed before the register call
    returns and again on the revoke line, rather than only once.
    """

    def __init__(self) -> None:
        self.received: int | None = None
        self._previous: dict[int, object] = {}

    def __enter__(self) -> DeferredSignals:
        for sig in (signal.SIGINT, signal.SIGTERM):
            self._previous[sig] = signal.getsignal(sig)
            signal.signal(sig, self._handle)
        return self

    def __exit__(self, *exc: object) -> None:
        for sig, previous in self._previous.items():
            # `getsignal` returns exactly what `signal` accepts, but its declared
            # type is a union wide enough that mypy cannot see that. Narrowed by
            # construction: these are the handlers this object replaced.
            signal.signal(sig, previous)  # type: ignore[arg-type]

    def _handle(self, signum: int, frame: FrameType | None) -> None:
        if self.received is not None:
            sys.stderr.write(
                "forcing exit — the agent key may still be registered; "
                "revoke it yourself\n"
            )
            sys.stderr.flush()
            # `os._exit` skips interpreter cleanup on purpose, and raising here
            # would be the wrong tool twice over: it is the PEP 475 hazard this
            # class exists to avoid, and anything that unwinds could block on the
            # very request the operator is trying to escape.
            os._exit(128 + signum)
        self.received = signum
        sys.stderr.write(
            "shutting down — revoking the agent key first, then exiting\n"
        )
        sys.stderr.flush()


def classify(error: NexusExchangeError) -> int:
    """The exit code an SDK failure should carry."""
    auth = isinstance(error, (AuthError, MissingCredentialsError)) or (
        isinstance(error, ApiError) and error.status in (401, 403)
    )
    return EX_NOPERM if auth else EX_DATAERR


def list_agents(client: Client, when: str) -> list[AgentInfo]:
    agents = client.fetch_agents()
    if not agents:
        log(f"  {when}: no agent keys registered")
    else:
        log(f"  {when}: {len(agents)} agent key(s)")
        for agent in agents:
            log(f"    {describe_agent(agent)}")
    return agents


def prove(client: Client, ready: Plan) -> None:
    """Show the venue accepts a signature made by the agent key alone.

    ``POST /auth/login`` is EIP-191 over a fixed message, and what comes back is
    the address the venue *recovered* from that signature plus a session token.
    Asserting the recovered address is the agent's is the end-to-end check: these
    bytes were produced by the agent key, on this machine, without the wallet key
    being present, and the venue read them the same way.

    Being precise about what that does and does not show, because an example that
    overclaims here is worse than one that skips the step. It proves the agent
    key is a working identity at this venue. What proves the *delegation* is
    ``GET /agents`` listing it against this wallet, which is the step either side
    of this one. A stronger proof -- placing an order as the agent -- needs the
    session token to be usable on a client, and ``nexus_exchange`` 0.4.0 has no
    way to pass one: ``Client`` takes HMAC credentials only, and ``sign_in``
    hands the token back for a future session-authenticated client that does not
    exist yet. Flagged rather than faked.

    The token is never printed. ``LoginResponse.__repr__`` redacts it too, so
    printing the whole object would have been safe -- this does not rely on that.
    """
    session = client.sign_in(ready.agent)
    recovered = session.address.lower()
    if recovered != ready.agent.address.lower():
        raise Fatal(
            EX_DATAERR,
            f"the venue recovered {session.address} from the agent key's "
            f"signature, not {ready.agent.address}",
        )
    log(f"  the venue accepted a signature from the agent key alone ({session.address})")
    log("    and issued a session token for it — withheld, it is a bearer credential")


def revoke(client: Client, address: str) -> None:
    """Take the delegation back. Raises :class:`Fatal` if it did not happen."""
    try:
        client.revoke_agent(address)
    except NexusExchangeError as error:
        raise Fatal(
            EX_TEMPFAIL,
            f"revoking {address} failed: {one_line(error)}\n"
            f"THE AGENT KEY IS STILL REGISTERED. Revoke it with "
            f"DELETE /agents/{address}, or let it lapse at the expiry printed "
            f"above — but do not leave it and forget.",
        ) from error


def run(config: Config) -> int:
    now_ms = int(datetime.now(tz=UTC).timestamp() * 1000)
    client = build_client(config)

    log(f"agent-enrollment on {config.base_url} ({describe_funds(client.network.funds)})")
    if client.network.funds is Funds.REAL:
        # Unreachable by any path this app offers -- testnet is named, and the
        # override declares UNKNOWN -- and kept anyway. `Funds` is tri-state
        # precisely so this check can be written positively, and an example whose
        # subject is delegating trading authority is the wrong place to leave the
        # real-funds branch to an argument about why it cannot be taken.
        raise Fatal(
            EX_DATAERR,
            "this target declares REAL FUNDS. This example is testnet-only; it "
            "will not delegate trading authority over real money.",
        )
    log(
        "  --dry-run: reading the signing domain and signing locally, sending nothing"
        if config.dry_run
        else "  will enroll an agent key, prove it, and revoke it before exiting"
    )

    ready = plan(config, now_ms)
    report_plan(config, ready)

    if config.dry_run:
        log("dry run: nothing was sent. Drop --dry-run to enroll for real.")
        return 0

    log("before:")
    try:
        list_agents(client, "delegated now")
    except NexusExchangeError as error:
        raise Fatal(classify(error), f"GET /agents failed: {one_line(error)}") from error

    address = ready.registration.agent
    # From here until the revoke there is a live delegation, so signals are held
    # and everything is wrapped. The `try` opens *after* the register call rather
    # than around it on purpose: a failed register leaves nothing to revoke, and
    # a `finally` that ran anyway would send a DELETE for a key that does not
    # exist and report its 404 over the real failure.
    with DeferredSignals() as signals:
        log(
            "register: POST /agents/register — unauthenticated; "
            "the signature is the credential"
        )
        try:
            registered = client.register_agent(ready.registration)
        except NexusExchangeError as error:
            raise Fatal(
                classify(error), f"registration failed: {one_line(error)}"
            ) from error
        # The venue's echo is printed; `address` -- the address this app signed
        # for -- is what gets revoked. They should be the same, and revoking the
        # one we asked for is right even when they are not: a response naming a
        # different agent is not licence to leave the key we actually authorized
        # standing. The `GET /agents` check below is where a mismatch shows up.
        log(f"  registered {registered.agent_address} until {iso(registered.expires_at)}")

        try:
            log("after:")
            listed = list_agents(client, "delegated now")
            if not any(a.address.lower() == address.lower() for a in listed):
                # Reported, not raised: the delegation exists either way -- the
                # venue said so -- so the revoke below still has to run, and
                # turning a surprising list into an exception here would skip it.
                log("  (the new key is not in this list — reporting what was returned)")
            prove(client, ready)
        except NexusExchangeError as error:
            # Converted here rather than left to escape. It would reach the
            # `finally` either way, so the revoke is not what is at stake -- the
            # exit code is. An SDK exception unwinding out of `main` is a
            # traceback and a `1`, which says "this program crashed" about a run
            # that in fact cleaned up after itself correctly.
            raise Fatal(
                classify(error), f"after registering: {one_line(error)}"
            ) from error
        finally:
            log(f"revoke: DELETE /agents/{address}")
            revoke(client, address)
            log("  revoked")
            try:
                list_agents(client, "delegated now")
            except NexusExchangeError as error:
                # The revoke succeeded; this is only the confirming read. Worth
                # printing, never worth failing the run over -- and never worth
                # masking the exception that sent us into this `finally`.
                log(f"  (could not re-read GET /agents: {one_line(error)})")

    if signals.received is not None:
        log("exiting on signal — the agent key was revoked first")
        return 128 + signals.received
    return 0


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
        return run(config)
    except ConfigError as error:
        # `plan` loads the keys, so a key this app never accepted can still
        # surface after the banner. Reported as configuration, not as a crash.
        print(f"\n{error}", file=sys.stderr)
        return 1
    except Fatal as fatal:
        print(f"\n{fatal.detail}", file=sys.stderr)
        return fatal.code
    except NexusExchangeError as error:
        # A backstop, and deliberately a thin one. Every call site above turns an
        # SDK failure into a `Fatal` with the context that makes it readable, so
        # reaching here means one was missed -- and the right outcome for a
        # missed case is still a one-line report and a `sysexits.h` code, not a
        # traceback that makes a handled venue error look like a crash.
        print(f"\n{one_line(error)}", file=sys.stderr)
        return classify(error)


def _entry() -> NoReturn:
    sys.exit(main(sys.argv[1:]))


if __name__ == "__main__":
    _entry()
