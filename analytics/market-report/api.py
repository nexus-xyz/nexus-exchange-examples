"""Read-only HTTP against the Exchange, with the standard library only.

There is no SDK dependency here, and that is not a stylistic choice: the Python
SDK (``nexus-exchange``) is not on PyPI yet — its own README says "once
published; for now, install from source" — and CONTRIBUTING.md requires a
self-contained ``requirements.txt`` where every dependency is pinned with ``==``.
A ``git+https://`` requirement cannot satisfy that. So this example talks to the
API directly, which for a read-only analytics tool costs about eighty lines.

What those eighty lines are actually for is the part worth copying. A GET is one
call; the rest is refusing to turn a bad response into a plausible number.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

# The deployment's gateway base. The `/api/v1` surface is mounted *under* this
# prefix rather than at the host root — see the README's "About the host", where
# the 404 that teaches you this is written out.
DEFAULT_BASE_URL = "https://exchange.nexus.xyz/api/exchange"

# Sent on every request for traffic attribution, the same way the CLI does. Not
# a version negotiation: see `API_VERSION`.
USER_AGENT = "nexus-exchange-examples/market-report"

# The spec release this example was written against. Sent as a header because
# that is the documented contract, and measured to be *unenforced* on this
# deployment — a bogus value and no header at all both behave identically. It is
# here so a future deployment that does enforce it gets the answer it expects,
# and so the number is visible in one place when a payload shape changes.
API_VERSION = "v0.8.1"

# A response bigger than this is refused rather than parsed. 1000 candles is
# about 60 KB; a megabyte means something other than what was asked for.
MAX_RESPONSE_BYTES = 8 * 1024 * 1024

JsonValue = Any


class ApiError(RuntimeError):
    """A request that did not produce usable JSON, with why in the message."""


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse redirects instead of following them.

    `urllib` follows them by default, and a redirect can cross to another origin
    — at which point the thing being parsed as venue data was served by someone
    else. Nothing here is authenticated, so there is no credential to leak; the
    reason to refuse is simply that a report should not silently describe a
    different host than the one it names in its own header.
    """

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


class Cache:
    """A tiny on-disk cache, because analytics gets re-run.

    Iterating on an analysis should not mean re-fetching the same window from
    the venue twenty times. Only public market data passes through here — there
    is no authenticated call in this example, and writing account data to a
    plain file in the working directory would be a different decision needing a
    different justification.

    It stores the **raw response body**, not the parsed payload, and that is the
    whole design. Storing the parsed object means re-serialising `Decimal`s, and
    since JSON has no decimal type they come back as *strings* — so a cache hit
    would hand the rest of the program subtly different types than a live fetch,
    and any bug that produced would only appear on the second run. Keeping the
    body means a hit and a miss go through exactly the same parse, so they cannot
    disagree.
    """

    def __init__(self, directory: Path, ttl_seconds: float) -> None:
        self.directory = directory
        self.ttl_seconds = ttl_seconds

    def _path(self, key: str) -> Path:
        return self.directory / f"{key}.json"

    def get(self, key: str) -> str | None:
        """The cached response body, or None for a miss, a stale or a bad entry."""
        try:
            raw = self._path(key).read_text(encoding="utf-8")
        except OSError:
            return None
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            # A half-written file from an interrupted run. Not an error: the
            # request is simply made again.
            return None
        if not isinstance(entry, dict):
            return None
        fetched_at = entry.get("fetched_at")
        body = entry.get("body")
        if not isinstance(body, str) or not isinstance(fetched_at, (int, float)):
            return None
        age = time.time() - float(fetched_at)
        if age > self.ttl_seconds or age < 0:
            # A negative age means the file is stamped in the future — a clock
            # change, or a file copied from elsewhere. Treated as a miss rather
            # than trusted indefinitely.
            return None
        return body

    def put(self, key: str, body: str) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self._path(key)
        # Written to a temporary file and moved into place, so a crash mid-write
        # cannot leave a truncated file that a later run reads as data. `replace`
        # is atomic on the same filesystem. The pid is in the temporary name so
        # two runs cannot collide on it.
        temp = target.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps({"fetched_at": time.time(), "body": body}), encoding="utf-8")
        temp.replace(target)


class Api:
    """One GET, hardened, plus pacing, retries and the cache."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 20.0,
        attempts: int = 3,
        min_interval: float = 0.1,
        cache: Cache | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        if self.base_url.endswith("/api/v1"):
            # The paths this app asks for already carry `/api/v1`, so a base that
            # also ends in it produces `/api/v1/api/v1/...` and a 404 that reads
            # like the endpoint does not exist.
            raise ApiError(
                f"base URL must not end in /api/v1 (got {self.base_url!r}); "
                "pass the gateway base, e.g. " + DEFAULT_BASE_URL
            )
        self.timeout = timeout
        self.attempts = max(1, attempts)
        self.min_interval = min_interval
        self.cache = cache
        self._opener = urllib.request.build_opener(_NoRedirects())
        self._last_request_at = 0.0
        self.request_count = 0
        self.cache_hits = 0

    # ── the public call ─────────────────────────────────────────────────────

    def get_json(self, path: str, params: Mapping[str, str] | None = None) -> JsonValue:
        query = urllib.parse.urlencode(dict(params or {}))
        url = f"{self.base_url}{path}" + (f"?{query}" if query else "")
        key = self._cache_key(url)

        if self.cache is not None:
            cached = self.cache.get(key)
            if cached is not None:
                self.cache_hits += 1
                return self._parse(cached, f"{url} (cached)")

        body = self._get_with_retries(url)
        payload = self._parse(body, url)
        # Cached only after it parsed, so a malformed response is never stored.
        if self.cache is not None:
            self.cache.put(key, body)
        return payload

    # ── internals ──────────────────────────────────────────────────────────

    def _cache_key(self, url: str) -> str:
        # The whole URL, so a run against a different host cannot be served this
        # host's answers. sha256 rather than a sanitised URL: no path traversal,
        # no filename length limit, no encoding questions.
        return hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]

    def _pace(self) -> None:
        """Keep a floor on the gap between requests.

        A token bucket would be the right shape for a trading client; this tool
        makes a couple of dozen requests in a burst and then exits, so a minimum
        interval is the whole of what it needs. Saying which one it is matters
        more than which one it uses.
        """
        elapsed = time.monotonic() - self._last_request_at
        if self._last_request_at and elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_request_at = time.monotonic()

    def _get_with_retries(self, url: str) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self.attempts + 1):
            self._pace()
            try:
                return self._get_once(url)
            except ApiError as exc:
                last_error = exc
                if not getattr(exc, "retryable", False) or attempt == self.attempts:
                    raise
            # Exponential backoff with equal jitter, so repeated failures neither
            # hammer the host nor line up across concurrent runs.
            ceiling = min(8.0, 0.5 * 2 ** (attempt - 1))
            time.sleep(ceiling / 2 + random.random() * ceiling / 2)
        raise ApiError(str(last_error))

    def _get_once(self, url: str) -> str:
        request = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
                "X-Nexus-Api-Version": API_VERSION,
            },
        )
        self.request_count += 1
        status: int
        content_type: str
        # Annotated because `urlopen` is typed as returning `Any`, and an
        # unannotated `body` would silently make `body.decode()` an `Any` too —
        # which is how a typed program grows an untyped middle.
        body: bytes
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                status = int(response.status)
                content_type = str(response.headers.get("content-type", ""))
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            # `HTTPError` is itself a file-like response and holds an open spooled
            # temporary file, so it is read *and closed*. Leaving it to the
            # garbage collector produces a ResourceWarning from inside the
            # standard library, which is a confusing thing for an example to
            # print at someone.
            try:
                detail = _describe_error_body(exc.read(4096).decode("utf-8", "replace"))
            finally:
                exc.close()
            error = ApiError(f"GET {url} → HTTP {exc.code}: {detail}")
            # 429 and 5xx are worth asking again; a 400 or a 404 will say the
            # same thing however many times it is asked.
            setattr(error, "retryable", exc.code == 429 or 500 <= exc.code < 600)
            raise error from exc
        except urllib.error.URLError as exc:
            error = ApiError(f"GET {url} failed to connect: {exc.reason}")
            setattr(error, "retryable", True)
            raise error from exc
        except TimeoutError as exc:
            error = ApiError(f"GET {url} timed out after {self.timeout}s")
            setattr(error, "retryable", True)
            raise error from exc

        if len(body) > MAX_RESPONSE_BYTES:
            raise ApiError(f"GET {url} returned more than {MAX_RESPONSE_BYTES} bytes")

        # The content type is checked *before* parsing, because the failure this
        # catches does not look like a failure otherwise: point a client at the
        # host root instead of the gateway base and every path returns the
        # marketing site's HTML 404 page with a 200-shaped body. Parsing that
        # produces `JSONDecodeError: Expecting value: line 1 column 1`, which
        # sends you looking at your JSON handling instead of your URL.
        if "json" not in content_type.lower():
            raise ApiError(
                f"GET {url} → HTTP {status} with content-type {content_type!r}, "
                "which is not JSON. If that is an HTML page, the base URL is "
                "probably wrong: this API is mounted under a gateway prefix, "
                f"not at the host root (see {DEFAULT_BASE_URL})."
            )

        try:
            return body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError(f"GET {url} → HTTP {status}, body is not UTF-8: {exc}") from exc

    def _parse(self, body: str, where: str) -> JsonValue:
        """Decode JSON with every float as a `Decimal`.

        `parse_float=Decimal` is the single most important argument in this file.
        The market-data routes are CCXT-shaped and send prices as JSON *doubles*
        — the live venue really does return a 24h change of 391.2000000000003 —
        so without it every price in this report would be a float before any of
        the careful arithmetic downstream could help. Parsing straight to Decimal
        keeps the digits the venue actually sent, and makes a float impossible to
        introduce later by accident: there are none in the data to begin with.

        It lives in one method so that a cache hit and a live fetch cannot
        possibly parse differently.
        """
        try:
            return json.loads(body, parse_float=Decimal)
        except json.JSONDecodeError as exc:
            raise ApiError(f"GET {where}: unparsable JSON: {exc}") from exc


def _describe_error_body(text: str) -> str:
    """Turn an error body into one useful line.

    The case worth special-handling is the one that costs an afternoon: point a
    client at the host root instead of the gateway base and the API answers with
    the marketing site's HTML 404. Echoing 200 characters of Next.js markup into
    the error is technically the response and practically useless, so an HTML
    body is diagnosed rather than quoted.
    """
    stripped = text.strip()
    if not stripped:
        return "(empty body)"
    head = stripped[:200].lower()
    if head.startswith("<!doctype html") or head.startswith("<html") or "<body" in head:
        return (
            "an HTML page rather than JSON — the base URL is probably wrong. This "
            f"API is mounted under a gateway prefix, not at the host root (try {DEFAULT_BASE_URL})"
        )
    return stripped.splitlines()[0][:200]
