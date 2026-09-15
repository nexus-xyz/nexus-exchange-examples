#!/usr/bin/env bash
#
# Offline tests for the parts of preflight-doctor that must be right.
#
# No network, no credentials, no account. What is covered here is the logic a
# reader is trusting: the classifier's 404-versus-401-versus-503 reading, the
# redactor on every path a secret could take, and the `set -euo pipefail`
# hazards that made this tool exit silently twice while it was being written.
#
#   ./test/run-tests.sh
#
# The venue's own behaviour is not stubbed and not asserted on — that is what
# the live run in the README shows. These are the decisions, not the wire.

set -uo pipefail

TEST_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd -P -- "$TEST_DIR/.." && pwd)

# The library under test needs a few globals its callers normally set.
DOCTOR_TIMEOUT_SECONDS=15
DOCTOR_WS_TIMEOUT_SECONDS=8
DOCTOR_STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/preflight-doctor-test.XXXXXX")
trap 'rm -f -- "$DOCTOR_STDERR_FILE"' EXIT

# shellcheck source=../lib/common.sh
source "$APP_DIR/lib/common.sh"
# shellcheck source=../lib/net.sh
source "$APP_DIR/lib/net.sh"

PASSED=0
FAILED=0

check() {
  local label=$1 expected=$2 actual=$3
  if [[ $expected == "$actual" ]]; then
    PASSED=$(( PASSED + 1 ))
  else
    FAILED=$(( FAILED + 1 ))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$label" "$expected" "$actual" >&2
  fi
}

contains() {
  local label=$1 needle=$2 haystack=$3
  if [[ $haystack == *"$needle"* ]]; then
    PASSED=$(( PASSED + 1 ))
  else
    FAILED=$(( FAILED + 1 ))
    printf 'FAIL  %s\n        expected to contain: %s\n        actual:              %s\n' \
      "$label" "$needle" "$haystack" >&2
  fi
}

lacks() {
  local label=$1 needle=$2 haystack=$3
  if [[ $haystack != *"$needle"* ]]; then
    PASSED=$(( PASSED + 1 ))
  else
    FAILED=$(( FAILED + 1 ))
    printf 'FAIL  %s\n        expected NOT to contain: %s\n        actual:                  %s\n' \
      "$label" "$needle" "$haystack" >&2
  fi
}

# ── the classifier ──────────────────────────────────────────────────────────
#
# The rule this tool lives or dies by: only a 404 means the prefix is wrong.

check "200 is served"                served       "$(classify 200 0)"
check "204 is served"                served       "$(classify 204 0)"
check "401 is auth_required"         auth_required "$(classify 401 0)"
check "403 is auth_required"         auth_required "$(classify 403 0)"
check "404 is not_routed"            not_routed   "$(classify 404 0)"
check "426 is version_skew"          version_skew "$(classify 426 0)"
check "429 is rate_limited"          rate_limited "$(classify 429 0)"
check "500 is dead_upstream"         dead_upstream "$(classify 500 0)"
check "502 is upstream_down"         upstream_down "$(classify 502 0)"
check "503 is upstream_down"         upstream_down "$(classify 503 0)"
check "504 is upstream_down"         upstream_down "$(classify 504 0)"
check "no answer is transport"       transport    "$(classify 0 6)"
check "418 has no opinion"           other        "$(classify 418 0)"

# The two that must never be confused. A 503 means the route matched and the
# backend is gone; a 404 means there is no route. Both were observed live on
# this venue within the same hour, from the same Envoy, both without an
# x-request-id — so nothing but the status separates them.
check "503 is not a prefix problem"  upstream_down "$(classify 503 0)"
check "404 is the only prefix problem" not_routed  "$(classify 404 0)"

# A 401 is not a prefix problem either, which is the other half of the rule:
# under /indexer, auth runs ahead of routing, so a nonexistent path 401s too.
check "401 is not a prefix problem"  auth_required "$(classify 401 0)"

# ── curl exit codes ─────────────────────────────────────────────────────────

contains "exit 6 names DNS"      "did not resolve"   "$(curl_exit_meaning 6)"
contains "exit 7 names connect"  "connection"        "$(curl_exit_meaning 7)"
contains "exit 35 names TLS"     "TLS"               "$(curl_exit_meaning 35)"
contains "exit 28 names timeout" "timed out"         "$(curl_exit_meaning 28)"
contains "unknown exit is honest" "99"               "$(curl_exit_meaning 99)"

# ── redaction ───────────────────────────────────────────────────────────────
#
# The property the README promises: output is safe to paste. Asserted on the
# error paths specifically, because those are the ones that carry wire text.

REDACT_VALUES=()
redact_register "s3cret-value-not-for-printing"
lacks "a registered secret never survives redact" \
  "s3cret-value-not-for-printing" \
  "$(redact 'the request failed with key s3cret-value-not-for-printing attached')"
contains "redact leaves the rest of the message alone" \
  "the request failed" \
  "$(redact 'the request failed with key s3cret-value-not-for-printing attached')"

# The catch-all, for a secret nobody registered — an error message quoting a
# signing key the tool never read, say.
lacks "a long hex run is redacted even unregistered" \
  "deadbeefdeadbeefdeadbeefdeadbeef0123" \
  "$(redact 'signature=deadbeefdeadbeefdeadbeefdeadbeef0123')"
lacks "a long token-shaped run is redacted even unregistered" \
  "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefgh" \
  "$(redact 'authorization: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefgh')"

# Over-redaction is the safe direction and is deliberate; this pins that the
# short, harmless things a reader needs are still legible.
contains "short values are left readable" "BTC-USDX-PERP" \
  "$(redact 'market BTC-USDX-PERP is halted')"
contains "an http status survives redaction" "404" "$(redact 'HTTP 404 from the gateway')"

# A registered value is replaced wherever it appears, not just at a boundary.
REDACT_VALUES=()
redact_register "abcdefghij"
lacks "a secret embedded mid-string is still redacted" \
  "abcdefghij" "$(redact 'prefix-abcdefghij-suffix')"

# Too short to register: replacing a 3-character string everywhere would
# corrupt unrelated output, so it is deliberately not registered.
REDACT_VALUES=()
redact_register "abc"
check "a too-short value is not registered" 0 "${#REDACT_VALUES[@]}"

# `describe_secret` is the only way a credential may appear in output: a length
# and a character class, never a value and never a prefix.
lacks "describe_secret never echoes the value" \
  "0123456789abcdef" "$(describe_secret '0123456789abcdef')"
contains "describe_secret reports the length" "16 characters" \
  "$(describe_secret '0123456789abcdef')"
contains "describe_secret reports hex" "hex" "$(describe_secret '0123456789abcdef')"
check "describe_secret handles empty" "not set" "$(describe_secret '')"

# ── set -euo pipefail hazards ───────────────────────────────────────────────
#
# Both of these shipped as bugs during development and both presented the same
# way: the tool exited 1 having printed nothing at all. They are regression
# tests because a silent exit is the single worst failure mode for a diagnostic
# — the reader learns nothing, including that anything went wrong.

# `(( 0 >= 8 ))` is false and therefore exits 1. As the last statement of a
# loop it made redact_register return 1, which killed the run at the call site.
# Registering nothing is the normal case for a reader with no credentials.
REDACT_VALUES=()
redact_register "" "" ""
check "redact_register succeeds when it registers nothing" 0 "$?"

REDACT_VALUES=()
redact_register "long-enough-to-register"
check "redact_register succeeds when it registers something" 0 "$?"

# A `grep` that matches nothing exits 1, `pipefail` promotes it to the whole
# pipeline, and the command substitution inherits it. An absent header is
# normal, so header_value has to survive one.
PROBE_HEADERS=$'content-type: application/json\r\nx-request-id: abc123\r'
check "header_value finds a header" "abc123" "$(header_value 'x-request-id')"
check "header_value is case-insensitive" "abc123" "$(header_value 'X-Request-Id')"
header_value 'x-nonexistent-header' >/dev/null
check "header_value survives an absent header" 0 "$?"
check "an absent header is empty, not an error" "" "$(header_value 'x-nonexistent-header')"

# The header block can be empty entirely — a transport failure answers nothing.
PROBE_HEADERS=""
header_value 'date' >/dev/null
check "header_value survives an empty header block" 0 "$?"

# ── clock skew ──────────────────────────────────────────────────────────────
#
# Parsed with GNU `date -d` or BSD `date -j -f`; the tool runs on both.

if clock_skew "$(date -u '+%a, %d %b %Y %H:%M:%S GMT')"; then
  abs=${CLOCK_SKEW_SECONDS#-}
  if (( abs <= 2 )); then
    PASSED=$(( PASSED + 1 ))
  else
    FAILED=$(( FAILED + 1 ))
    printf 'FAIL  clock_skew against our own clock should be ~0, got %s\n' \
      "$CLOCK_SKEW_SECONDS" >&2
  fi
else
  FAILED=$(( FAILED + 1 ))
  printf 'FAIL  clock_skew could not parse an RFC 1123 date on this platform\n' >&2
fi

clock_skew "not a date at all" >/dev/null 2>&1
check "clock_skew refuses garbage rather than inventing a skew" 1 "$?"
check "a refused parse leaves no skew behind" "" "$CLOCK_SKEW_SECONDS"

clock_skew "" >/dev/null 2>&1
check "clock_skew refuses an empty date" 1 "$?"

# ── the verdict table ───────────────────────────────────────────────────────

CHECK_NAMES=(); CHECK_VERDICTS=(); CHECK_FINDINGS=(); CHECK_STEPS=()
check "no checks means ok" "ok" "$(worst_verdict)"
record a ok "fine" "nothing"
check "all ok means ok" "ok" "$(worst_verdict)"
record b warn "hmm" "look"
check "a warning outranks ok" "warn" "$(worst_verdict)"
record c ok "fine" "nothing"
check "a later ok does not clear a warning" "warn" "$(worst_verdict)"
record d fail "broken" "fix"
check "a failure outranks a warning" "fail" "$(worst_verdict)"
record e ok "fine" "nothing"
check "a later ok does not clear a failure" "fail" "$(worst_verdict)"

# The documented happy path reaches exit 0.
#
# `check_env` and `check_cli` used to `warn` when credentials and the CLI were
# simply ABSENT, so a credential-less run -- which README:102-103 calls the
# degrade-to-skip case and which a CI step following the README performs --
# always produced `warn`, i.e. exit 3, "a warning will bite you later"
# (@nvizble, #21). Exit 0 was unreachable from the documented invocation.
#
# Absent is a skip: the check could not run. Present-but-wrong is still a warn.
CHECK_NAMES=(); CHECK_VERDICTS=(); CHECK_FINDINGS=(); CHECK_STEPS=()
record env skip "no credentials configured" "mint a pair"
record cli skip "the nexus CLI is not on PATH" "install it"
record rest ok "reachable" ""
check "a credential-less run is ok, not warn" "ok" "$(worst_verdict)"
record env warn "half a pair is configured" "copy them across"
check "a MISCONFIGURED credential is still a warning" "warn" "$(worst_verdict)"

# A skip is not a pass. "Not checked" has to stay distinguishable from "fine",
# or a reader reads an unrun check as a clean bill of health.
CHECK_NAMES=(); CHECK_VERDICTS=(); CHECK_FINDINGS=(); CHECK_STEPS=()
record f skip "not checked" "install the CLI"
check "a skip does not count as a failure" "ok" "$(worst_verdict)"

# `record` redacts, so a finding built from wire text cannot leak.
CHECK_NAMES=(); CHECK_VERDICTS=(); CHECK_FINDINGS=(); CHECK_STEPS=()
REDACT_VALUES=()
redact_register "leaked-secret-value"
record g fail "the venue rejected leaked-secret-value" "re-mint leaked-secret-value"
lacks "record redacts the finding"   "leaked-secret-value" "${CHECK_FINDINGS[0]}"
lacks "record redacts the next step" "leaked-secret-value" "${CHECK_STEPS[0]}"

# ── regression: the five findings from #21's review ─────────────────────────
#
# Each of these reproduces a bug that shipped, so a future refactor that
# reintroduces one fails here rather than in a support channel.

# B2/B1 — a base carrying `user:pass@` must never reach the report, and the
# password is neither registered nor long enough for the catch-all, so `redact`
# cannot save it. Stripping has to be structural.
check "userinfo is stripped from an https base" \
  "https://127.0.0.1:9391/indexer" \
  "$(url_without_userinfo 'https://apiuser:hunter2-proxy-password@127.0.0.1:9391/indexer')"
check "userinfo is stripped from a wss base" \
  "wss://127.0.0.1:9391/indexer" \
  "$(url_without_userinfo 'wss://apiuser:pw@127.0.0.1:9391/indexer')"
check "a base without userinfo is untouched" \
  "https://api.testnet.nexus.xyz/indexer" \
  "$(url_without_userinfo 'https://api.testnet.nexus.xyz/indexer')"
check "a base with no path is untouched" \
  "http://localhost:8080" \
  "$(url_without_userinfo 'http://localhost:8080')"
# The LAST `@` before the path delimits userinfo, because a password may
# contain one. Splitting on the first `@` would leave `ss@host` as the host.
check "an @ inside the password does not confuse the split" \
  "https://host/x" \
  "$(url_without_userinfo 'https://u:p@ss@host/x')"

# And the host derived from that base is the HOST, not the proxy username --
# `${h%%:*}` on `apiuser:pw@127.0.0.1:9391` yields `apiuser`, which is what
# `resolve_host` was being handed.
doctor_test_host=$(url_without_userinfo 'https://apiuser:hunter2-proxy-password@127.0.0.1:9391/indexer')
doctor_test_host=${doctor_test_host#*://}
doctor_test_host=${doctor_test_host%%/*}
check "the derived host is the host, not the userinfo user" \
  "127.0.0.1" "${doctor_test_host%%:*}"

# B5 — curl speaks neither `ws:` nor `wss:`. Rewriting only `wss:` made every
# plain-HTTP deployment report a blocked Upgrade.
check "wss is rewritten to https" "https://h/p" "$(ws_probe_url 'wss://h/p')"
check "ws is rewritten to http"   "http://h/p"  "$(ws_probe_url 'ws://h/p')"
check "a non-ws url is untouched" "https://h/p" "$(ws_probe_url 'https://h/p')"

# ── report ──────────────────────────────────────────────────────────────────

printf '\n%d passed, %d failed.\n' "$PASSED" "$FAILED"
(( FAILED == 0 )) || exit 1
