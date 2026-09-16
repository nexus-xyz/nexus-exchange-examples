# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# Logging, exit codes, and the small guards every other file leans on.

# Exit codes, because the intended reader of this script is `cron`, a CI step or
# a systemd unit, and "it failed" is not enough for any of them to decide what to
# do next. 75 is sysexits' EX_TEMPFAIL — the conventional "nothing is wrong, come
# back later", which is exactly what a held lock means.
readonly EX_OK=0
readonly EX_USAGE=1     # a bad flag, or an environment value that cannot be read
readonly EX_CONFIG=2    # a preflight refusal: wrong network, missing tool, no auth
readonly EX_MARKET=3    # the market cannot be quoted right now (halted, no price)
readonly EX_PARTIAL=4   # a write was attempted and did not fully land
readonly EX_BUSY=75     # another run holds the lock

# stderr for everything conversational, so stdout stays a clean report a caller
# can pipe. Timestamps because the whole point of this tool is to be run
# unattended and read afterwards, out of a log.
_stamp() { date -u '+%H:%M:%SZ'; }

info()  { printf '%s  %s\n' "$(_stamp)" "$*" >&2; }
warn()  { printf '%s  warning: %s\n' "$(_stamp)" "$*" >&2; }
error() { printf '%s  error: %s\n' "$(_stamp)" "$*" >&2; }

# die <exit-code> <message...>
die() {
  local code=$1; shift
  error "$*"
  exit "$code"
}

# Report a value without vouching for it. Used for anything that came off the
# wire, so a server string cannot impersonate this script's own output.
quoted() { printf "'%s'" "$1"; }

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 ||
      die "$EX_CONFIG" "$cmd is required but not on PATH. See the README's Prerequisites."
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
