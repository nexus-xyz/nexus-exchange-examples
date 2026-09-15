#!/usr/bin/env bash
#
# Tests for stream-monitor, with the `nexus` binary stubbed out.
#
# What this is for: the claim this example makes is "the resume loses
# nothing", and that claim is not testable against a live venue by a reader
# without an account — nor, with an account, on demand, because it needs the
# socket to break at a moment when events are in flight. Waiting for a real
# disconnect is not a test.
#
# So the venue is replaced by `fake-nexus.sh`, whose `ws` stub is a *replay
# buffer* and not a script: `@replay-from` sends everything strictly after the
# `--since` it was handed. An app that resumes from the wrong sequence
# therefore gets the wrong events and the assertions catch it, which is the
# only way a stub can test a resume rather than test itself.
#
#   ./test/run-tests.sh          # needs bash 3.2+, jq and mkfifo; no network
#
# It takes about a minute: the supervisor polls on a one-second tick, and
# several of these tests are about what happens when nothing arrives.

set -uo pipefail

HERE=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(dirname -- "$HERE")

PASSED=0
FAILED=0
CURRENT=""
STUB_DIR=""
OUT=""
ERR=""
STATUS=0

# ── harness ─────────────────────────────────────────────────────────────────

start() {
  CURRENT=$1
  STUB_DIR=$(mktemp -d "${TMPDIR:-/tmp}/stream-monitor-test.XXXXXX")
  mkdir -p "$STUB_DIR/bin"
  ln -s "$HERE/fake-nexus.sh" "$STUB_DIR/bin/nexus"
  : >"$STUB_DIR/calls.log"
  printf '[]\n' >"$STUB_DIR/orders.json"
  printf '[]\n' >"$STUB_DIR/fills.json"

  export STUB_DIR
  export PATH="$STUB_DIR/bin:$PATH"
  export MONITOR_STATE_DIR="$STUB_DIR/state"
  export MONITOR_CHANNELS=fills
  export MONITOR_BACKOFF_SECONDS=0
  export MONITOR_BACKOFF_MAX_SECONDS=1
  export MONITOR_HANDSHAKE_SECONDS=3
  export MONITOR_IDLE_SECONDS=2
  export MONITOR_RUN_SECONDS=60
  export MONITOR_MAX_ATTEMPTS=2
  export MONITOR_MAX_EVENTS=0
  export MONITOR_PROVE_AFTER=2
  export MONITOR_ALLOW_CLI_VERSION=0
  unset MONITOR_BASE_URL MONITOR_WS_URL NEXUS_BASE_URL NEXUS_EXCHANGE_API_URL 2>/dev/null || true
}

finish() {
  [[ -n $STUB_DIR && -d $STUB_DIR ]] && rm -rf -- "$STUB_DIR"
  PATH=${PATH#"$STUB_DIR/bin:"}
}

# stdout and stderr captured apart, because this app puts a machine-readable
# event journal on one and everything conversational on the other — and a
# test that merged them could not tell a delivered event from a log line
# about one.
run_app() {
  local out err
  out=$(mktemp "${TMPDIR:-/tmp}/sm-out.XXXXXX")
  err=$(mktemp "${TMPDIR:-/tmp}/sm-err.XXXXXX")
  "$APP_DIR/run.sh" "$@" >"$out" 2>"$err"
  STATUS=$?
  OUT=$(cat "$out")
  ERR=$(cat "$err")
  rm -f -- "$out" "$err"
  return 0
}

# WITH JOB CONTROL, which is how a reader runs it and how `run_app` does not.
# `set -m` makes the script a process-group leader, which is the condition
# `cleanup`'s `kill -- -$$` branch tests for. Every bug in that branch is
# invisible to `run_app`; this is the only way to reach it from the suite.
run_app_interactive() {
  local out err
  out=$(mktemp "${TMPDIR:-/tmp}/sm-out.XXXXXX")
  err=$(mktemp "${TMPDIR:-/tmp}/sm-err.XXXXXX")
  set -m
  "$APP_DIR/run.sh" "$@" >"$out" 2>"$err"
  STATUS=$?
  set +m
  OUT=$(cat "$out")
  ERR=$(cat "$err")
  rm -f -- "$out" "$err"
  return 0
}

expect_no_lock() {
  if [[ -e "$MONITOR_STATE_DIR/lock" ]]; then
    fail "$CURRENT: the lock was released" "$MONITOR_STATE_DIR/lock still exists"
  else
    pass "$CURRENT: the lock was released"
  fi
}

pass() { PASSED=$(( PASSED + 1 )); printf '  ok    %s\n' "$1"; }
fail() {
  FAILED=$(( FAILED + 1 ))
  printf '  FAIL  %s\n' "$1"
  printf '        %s\n' "$2"
  printf '        ---- stdout ----\n'
  printf '        %s\n' "${OUT//$'\n'/$'\n'        }"
  printf '        ---- stderr ----\n'
  printf '        %s\n' "${ERR//$'\n'/$'\n'        }"
}

expect_status() {
  local want=$1
  if [[ $STATUS == "$want" ]]; then pass "$CURRENT: exit $want"
  else fail "$CURRENT: exit $want" "got exit $STATUS"; fi
}

expect_says() {
  local needle=$1
  if [[ $OUT == *"$needle"* || $ERR == *"$needle"* ]]; then
    pass "$CURRENT: says $(printf '%q' "$needle")"
  else
    fail "$CURRENT: says $(printf '%q' "$needle")" "not found"
  fi
}

expect_silent_about() {
  local needle=$1
  if [[ $OUT != *"$needle"* && $ERR != *"$needle"* ]]; then
    pass "$CURRENT: does not say $(printf '%q' "$needle")"
  else
    fail "$CURRENT: does not say $(printf '%q' "$needle")" "but it did"
  fi
}

# The delivered event journal is stdout, one JSON frame per line.
expect_events() {
  local want=$1 got
  got=$(printf '%s' "$OUT" | grep -c '"op":"event"' || true)
  if [[ $got == "$want" ]]; then pass "$CURRENT: delivered $want event(s)"
  else fail "$CURRENT: delivered $want event(s)" "delivered $got"; fi
}

expect_seq_delivered() {
  local seq=$1
  if printf '%s' "$OUT" | grep -q "\"seq\":$seq,"; then
    pass "$CURRENT: delivered seq $seq"
  else
    fail "$CURRENT: delivered seq $seq" "not on stdout"
  fi
}

expect_cursor() {
  local channel=$1 want=$2 file got
  file="$MONITOR_STATE_DIR/cursor/$channel"
  got=$(cat "$file" 2>/dev/null || printf '<missing>')
  if [[ $got == "$want" ]]; then pass "$CURRENT: $channel cursor is $want"
  else fail "$CURRENT: $channel cursor is $want" "cursor file holds $(printf '%q' "$got")"; fi
}

# The reconnect assertion: what `--since` did each successive attach carry?
expect_since_log() {
  local channel=$1 want=$2 got
  got=$(tr '\n' ' ' <"$STUB_DIR/since-$channel.log" 2>/dev/null | sed 's/ *$//')
  if [[ $got == "$want" ]]; then pass "$CURRENT: attaches used --since [$want]"
  else fail "$CURRENT: attaches used --since [$want]" "got [$got]"; fi
}

# The resync reads the REST endpoint that mirrors the channel, so `fills`
# resyncs over `nexus fills` and not over `nexus orders`. The auth probe at
# startup is always `orders --limit 1`, and is counted separately.
expect_rest_resyncs() {
  local channel=$1 want=$2 pattern got
  case $channel in
    orders)    pattern='json orders$' ;;
    fills)     pattern='json fills --limit 50$' ;;
    positions) pattern='json positions$' ;;
    balances)  pattern='json balance$' ;;
  esac
  got=$(grep -cE "$pattern" "$STUB_DIR/calls.log" || true)
  if [[ $got == "$want" ]]; then pass "$CURRENT: $want REST resync(s) for $channel"
  else fail "$CURRENT: $want REST resync(s) for $channel" "counted $got in the call log:
$(cat "$STUB_DIR/calls.log")"; fi
}

ws() { printf '%s\n' "$@" >"$STUB_DIR/ws-$WS_CHANNEL-$WS_ATTEMPT"; }
script_for() { WS_CHANNEL=$1; WS_ATTEMPT=$2; }

ack()   { printf '{"op":"subscribed","channel":"%s","market":null,"seq_at_join":%s}\n' "$1" "$2"; }
event() { printf '{"op":"event","channel":"%s","market":null,"seq":%s,"payload":{"stub":true}}\n' "$1" "$2"; }
oos()   { printf '{"op":"out_of_sync","channel":"%s","market":null,"oldest_seq":%s}\n' "$1" "$2"; }

# ── the tests ───────────────────────────────────────────────────────────────

# The headline claim. Attach, take three events, lose the socket, reattach
# from the cursor, and receive exactly the events that happened in between.
test_resume_is_lossless() {
  start "lossless resume"
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)" "$(event fills 102)" "$(event fills 103)"
  script_for fills 2
  ws "@ceiling 106" "$(ack fills 106)" "@replay-from"

  run_app --follow
  expect_status 0
  # `<none>` on the first attach — there is no cursor yet — then the sequence
  # the first attach ended on. Not 100, which was the ack, and not 106, which
  # is what the second ack said.
  expect_since_log fills "<none> 103"
  expect_events 6
  expect_seq_delivered 104
  expect_seq_delivered 106
  expect_cursor fills 106
  expect_says "101..106, 6 event(s), no gap"
  finish
}

# The trap. The second ack says the channel is at 110; the replay that would
# carry 102..110 never arrives because the socket dies first. The cursor must
# still be 101 — storing the ack would have skipped nine events and left no
# trace that it had.
test_ack_does_not_outrun_the_replay() {
  start "the ack does not advance the cursor"
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)"
  script_for fills 2
  ws "$(ack fills 110)" "@hang"

  run_app --follow
  expect_cursor fills 101
  expect_says "expecting a replay of 102..110"
  finish
}

# The other half of "durable": a cursor that survives the process, not just
# the socket. Two separate invocations, one stub, and the second one has to
# pick up where the first left off.
test_cursor_survives_the_process() {
  start "cursor survives a restart"
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 200)" "$(event fills 201)" "$(event fills 202)"
  script_for fills 2
  ws "@ceiling 204" "$(ack fills 204)" "@replay-from"

  run_app --follow
  expect_cursor fills 202
  # A second, entirely separate process.
  run_app --follow
  expect_since_log fills "<none> 202"
  expect_cursor fills 204
  expect_seq_delivered 203
  finish
}

# `out_of_sync` is the failure mode the example exists for: a monitor that
# resubscribes at the same `--since` is told the same thing again, forever,
# while reporting itself healthy. The cursor must be *cleared*, not retried.
test_out_of_sync_does_not_spin() {
  start "out_of_sync clears the cursor"
  export MONITOR_MAX_ATTEMPTS=3
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)"
  script_for fills 2
  ws "$(oos fills 500)"
  script_for fills 3
  ws "$(ack fills 500)" "$(event fills 501)"

  run_app --follow
  # The third attach carries no cursor at all — that is what "resubscribe with
  # a fresh cursor" means. `101 101` here would be the infinite loop.
  expect_since_log fills "<none> 101 <none>"
  # One refetch at startup (the auth probe) and one for the resync.
  expect_rest_resyncs fills 1
  expect_says "out_of_sync"
  expect_says "state refetched over REST"
  expect_says "recovered"
  expect_silent_about "LOSSY"
  expect_status 0
  finish
}

# A hole nothing explains. The venue accepted the resume and then skipped
# 103 and 104. This is the one result that changes the exit status.
test_unexplained_hole_is_lossy() {
  start "an unexplained hole is LOSSY"
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)" "$(event fills 102)"
  script_for fills 2
  ws "$(ack fills 106)" "$(event fills 105)" "$(event fills 106)"

  run_app --follow
  expect_says "LOSSY"
  expect_says "missing 103-104"
  expect_status 4
  finish
}

# `since` inclusivity is not pinned by the contract, so a venue that
# re-delivers the cursor itself is within its rights. It must not show up as
# a duplicate event or move the verdict.
test_redelivered_cursor_is_dropped() {
  start "a re-delivered cursor is dropped"
  script_for fills 1
  ws "$(ack fills 300)" "$(event fills 301)" "$(event fills 302)"
  script_for fills 2
  ws "$(ack fills 303)" "$(event fills 302)" "$(event fills 303)"

  run_app --follow
  expect_events 3
  expect_cursor fills 303
  expect_says "301..303, 3 event(s), no gap"
  finish
}

# The sequence went backwards, which on this venue means an engine epoch
# bump. Holding the old cursor would wait for events that will never be
# numbered that high.
test_sequence_going_backwards_resets() {
  start "a backwards sequence is an epoch reset"
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)" "$(event fills 102)"
  script_for fills 2
  ws "$(ack fills 5)" "$(event fills 6)"

  run_app --follow
  expect_says "went backwards"
  expect_says "cursor reset to 5"
  expect_says "recovered"
  expect_rest_resyncs fills 1
  expect_cursor fills 6
  expect_status 0
  finish
}

# The demonstration a reader actually runs. It severs its own socket
# mid-stream rather than waiting for one to break.
test_prove_resume_severs_and_proves() {
  start "--prove-resume"
  export MONITOR_MAX_ATTEMPTS=2
  script_for fills 1
  ws "$(ack fills 400)" "$(event fills 401)" "$(event fills 402)" "$(event fills 403)" "@hang"
  script_for fills 2
  ws "@ceiling 405" "$(ack fills 405)" "@replay-from"

  run_app --prove-resume
  expect_says "severing the socket after 2 event(s)"
  # Severed at 402, so the reattach asks for 403 onwards — 403 was in flight
  # when the socket died and has to come back.
  expect_since_log fills "<none> 402"
  expect_seq_delivered 403
  expect_seq_delivered 405
  expect_says "401..405, 5 event(s), no gap"
  expect_status 0
  finish
}

# An idle channel proves a reconnect and nothing else. Reporting that as a
# pass is how an example comes to certify a property it never tested.
test_idle_channel_is_not_a_pass() {
  start "an idle channel is inconclusive"
  script_for fills 1
  ws "$(ack fills 700)" "@hang"
  script_for fills 2
  ws "$(ack fills 700)" "@hang"

  run_app --prove-resume
  expect_says "idle"
  expect_says "nothing was proven"
  expect_silent_about "contiguous"
  expect_status 0
  finish
}

# One channel per `nexus ws`, because `--since` is single-valued and each
# channel's sequence is its own.
test_one_process_per_channel() {
  start "one ws process per channel"
  export MONITOR_CHANNELS="fills orders"
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)"
  script_for orders 1
  ws "$(ack orders 7)" "$(event orders 8)"

  run_app --follow
  expect_cursor fills 101
  expect_cursor orders 8
  local multi
  multi=$(grep -c 'ws .* .*' "$STUB_DIR/calls.log" | head -1)
  : "$multi"
  if grep -qE '(^| )ws (fills orders|orders fills)( |$)' "$STUB_DIR/calls.log"; then
    fail "$CURRENT: never names two channels in one ws call" "found a multi-channel invocation:
$(grep ' ws ' "$STUB_DIR/calls.log")"
  else
    pass "$CURRENT: never names two channels in one ws call"
  fi
  finish
}

# ── refusals ────────────────────────────────────────────────────────────────

test_engine_channel_refused() {
  start "engine channel refused"
  export MONITOR_CHANNELS=engine
  run_app --follow
  expect_status 1
  expect_says "publishes no frames yet"
  finish
}

test_public_channel_refused() {
  start "public channel refused"
  export MONITOR_CHANNELS=trades
  run_app --follow
  expect_status 1
  expect_says "requires a market"
  finish
}

test_mainnet_refused() {
  start "mainnet refused by hostname"
  export MONITOR_BASE_URL="https://api.nexus.xyz"
  export MONITOR_WS_URL="wss://api.nexus.xyz/ws"
  run_app --follow
  expect_status 2
  expect_says "real-funds deployment"
  finish
}

test_split_hosts_refused() {
  start "split rest/ws hosts refused"
  export MONITOR_BASE_URL="https://exchange.nexus.xyz/api/exchange"
  export MONITOR_WS_URL="wss://api.testnet.nexus.xyz/indexer/ws"
  run_app --follow
  expect_status 2
  expect_says "scoped to the host that issued it"
  finish
}

test_ws_query_refused() {
  start "a ws url with a query is refused"
  export MONITOR_WS_URL="wss://api.testnet.nexus.xyz/indexer/ws?token=abc"
  run_app --follow
  expect_status 1
  expect_says "no query string"
  finish
}

test_base_url_override_refused() {
  start "NEXUS_BASE_URL refused"
  export NEXUS_BASE_URL="https://elsewhere.example/api"
  script_for fills 1
  ws "$(ack fills 100)"
  run_app --follow
  expect_status 2
  expect_says "overrides --network"
  unset NEXUS_BASE_URL
  finish
}

test_unpinned_cli_refused() {
  start "an unpinned CLI is refused"
  printf 'nexus 0.5.0 (spec v0.9.0, nexus-exchange 0.10.0)\n' >"$STUB_DIR/version"
  run_app --follow
  expect_status 2
  expect_says "pinned to nexus 0.4.0"
  finish
}

test_broken_credentials_refused() {
  start "broken credentials are refused, not downgraded"
  printf 'Error: 401 Unauthorized\n' >"$STUB_DIR/fail-orders"
  run_app --follow
  expect_status 2
  expect_says "looks exactly like a quiet account"
  finish
}

# ── the generated CLI config ────────────────────────────────────────────────

test_generated_cli_config() {
  start "the generated CLI config"
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 100)"
  run_app --follow

  local cfg="$MONITOR_STATE_DIR/cli-home/nexus/config.json"
  if [[ -f $cfg ]] &&
     [[ $(jq -r '.custom_networks | keys[0]' "$cfg") == "nexus-testnet-indexer" ]] &&
     [[ $(jq -r '.custom_networks["nexus-testnet-indexer"].funds' "$cfg") == "play" ]] &&
     [[ $(jq -r '.custom_networks["nexus-testnet-indexer"].ws_url' "$cfg") == "wss://api.testnet.nexus.xyz/indexer/ws" ]] &&
     [[ $(jq -r '.custom_networks["nexus-testnet-indexer"].base_url' "$cfg") == "https://api.testnet.nexus.xyz/indexer" ]]; then
    pass "$CURRENT: declares the deployment as a play-funds custom network"
  else
    fail "$CURRENT: declares the deployment as a play-funds custom network" \
         "config is $( [[ -f $cfg ]] && cat "$cfg" || printf 'missing' )"
  fi

  # The WS origin keeps its `/indexer` prefix. Deriving a bare origin from the
  # host is a real defect elsewhere in the stack (ENG-14963), and it is why
  # the value is declared verbatim rather than composed.
  if grep -q '/indexer/ws' "$cfg"; then
    pass "$CURRENT: the ws origin keeps its /indexer prefix"
  else
    fail "$CURRENT: the ws origin keeps its /indexer prefix" "$(cat "$cfg")"
  fi

  # Nothing that could be a credential is written to disk.
  if grep -qiE 'api_key|api_secret|token' "$cfg"; then
    fail "$CURRENT: writes no credential to disk" "$(cat "$cfg")"
  else
    pass "$CURRENT: writes no credential to disk"
  fi
  finish
}

test_status_touches_no_network() {
  start "--status touches no network"
  run_app --status
  expect_status 0
  expect_says "no cursor stored"
  local calls
  calls=$(wc -l <"$STUB_DIR/calls.log" | tr -d ' ')
  if [[ $calls == 0 ]]; then pass "$CURRENT: invoked the CLI zero times"
  else fail "$CURRENT: invoked the CLI zero times" "call log:
$(cat "$STUB_DIR/calls.log")"; fi
  finish
}

test_reset_forgets_cursors() {
  start "--reset forgets cursors"
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)"
  run_app --follow
  expect_cursor fills 101
  run_app --reset
  expect_status 0
  if [[ -e "$MONITOR_STATE_DIR/cursor/fills" ]]; then
    fail "$CURRENT: the cursor file is gone" "it is still there"
  else
    pass "$CURRENT: the cursor file is gone"
  fi
  finish
}

# `.env` is parsed, never sourced: the one file whose whole purpose is to hold
# a credential is the last one to hand to a shell.
test_dotenv_is_parsed_not_sourced() {
  start ".env is parsed, not sourced"
  local marker="$STUB_DIR/env-was-executed"
  cat >"$APP_DIR/.env" <<EOF
MONITOR_CHANNELS=fills
MONITOR_NETWORK_LABEL=\$(touch $marker; echo pwned)
EOF
  run_app --status
  if [[ -e $marker ]]; then
    fail "$CURRENT: does not execute .env" "the substitution ran"
  else
    pass "$CURRENT: does not execute .env"
  fi
  # The literal text is not a usable label, so the app refuses on the value
  # rather than on what it might have done.
  expect_status 1
  rm -f -- "$APP_DIR/.env"
  finish
}

# ── main ────────────────────────────────────────────────────────────────────

# ── regressions from #23's review ───────────────────────────────────────────

# Finding 1. An epoch bump renumbers the channel, so a new-epoch event can
# carry a sequence an old-epoch event already used. The journal was a flat set,
# so the collision read as a duplicate and was dropped BEFORE reaching stdout,
# and the verdict then certified the run contiguous over events it never
# delivered. The reviewer's own scenario.
test_epoch_collision_is_not_a_duplicate() {
  start "an epoch bump does not swallow colliding sequences"
  script_for fills 1
  ws "$(ack fills 4)" "$(event fills 5)" "$(event fills 6)"
  script_for fills 2
  ws "$(ack fills 3)" "$(event fills 4)" "$(event fills 5)" "$(event fills 6)" "$(event fills 7)"

  run_app --follow
  # Two from epoch A, four from epoch B. Before the fix this was 4: B/5 and
  # B/6 were dropped as "already seen", which is the whole bug.
  expect_events 6
  expect_says "cursor reset to 3"
  finish
}

# Finding 2. `seen/` is documented as per-run and nothing implemented that, so
# the EVIDENCE of a hole outlived its EXPLANATION -- `gap/` and `severed/` are
# wiped at every run start and `seen/` was not. A clean run was then judged
# against the previous run's sequences and reported LOSSY.
test_a_clean_run_is_not_judged_by_the_previous_one() {
  start "a clean run is not judged by the previous run's sequences"
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)" "$(event fills 102)"
  run_app --follow

  # Attempt counters persist across `run_app` within a test, so run 2's
  # scripts are attempts 3 and 4.
  script_for fills 3
  ws "$(ack fills 500)" "$(event fills 501)" "$(event fills 502)"
  script_for fills 4
  ws "$(ack fills 502)"
  run_app --follow

  # The assertion is about the JOURNAL'S LIFETIME, not the verdict word: run 2
  # must be judged over its own sequences only. Before the fix the range was
  # `101..502` with a hole, because run 1's numbers were still in `seen/` while
  # the `gap/` marker that would have explained them had been wiped.
  expect_says "501..502"
  expect_silent_about "101..502"
  finish
}

# Finding 3. `cleanup` restored TERM to its default disposition and then
# signalled its own process group, so the shell died before `lock_release`.
# Only reachable with job control, which is why 72 tests never saw it.
test_reset_takes_the_lock() {
  start "--reset refuses while another monitor holds the lock"
  # Seed a cursor first, with nothing holding the lock.
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)"
  run_app --follow
  expect_cursor fills 101

  # Now a live holder: this shell. `--reset` is `rm -rf` on the cursor store,
  # and a running monitor's next reattach would find no cursor and attach at
  # the LIVE EDGE -- a silent gap in the one tool that exists to not have those.
  mkdir -p -- "$MONITOR_STATE_DIR/lock"
  printf '%s\n' "$$" >"$MONITOR_STATE_DIR/lock/pid"

  run_app --reset
  expect_status 75
  expect_cursor fills 101
  rm -rf -- "$MONITOR_STATE_DIR/lock"
  finish
}

test_a_pidless_lock_does_not_wedge_forever() {
  start "an orphaned lock clears instead of refusing forever"
  # The state a crash between `mkdir` and the pid `printf` leaves -- and, before
  # `lock_release` was made atomic, the state a failed `rmdir` left too. It
  # never cleared on its own, so every later run exited 75 indefinitely.
  mkdir -p -- "$MONITOR_STATE_DIR/lock"
  # Backdate it past LOCK_ORPHAN_SECONDS. A fresh pid-less lock must still
  # refuse -- that one is a run microseconds into its own start.
  touch -t 202001010000 -- "$MONITOR_STATE_DIR/lock"
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)"

  run_app --follow
  expect_status 0
  expect_says "clearing an orphaned lock"
  expect_no_lock
  finish
}

test_a_fresh_pidless_lock_still_refuses() {
  start "a pid-less lock younger than the orphan window still refuses"
  # The other half of the test above: this is a run that has just done `mkdir`
  # and has not reached its `printf` yet, and taking its lock would put two
  # monitors on one cursor store.
  mkdir -p -- "$MONITOR_STATE_DIR/lock"
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 100)"

  run_app --follow
  expect_status 75
  expect_says "--unlock"
  rm -rf -- "$MONITOR_STATE_DIR/lock"
  finish
}

test_unlock_clears_a_dead_lock_but_not_a_live_one() {
  start "--unlock clears a dead lock and refuses a live one"
  mkdir -p -- "$MONITOR_STATE_DIR/lock"
  printf '%s\n' "$$" >"$MONITOR_STATE_DIR/lock/pid"
  run_app --unlock
  expect_status 75
  if [[ -e "$MONITOR_STATE_DIR/lock" ]]; then
    pass "$CURRENT: a live lock survives --unlock"
  else
    fail "$CURRENT: a live lock survives --unlock" "it was cleared"
  fi

  # A pid that cannot be alive: PID 0 is never a user process.
  printf '%s\n' "2147483647" >"$MONITOR_STATE_DIR/lock/pid"
  run_app --unlock
  expect_status 0
  expect_no_lock
  finish
}

test_out_of_sync_does_not_erase_the_attach_evidence() {
  start "a run interrupted after out_of_sync still reports its verdict"
  # `out_of_sync` deletes the cursor deliberately -- a fresh resubscribe is the
  # spec's own remedy. When the cursor WAS the attach evidence, a run ending in
  # that window reported "no channel ever acknowledged a subscription" and
  # exited EX_STREAM, throwing away the verdict and any LOSSY finding in it.
  export MONITOR_MAX_ATTEMPTS=1
  script_for fills 1
  ws "$(ack fills 100)" "$(event fills 101)" \
     "$(oos fills 5000)"

  run_app --follow
  if [[ -e "$MONITOR_STATE_DIR/cursor/fills" ]]; then
    fail "$CURRENT: out_of_sync cleared the cursor" "the cursor file is still there"
  else
    pass "$CURRENT: out_of_sync cleared the cursor"
  fi
  if [[ $OUT == *"no channel ever acknowledged a subscription"* ||
        $ERR == *"no channel ever acknowledged a subscription"* ]]; then
    fail "$CURRENT: the run is not reported as never attached" "it claims nothing attached"
  else
    pass "$CURRENT: the run is not reported as never attached"
  fi
  finish
}

test_interactive_run_exits_clean_and_releases_the_lock() {
  start "an interactive run exits clean and releases the lock"
  script_for fills 1
  ws "$(ack fills 10)" "$(event fills 11)"
  script_for fills 2
  ws "$(ack fills 11)"

  run_app_interactive --follow
  # 143 is SIGTERM -- the shell killing itself. It also means every line after
  # the group kill was skipped, so the lock below is the same bug's other half.
  expect_status 0
  expect_no_lock
  finish
}

for t in \
  test_resume_is_lossless \
  test_ack_does_not_outrun_the_replay \
  test_cursor_survives_the_process \
  test_out_of_sync_does_not_spin \
  test_unexplained_hole_is_lossy \
  test_redelivered_cursor_is_dropped \
  test_sequence_going_backwards_resets \
  test_prove_resume_severs_and_proves \
  test_idle_channel_is_not_a_pass \
  test_one_process_per_channel \
  test_engine_channel_refused \
  test_public_channel_refused \
  test_mainnet_refused \
  test_split_hosts_refused \
  test_ws_query_refused \
  test_base_url_override_refused \
  test_unpinned_cli_refused \
  test_broken_credentials_refused \
  test_generated_cli_config \
  test_status_touches_no_network \
  test_reset_forgets_cursors \
  test_dotenv_is_parsed_not_sourced \
  test_epoch_collision_is_not_a_duplicate \
  test_a_clean_run_is_not_judged_by_the_previous_one \
  test_interactive_run_exits_clean_and_releases_the_lock \
  test_reset_takes_the_lock \
  test_a_pidless_lock_does_not_wedge_forever \
  test_a_fresh_pidless_lock_still_refuses \
  test_unlock_clears_a_dead_lock_but_not_a_live_one \
  test_out_of_sync_does_not_erase_the_attach_evidence
do
  printf '\n%s\n' "$t"
  "$t"
done

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
