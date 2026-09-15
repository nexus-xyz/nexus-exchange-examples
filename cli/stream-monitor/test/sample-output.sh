#!/usr/bin/env bash
#
# Regenerate the README's sample output: one `--prove-resume` run against the
# stubbed venue in `fake-nexus.sh`. It exists so the block in the README can be
# re-derived rather than hand-edited — a sample output nobody can reproduce is
# the first thing in a README to become untrue.
#
# The frame script below severs the socket with 8415 and 8416 already written
# into the pipe, so they are genuinely lost with the socket and genuinely
# recovered by the replay. That is the point being illustrated.
set -uo pipefail
HERE=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP=$(dirname -- "$HERE")
D=$(mktemp -d "${TMPDIR:-/tmp}/sm-demo.XXXXXX")
mkdir -p "$D/bin"
ln -s "$HERE/fake-nexus.sh" "$D/bin/nexus"
: >"$D/calls.log"
printf '[]\n' >"$D/orders.json"
printf '[]\n' >"$D/fills.json"
{
  printf '{"op":"subscribed","channel":"fills","market":null,"seq_at_join":8412}\n'
  for s in 8413 8414 8415 8416; do
    printf '{"op":"event","channel":"fills","market":null,"seq":%s,"payload":{"stub":true}}\n' "$s"
  done
  printf '@hang\n'
} >"$D/ws-fills-1"
{
  printf '@ceiling 8418\n'
  printf '{"op":"subscribed","channel":"fills","market":null,"seq_at_join":8418}\n'
  printf '@replay-from\n'
} >"$D/ws-fills-2"
export STUB_DIR="$D" PATH="$D/bin:$PATH"
export MONITOR_STATE_DIR="$D/state" MONITOR_CHANNELS=fills
export MONITOR_BACKOFF_SECONDS=0 MONITOR_HANDSHAKE_SECONDS=3 MONITOR_IDLE_SECONDS=2
export MONITOR_RUN_SECONDS=60 MONITOR_MAX_ATTEMPTS=2 MONITOR_PROVE_AFTER=2
"$APP/run.sh" --prove-resume 2>&1
printf '\n---- exit %s ----\n' "$?"
rm -rf -- "$D"
