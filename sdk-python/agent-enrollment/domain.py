"""The EIP-712 signing domain, read from the target and never guessed.

The domain is ``{name: "Nexus Exchange", version: "1", chainId: <per-network>}``.
``name`` and ``version`` are contract-level constants -- identical on every
deployment, which is why the SDK does not let you override them. ``chainId`` is
the one field that is per-network and **server-authoritative**, and it is the
whole security boundary: a distinct domain per network is what makes a
registration signed for one network invalid on another.

So there is exactly one correct way to obtain it, and it is this module's entire
job:

    Read ``signing_domain.chain_id`` from ``GET /metadata`` **on the host you are
    about to register with**, and refuse to sign if you cannot.

Refuse, not fall back. There are two failure modes and only one of them is loud:

* A **wrong** chain id fails verification. Annoying, and self-announcing.
* A chain id belonging to **another network** verifies -- somewhere else. That
  produces a valid delegation on a network you did not intend, out of an
  operation you believed had failed. That is the one this refusal exists for.

Which is also why there is no fallback map here. The SDK ships the spec's
``x-nexus-networks`` map (``nexus_exchange.networks``) and every entry in it
carries ``chain_id=None`` on purpose: the static map does not publish the value,
and ``None`` means *unknown*, not zero and not "use a default". Falling back to it
would mean falling back to nothing. :func:`fallback_chain_id` says so in code, so
the claim is checked by a test rather than asserted in a comment.

Mainnet is worth naming specifically: it is the real-funds exchange running
against **Ethereum Mainnet** via the USDX bridge, not a Nexus L1 chain, so a
Nexus L1 chain id is never the right answer there. Guessing it from the network
name is exactly the reasoning this module exists to prevent.

The SDK has no reader for ``/metadata`` in 0.4.0, so this is ~40 lines of
``httpx`` -- the SDK's own transport, already in the pinned set -- rather than a
new dependency or a reach into ``Client._request``.
"""

from __future__ import annotations

import json

import httpx
from nexus_exchange import Network

#: A ``/metadata`` body larger than this is refused rather than parsed. The real
#: payload is a few hundred bytes; a megabyte means something other than what was
#: asked for is on the other end, and this runs before any trust decision.
MAX_METADATA_BYTES = 256 * 1024


class DomainUnavailable(Exception):
    """The chain id could not be read, so nothing may be signed.

    Deliberately not a subclass of anything the SDK raises. This is not a failed
    request to be retried at a higher level -- it is the app declining to
    produce a signature, which is a different kind of event and gets its own
    exit code.
    """


def metadata_url(base_url: str) -> str:
    """``/metadata`` on the same base every other request in this run uses.

    Taking the base as an argument rather than reading it back off the client is
    not fussiness. ``nexus_exchange.Client`` does not expose the base it resolved,
    and ``client.network.base_url`` is *not* it: construct
    ``Client(Network.TESTNET, base_url=X)`` and the config still reports testnet's
    own base while requests go to ``X``. An app that read the chain id from
    ``client.network.base_url`` and registered at ``X`` would be signing under one
    host's domain and delegating on another's -- silently, and only when an
    override was in play. So ``config.base_url`` is the single source and both
    callers take it from there.
    """
    return f"{base_url.rstrip('/')}/metadata"


def fallback_chain_id(network: Network = Network.TESTNET) -> int | None:
    """What the static ``x-nexus-networks`` map offers. Always ``None``.

    Kept as a function, and pinned by a test, because "there is no fallback" is a
    claim about the SDK rather than about this app. If a future release starts
    publishing a chain id in the static map, this stops returning ``None`` and the
    test fails -- which is the conversation worth having, since a value that
    ships in a client library is a value nobody re-reads when a network moves.
    """
    return network.signing_domain.chain_id


def read_chain_id(base_url: str, timeout: float) -> int:
    """The live EIP-712 chain id for ``base_url``, or raise.

    Every failure lands as :class:`DomainUnavailable`, and none of them resolves
    to a number. Redirects are not followed -- ``httpx``'s default, and the right
    one here: a redirect can cross origins, and "read the domain from the host
    you will register with" stops being true the moment another host answers.
    """
    url = metadata_url(base_url)
    try:
        with httpx.Client(timeout=timeout) as http:
            with http.stream("GET", url) as response:
                # A 2xx and nothing else. Not `< 400`: redirects are deliberately
                # not followed, so a 302 arrives here as a status with an empty
                # body, and "answered HTTP 302" is the useful report -- an app
                # that got as far as "did not answer JSON" would have buried the
                # one fact that explains it.
                if not 200 <= response.status_code < 300:
                    raise DomainUnavailable(
                        f"{url} answered HTTP {response.status_code}"
                    )
                body = _read_bounded(response, url)
    except httpx.HTTPError as exc:
        raise DomainUnavailable(f"{url} could not be reached: {exc}") from exc

    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise DomainUnavailable(f"{url} did not answer JSON") from exc

    return chain_id_from_metadata(payload, url)


def _read_bounded(response: httpx.Response, url: str) -> bytes:
    """Read a streamed body, refusing one that will not stop.

    ``response.read()`` would be one line and would also read whatever is sent.
    Nothing here is authenticated yet, so the cost of a hostile or broken host is
    only memory -- but this is the request that decides what gets signed, and
    "bounded before trusted" is cheaper than deciding later which parts of a
    surprise payload to believe.
    """
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > MAX_METADATA_BYTES:
            raise DomainUnavailable(
                f"{url} returned more than {MAX_METADATA_BYTES} bytes of metadata"
            )
        chunks.append(chunk)
    return b"".join(chunks)


def chain_id_from_metadata(payload: object, source: str) -> int:
    """Pull ``signing_domain.chain_id`` out of a ``/metadata`` body, strictly.

    Split out from the request so the rules are testable without a socket, and
    because the rules are the interesting part. Every one of them refuses rather
    than coerces:

    * a missing ``signing_domain`` block, or a missing / null ``chain_id``, means
      the server has not published one -- which is *unknown*, not zero;
    * ``bool`` is rejected before ``int``, because it is an ``int`` subclass and
      ``True`` would otherwise sign under chain id 1, Ethereum Mainnet;
    * a string ``"11155111"`` is rejected rather than parsed. JSON has a number
      type and the spec uses it, so a string here means the payload is not the
      shape this app was written against, and quietly accepting it is how an app
      keeps working against a contract that changed under it.

    The SDK's :func:`nexus_exchange.auth._require_chain_id` applies the same rules
    at the moment of signing, so this is a second gate rather than the only one.
    It exists to fail with the URL in the message, before a key is even loaded.
    """
    if not isinstance(payload, dict):
        raise DomainUnavailable(f"{source} did not answer a JSON object")
    domain = payload.get("signing_domain")
    if not isinstance(domain, dict):
        raise DomainUnavailable(f"{source} published no signing_domain block")
    chain_id = domain.get("chain_id")
    if chain_id is None:
        raise DomainUnavailable(
            f"{source} published signing_domain without a chain_id. That means the "
            f"value is unknown, not zero — and it is not an invitation to use "
            f"another network's."
        )
    if isinstance(chain_id, bool) or not isinstance(chain_id, int):
        raise DomainUnavailable(
            f"{source} published a non-integer chain_id ({chain_id!r})"
        )
    if chain_id < 1:
        raise DomainUnavailable(
            f"{source} published a chain_id that cannot be real ({chain_id})"
        )
    return chain_id
