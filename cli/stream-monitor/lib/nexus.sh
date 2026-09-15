# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# The one place this app invokes the `nexus` CLI.
#
# Every call goes through here, and every call carries the same three things
# for reasons that are each a bug if you skip them:
#
# 1. **`XDG_CONFIG_HOME` is this app's own state directory.** The generated
#    config there declares the custom network (see preflight.sh); the reader's
#    real `~/.config/nexus/config.json` is never read or written. It is set
#    per invocation rather than exported once, so nothing this script shells
#    out to inherits it by accident.
#
# 2. **The network is named on every single call.** `--network` beats
#    `NEXUS_NETWORK`, so a stale value in the reader's shell cannot silently
#    redirect one command in the middle of a run.
#
# 3. **`--output json` is passed as a flag, not left to `NEXUS_OUTPUT`.** Same
#    reasoning: this script parses stdout, so the format is not the
#    environment's decision to make. On the WS path it is what turns each
#    frame into exactly one compact JSON line, which is what makes a
#    line-oriented reader correct rather than lucky.
#
# Credentials are never arguments. The CLI accepts `--api-key` and
# `--api-secret`, and its own help says not to use them: arguments are visible
# in the process list and in shell history. They stay in the environment,
# which is also why nothing in this app ever reads, prints, or logs the secret
# — the only code that touches it is the CLI itself.

NX_OUT=""
NX_ERR=""
NX_STATUS=0
NX_STDERR_FILE=""

nx_init() {
  NX_STDERR_FILE=$1
  # `NEXUS_BASE_URL` outranks `--network` inside the CLI, so a stray one in the
  # reader's shell would send a run labelled with this app's own network label
  # somewhere else entirely — with the label unchanged in every log line. It is
  # refused rather than reported, and the same goes for `NEXUS_NETWORK`, which
  # `--network` beats but which would still pick the credential namespace if
  # this app ever forgot the flag.
  if [[ -n ${NEXUS_BASE_URL:-} ]]; then
    die "$EX_CONFIG" "NEXUS_BASE_URL is set, and it overrides --network in the CLI, so this run could not honour MONITOR_BASE_URL. Unset it — this app declares its deployment as a custom network instead, which is the CLI's own replacement for that variable (it is deprecated as of ENG-10956)."
  fi
}

# nx <cli args...> — run a REST command, capture both streams, return status.
#
# Callers must handle the status. Under `set -e` a bare failing call would take
# the whole script down, which is right for a preflight read and wrong for a
# probe.
nx() {
  local status=0
  NX_OUT=$(XDG_CONFIG_HOME="$MONITOR_CLI_HOME" nexus \
    --network "$MONITOR_NETWORK_LABEL" \
    --output json \
    "$@" 2>"$NX_STDERR_FILE") || status=$?
  NX_ERR=$(<"$NX_STDERR_FILE")
  NX_STATUS=$status
  return "$status"
}

# nx_ws_argv <channel> <cursor> — echo the argv for one attach attempt.
#
# **One `--since` per invocation, so one invocation per channel.** The CLI
# takes a single `--since` and applies it to every channel named on the
# command line, but each channel's sequence is its own — `fills` at 900 and
# `positions` at 12 are both normal. A single `nexus ws orders fills --since N`
# would therefore be wrong for at least one of them, and wrong in the worse
# direction for the lower one: it asks for a replay from a sequence that
# channel has not reached, and gets nothing back at all.
#
# So this app runs one supervised child per channel. That is a constraint the
# CLI's surface imposes, not a design preference, and it is the reason the
# cursor store is a directory rather than a file.
nx_ws_argv() {
  local channel=$1 cursor=$2
  NX_WS_ARGV=(--network "$MONITOR_NETWORK_LABEL" --output json ws "$channel")
  if [[ -n $cursor ]]; then
    NX_WS_ARGV[${#NX_WS_ARGV[@]}]=--since
    NX_WS_ARGV[${#NX_WS_ARGV[@]}]=$cursor
  fi
}
