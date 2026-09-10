# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# The durable cursor store: one small file per channel, under the state
# directory. This is what separates the app from `nexus ws | jq` — the cursor
# outlives the socket, the process, and the machine.
#
#   $MONITOR_STATE_DIR/cursor/<channel>     the last sequence folded, as text
#   $MONITOR_STATE_DIR/seen/<channel>       every sequence delivered this run
#
# A directory of files rather than an associative array, for three reasons and
# only incidentally because bash 3.2 has no associative arrays:
#
#  1. **It has to survive the process.** An in-memory map is exactly the thing
#     that does not, and "resumes across a restart" is the claim being made.
#  2. **Each channel is supervised by its own subshell** (see stream.sh), and a
#     subshell cannot write back into its parent's variables. The filesystem is
#     the only shared mutable state a `&`-forked bash has.
#  3. **A rename is atomic and an assignment is not.** Every advance is written
#     to a temporary file and `mv`d into place, so a monitor killed mid-write
#     leaves the *previous* cursor rather than half of the new one. A truncated
#     cursor file reads as a smaller number, and a smaller number is a silent
#     re-request of history the app then reports as a duplicate — which looks
#     exactly like a venue bug.
#
# ── What the cursor actually is ─────────────────────────────────────────────
#
# The client-facing resume cursor on this venue is a **per-channel `seq`**,
# carried two ways:
#
#   · `{"op":"subscribed", "channel":"fills", "seq_at_join": 42}`
#        the channel's current sequence at attach time
#   · `{"op":"event", "channel":"fills", "seq": 43, "payload": {...}}`
#        a delivered event, monotonic per channel
#
# and handed back on the next attach as `{"op":"subscribe","since":42}` — which
# the CLI spells `nexus ws fills --since 42`.
#
# It is **not** `x-resume-from-sequence`. That header is real, and it is one
# layer below this one: it is what the *indexer* sends the *engine* to replay
# from the engine's event WAL (ENG-13641, fixed in nexus#10356 — before that
# fix the indexer's cursor sat at 0 and the header was never sent at all, so
# every indexer reconnect was a plain live tail). It does not appear on the
# client contract, and grepping the deployment's own `openapi.json` for it
# returns nothing. The two matter to each other exactly once: the replay this
# app asks for can only be served out of a buffer the indexer itself did not
# lose, so an indexer that never resumes upstream sets a floor on how lossless
# any client below it can be. That is the failure `out_of_sync` reports.

# cursor_path <channel>
cursor_path() { printf '%s/cursor/%s' "$MONITOR_STATE_DIR" "$1"; }
seen_path()   { printf '%s/seen/%s' "$MONITOR_STATE_DIR" "$1"; }

cursor_init() {
  mkdir -p -- "$MONITOR_STATE_DIR/cursor" "$MONITOR_STATE_DIR/seen" ||
    die "$EX_CONFIG" "cannot create the cursor store under $MONITOR_STATE_DIR"
}

# cursor_read <channel> — the stored cursor, or the empty string if there is
# none. A cursor file that is not a plain sequence is treated as absent and
# reported: resuming from a value the venue cannot parse would be refused at
# the socket, and resuming from a value it *can* parse but that we did not
# write is worse.
cursor_read() {
  local channel=$1 file value=""
  file=$(cursor_path "$channel")
  [[ -r $file ]] || return 0
  read -r value <"$file" 2>/dev/null || return 0
  if ! is_sequence "$value"; then
    warn "$channel: cursor file holds $(quoted "$value"), which is not a sequence — starting from the live edge instead"
    return 0
  fi
  printf '%s' "$value"
}

# cursor_write <channel> <sequence> — advance the cursor, monotonically.
#
# Refuses to move backwards. Every caller has a reason it believes its value is
# the newest, and exactly one of them can be right at a time; letting the loser
# win would re-request history that has already been folded. The one case that
# legitimately needs to go backwards is an epoch reset, which calls
# `cursor_reset` and says so out loud.
cursor_write() {
  local channel=$1 seq=$2 file current tmp
  is_sequence "$seq" || { warn "$channel: refusing to store $(quoted "$seq") as a cursor"; return 0; }
  file=$(cursor_path "$channel")
  current=$(cursor_read "$channel")
  if [[ -n $current ]] && (( seq <= current )); then
    return 0
  fi
  tmp="$file.$$"
  printf '%s\n' "$seq" >"$tmp" && mv -f -- "$tmp" "$file"
}

# cursor_reset <channel> <sequence> <why> — deliberately move the cursor to a
# value that may be lower than the stored one.
#
# Two things justify it, and both are recorded rather than assumed:
#
#  · `out_of_sync` — our cursor fell out of the replay buffer, so there is no
#    value between it and `oldest_seq` the venue can still serve.
#  · the ack's `seq_at_join` came back *below* our stored cursor, which means
#    the channel's sequence went backwards. On this venue that is an engine
#    epoch bump (ENG-13641's own note: the epoch-advance arm clears the
#    indexer's cursor, its sparse set and its gap origin together). Holding a
#    cursor above the channel's current sequence would wait for events that
#    will never be numbered that high.
#
# Both mean the same thing to a reader: the gap is real, and whatever covers it
# is not the replay buffer.
cursor_reset() {
  local channel=$1 seq=$2 why=$3 file tmp
  is_sequence "$seq" || { warn "$channel: refusing to reset the cursor to $(quoted "$seq")"; return 0; }
  file=$(cursor_path "$channel")
  tmp="$file.$$"
  printf '%s\n' "$seq" >"$tmp" && mv -f -- "$tmp" "$file"
  warn "$channel: cursor reset to $seq ($why)"
}

cursor_forget() {
  rm -rf -- "$MONITOR_STATE_DIR/cursor" "$MONITOR_STATE_DIR/seen"
  cursor_init
}

# ── the delivered-sequence journal ──────────────────────────────────────────
#
# Every `seq` this run delivered, one per line, appended in arrival order. It
# exists for exactly one purpose: to answer "did the resume miss anything?"
# with a set operation rather than with a feeling.
#
# Kept per run, not per cursor: the cursor answers "where do I resume from",
# and no single number can also answer "was the run contiguous". A cursor of
# 900 is consistent with having seen 1..900 and with having seen only 900.

seen_record() {
  local channel=$1 seq=$2
  printf '%s\n' "$seq" >>"$(seen_path "$channel")"
}

# seen_is_duplicate <channel> <seq> — has this sequence already been delivered?
#
# The contract does not pin whether `since` is inclusive or exclusive. The
# spec's own wording is "pass the last `seq` you received", which reads as
# exclusive, and `seq_at_join` — "the channel's current sequence at attach
# time" — reads the same way. But a resume that re-delivered the cursor itself
# would still be a correct reading of "since", so this app treats a
# re-delivery at or below the cursor as expected and drops it, rather than
# reporting the venue for a bug that is a documentation ambiguity.
#
# `grep -qxF` and not a shell loop: this file grows for the life of the run.
seen_is_duplicate() {
  local channel=$1 seq=$2 file
  file=$(seen_path "$channel")
  [[ -s $file ]] || return 1
  grep -qxF -- "$seq" "$file"
}

# seen_verdict <channel> — print `<status> <detail>` for the sequences seen.
#
# `contiguous` means every integer between the lowest and highest delivered
# sequence was delivered. That is the whole claim: not "the socket came back",
# but "the socket came back and the numbers have no hole in them".
#
# An empty channel is `idle`, not a pass. A monitor that attached, was told
# nothing, and reconnected has demonstrated a reconnect and nothing about
# losslessness — and reporting that as a pass is precisely how an example
# comes to certify a property it never tested.
seen_verdict() {
  local channel=$1 file
  file=$(seen_path "$channel")
  if [[ ! -s $file ]]; then
    printf 'idle no events were delivered on this channel'
    return 0
  fi
  sort -n -u -- "$file" | awk '
    NR == 1 { low = $1; prev = $1; next }
    {
      if ($1 != prev + 1) { gaps = gaps sep (prev + 1) "-" ($1 - 1); sep = "," }
      prev = $1
    }
    END {
      if (gaps == "") printf "contiguous %d..%d, %d event(s), no gap", low, prev, NR
      else            printf "gap missing %s (delivered %d..%d)", gaps, low, prev
    }'
}
