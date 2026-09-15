#!/usr/bin/env bash
# shellcheck shell=bash
#
# A stand-in for the `nexus` binary, so the resume path can be tested without
# an account, without a socket, and without waiting for a venue to happen to
# publish something.
#
# It is symlinked into a temp directory as `nexus`, that directory goes on
# PATH, and it answers from files the test wrote first. Every invocation is
# appended to `$STUB_DIR/calls.log`, which is how the suite asserts on the
# `--since` value each *attempt* carried — the single most important
# assertion here, and one that cannot be made from stdout.
#
# ── The `ws` stub ───────────────────────────────────────────────────────────
#
# Each attach reads a scripted frame list:
#
#   $STUB_DIR/ws-<channel>-<attempt>            frames for the Nth attach
#   $STUB_DIR/ws-<channel>-default              used when there is no Nth file
#
# A line in one of those files is either a literal JSON frame, or one of two
# directives:
#
#   @replay-from  emit an `event` for every sequence strictly greater than the
#                 `--since` this attempt was given, up to `@ceiling`. This is
#                 what makes the stub a *replay buffer* rather than a script:
#                 what it sends depends on what the app asked for, so an app
#                 that asks for the wrong thing gets the wrong answer and the
#                 test catches it.
#   @hang         stop emitting and sleep, so the app has to sever the socket
#                 itself rather than seeing the process exit.
#
# The attempt counter is per channel and lives in `$STUB_DIR/ws-attempt-<channel>`.

set -uo pipefail
: "${STUB_DIR:?fake-nexus needs STUB_DIR}"

printf '%s\n' "$*" >>"$STUB_DIR/calls.log"

channel=""
since=""
command_path=""
args=()

while (( $# )); do
  case $1 in
    --version)
      cat "$STUB_DIR/version" 2>/dev/null ||
        printf 'nexus 0.4.0 (spec v0.8.1, nexus-exchange 0.9.1)\n'
      exit 0
      ;;
    --since)
      since=${2:-}
      shift 2
      ;;
    --network|--output|--market|--limit|--api-key|--api-secret|--base-url)
      shift 2
      ;;
    --yes|--all)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      args[${#args[@]}]=$1
      shift
      ;;
  esac
done

command_path="${args[0]:-}"
case $command_path in
  order|account|market)
    command_path="$command_path ${args[1]:-}"
    ;;
esac

# A canned failure for any command, so the tests can exercise the error paths:
# `touch $STUB_DIR/fail-<command with spaces replaced by ->`.
fail_marker="$STUB_DIR/fail-${command_path// /-}"
if [[ -e $fail_marker ]]; then
  cat "$fail_marker" >&2
  [[ -s $fail_marker ]] || printf 'Error: %s failed (stubbed)\n' "$command_path" >&2
  exit 1
fi

emit_file() {
  local file="$STUB_DIR/$1" fallback=${2:-}
  if [[ -f $file ]]; then
    cat "$file"
  elif [[ -n $fallback ]]; then
    printf '%s\n' "$fallback"
  else
    printf 'Error: fake-nexus has no canned response for %s\n' "$command_path" >&2
    exit 1
  fi
}

case $command_path in
  orders)    emit_file orders.json '[]'; exit 0 ;;
  fills)     emit_file fills.json '[]'; exit 0 ;;
  positions) emit_file positions.json '[]'; exit 0 ;;
  balance)   emit_file balance.json '{}'; exit 0 ;;
  ws)        ;;  # below
  *)
    printf 'Error: fake-nexus does not implement %s\n' "$command_path" >&2
    exit 1
    ;;
esac

# ── ws ──────────────────────────────────────────────────────────────────────

channel=${args[1]:-}
[[ -n $channel ]] || { printf 'Error: ws needs a channel\n' >&2; exit 1; }

# The reconnect assertion lives here: one line per attach, recording the
# `--since` this attempt was launched with. A monitor that reconnected without
# re-reading its cursor writes the same value twice, and the test that reads
# this file is what notices.
printf '%s\n' "${since:-<none>}" >>"$STUB_DIR/since-$channel.log"

attempt_file="$STUB_DIR/ws-attempt-$channel"
attempt=0
[[ -r $attempt_file ]] && read -r attempt <"$attempt_file" 2>/dev/null
[[ $attempt =~ ^[0-9]+$ ]] || attempt=0
attempt=$(( attempt + 1 ))
printf '%s\n' "$attempt" >"$attempt_file"

script="$STUB_DIR/ws-$channel-$attempt"
[[ -f $script ]] || script="$STUB_DIR/ws-$channel-default"
[[ -f $script ]] || { printf 'Error: no ws script for %s attempt %s\n' "$channel" "$attempt" >&2; exit 1; }

ceiling=0
while IFS= read -r line || [[ -n $line ]]; do
  case $line in
    ''|'#'*) continue ;;
    '@ceiling '*)
      ceiling=${line#@ceiling }
      ;;
    '@replay-from')
      # Everything strictly after the requested cursor, up to the ceiling. An
      # empty `--since` means "from the live edge": nothing is replayed.
      start=${since:-$ceiling}
      seq=$(( start + 1 ))
      while (( seq <= ceiling )); do
        printf '{"op":"event","channel":"%s","market":null,"seq":%d,"payload":{"stub":true}}\n' \
          "$channel" "$seq"
        seq=$(( seq + 1 ))
      done
      ;;
    '@hang')
      # Emit nothing further and keep the socket "open". The app is expected
      # to sever it, or to time out on its own idle budget.
      sleep 30
      ;;
    *)
      printf '%s\n' "$line"
      ;;
  esac
done <"$script"
