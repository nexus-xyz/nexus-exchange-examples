# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# The one place this app invokes the `nexus` CLI.
#
# Everything goes through `nx`, for three reasons that are each a bug if you skip
# them:
#
# 1. **The network is named on every single call.** `--network` beats
#    `NEXUS_NETWORK`, so a stale value in the reader's shell cannot silently
#    redirect one command in the middle of a run. (What it cannot beat is
#    `NEXUS_BASE_URL`, which outranks both — see `preflight.sh`, which refuses to
#    start when one is set.)
#
# 2. **`--output json` is passed as a flag, not left to `NEXUS_OUTPUT`.** Same
#    reasoning: this script parses stdout, so the format is not the environment's
#    decision to make.
#
# 3. **Credentials are never arguments.** The CLI accepts `--api-key` and
#    `--api-secret`, and its own help says not to use them: arguments are visible
#    in the process list and in shell history. They stay in the environment,
#    which is also why nothing in this app ever reads, prints, or logs the secret
#    — the only code that touches it is the CLI itself.

# Populated by `nx` on every call.
NX_OUT=""
NX_ERR=""
NX_STATUS=0

# Set once, in run.sh, so a run's stderr capture cannot collide with a parallel
# run's.
NX_STDERR_FILE=""

# A per-call wall-clock ceiling, so a hung request cannot wedge a cron job
# forever. `timeout` is GNU coreutils and is not on a stock macOS, so it is used
# when present and simply skipped when not — a missing timeout is a worse run,
# not a broken one.
_nx_timeout=()

nx_init() {
  NX_STDERR_FILE=$1
  if command -v timeout >/dev/null 2>&1; then
    _nx_timeout=(timeout --signal=INT "${LADDER_TIMEOUT_SECONDS}s")
  else
    warn "coreutils \`timeout\` not found; CLI calls will run without a time limit"
  fi
}

# nx <cli args...> — run the CLI, capture both streams, return its status.
#
# Callers must handle the status: either `if nx ...; then`, or `nx ... || ...`, or
# via `nx_read` below. Under `set -e` a bare failing call would take the whole
# script down, which is right for a read this app cannot continue without and
# wrong for a probe.
nx() {
  local status=0
  # `|| status=$?` is what keeps errexit from firing on the assignment, so the
  # caller gets to decide what a non-zero status means.
  NX_OUT=$("${_nx_timeout[@]}" nexus \
    --network "$LADDER_NETWORK" \
    --output json \
    "$@" 2>"$NX_STDERR_FILE") || status=$?
  NX_ERR=$(<"$NX_STDERR_FILE")
  NX_STATUS=$status
  return "$status"
}

# nx_read <what> <cli args...> — a read this app cannot continue without.
#
# Retried, because a read is idempotent: asking twice cannot change anything at
# the venue. Nothing that *writes* goes through here, and that asymmetry is the
# point — see the comment on `nx_write_once`.
nx_read() {
  local what=$1; shift
  local attempt=1
  while :; do
    if nx "$@"; then
      return 0
    fi
    if (( attempt >= LADDER_READ_ATTEMPTS )); then
      error "$what failed after $attempt attempt(s):"
      printf '%s\n' "$NX_ERR" >&2
      exit "$EX_MARKET"
    fi
    warn "$what failed (attempt $attempt), retrying in ${attempt}s"
    sleep "$attempt"
    attempt=$(( attempt + 1 ))
  done
}

# nx_write_once <what> <cli args...> — a write, attempted exactly once.
#
# Never retried, ever. The Exchange has no client-supplied idempotency key on the
# request itself, so a retry after a timeout is how one intended order becomes
# two real ones: the first attempt may well have been accepted and only the
# *reply* lost. A caller that gets a non-zero status here does not know whether
# the write landed, and must go and read the actual state back rather than
# assume — which is exactly what run.sh does, and why the whole design is a
# reconciler instead of a sequence of steps.
#
# Returns the CLI's status; `NX_OUT` and `NX_ERR` hold both streams.
nx_write_once() {
  local what=$1; shift
  if nx "$@"; then
    return 0
  fi
  warn "$what did not complete cleanly (exit $NX_STATUS); the state will be read back rather than assumed"
  return "$NX_STATUS"
}

# jq, with the two flags that turn a silent wrong answer into an error: `-e` so
# a null or missing field is a non-zero exit rather than the string "null", and
# `-r` so a decimal string arrives without its quotes.
nx_jq() { jq -er "$@"; }
