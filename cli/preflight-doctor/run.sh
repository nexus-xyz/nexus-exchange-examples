#!/usr/bin/env bash
#
# preflight-doctor — the command you run before anything else, to find out why
# you cannot reach the Nexus Exchange.
#
# It answers one question in as many pieces as it takes: which of the things
# between your shell and the venue is the broken one. Is the host deployed at
# all? Is the base URL carrying the path prefix the venue serves under? Is the
# WebSocket base derived from the right place? Is your clock close enough to
# sign a request? And only once all of that is established: are your
# credentials the problem?
#
# The order is not cosmetic. Every support question in this area arrives as the
# same opaque `401`, and the causes are deliberately indistinguishable from the
# status alone — a wrong-network key, a revoked key, a drifted clock and a
# signature over the old path all return it. Separating them is what this is
# for, and it can only be done by ruling things out from the bottom up.
#
#   ./run.sh              run every check and print the report
#   ./run.sh --json       the same verdicts as JSON, for a CI step
#   ./run.sh --quiet      the summary line only
#
# Read-only, always. It places no orders, cancels nothing, and changes no
# account setting on any path. Its output is safe to paste into a bug report:
# see "Redaction" in README.md.

set -euo pipefail

# ── bash version ────────────────────────────────────────────────────────────
# Before anything else, and before sourcing a single file: this tool relies on
# `set -u` tolerating an empty array expansion, which is bash 4.4. macOS still
# ships bash 3.2, where the failure is a parse error inside a sourced file — an
# error about a file the reader did not write, which is a bad way to learn you
# need a newer bash.
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  printf 'error: bash 4.4 or newer is required (this is %s).\n' "${BASH_VERSION:-unknown}" >&2
  printf '       macOS ships bash 3.2 — install a newer one (brew install bash) and re-run.\n' >&2
  exit 1
fi

# Resolve the example's own directory, so it can be run from anywhere — a CI
# step, a support script, someone's home directory.
SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/config.sh
source "$SCRIPT_DIR/lib/config.sh"
# shellcheck source=lib/net.sh
source "$SCRIPT_DIR/lib/net.sh"
# shellcheck source=lib/checks.sh
source "$SCRIPT_DIR/lib/checks.sh"

OUTPUT=report
TMP_DIR=""
DOCTOR_STDERR_FILE=""
DIAGNOSTIC_TAIL=""

usage() {
  cat <<'USAGE'
preflight-doctor — find out why you cannot reach the Nexus Exchange.

usage: ./run.sh [--json | --quiet] [--help]

  (no flags)   run every check and print the full report. The default.
  --json       the same verdicts as a JSON array, for a CI step or a script.
  --quiet      the one-line summary only.
  --help       this text.

Read-only: it places no orders and changes nothing. Its output is safe to paste
into a bug report — credentials are never printed, on any path.

Configuration is environment-only; see .env.example and README.md.
USAGE
}

parse_args() {
  while (( $# )); do
    case $1 in
      --json)   OUTPUT=json ;;
      --quiet)  OUTPUT=quiet ;;
      --report) OUTPUT=report ;;
      -h|--help) usage; exit "$EX_OK" ;;
      *) usage >&2; die "$EX_USAGE" "unknown argument $(quoted "$1")" ;;
    esac
    shift
  done
}

# shellcheck disable=SC2317,SC2329  # reached via `trap`, which shellcheck does not follow
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [[ -n $TMP_DIR && -d $TMP_DIR ]] && rm -rf -- "$TMP_DIR"
  exit "$code"
}

# ── report ──────────────────────────────────────────────────────────────────

hr() { printf -- '─%.0s' {1..78}; printf '\n'; }

# A glyph and a word. The glyph is for scanning a wall of output; the word is
# for the reader whose terminal or paste target eats the glyph.
verdict_mark() {
  case $1 in
    ok)   printf 'PASS' ;;
    warn) printf 'WARN' ;;
    fail) printf 'FAIL' ;;
    skip) printf 'skip' ;;
    *)    printf '????' ;;
  esac
}

report_header() {
  printf 'preflight-doctor  %s  (%s)\n' "$REST_HOST" "$DOCTOR_NETWORK"
  hr
  printf '%-12s%s\n' "network" "$DOCTOR_NETWORK — $NETWORK_FUNDS"
  printf '%-12s%s\n' "rest base" "$REST_BASE"
  printf '%-12s%s\n' "  from" "$REST_BASE_SOURCE"
  printf '%-12s%s\n' "  prefix" "$REST_PREFIX"
  printf '%-12s%s\n' "ws base" "$WS_BASE"
  printf '%-12s%s\n' "  from" "$WS_BASE_SOURCE"
  printf '%-12s%s\n' "cli" "${CLI_VERSION_LINE:-not installed}"
  # Printed here, outside `record`, because the redactor's catch-all treats a
  # 32-hex string as a credential and would eat it. It is a server-issued
  # correlation id and the single most useful thing to quote in a support
  # ticket, so it is extracted deliberately rather than smuggled through.
  [[ -n ${REACH_REQUEST_ID:-} ]] &&
    printf '%-12s%s\n' "request id" "$REACH_REQUEST_ID"
  printf '%-12s%s\n' "checked" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  hr
}

report_checks() {
  local i
  for i in "${!CHECK_NAMES[@]}"; do
    printf '%-6s%-12s%s\n' \
      "$(verdict_mark "${CHECK_VERDICTS[$i]}")" "${CHECK_NAMES[$i]}" "${CHECK_FINDINGS[$i]}"
    # The next step is indented under its finding rather than collected at the
    # bottom, because the reader scanning for their one FAIL should not then
    # have to go and find the matching advice.
    [[ -n ${CHECK_STEPS[$i]} ]] && printf '%18s→ %s\n' "" "${CHECK_STEPS[$i]}"
  done
}

report_summary() {
  local i pass=0 warn=0 fail=0 skip=0
  for i in "${!CHECK_VERDICTS[@]}"; do
    case ${CHECK_VERDICTS[$i]} in
      ok) pass=$(( pass + 1 )) ;;
      warn) warn=$(( warn + 1 )) ;;
      fail) fail=$(( fail + 1 )) ;;
      skip) skip=$(( skip + 1 )) ;;
    esac
  done
  printf '%d passed, %d warning(s), %d failed, %d skipped.\n' "$pass" "$warn" "$fail" "$skip"
}

# JSON without jq, because the tool has to work when jq is not installed —
# and the values here are this script's own strings, not arbitrary input. Only
# the two characters JSON cannot carry raw are escaped.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  printf '%s' "$s"
}

report_json() {
  local i first=1
  printf '{\n'
  printf '  "network": "%s",\n' "$(json_escape "$DOCTOR_NETWORK")"
  printf '  "rest_base": "%s",\n' "$(json_escape "$REST_BASE")"
  printf '  "rest_base_source": "%s",\n' "$(json_escape "$REST_BASE_SOURCE")"
  printf '  "ws_base": "%s",\n' "$(json_escape "$WS_BASE")"
  printf '  "checked_at": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '  "verdict": "%s",\n' "$(worst_verdict)"
  printf '  "checks": [\n'
  for i in "${!CHECK_NAMES[@]}"; do
    (( first )) || printf ',\n'
    first=0
    printf '    {"check": "%s", "verdict": "%s", "finding": "%s", "next_step": "%s"}' \
      "$(json_escape "${CHECK_NAMES[$i]}")" \
      "$(json_escape "${CHECK_VERDICTS[$i]}")" \
      "$(json_escape "${CHECK_FINDINGS[$i]}")" \
      "$(json_escape "${CHECK_STEPS[$i]}")"
  done
  printf '\n  ]\n}\n'
}

# ── main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  trap cleanup EXIT INT TERM

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/preflight-doctor.XXXXXX")
  DOCTOR_STDERR_FILE="$TMP_DIR/stderr"

  load_dotenv "$SCRIPT_DIR/.env"
  resolve_config
  resolve_network

  require_cmd curl date sed grep

  # Order matters, and each comment says why this one has to come before the
  # next: the verdicts below depend on what the ones above established.
  check_env                 # what is configured, and in whose namespace
  check_base_url_override   # what would silently redirect the CLI
  check_cli                 # the CLI as a component — not needed by the probes
  check_dns                 # is there a host at all
  check_reach               # does the configured base serve a public path
  check_prefix_semantics    # what a 401 means *here*, proved rather than assumed
  check_legacy_base         # is an unconfigured client pointed at a dead host
  check_clock               # eliminate one of the four causes of a 401
  check_version             # is this client inside the venue's supported window
  check_health              # reachable is not the same as working
  check_ws                  # the stream has its own base and its own failure
  check_credentials         # last: now a 401 here means something specific

  case $OUTPUT in
    json)
      report_json
      ;;
    quiet)
      report_summary
      ;;
    *)
      report_header
      report_checks
      hr
      report_summary
      if [[ -n $DIAGNOSTIC_TAIL ]]; then
        printf '\nthe CLI said (redacted):\n%s\n' "$DIAGNOSTIC_TAIL"
      fi
      ;;
  esac

  case $(worst_verdict) in
    fail) exit "$EX_FAIL" ;;
    warn) exit "$EX_DEGRADED" ;;
    *)    exit "$EX_OK" ;;
  esac
}

main "$@"
