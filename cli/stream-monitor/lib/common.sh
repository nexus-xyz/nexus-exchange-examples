# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# Logging, exit codes, and the small guards every other file leans on.
#
# Copied from `cli/quote-ladder`, not imported, per CONTRIBUTING § 1: a reader
# should be able to download this one directory and have it work. The exit-code
# table is this app's own — the two tools fail for different reasons.

# Exit codes, because the intended caller is a supervisor — systemd, a container
# restart policy, a terminal you left open — and "it failed" is not enough for
# any of them to decide whether restarting will help.
readonly EX_OK=0
readonly EX_USAGE=1     # a bad flag, or an environment value that cannot be read
readonly EX_CONFIG=2    # a preflight refusal: wrong network, missing tool, unpinned CLI
readonly EX_STREAM=3    # no channel ever attached; there is nothing to monitor
readonly EX_LOSSY=4     # a gap the replay did not cover — the failure this app exists to find
readonly EX_BUSY=75     # another run holds the cursor store

# stderr for everything conversational, so stdout stays a clean event journal a
# caller can pipe into `jq`. Timestamps because the whole point of this tool is
# to run unattended for hours and be read afterwards, out of a log.
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

# Lowercase, without bash 4's `${var,,}`.
#
# This app runs on bash 3.2 on purpose (see run.sh), so every 4.x convenience
# has a replacement here rather than a version check at the top.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# A sequence number as the venue reports it: a non-negative integer, narrow
# enough that bash arithmetic on it cannot wrap.
#
# Sequences are compared with `((` … `))` all over this app, and bash integer
# overflow is silent — there is no error to catch — so a value wide enough to
# wrap is rejected at the boundary instead, where it is still a string.
is_sequence() {
  [[ $1 =~ ^[0-9]+$ ]] && (( ${#1} <= 18 ))
}
