#!/usr/bin/env bash
#
# stream-monitor — follow your account's WebSocket channels across
# disconnects, using nothing but the `nexus` CLI, `jq`, and bash.
#
# The model, which is the whole point of the example:
#
#   cursor      — the last sequence this app folded, per channel, on disk
#   attach      — `nexus ws <channel> --since <cursor>`, one process per try
#   ack         — `seq_at_join` tells you where the channel is right now
#   replay      — the venue re-sends cursor+1 .. seq_at_join
#   out_of_sync — the cursor fell out of the replay buffer; refetch over REST
#
# Everything else follows. Kill the socket and it resumes at the sequence it
# left off. Kill the *process* and it resumes at the same sequence, because
# the cursor is a file and not a variable. Ask it to prove that, and it severs
# its own socket mid-stream and checks the sequences on both sides of the
# break for a hole.
#
#   ./run.sh                 follow the account's channels, resuming (default)
#   ./run.sh --prove-resume  sever the socket on purpose and prove the resume
#                            lost nothing
#   ./run.sh --status        print the cursor store and exit
#   ./run.sh --reset         forget every cursor
#   ./run.sh --unlock        clear a lock a crashed run left behind
#
# Read-only. It places nothing, cancels nothing, and moves nothing. Testnet,
# play funds. See README.md.

set -uo pipefail

# ── bash version ────────────────────────────────────────────────────────────
# bash 3.2 is enough, on purpose, and that is a difference from `quote-ladder`
# next door — which needs 4.4 for associative arrays. A monitor is the thing
# you leave running on whatever box you have, including a stock macOS that has
# shipped bash 3.2 since 2007, so the state that would have lived in an
# associative array lives in the cursor directory instead. It had to be on
# disk anyway: that is what makes it survive a restart.
if (( BASH_VERSINFO[0] < 3 || (BASH_VERSINFO[0] == 3 && BASH_VERSINFO[1] < 2) )); then
  printf 'error: bash 3.2 or newer is required (this is %s).\n' "${BASH_VERSION:-unknown}" >&2
  exit 1
fi

# Resolve the example's own directory, so the app can be run from anywhere —
# including out of a unit file, where the working directory is not what you
# think.
SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/cursor.sh
. "$SCRIPT_DIR/lib/cursor.sh"
# shellcheck source=lib/preflight.sh
. "$SCRIPT_DIR/lib/preflight.sh"
# shellcheck source=lib/nexus.sh
. "$SCRIPT_DIR/lib/nexus.sh"
# shellcheck source=lib/lock.sh
. "$SCRIPT_DIR/lib/lock.sh"
# shellcheck source=lib/stream.sh
. "$SCRIPT_DIR/lib/stream.sh"

MODE=follow
PROVE_RESUME=0
RUN_DIR=""
RUN_DEADLINE=0
EXIT_CODE=$EX_OK

usage() {
  cat <<'USAGE'
stream-monitor — a resumable account monitor over the nexus CLI's WebSocket.

usage: ./run.sh [--follow | --prove-resume | --status | --reset | --unlock] [--help]

  --follow        follow the account channels, resuming each one from its
                  stored cursor. Reconnects for as long as you leave it
                  running. The default.
  --prove-resume  the demonstration: connect, take a few events, sever the
                  socket on purpose, resume from the cursor, and report
                  whether the sequences on both sides of the break have a
                  hole in them.
  --status        print the cursor store and exit. Touches no network.
  --reset         forget every stored cursor. The next run starts from the
                  live edge. Takes the lock first — a reset under a running
                  monitor would send its next reattach to the live edge.
  --unlock        remove a lock left behind by a crashed run, after checking
                  that its recorded pid is not alive. The escape hatch for an
                  EX_BUSY that will not clear on its own.
  --help          this text.

Configuration is environment-only; see .env.example and README.md.
USAGE
}

parse_args() {
  while (( $# )); do
    case $1 in
      --follow) MODE=follow ;;
      --prove-resume) MODE=prove; PROVE_RESUME=1 ;;
      --status) MODE=status ;;
      --reset) MODE=reset ;;
      --unlock) MODE=unlock ;;
      -h|--help) usage; exit "$EX_OK" ;;
      *) usage >&2; die "$EX_USAGE" "unknown argument $(quoted "$1")" ;;
    esac
    shift
  done
}

# One trap, every exit path: a clean finish, a `die`, Ctrl-C, or a SIGTERM
# from whatever supervisor is running this. Two things must not survive the
# process — the lock, and the `nexus ws` children — so neither is left to the
# happy path.
# shellcheck disable=SC2317,SC2329  # reached via `trap`, which shellcheck does not follow
cleanup() {
  local code=$? pid
  trap - EXIT INT TERM
  # The stop file first: a supervisor that is mid-`sleep` in its backoff will
  # see it and exit on its own, which is tidier than killing it out of a
  # sleep and leaving its child orphaned.
  stream_request_stop
  for pid in ${STREAM_PIDS:-}; do
    kill "$pid" 2>/dev/null || true
  done
  # Then the CLI grandchildren. Killing a supervisor does not kill the `nexus
  # ws` it forked, and one left running would hold a socket and a subscription
  # slot against ceilings that are per *account*, not per process.
  #
  # By process group, but only when this process actually leads one — which it
  # does when run from an interactive shell, and does not when run from
  # another script. `kill -- -$$` against a pgid we do not lead would be
  # aiming at somebody else's processes, so the id is checked rather than
  # assumed, and the fallback is to let the supervisors' own traps do it.
  local pgid
  pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  if [[ $pgid == "$$" ]]; then
    # IGNORE THE SIGNAL WE ARE ABOUT TO SEND OURSELVES. `kill -- -$$` targets
    # the whole group, and this shell is in it. `trap - EXIT INT TERM` above
    # restored TERM to its DEFAULT disposition, so the shell died right here:
    # `lock_release`, the `RUN_DIR` removal and `exit "$code"` below were never
    # reached. Every interactive run exited 143 and leaked the lock directory
    # and the run dir, which in turn made `lock_acquire`'s liveness check face
    # a stale pid on the next run.
    #
    # It never showed up in the suite because `run_app` invokes the script
    # WITHOUT job control, so the shell is not a process-group leader and this
    # branch is skipped -- while `./run.sh` from a terminal IS one, so the
    # branch is taken in exactly the mode the README documents. The practical
    # consequence was that `EX_OK=0` and `EX_LOSSY=4` were unobservable from a
    # terminal: the exit-code table was unreachable in the mode readers use.
    trap '' TERM
    kill -- "-$$" 2>/dev/null || true
    trap - TERM
  fi
  lock_release
  [[ -n $RUN_DIR && -d $RUN_DIR ]] && rm -rf -- "$RUN_DIR"
  exit "$code"
}

# ── report ──────────────────────────────────────────────────────────────────

hr() { printf -- '─%.0s' {1..78}; printf '\n'; }

report_header() {
  printf 'stream-monitor  %s  (%s)\n' "$MONITOR_HOST" "$MONITOR_NETWORK_LABEL"
  hr
  printf '%-12s%s\n' "cli" "$CLI_VERSION_LINE"
  printf '%-12s%s\n' "rest" "$MONITOR_BASE_URL"
  printf '%-12s%s\n' "socket" "$MONITOR_WS_URL"
  printf '%-12s%s\n' "channels" "${CHANNELS[*]}"
  printf '%-12s%s\n' "cursors" "$MONITOR_STATE_DIR/cursor/"
  if (( PROVE_RESUME )); then
    printf '%-12ssever each channel after %s event(s), then resume from the cursor\n' \
      "mode" "$MONITOR_PROVE_AFTER"
  else
    printf '%-12sfollow and resume; Ctrl-C to stop\n' "mode"
  fi
  hr
}

report_cursors() {
  local channel cursor
  printf '%-14s%-14s%s\n' "CHANNEL" "CURSOR" "SOURCE"
  for channel in "${CHANNELS[@]}"; do
    cursor=$(cursor_read "$channel")
    if [[ -n $cursor ]]; then
      printf '%-14s%-14s%s\n' "$channel" "$cursor" "$(cursor_path "$channel")"
    else
      printf '%-14s%-14s%s\n' "$channel" "—" "no cursor stored; would attach at the live edge"
    fi
  done
}

# The verdict. This is what the example is for.
#
# Three outcomes per channel, and the distinction between the last two is the
# one worth reading carefully:
#
#   contiguous  every sequence between the first and last delivered arrived.
#               Nothing was missed.
#   recovered   there is a hole, and the venue told us why — `out_of_sync`
#               (our cursor aged out of the replay buffer) or a sequence that
#               went backwards (an engine epoch bump). Both are gaps the
#               replay cannot bridge by design, and both were answered with a
#               REST refetch of the state. The individual events are gone; the
#               state is not.
#   LOSSY       there is a hole and nothing explains it. The venue accepted a
#               resume and then did not deliver everything it implied it
#               would. This is the failure the whole app exists to detect, and
#               it is the only one that changes the exit status.
#
# An idle channel is neither: it demonstrates a reconnect and nothing about
# losslessness, and reporting that as a pass is exactly how an example comes
# to certify a property it never tested.
report_verdict() {
  local channel verdict status detail severed gap events cursor overall=0 conclusive=0

  printf '\n'
  hr
  printf '%-14s%-9s%-10s%-13s%s\n' "CHANNEL" "EVENTS" "CURSOR" "RESULT" "DETAIL"
  for channel in "${CHANNELS[@]}"; do
    events=$(count_read "$channel")
    cursor=$(cursor_read "$channel")
    verdict=$(seen_verdict "$channel")
    status=${verdict%% *}
    detail=${verdict#* }
    severed=no
    [[ -e "$(sever_marker_path "$channel")" ]] && severed=yes
    gap=""
    [[ -s "$(gap_marker_path "$channel")" ]] && gap=$(tr '\n' ' ' <"$(gap_marker_path "$channel")")

    case $status in
      contiguous)
        conclusive=1
        if (( PROVE_RESUME )) && [[ $severed == no ]]; then
          printf '%-14s%-9s%-10s%-13s%s\n' "$channel" "$events" "${cursor:-—}" "inconclusive" \
            "$detail, but the socket was never severed — nothing was proven"
        else
          printf '%-14s%-9s%-10s%-13s%s\n' "$channel" "$events" "${cursor:-—}" "contiguous" "$detail"
        fi
        ;;
      gap)
        conclusive=1
        if [[ -n $gap ]]; then
          printf '%-14s%-9s%-10s%-13s%s\n' "$channel" "$events" "${cursor:-—}" "recovered" \
            "$detail — explained: $gap"
        else
          printf '%-14s%-9s%-10s%-13s%s\n' "$channel" "$events" "${cursor:-—}" "LOSSY" \
            "$detail — nothing explains this hole"
          overall=1
        fi
        ;;
      idle)
        printf '%-14s%-9s%-10s%-13s%s\n' "$channel" "$events" "${cursor:-—}" "idle" "$detail"
        ;;
    esac
  done
  hr

  if (( overall )); then
    printf '\nA sequence hole was delivered that no out_of_sync frame and no epoch\n'
    printf 'reset accounts for. The resume was NOT lossless. Exiting %d.\n' "$EX_LOSSY"
    EXIT_CODE=$EX_LOSSY
    return 0
  fi

  if (( PROVE_RESUME )); then
    if (( conclusive )); then
      printf '\nEvery severed channel resumed with no unexplained hole in its sequences.\n'
    else
      printf '\nNo channel delivered an event, so the socket was never severed and\n'
      printf 'nothing was proven. This account was quiet for the whole run — try a\n'
      printf 'longer MONITOR_RUN_SECONDS, or place and cancel an order in another\n'
      printf 'terminal to give the orders channel something to say.\n'
    fi
  fi
}

# ── main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  load_dotenv "$SCRIPT_DIR/.env"
  resolve_config
  cursor_init

  if [[ $MODE == status ]]; then
    report_cursors
    exit "$EX_OK"
  fi
  if [[ $MODE == unlock ]]; then
    lock_break "$MONITOR_STATE_DIR/lock"
    exit "$EX_OK"
  fi
  if [[ $MODE == reset ]]; then
    # Under the lock, and this is not bookkeeping. `cursor_forget` is `rm -rf`
    # on the cursor store; a monitor running in another terminal is unaffected
    # in memory but its next reattach finds no cursor and attaches at the LIVE
    # EDGE — a silent gap mid-run, in the one tool whose entire claim is that
    # it does not have those. The comment further down used to say "every mode
    # here that opens a socket also advances the cursor store — so there is no
    # read-only path to leave unlocked", which reasoned about sockets when the
    # question is writes, and `--reset` is the most destructive write there is
    # while opening no socket at all (@nvizble, #23).
    lock_acquire "$MONITOR_STATE_DIR/lock"
    cursor_forget
    info "every cursor forgotten; the next run attaches at the live edge"
    exit "$EX_OK"
  fi

  require_cmd jq nexus mkfifo

  # The demonstration has to end by itself, so it gets bounds unless the
  # reader set their own. `--follow` has none: it is meant to be left running.
  if (( PROVE_RESUME )); then
    (( MONITOR_RUN_SECONDS > 0 )) || MONITOR_RUN_SECONDS=120
    (( MONITOR_MAX_EVENTS > 0 )) || MONITOR_MAX_EVENTS=$(( MONITOR_PROVE_AFTER * 3 ))
  fi

  RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/stream-monitor.XXXXXX")
  trap cleanup EXIT INT TERM

  build_cli_config
  nx_init "$RUN_DIR/stderr"
  check_cli_version
  check_auth

  # Taken before the first attach and held for the whole run. Unlike
  # `quote-ladder`, where reads are lock-free and only writes contend, every
  # mode here that WRITES the cursor store contends — which is the test, not
  # whether a socket is opened. `--reset` opens none and writes the most, so it
  # takes the lock above; `--status` opens none and writes nothing, so it does
  # not (@nvizble, #23).
  lock_acquire "$MONITOR_STATE_DIR/lock"
  markers_init

  (( MONITOR_RUN_SECONDS > 0 )) && RUN_DEADLINE=$(( $(date -u +%s) + MONITOR_RUN_SECONDS ))

  report_header
  report_cursors
  printf '\n'

  stream_run

  # Did anything attach at all? The evidence is the per-run `attached/` marker,
  # written on every subscribe ack before the cursor is even consulted.
  #
  # It used to be the cursor, on the reasoning that a cursor "is written on the
  # first ack, before any event, so a channel with no cursor never got one".
  # True of the write, false of the read: `out_of_sync` DELETES the cursor
  # deliberately, so a run ending between that and the next ack saw no cursor,
  # reported "no channel ever acknowledged a subscription", and exited
  # EX_STREAM — discarding `report_verdict` and any LOSSY finding in it
  # (@nvizble, #23). The marker is only ever created, so it cannot be erased by
  # the recovery path it is meant to survive.
  local channel attached=0
  for channel in "${CHANNELS[@]}"; do
    [[ -e $(attached_marker_path "$channel") ]] && attached=1
  done
  if (( ! attached )); then
    error "no channel ever acknowledged a subscription"
    EXIT_CODE=$EX_STREAM
  else
    report_verdict
  fi

  exit "$EXIT_CODE"
}

main "$@"
