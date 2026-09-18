"""One deployment, read once, handed to both halves of the comparison.

This module exists because of a bug that a shared :class:`~nexus_exchange.Client`
looks like it fixes and does not.

`ccxt_path.py` and `native_path.py` run one after the other, and each issues its
own requests. Sharing a client shares the *transport*, not the *responses*: on a
default all-market run the two readings of a market can be separated by dozens of
round-trips. Any ordinary tick in between — a new trade, a book update, a candle
closing — then arrives at `parity.py` as a field that ``differs``, and `--strict`
exits 4 over a market that simply moved. A scheduled canary built that way cannot
tell adapter drift from the venue being alive, which is the only thing it was
put there to do.

So the comparison is made against a **snapshot**. :class:`SnapshotClient` answers
each distinct read once per run and replays the stored response to every later
caller, which makes the two paths provably read the same bytes. What is left in
the parity report is the thing the report is about: how the two surfaces
*represent* one payload. Temporal drift is not measured, because it is not an API
difference.

The seam is :meth:`Client._send`. It is the one place both halves meet — the
adapter calls ``client._request`` for every route, the typed client's readers go
through ``_request`` and ``_request_page``, and all three bottom out here. A
private name is not usually somewhere an example should reach, and this is the
exception that proves the rule: interposing anywhere higher would miss one of the
three, and interposing lower would mean owning the HTTP client.

**Reads only, and unsigned only.** A cache that replayed a signed or non-``GET``
request would be a correctness bug in any app that grew one, so the guard is
here rather than in a comment. This example never issues either.
"""

from __future__ import annotations

from typing import Any

import httpx
from nexus_exchange import Client, NetworkConfig

#: What makes two reads "the same read": the verb, the route, and the query
#: string, plus whether the request went to the direct ``/api/v1`` surface or
#: the gateway base — the same path means different things under each, so the
#: flag is part of the identity rather than an afterthought.
Key = tuple[str, str, str, bool]


class SnapshotClient(Client):
    """A :class:`~nexus_exchange.Client` that reads each route once per run.

    Construct and use it exactly like a ``Client``; nothing above it has to know.
    Both the CCXT adapter and the typed client see an ordinary client that
    happens to be very fast the second time.

    The counters are not decoration — they are how the app can state, in its own
    output, that the second path cost no round-trips and therefore read the first
    path's bytes. A claim of that shape should be measured rather than asserted,
    which is the same argument the rest of this example makes.
    """

    def __init__(self, network: NetworkConfig, *, timeout: float) -> None:
        super().__init__(network, timeout=timeout)
        self._snapshot: dict[Key, httpx.Response] = {}
        #: Reads that went to the venue.
        self.fetched = 0
        #: Reads answered from the snapshot instead.
        self.replayed = 0

    def _send(
        self,
        method: str,
        path: str,
        *,
        query: str = "",
        body: Any | None = None,
        signed: bool = False,
        direct: bool = False,
    ) -> httpx.Response:
        """One read, from the venue the first time and from memory after that.

        ``httpx`` buffers a non-streamed response, so ``.content``, ``.json()``
        and ``.headers`` can all be read again as many times as they are asked
        for. Replaying the object is therefore giving the second caller the same
        bytes, not a re-parse of them.

        A failed read is not stored: the exception propagates and the next caller
        tries again, which is what a caller of a client expects.
        """
        cacheable = method == "GET" and not signed and body is None
        if cacheable:
            key: Key = (method, path, query, direct)
            cached = self._snapshot.get(key)
            if cached is not None:
                self.replayed += 1
                return cached

        response = super()._send(
            method, path, query=query, body=body, signed=signed, direct=direct
        )
        if cacheable:
            self._snapshot[key] = response
        self.fetched += 1
        return response
