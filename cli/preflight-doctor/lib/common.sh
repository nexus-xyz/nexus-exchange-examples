# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# Exit codes, logging, the verdict table, and — the part worth copying — the
# redaction every line of output goes through.

# Exit codes. A doctor's caller is a support script, a CI step or a human
# pasting the output into an issue, and "it failed" is not enough for any of
# them. The distinction that matters is between *cannot reach the venue* and
# *reached it, but something here will bite you later*.
readonly EX_OK=0        # every check passed (warnings allowed)
readonly EX_USAGE=1     # a bad flag, or an environment value that cannot be read
readonly EX_FAIL=2      # at least one check failed: the venue is not reachable as configured
readonly EX_DEGRADED=3  # nothing failed, but at least one warning will bite

# ── redaction ───────────────────────────────────────────────────────────────
#
# This tool exists to be run when something is broken, and its output exists to
# be pasted into a bug report. So the output has to be safe to paste, on every
# path including the failing ones — a doctor that echoes a rejected API secret
# into a terminal has converted a configuration problem into a credential leak,
# and the reader will not notice until it is in someone else's issue tracker.
#
# Two layers, because either one alone has a hole:
#
#   1. Nothing here ever formats a credential into a line. A key is reported as
#      a shape ("set, 20 characters"), never as a value, not even a prefix.
#   2. Every byte of *foreign* text — curl's stderr, the CLI's stderr, anything
#      off the wire — goes through `redact` before it is printed. That is the
#      layer that covers the paths nobody thought about: an error message that
#      quotes the request it just tried to sign, a stack trace, a `--verbose`
#      dump. Layer 1 is the design; layer 2 is what makes it true anyway.
#
# `redact` over-redacts on purpose. It replaces the registered secrets, and then
# any long high-entropy run that looks like a key. That can eat something
# harmless — a request id inside a CLI error message, say — and that is the
# right direction to be wrong in. Where an identifier is genuinely worth having
# in a bug report, this tool extracts it deliberately and prints it itself
# (see `x-request-id` in the report), rather than hoping it survives the filter.

# Values registered here are replaced wherever they appear. Held in an array
# rather than interpolated into one regex: a secret can contain any byte, and
# building a pattern out of it is how a `.` in a key turns into a wildcard.
REDACT_VALUES=()

# redact_register <value...> — never print this string again.
#
# The explicit `if` and the trailing `return 0` are not style. `(( 0 >= 8 ))`
# evaluates to false and therefore *exits 1*, so `(( ... )) && arr+=(x)` as the
# last statement of a loop makes this whole function return 1 — and under
# `set -e` that takes the script down at the call site, before it has printed a
# single line. Registering no secrets is the normal case (a reader running the
# public checks has none), so the bug would fire for exactly the reader least
# equipped to debug it.
redact_register() {
  local value
  for value in "$@"; do
    # Below 8 characters a "secret" is more likely to be a placeholder, and
    # blanket-replacing a short string would corrupt unrelated output.
    if (( ${#value} >= 8 )); then
      REDACT_VALUES+=("$value")
    fi
  done
  return 0
}

# redact <text> — the filter every foreign string passes through.
redact() {
  local text=$1 value
  for value in "${REDACT_VALUES[@]:-}"; do
    [[ -z $value ]] && continue
    text=${text//"$value"/<redacted>}
  done
  # The catch-all: a long hex or base64-ish run is a credential often enough
  # that printing one is not worth the coin flip. `sed` rather than a bash
  # replacement because this needs a character class, and an ERE is the same on
  # GNU and BSD sed where `\+` and friends are not.
  printf '%s' "$text" |
    sed -E \
      -e 's/[0-9a-fA-F]{32,}/<redacted:hex>/g' \
      -e 's/[A-Za-z0-9_-]{40,}/<redacted:token>/g'
}

# url_without_userinfo <url> -- the URL with any `user:pass@` removed.
#
# `redact` cannot cover this. It scrubs values that were REGISTERED plus long
# hex/base64 runs, and a proxy password like `hunter2-proxy-password` is
# neither -- it arrives from `NEXUS_EXCHANGE_API_URL`, which the tool never
# sees as a secret, and it is too short and too punctuated for the catch-all.
# So the only safe move is structural: drop the userinfo entirely rather than
# try to recognise what is in it.
#
# Userinfo is delimited by the LAST `@` before the first `/` of the path, since
# a password may itself contain `@`.
url_without_userinfo() {
  local url=$1 scheme rest
  case $url in
    *://*) scheme=${url%%://*}://; rest=${url#*://} ;;
    *) printf '%s' "$url"; return ;;
  esac
  local authority=${rest%%/*} tail=${rest#"${rest%%/*}"}
  case $authority in
    *@*) authority=${authority##*@} ;;
  esac
  printf '%s%s%s' "$scheme" "$authority" "$tail"
}

# describe_secret <value> — how a credential is allowed to appear in output.
#
# A length and a character class, and nothing else. The temptation is to print
# the first four characters "so you can tell which key it is", and it is worth
# resisting: a key id prefix is enough to identify an account in a support
# channel, and the reader who needs to tell two keys apart can compare lengths.
describe_secret() {
  local value=$1
  if [[ -z $value ]]; then
    printf 'not set'
    return
  fi
  # Most specific first: every hex string also matches the base64url class, so
  # testing them in the other order labels every key "base64url-safe" and the
  # class stops carrying information.
  local class="mixed"
  if [[ $value =~ ^[0-9a-fA-F]+$ ]]; then
    class="hex"
  elif [[ $value =~ ^[A-Za-z0-9_-]+$ ]]; then
    class="base64url-safe"
  fi
  printf 'set (%d characters, %s)' "${#value}" "$class"
}

# ── logging ─────────────────────────────────────────────────────────────────
#
# stderr for everything conversational, so stdout stays a clean report the
# reader can pipe into a file and attach to an issue.

_stamp() { date -u '+%H:%M:%SZ'; }

info()  { printf '%s  %s\n' "$(_stamp)" "$(redact "$*")" >&2; }
warn()  { printf '%s  warning: %s\n' "$(_stamp)" "$(redact "$*")" >&2; }
error() { printf '%s  error: %s\n' "$(_stamp)" "$(redact "$*")" >&2; }

# die <exit-code> <message...>
die() {
  local code=$1; shift
  error "$*"
  exit "$code"
}

# Report a value without vouching for it. Used for anything that came off the
# wire, so a server string cannot impersonate this script's own output.
quoted() { printf "'%s'" "$(redact "$1")"; }

# ── the verdict table ───────────────────────────────────────────────────────
#
# Every check appends exactly one row: a name, a verdict, a one-line finding,
# and the next step. The next step is not optional. A check that can say "this
# is wrong" and cannot say "so do this" is a check that generates support
# tickets rather than closing them.

CHECK_NAMES=()
CHECK_VERDICTS=()
CHECK_FINDINGS=()
CHECK_STEPS=()

# record <name> <ok|warn|fail|skip> <finding> [next-step]
record() {
  CHECK_NAMES+=("$1")
  CHECK_VERDICTS+=("$2")
  CHECK_FINDINGS+=("$(redact "$3")")
  CHECK_STEPS+=("$(redact "${4:-}")")
}

# The worst verdict recorded so far decides the exit code.
worst_verdict() {
  local verdict worst=ok
  for verdict in "${CHECK_VERDICTS[@]:-}"; do
    case $verdict in
      fail) worst=fail ;;
      warn) [[ $worst == ok ]] && worst=warn ;;
    esac
  done
  printf '%s' "$worst"
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 ||
      die "$EX_USAGE" "$cmd is required but not on PATH. See the README's Prerequisites."
  done
}

# A plain integer in an inclusive range, or a refusal naming the variable.
require_int_range() {
  local name=$1 value=$2 low=$3 high=$4
  [[ $value =~ ^[0-9]+$ ]] ||
    die "$EX_USAGE" "$name must be a whole number, got $(quoted "$value")"
  # Length first: a 25-digit "number" would overflow the arithmetic doing the
  # range check itself, so it has to be rejected before the comparison runs.
  (( ${#value} <= 18 )) ||
    die "$EX_USAGE" "$name is absurdly large: $(quoted "$value")"
  (( value >= low && value <= high )) ||
    die "$EX_USAGE" "$name must be between $low and $high, got $value"
}
