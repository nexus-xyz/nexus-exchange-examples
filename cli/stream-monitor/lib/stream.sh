# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# One supervised `nexus ws` child per channel, and the frame handling that
# turns its stdout into a cursor.
#
# ── One process per attempt, and why that is the whole design ───────────────
#
# The CLI reconnects on its own. It has backoff, ping/pong keep-alive and
# bounded buffering, and for a public stream that is exactly what you want.
# This app deliberately does **not** let it, and kills the child the moment it
# reports a disconnect. Two reasons, and the first one is a live defect:
#
#  1. **The token is spent.** `/ws` tokens are single-use and expire after 60
#     seconds. At the pinned 0.4.0 the CLI mints one *once*, bakes it into the
#     socket URL, and hands that URL to the SDK's low-level `connect`, which
#     re-sends the same URL — and so the same spent token — on every
#     reconnect. The first automatic reconnect therefore presents a consumed
#     token and the upgrade is rejected. That is ENG-5291 (cli#76): the SDK's
#     own `connect_ws` mints a fresh token before every attempt and the CLI
#     does not use it. A new *process* mints a new token, so process-level
#     reconnection is the remint.
#
#  2. **Even fixed, the CLI would resume from the wrong place.** `--since` is
#     read from argv once, at launch. A connection that has been up for an
#     hour has a cursor thousands of sequences ahead of the one it started
#     with, and an in-process reconnect would re-request all of it — or be
#     told `out_of_sync` and lose the gap entirely. The cursor advances in
#     this app's state directory, so the only way to reconnect *at* it is to
#     re-read it, which means re-launching.
#
# So the supervisor owns reconnection: read cursor → launch → follow frames →
# child exits or reports a disconnect → kill it → back off → repeat. Nothing
# is retried in place, and every attempt starts from the durable cursor rather
# than from whatever the last process happened to be holding.

# stream_run — supervise every channel until the run ends.
#
# One background subshell per channel. They share nothing but the state
# directory and stdout: a subshell cannot write back into its parent's
# variables, so every fact that has to outlive an attempt is a file, which is
# the same property that makes the cursor survive the process.
stream_run() {
  local channel pid pids=()
  for channel in "${CHANNELS[@]}"; do
    supervise_channel "$channel" &
    pids[${#pids[@]}]=$!
  done
  STREAM_PIDS="${pids[*]}"
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

stream_stop_requested() { [[ -e "$RUN_DIR/stop" ]]; }
stream_request_stop()   { : >"$RUN_DIR/stop" 2>/dev/null || true; }

# Has the run's wall-clock budget expired? `MONITOR_RUN_SECONDS=0` means never.
stream_deadline_passed() {
  (( MONITOR_RUN_SECONDS > 0 )) || return 1
  (( $(date -u +%s) >= RUN_DEADLINE ))
}

# ── the per-channel supervisor ──────────────────────────────────────────────

supervise_channel() {
  local channel=$1 attempt=0 backoff=$MONITOR_BACKOFF_SECONDS outcome cursor

  # The supervisor's own trap, and not only the parent's. A subshell killed by
  # its parent does not run the parent's EXIT trap, so without this the
  # `nexus ws` it forked would be reparented to init and keep holding a socket
  # — and the subscription ceiling it counts against is per account, so an
  # orphan from one run is a refused attach in the next.
  # shellcheck disable=SC2317  # reached via `trap`
  CHANNEL_CHILD=""
  trap 'kill "$CHANNEL_CHILD" 2>/dev/null; exit 0' TERM INT

  while :; do
    if stream_stop_requested || stream_deadline_passed; then break; fi
    if (( MONITOR_MAX_ATTEMPTS > 0 && attempt >= MONITOR_MAX_ATTEMPTS )); then
      info "$channel: reached MONITOR_MAX_ATTEMPTS=$MONITOR_MAX_ATTEMPTS; stopping this channel"
      break
    fi
    attempt=$(( attempt + 1 ))

    cursor=$(cursor_read "$channel")
    if [[ -n $cursor ]]; then
      info "$channel: attach #$attempt resuming from seq $cursor"
    else
      info "$channel: attach #$attempt from the live edge (no stored cursor)"
    fi

    attempt_once "$channel" "$attempt" "$cursor"
    outcome=$?

    case $outcome in
      # 0 — the child exited or was severed. Reconnect.
      0) ;;
      # 10 — this channel is done on purpose (event budget, proof complete).
      10) break ;;
      # 11 — `out_of_sync`. The cursor has already been cleared and the state
      #      refetched over REST; reattach immediately rather than backing off,
      #      because nothing is wrong with the socket.
      11) backoff=$MONITOR_BACKOFF_SECONDS; continue ;;
      *) ;;
    esac

    if stream_stop_requested || stream_deadline_passed; then break; fi

    # Exponential backoff, capped. A monitor that reconnects in a tight loop
    # against a venue that is refusing it is a monitor that gets rate-limited
    # at the upgrade — the per-IP connection cap binds on every tier — and
    # then cannot reconnect when the venue recovers.
    if (( backoff > 0 )); then
      info "$channel: reconnecting in ${backoff}s"
      sleep "$backoff"
    fi
    backoff=$(( backoff * 2 ))
    (( backoff <= MONITOR_BACKOFF_MAX_SECONDS )) || backoff=$MONITOR_BACKOFF_MAX_SECONDS
  done
}

# attempt_once <channel> <attempt> <cursor> — one socket, start to finish.
#
# Returns 0 to reconnect, 10 to stop this channel, 11 for an `out_of_sync`
# that has already been handled.
attempt_once() {
  local channel=$1 attempt=$2 cursor=$3
  local dir="$RUN_DIR/$channel"
  local fifo="$dir/frames"
  local err="$dir/stderr"
  local child line status rc=0 last_seen deadline now
  local frames=0

  mkdir -p -- "$dir"
  rm -f -- "$fifo"
  mkfifo -- "$fifo" || { error "$channel: cannot create $fifo"; return 10; }
  : >"$err"

  nx_ws_argv "$channel" "$cursor"

  # `XDG_CONFIG_HOME` inline, so only the CLI sees it — see nexus.sh.
  XDG_CONFIG_HOME="$MONITOR_CLI_HOME" nexus "${NX_WS_ARGV[@]}" >"$fifo" 2>"$err" &
  child=$!
  CHANNEL_CHILD=$child

  # Opened read-**write**, which is the difference between a supervisor and a
  # hang: a plain `<` on a FIFO blocks until a writer appears, so a child that
  # died before it could open the pipe would wedge the supervisor forever.
  # Holding a writer ourselves means the open returns immediately — at the
  # price that we never see EOF, which is why the loop below watches the child
  # rather than waiting for the pipe to close.
  exec 3<>"$fifo"

  ATTEMPT_CURSOR=$cursor
  ATTEMPT_SEVERED=0
  last_seen=$(date -u +%s)

  while :; do
    if IFS= read -r -t 1 line <&3; then
      [[ -n $line ]] || continue
      frames=$(( frames + 1 ))
      last_seen=$(date -u +%s)
      handle_frame "$channel" "$line"
      rc=$?
      case $rc in
        0) continue ;;
        # 13 — the deliberate severance. It is a reconnect, not a fault, so it
        # leaves the loop with the ordinary "go round again" status; the kill
        # below is what actually severs the socket.
        13) rc=0; break ;;
        *) break ;;
      esac
    fi

    # `read` timed out. Everything that is not a frame is decided here.
    if stream_stop_requested || stream_deadline_passed; then rc=10; break; fi

    # The CLI's own reconnect, refused. See the header comment: at 0.4.0 it
    # would present a spent token, and at any version it would resume from the
    # cursor this process launched with rather than the one on disk.
    if grep -q 'disconnected:' "$err" 2>/dev/null; then
      info "$channel: the CLI reported a disconnect — taking the reconnect at the process level so the token is re-minted"
      rc=0
      break
    fi

    if ! kill -0 "$child" 2>/dev/null; then
      info "$channel: the stream process exited"
      rc=0
      break
    fi

    now=$(date -u +%s)
    if (( frames == 0 )); then
      deadline=$(( last_seen + MONITOR_HANDSHAKE_SECONDS ))
      if (( now >= deadline )); then
        warn "$channel: no subscribe ack within ${MONITOR_HANDSHAKE_SECONDS}s — treating the attach as failed"
        rc=0
        break
      fi
    elif (( MONITOR_IDLE_SECONDS > 0 )); then
      deadline=$(( last_seen + MONITOR_IDLE_SECONDS ))
      if (( now >= deadline )); then
        # A liveness guard, not a correctness one. A per-account channel can
        # legitimately be silent for hours, and the socket's own keep-alive is
        # inside the CLI where this app cannot see it — so a long silence is
        # ambiguous between "quiet account" and "dead socket", and the cheap
        # resolution is to reattach from the cursor. Nothing is lost by being
        # wrong: the reattach replays anything that arrived in between.
        info "$channel: ${MONITOR_IDLE_SECONDS}s with no frame — reattaching from the cursor to prove the socket is still there"
        rc=0
        break
      fi
    fi
  done

  exec 3<&-
  kill "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  rm -f -- "$fifo"

  # The CLI writes its own diagnostics here; surface the last line of anything
  # that was not a routine disconnect, so a refused upgrade is legible.
  if [[ -s $err ]] && ! grep -q 'disconnected:' "$err" 2>/dev/null; then
    local tail_line
    tail_line=$(grep -v -e '^connecting to' -e '^streaming events' -e '^connected;' "$err" | tail -1)
    [[ -n $tail_line ]] && info "$channel: cli said: $tail_line"
  fi

  return "$rc"
}

# handle_frame <channel> <json-line> — fold one server envelope.
#
# Returns 0 to keep reading, 10 to stop the channel, 11 for `out_of_sync`.
handle_frame() {
  local channel=$1 line=$2
  local parsed op chan seq join oldest message

  # `--output json` gives one compact JSON object per line, so a line-oriented
  # reader is correct rather than lucky. A line that is not an object is
  # reported and skipped: the CLI puts its own chatter on stderr, so anything
  # unparsable on stdout is a contract change worth seeing.
  # An absent field becomes `-`, never the empty string. Tab is IFS
  # *whitespace*, so bash collapses a run of them: with empty fields, a frame
  # carrying only `op` and `seq_at_join` would shift `seq_at_join` into the
  # `seq` column and the ack would silently read as an event. A placeholder
  # keeps every field positional, and `-` is not a sequence, so the guards
  # downstream reject it on their own.
  parsed=$(printf '%s' "$line" | jq -r '
    [.op, .channel, .seq, .seq_at_join, .oldest_seq, .message]
    | map(if . == null then "-" else tostring end)
    | @tsv' 2>/dev/null) || {
    warn "$channel: unparsable frame on stdout, skipped"
    return 0
  }
  IFS=$'\t' read -r op chan seq join oldest message <<<"$parsed"
  : "$chan"
  [[ $message == "-" ]] && message=""

  case $op in
    subscribed)
      handle_subscribed "$channel" "$join"
      ;;

    event)
      handle_event "$channel" "$seq" "$line"
      return $?
      ;;

    out_of_sync)
      # **The failure this example exists to make survivable.** Our cursor fell
      # out of the venue's replay buffer, and `oldest_seq` is the earliest it
      # can still serve. There is no value between the two that would work, so
      # resubscribing at the same `--since` is an infinite loop — the venue
      # answers `out_of_sync` again, forever, while the monitor reports itself
      # as healthy and delivers nothing.
      #
      # The only correct response is the one the spec names: refetch state over
      # REST, then resubscribe with a *fresh* cursor. "Fresh" means no `--since`
      # at all — the next ack's `seq_at_join` becomes the new cursor.
      warn "$channel: out_of_sync — the stored cursor is older than the venue's replay buffer (oldest_seq=$oldest)"
      resync_over_rest "$channel"
      rm -f -- "$(cursor_path "$channel")"
      : >"$(gap_marker_path "$channel")"
      printf '%s\n' "rest-refetch oldest_seq=$oldest" >>"$(gap_marker_path "$channel")"
      return 11
      ;;

    unsubscribed)
      info "$channel: unsubscribed by the venue"
      return 0
      ;;

    error)
      # An `error` frame is not a transport failure and reconnecting will not
      # fix it — an unknown channel or a malformed op reads the same way on
      # every attempt. Reported and left to the supervisor's attempt cap rather
      # than retried tightly.
      warn "$channel: error frame from the venue: ${message:-<no message>}"
      return 0
      ;;

    *)
      info "$channel: unrecognised op $(quoted "$op"); ignored"
      return 0
      ;;
  esac
  return 0
}

# The subscribe ack. `seq_at_join` is the channel's current sequence at attach
# time — and the cursor to persist, rather than the first event's `seq`.
#
# The difference matters exactly when nothing happens: an account channel can
# be silent for hours, and a monitor that waits for an event to learn where it
# is has no cursor at all if the socket drops first. `seq_at_join` is available
# immediately, on every attach, whether or not anything is ever published.
#
# Three cases, and the middle one is the trap.
handle_subscribed() {
  local channel=$1 join=$2 cursor
  is_sequence "$join" || { warn "$channel: subscribe ack carried no usable seq_at_join"; return 0; }
  cursor=$(cursor_read "$channel")

  if [[ -z $cursor ]]; then
    # First attach ever. Seed from the ack — this is the cursor's origin.
    cursor_write "$channel" "$join"
    info "$channel: attached, seq_at_join=$join (cursor seeded)"
    return 0
  fi

  if (( join < cursor )); then
    # The channel's sequence went **backwards**. On this venue that is an
    # engine epoch bump: ENG-13641's own record notes the epoch-advance arm
    # clears the indexer's cursor, its sparse set and its gap origin together,
    # so numbering restarts below where we were. Holding a cursor above the
    # channel's current sequence would wait for events that will never be
    # numbered that high — the monitor would sit there looking healthy and
    # deliver nothing, which is the same silent failure as spinning on
    # `out_of_sync`.
    #
    # Nothing bridges an epoch boundary, so this is a hole in the numbering
    # that no replay can fill. REST is what re-establishes state, and the gap
    # is recorded so the verdict cannot call the run lossless.
    warn "$channel: seq_at_join=$join is below the stored cursor $cursor — the channel's sequence went backwards (an engine epoch bump does this)"
    resync_over_rest "$channel"
    cursor_reset "$channel" "$join" "sequence went backwards; nothing replays across an epoch boundary"
    # The attempt's own copy has to move with it. It is what suppresses a
    # re-delivered cursor, and left at the pre-reset value it would suppress
    # every event in the new epoch — all of which are numbered below it. That
    # is a silent, total loss of the channel dressed up as duplicate
    # filtering, and it is exactly what the epoch test caught.
    ATTEMPT_CURSOR=$join
    : >"$(gap_marker_path "$channel")"
    printf '%s\n' "epoch-reset from=$cursor to=$join" >>"$(gap_marker_path "$channel")"
    return 0
  fi

  # `join >= cursor`, the ordinary resume. **Do not advance the cursor here.**
  #
  # It is the single most tempting line in the file: the ack carries a bigger
  # number, so storing it looks like progress. It is the opposite. We asked for
  # a replay from `cursor`, and the venue is about to deliver `cursor+1 ..
  # join` — the very events we reconnected to collect. Writing `join` now would
  # move the cursor past them before they arrive, and a crash in the middle of
  # the replay would then resume *after* the gap it was replaying. The cursor
  # advances only on a delivered event, which is the only evidence that an
  # event was actually folded.
  if (( join > cursor )); then
    info "$channel: attached, seq_at_join=$join — expecting a replay of $(( cursor + 1 ))..$join"
  else
    info "$channel: attached, seq_at_join=$join — caught up, tailing live"
  fi
}

# A delivered event. This is the only thing that advances the cursor.
handle_event() {
  local channel=$1 seq=$2 line=$3
  is_sequence "$seq" || { warn "$channel: event frame carried no usable seq"; return 0; }

  # Duplicate suppression, in two forms, because `since` inclusivity is not
  # pinned by the contract (see cursor.sh).
  if [[ -n $ATTEMPT_CURSOR ]] && (( seq <= ATTEMPT_CURSOR )); then
    return 0
  fi
  if seen_is_duplicate "$channel" "$seq"; then
    return 0
  fi

  seen_record "$channel" "$seq"
  # The event is emitted **before** the cursor advances. If the process dies
  # between the two, the next run re-delivers this event — visible, and handled
  # by the duplicate suppression above. Advancing first would lose it silently,
  # and a monitor whose failure mode is silence is not a monitor.
  printf '%s\n' "$line"
  cursor_write "$channel" "$seq"

  local count
  count=$(count_bump "$channel")

  # The demonstration. Sever the socket mid-stream, exactly once, so the resume
  # path is exercised on a stream that was genuinely in flight rather than on
  # one that ended tidily.
  if (( PROVE_RESUME )) && (( ! ATTEMPT_SEVERED )) && [[ ! -e "$(sever_marker_path "$channel")" ]] &&
     (( count >= MONITOR_PROVE_AFTER )); then
    : >"$(sever_marker_path "$channel")"
    ATTEMPT_SEVERED=1
    warn "$channel: severing the socket after $count event(s) at seq $seq — this is the demonstration, not a fault"
    return 13
  fi

  if (( MONITOR_MAX_EVENTS > 0 && count >= MONITOR_MAX_EVENTS )); then
    info "$channel: reached MONITOR_MAX_EVENTS=$MONITOR_MAX_EVENTS"
    return 10
  fi
  return 0
}

# ── the resync path ─────────────────────────────────────────────────────────

# The REST half of an `out_of_sync` recovery.
#
# The stream is a projection; REST is the state. When the replay buffer can no
# longer bridge the gap, the state has to be re-read rather than reconstructed
# from events that no longer exist. This prints a one-line summary rather than
# dumping the payload — the point a reader needs is that the refetch *happened*
# and what it found, not the account's contents.
resync_over_rest() {
  local channel=$1
  local -a argv
  case $channel in
    orders)       argv=(orders) ;;
    fills)        argv=(fills --limit 50) ;;
    positions)    argv=(positions) ;;
    balances)     argv=(balance) ;;
    liquidations)
      # There is no REST read of this channel, and subscribing does not replay
      # the current alert state — alerts are edge-triggered, one frame per
      # worsening severity transition, and nothing is re-sent when a client
      # reconnects. So a gap here cannot be closed at all: whatever transition
      # happened during the outage is simply gone, and the next thing the
      # monitor sees is the next *worsening* transition. Saying so is the only
      # honest handling.
      warn "$channel: no REST read exists for this channel and alerts are edge-triggered, so a missed transition cannot be recovered — the gap is permanent"
      return 0
      ;;
  esac

  if nx "${argv[@]}"; then
    local n
    n=$(printf '%s' "$NX_OUT" | jq -r 'if type == "array" then length else 1 end' 2>/dev/null || printf '?')
    info "$channel: state refetched over REST (${n} record(s))"
  else
    warn "$channel: the REST refetch failed: ${NX_ERR%%$'\n'*}"
  fi
}

# ── per-channel counters and markers ────────────────────────────────────────
#
# Files rather than variables, for the same reason the cursor is: these are
# written inside a `&`-forked subshell and read by the parent after `wait`.

count_path()        { printf '%s/count/%s' "$MONITOR_STATE_DIR" "$1"; }
sever_marker_path() { printf '%s/severed/%s' "$MONITOR_STATE_DIR" "$1"; }
gap_marker_path()   { printf '%s/gap/%s' "$MONITOR_STATE_DIR" "$1"; }

markers_init() {
  mkdir -p -- "$MONITOR_STATE_DIR/count" "$MONITOR_STATE_DIR/severed" "$MONITOR_STATE_DIR/gap"
  rm -f -- "$MONITOR_STATE_DIR"/count/* "$MONITOR_STATE_DIR"/severed/* "$MONITOR_STATE_DIR"/gap/* 2>/dev/null || true
}

# Increment and echo. Not atomic across processes — but each channel has
# exactly one supervisor, so there is exactly one writer per file.
count_bump() {
  local file value=0
  file=$(count_path "$1")
  [[ -r $file ]] && read -r value <"$file" 2>/dev/null
  is_sequence "$value" || value=0
  value=$(( value + 1 ))
  printf '%s\n' "$value" >"$file"
  printf '%s' "$value"
}

count_read() {
  local file value=0
  file=$(count_path "$1")
  [[ -r $file ]] && read -r value <"$file" 2>/dev/null
  is_sequence "$value" || value=0
  printf '%s' "$value"
}
