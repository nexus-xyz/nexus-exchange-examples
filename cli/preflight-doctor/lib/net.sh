# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# The probes, and the classifier that turns a response into a cause.
#
# This file is the actual content of the example. Everything else is scaffolding
# around one question: when a request to the venue does not work, *which* thing
# is wrong? The statuses are few and the causes are many, so the mapping has to
# be stated exactly once, in one place, and be right.
#
# Measured against `api.testnet.nexus.xyz` on 2026-09-09; see the README's
# "What the verdicts mean" for the evidence behind each row.

# ── one HTTP probe ──────────────────────────────────────────────────────────
#
# Populated by `probe_http` on every call. Globals rather than a return value
# because bash can return one integer, and a probe produces six things.
PROBE_STATUS=0        # HTTP status, or 0 when nothing answered
PROBE_CURL_EXIT=0     # curl's own exit code, which is the whole story when STATUS is 0
PROBE_BODY=""         # first line of the body, trimmed — enough to name an Envoy fault
PROBE_HEADERS=""      # the response headers, lowercased names
PROBE_REQUEST_ID=""   # x-request-id, if the venue's app answered
PROBE_DATE=""         # the server's Date header, for the clock check
PROBE_CLASS=""        # the classifier's verdict; see `classify` below

# probe_http <method> <url> — one request, no credentials, no side effects.
#
# Deliberately never sends an Authorization header. Everything this function
# probes is answerable unauthenticated, and a probe that carried a credential
# would put one on a code path whose entire job is to run when things are
# broken. The credential check is a separate step, and it delegates to the CLI
# rather than signing anything here (see `lib/checks.sh`).
probe_http() {
  local method=$1 url=$2
  local raw exit_code=0

  PROBE_STATUS=0; PROBE_CURL_EXIT=0; PROBE_BODY=""; PROBE_HEADERS=""
  PROBE_REQUEST_ID=""; PROBE_DATE=""; PROBE_CLASS=""

  # `-D -` puts the headers on stdout ahead of the body, and the sentinel below
  # separates them: parsing on a blank line is wrong for HTTP/2, where curl's
  # header block ends differently than the CRLFCRLF a reader expects.
  raw=$(curl -sS \
    --request "$method" \
    --max-time "$DOCTOR_TIMEOUT_SECONDS" \
    --dump-header - \
    --write-out '\n__DOCTOR__%{http_code}\n' \
    "$url" 2>"$DOCTOR_STDERR_FILE") || exit_code=$?

  PROBE_CURL_EXIT=$exit_code
  PROBE_STATUS=$(printf '%s' "$raw" | sed -n 's/^__DOCTOR__\([0-9]*\)$/\1/p' | tail -1)
  PROBE_STATUS=${PROBE_STATUS:-0}

  PROBE_HEADERS=$(printf '%s' "$raw" | { grep '^[A-Za-z0-9-]*:' || true; })
  PROBE_REQUEST_ID=$(header_value 'x-request-id')
  PROBE_DATE=$(header_value 'date')

  # The body's first non-empty line, which for the two failures that matter is
  # the entire diagnosis: Envoy answers `fault filter abort` for a route it does
  # not have and `no healthy upstream` for one whose backend is gone.
  PROBE_BODY=$(printf '%s' "$raw" |
    sed -e '/^__DOCTOR__[0-9]*$/d' |
    { grep -v '^[A-Za-z0-9-]*:' || true; } |
    { grep -m1 '[^[:space:]]' || true; })
  PROBE_BODY=${PROBE_BODY:0:200}

  PROBE_CLASS=$(classify "$PROBE_STATUS" "$PROBE_CURL_EXIT")
}

# header_value <name> — read one header out of the last probe, case-insensitively.
#
# Header names are case-insensitive on the wire and both cases show up here:
# this venue answers `x-request-id` in lower case over HTTP/2 and `Content-Type`
# capitalised over HTTP/1.1, and the WebSocket probe forces HTTP/1.1. So the
# match has to ignore case.
#
# It is done with `grep -i` at lookup rather than by folding the names once at
# capture, and that is deliberate: the obvious fold, `sed 's/.../\L\1\E: /'`, is
# a GNU extension that BSD sed does not implement. On macOS it silently produces
# nothing, and every header-derived check — the request id, the clock, the
# rate-limit budget, the indexer lag — degrades to "not available" with no error
# anywhere. Folding the whole block with `tr` instead is worse: it would lower-
# case the *values* too, and `date -j -f '%a, %d %b %Y'` cannot parse `sep`.
#
# `{ grep ... || true; }` is load-bearing under this script's `set -o pipefail`.
# A `grep` that matches nothing exits 1, pipefail promotes that to the whole
# pipeline, the command substitution inherits it, and `set -e` kills the run at
# the assignment. An absent header is the *normal* case for most of these
# lookups, so without the guard the tool aborts — silently, with no output at
# all — the first time it meets a response that omits one.
header_value() {
  printf '%s\n' "$PROBE_HEADERS" |
    { grep -i "^$1:" || true; } |
    tail -1 |
    sed 's/^[^:]*:[[:space:]]*//' |
    tr -d '\r'
}

# ── the classifier ──────────────────────────────────────────────────────────
#
# The one piece of logic worth reading. A doctor that misreports the cause is
# worse than no doctor, because it sends the reader off to re-mint a key that
# was never the problem.
#
# The rule, in one sentence: **only a 404 means the path prefix is wrong.**
#
# That is not obvious, and the two ways to get it wrong are both natural:
#
#   - "A 401 means my key is bad." Not necessarily. Under the `/indexer` prefix
#     authentication runs *ahead* of routing, so a path that does not exist at
#     all answers 401 too. `/indexer/definitely-not-a-real-path` returns
#     `{"code":"UNAUTHORIZED"}`, exactly as `/indexer/account/summary` does. A
#     401 therefore proves the prefix is right and proves nothing else — it is
#     not evidence that the path you asked for exists.
#
#   - "A 5xx means the venue is broken, so my configuration is fine." Also not
#     necessarily, and the interesting case is the reverse: a 503 proves your
#     routing is *correct*. The gateway matched your prefix, tried to forward,
#     and found no healthy backend. Reporting that as a configuration problem
#     sends the reader to edit a URL that was already right.
#
# Verified live: while this example was being written the testnet indexer went
# down, and every path under `/indexer` answered `503 no healthy upstream` while
# the bare host still answered `404 fault filter abort`. Both come from the same
# Envoy, both arrive with no `x-request-id`, and the status is the only thing
# that separates them. That is why the status is the rule and everything else
# here is corroboration.
#
# classify <http-status> <curl-exit> → one of:
#   served         2xx — the venue answered this path
#   auth_required  401/403 — routing is right; credentials are the open question
#   not_routed     404 — the ONLY status that means a wrong prefix
#   upstream_down  502/503/504 — routing is right, the backend is not there
#   dead_upstream  500 — the venue's own 500, or a proxy to something retired
#   rate_limited   429 — you are being throttled, not misconfigured
#   version_skew   426 — the client is older than the venue's minimum
#   transport      nothing answered; the curl exit says whether it was DNS, TLS
#                  or a timeout
#   other          a status this tool has no opinion about, reported verbatim
classify() {
  local status=$1 curl_exit=$2

  if [[ $status == 0 ]]; then
    printf 'transport'
    return
  fi

  case $status in
    2??)      printf 'served' ;;
    401|403)  printf 'auth_required' ;;
    404)      printf 'not_routed' ;;
    426)      printf 'version_skew' ;;
    429)      printf 'rate_limited' ;;
    500)      printf 'dead_upstream' ;;
    502|503|504) printf 'upstream_down' ;;
    *)        printf 'other' ;;
  esac
  : "$curl_exit"
}

# What a curl exit code means, in words a reader can act on. Only the handful
# that actually come up; anything else is reported as its number, because a
# wrong guess about a rare failure is worse than an honest "look it up".
curl_exit_meaning() {
  case $1 in
    0)  printf 'no error' ;;
    5)  printf 'the proxy in HTTPS_PROXY/https_proxy could not be resolved' ;;
    6)  printf 'the host name did not resolve to any address' ;;
    7)  printf 'the address resolved but the connection was refused or unreachable' ;;
    28) printf 'the request timed out after %ss' "$DOCTOR_TIMEOUT_SECONDS" ;;
    35) printf 'the TLS handshake failed' ;;
    52) printf 'the server closed the connection without sending anything' ;;
    56) printf 'the connection was reset while receiving' ;;
    60) printf 'the server certificate could not be verified' ;;
    *)  printf 'curl exit %s (see the EXIT CODES section of the curl manual)' "$1" ;;
  esac
}

# ── DNS ─────────────────────────────────────────────────────────────────────
#
# Its own check because "the host does not resolve" is a completely different
# conversation from "the host resolved and said no", and a tool that lets the
# first one arrive as a timeout has wasted the reader's next thirty seconds.

RESOLVE_ADDRESSES=""
RESOLVE_COUNT=0
RESOLVE_RCODE=""

# resolve_host <hostname>
#
# `dig` is used when present for the DNS response code, and curl's own exit code
# is the fallback that always works. Note what this deliberately does *not*
# claim: it reports the number of addresses, not whether the name "exists".
# Under this zone a name with no address and a name that was never created both
# answer NOERROR with an empty answer section — measured for both
# `api.nexus.xyz` and a nonsense subdomain — so NODATA and NXDOMAIN cannot be
# told apart from here, and the honest report is "resolves to no address".
resolve_host() {
  local host=$1
  RESOLVE_ADDRESSES=""; RESOLVE_COUNT=0; RESOLVE_RCODE=""

  # Every pipeline below is guarded, and a host with no addresses is exactly
  # when the guards matter: `grep` matching nothing exits 1, `pipefail` promotes
  # it, and `set -e` would abort the run at the assignment — turning "mainnet is
  # not deployed", the single most useful thing this tool can say, into a silent
  # exit. `dig` itself is allowed to fail too; a missing resolver is a degraded
  # check, not a crash.
  if command -v dig >/dev/null 2>&1; then
    RESOLVE_RCODE=$(dig +noall +comments +time="$DOCTOR_TIMEOUT_SECONDS" +tries=1 \
      "$host" A 2>/dev/null | sed -n 's/.*status: \([A-Z]*\).*/\1/p' | tail -1) || true
    RESOLVE_ADDRESSES=$(dig +short +time="$DOCTOR_TIMEOUT_SECONDS" +tries=1 \
      "$host" A 2>/dev/null | { grep -E '^[0-9]+\.' || true; } | tr '\n' ' ') || true
    RESOLVE_ADDRESSES=${RESOLVE_ADDRESSES% }
  elif command -v host >/dev/null 2>&1; then
    RESOLVE_ADDRESSES=$(host -t A "$host" 2>/dev/null |
      sed -n 's/.* has address //p' | tr '\n' ' ') || true
    RESOLVE_ADDRESSES=${RESOLVE_ADDRESSES% }
  fi

  if [[ -n $RESOLVE_ADDRESSES ]]; then
    # shellcheck disable=SC2086  # deliberate word splitting: counting addresses
    set -- $RESOLVE_ADDRESSES
    RESOLVE_COUNT=$#
  fi
}

# ── the WebSocket upgrade probe ─────────────────────────────────────────────
#
# WS needs its own check, because a client can have a perfectly good REST base
# and still no stream: the TypeScript SDK derived its WS URL from the bare
# origin and dropped the `/indexer` prefix, which turns a working configuration
# into a silent 404 on connect. Nothing in a REST check would catch that.
#
# No websocket client is needed, and none is used: the handshake is an ordinary
# HTTP/1.1 request with four headers, and its *response* is the whole answer.
# `curl --http1.1` sends it and prints what came back.
WS_STATUS=0
WS_HAS_ACCEPT=0
WS_BODY=""
WS_CLASS=""

# probe_ws <wss-or-ws-url>
#
# The three outcomes, all measured:
#   101 + sec-websocket-accept → the stream is open, unauthenticated
#   401 + sec-websocket-accept → the route is served and token-gated. The accept
#                                header is the tell: the gateway ran the upgrade
#                                and *then* the venue refused it, so the path is
#                                real and the only thing missing is a token.
#   404                        → no route here. This is the dropped-prefix bug.
#
# The fixed `Sec-WebSocket-Key` is not a shortcut. The key is not a secret and
# not a nonce in any security sense — RFC 6455 uses it to prove the peer is a
# websocket implementation and not a confused cache — and this probe never
# reads a frame, so it has nothing to verify the accept value against. A
# constant makes the probe reproducible.
probe_ws() {
  local url=$1 raw exit_code=0
  WS_STATUS=0; WS_HAS_ACCEPT=0; WS_BODY=""; WS_CLASS=""

  # A successful upgrade leaves the connection open, and curl has no reason to
  # ever close it — so a 101 costs the full timeout and exits 28. That is a
  # *success*, and treating a timeout here as a failure would report the one
  # healthy outcome as broken. Kept short for that reason.
  raw=$(curl -sS -i --http1.1 \
    --max-time "$DOCTOR_WS_TIMEOUT_SECONDS" \
    --header 'Connection: Upgrade' \
    --header 'Upgrade: websocket' \
    --header 'Sec-WebSocket-Version: 13' \
    --header 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==' \
    "${url/#wss:/https:}" 2>"$DOCTOR_STDERR_FILE") || exit_code=$?

  WS_STATUS=$(printf '%s' "$raw" | sed -n 's|^HTTP/1\.1 \([0-9]\{3\}\).*|\1|p' | tail -1) || true
  WS_STATUS=${WS_STATUS:-0}
  if printf '%s' "$raw" | grep -qi '^sec-websocket-accept:'; then
    WS_HAS_ACCEPT=1
  fi
  WS_BODY=$(printf '%s' "$raw" |
    { grep -v '^[A-Za-z0-9-]*:' || true; } | { grep -m1 '[^[:space:]]' || true; })
  WS_BODY=${WS_BODY:0:200}

  case $WS_STATUS in
    101) WS_CLASS=open ;;
    401|403) WS_CLASS=token_required ;;
    404) WS_CLASS=not_routed ;;
    0)   WS_CLASS=transport ;;
    502|503|504) WS_CLASS=upstream_down ;;
    *)   WS_CLASS=other ;;
  esac
  : "$exit_code"
}

# ── clock skew ──────────────────────────────────────────────────────────────
#
# The one cause of a 401 this tool can actually *eliminate*, which is why it is
# worth the portability trouble. An HMAC request carries a timestamp the venue
# checks against a narrow window; a laptop whose clock has drifted signs
# requests that are rejected as replays, and the rejection is the same opaque
# 401 a wrong key gets. Ruling it out takes the reader's list of suspects from
# four down to three.
CLOCK_SKEW_SECONDS=""

# clock_skew <http-date-header>
#
# `date -d` is GNU and `date -j -f` is BSD, and this example is expected to run
# on both — macOS has no GNU date unless the reader installed one. Try each.
clock_skew() {
  local http_date=$1 server_epoch="" now
  [[ -z $http_date ]] && { CLOCK_SKEW_SECONDS=""; return 1; }

  server_epoch=$(date -u -d "$http_date" +%s 2>/dev/null) ||
    server_epoch=$(date -u -j -f '%a, %d %b %Y %T %Z' "$http_date" +%s 2>/dev/null) ||
    server_epoch=""

  [[ $server_epoch =~ ^[0-9]+$ ]] || { CLOCK_SKEW_SECONDS=""; return 1; }

  now=$(date -u +%s)
  CLOCK_SKEW_SECONDS=$(( now - server_epoch ))
  return 0
}
