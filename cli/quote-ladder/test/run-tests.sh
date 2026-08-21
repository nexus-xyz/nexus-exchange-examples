#!/usr/bin/env bash
#
# Tests for quote-ladder, with the `nexus` binary stubbed out.
#
# What this is for: the read path of this app can be run against live testnet by
# anyone, but the *write* path needs a funded testnet account, and the parts most
# worth being sure about are exactly the ones a reader without an account cannot
# reach — that a second run places nothing, that an off-ladder rung is cancelled
# and a partially filled one is not, that a rejected batch entry fails the run,
# that the lock actually excludes a second writer.
#
# So the venue is replaced by `fake-nexus.sh`, which answers from files these
# tests write, and records every invocation. The assertions are mostly about what
# the app *did not* send.
#
#   ./test/run-tests.sh          # needs bash 4.4+ and jq; no network, no account

set -uo pipefail

HERE=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(dirname -- "$HERE")

PASSED=0
FAILED=0
CURRENT=""
STUB_DIR=""
OUT=""
STATUS=0

# ── harness ─────────────────────────────────────────────────────────────────

start() {
  CURRENT=$1
  STUB_DIR=$(mktemp -d "${TMPDIR:-/tmp}/quote-ladder-test.XXXXXX")
  mkdir -p "$STUB_DIR/bin"
  ln -s "$HERE/fake-nexus.sh" "$STUB_DIR/bin/nexus"
  : >"$STUB_DIR/calls.log"

  cat >"$STUB_DIR/markets.json" <<'JSON'
[ { "market_id": "BTC-USDX-PERP", "tick_size": "0.5", "lot_size": "0.001",
    "min_order_size": "0.001", "max_order_size": "100", "max_leverage": 50 },
  { "market_id": "ETH-USDX-PERP", "tick_size": "0.10", "lot_size": "0.01",
    "min_order_size": "0.01", "max_order_size": "1000", "max_leverage": 50 } ]
JSON
  cat >"$STUB_DIR/market-status.json" <<'JSON'
{ "market_id": "BTC-USDX-PERP", "status": "active", "halted_at": null,
  "halt_reason": null, "adl_event_count": 0 }
JSON
  # 70000 exactly, so every expected price below can be checked by hand:
  # 100bps -> 69300, 150bps -> 68950, 200bps -> 68600, all on the 0.5 grid.
  cat >"$STUB_DIR/mark-price.json" <<'JSON'
{ "market_id": "BTC-USDX-PERP", "mark_price": "70000.00" }
JSON
  cat >"$STUB_DIR/orderbook.json" <<'JSON'
{ "bids": [["69990", "0.5"]], "asks": [["70010", "0.5"]] }
JSON
  printf '[]\n' >"$STUB_DIR/orders.json"
  printf '[]\n' >"$STUB_DIR/fills.json"
  cat >"$STUB_DIR/account-state.json" <<'JSON'
{ "summary": { "collateral": "1000", "total_equity": "1000",
               "total_unrealized_pnl": "0", "total_realized_pnl_24h": null,
               "total_volume_24h": null, "open_positions_count": 0,
               "open_orders_count": 3, "margin_used": "0",
               "available_margin": "1000", "withdrawable": "1000",
               "early_access_allowed": true },
  "positions": [] }
JSON

  export STUB_DIR
  export PATH="$STUB_DIR/bin:$PATH"
  export LADDER_STATE_DIR="$STUB_DIR/state"
  export LADDER_NETWORK=testnet
  export LADDER_MARKET=BTC-USDX-PERP
  export LADDER_SIDES=buy
  export LADDER_RUNGS=3
  export LADDER_START_BPS=100
  export LADDER_STEP_BPS=50
  export LADDER_TAG=ql
  export LADDER_QUANTITY=""
  export LADDER_ALLOW_NETWORK=""
  export LADDER_ALLOW_CLI_VERSION=0
  export LADDER_READ_ATTEMPTS=1     # no retry backoff in the suite
  unset NEXUS_BASE_URL || true
}

finish() {
  [[ -n $STUB_DIR && -d $STUB_DIR ]] && rm -rf -- "$STUB_DIR"
  PATH=${PATH#"$STUB_DIR/bin:"}
}

# Run the app, capturing both streams together (the report is on stdout and the
# log lines on stderr, and a test that reads one without the other would miss
# half of what the app said).
run_app() {
  OUT=$("$APP_DIR/run.sh" "$@" 2>&1)
  STATUS=$?
  return 0
}

pass() { PASSED=$(( PASSED + 1 )); printf '  ok    %s\n' "$1"; }
fail() {
  FAILED=$(( FAILED + 1 ))
  printf '  FAIL  %s\n' "$1"
  printf '        %s\n' "$2"
  printf '        ---- output ----\n'
  printf '        %s\n' "${OUT//$'\n'/$'\n'        }"
}

expect_status() {
  local want=$1
  if [[ $STATUS == "$want" ]]; then pass "$CURRENT: exit $want"
  else fail "$CURRENT: exit $want" "got exit $STATUS"; fi
}

expect_contains() {
  local needle=$1
  if [[ $OUT == *"$needle"* ]]; then pass "$CURRENT: says $(printf '%q' "$needle")"
  else fail "$CURRENT: says $(printf '%q' "$needle")" "not found in the output"; fi
}

expect_missing() {
  local needle=$1
  if [[ $OUT != *"$needle"* ]]; then pass "$CURRENT: does not say $(printf '%q' "$needle")"
  else fail "$CURRENT: does not say $(printf '%q' "$needle")" "but it did"; fi
}

# The important one: assert nothing was written.
expect_no_writes() {
  local writes
  writes=$(grep -c -E '(^| )order (batch|amend|cancel)' "$STUB_DIR/calls.log" || true)
  if [[ $writes == 0 ]]; then pass "$CURRENT: sent no write command"
  else fail "$CURRENT: sent no write command" "$writes write command(s) in the call log:
$(grep -E '(^| )order ' "$STUB_DIR/calls.log")"; fi
}

expect_file_contains() {
  local file=$1 needle=$2
  if [[ -f $file && $(cat "$file") == *"$needle"* ]]; then
    pass "$CURRENT: $(basename "$file") contains $(printf '%q' "$needle")"
  else
    fail "$CURRENT: $(basename "$file") contains $(printf '%q' "$needle")" \
         "file is $( [[ -f $file ]] && printf 'present:\n%s' "$(cat "$file")" || printf 'missing' )"
  fi
}

# An order object as the venue reports it, for the `orders.json` fixture.
resting() {
  jq -n --arg cid "$1" --arg price "$2" --arg qty "$3" \
        --arg filled "${4:-0}" --arg market "${5:-BTC-USDX-PERP}" \
    '[{ id: ("srv-" + $cid), market_id: $market, account_id: "0xacct",
        side: "buy", order_type: "Limit", price: $price, quantity: $qty,
        filled_qty: $filled, status: "open", time_in_force: "PostOnly",
        client_order_id: $cid, created_at: 1, updated_at: 1 }]'
}

# ── the tests ───────────────────────────────────────────────────────────────

test_plan_is_read_only() {
  start "plan mode"
  run_app
  expect_status 0
  expect_contains "place    buy   69300"
  expect_contains "place    buy   68950"
  expect_contains "place    buy   68600"
  expect_contains "0 to cancel, 3 to place, 0 already correct."
  expect_contains "nothing was sent"
  expect_no_writes
  finish
}

test_commit_places_post_only_batch() {
  start "commit places"
  run_app --commit
  expect_status 0
  expect_contains "batch reported 3 placed, 0 rejected"
  # The two details this app cannot get wrong and still work:
  expect_file_contains "$STUB_DIR/batch-payload.json" '"tif": "postonly"'
  expect_file_contains "$STUB_DIR/batch-payload.json" '"client_order_id": "ql-b-138600-1"'
  finish
}

test_second_run_does_nothing() {
  start "idempotent re-run"
  # Exactly the ladder the first run would place, echoed back as resting.
  jq -n '[
    { id: "s1", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "69300", quantity: "0.001", filled_qty: "0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-138600-1" },
    { id: "s2", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "68950", quantity: "0.001", filled_qty: "0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-137900-1" },
    { id: "s3", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "68600", quantity: "0.001", filled_qty: "0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-137200-1" } ]' \
    >"$STUB_DIR/orders.json"
  run_app --commit
  expect_status 0
  expect_contains "0 to cancel, 0 to place, 3 already correct."
  expect_contains "nothing to do."
  expect_no_writes
  finish
}

test_trailing_zeros_are_not_a_difference() {
  start "price echoed with trailing zeros"
  # Same three prices, spelled the way a server legitimately might. If these were
  # compared as strings the app would cancel and replace the whole ladder, on
  # every single run, forever.
  jq -n '[
    { id: "s1", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "69300.00", quantity: "0.00100", filled_qty: "0.0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-138600-1" },
    { id: "s2", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "68950.0", quantity: "0.001", filled_qty: "0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-137900-1" },
    { id: "s3", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "68600.000", quantity: "0.0010", filled_qty: "0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-137200-1" } ]' \
    >"$STUB_DIR/orders.json"
  run_app --commit
  expect_status 0
  expect_contains "3 already correct."
  expect_no_writes
  finish
}

test_off_ladder_rung_is_cancelled() {
  start "off-ladder cancel"
  resting ql-b-130000-1 65000 0.001 >"$STUB_DIR/orders.json"
  run_app --commit
  expect_status 0
  expect_contains "cancel ql-b-130000-1: resting at 65000 × 0.001 but no longer on the ladder"
  expect_file_contains "$STUB_DIR/cancels.log" "ql-b-130000-1"
  finish
}

test_foreign_orders_are_left_alone() {
  start "someone else's order"
  jq -n '[
    { id: "h1", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "60000", quantity: "0.5", filled_qty: "0", status: "open",
      time_in_force: "Gtc", client_order_id: "my-hand-placed-order" },
    { id: "h2", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "61000", quantity: "0.5", filled_qty: "0", status: "open",
      time_in_force: "Gtc", client_order_id: null } ]' >"$STUB_DIR/orders.json"
  run_app --commit
  expect_status 0
  expect_missing "my-hand-placed-order"
  if [[ ! -f "$STUB_DIR/cancels.log" ]]; then pass "$CURRENT: cancelled nothing"
  else fail "$CURRENT: cancelled nothing" "$(cat "$STUB_DIR/cancels.log")"; fi
  finish
}

test_partial_fill_is_not_topped_up() {
  start "partially filled rung"
  jq -n '[
    { id: "s1", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "69300", quantity: "0.001", filled_qty: "0.0005", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-138600-1" } ]' \
    >"$STUB_DIR/orders.json"
  run_app --commit
  expect_status 0
  expect_contains "keep ql-b-138600-1: partially filled (0.0005 of 0.001)"
  # The other two rungs are still placed; the filled one is simply not re-armed.
  expect_contains "2 to place, 1 already correct"
  if ! grep -q 'ql-b-138600-1' "$STUB_DIR/batch-payload.json"; then
    pass "$CURRENT: the filled rung is not in the placement batch"
  else
    fail "$CURRENT: the filled rung is not in the placement batch" "$(cat "$STUB_DIR/batch-payload.json")"
  fi
  if [[ ! -f "$STUB_DIR/cancels.log" ]]; then pass "$CURRENT: cancelled nothing"
  else fail "$CURRENT: cancelled nothing" "$(cat "$STUB_DIR/cancels.log")"; fi
  finish
}

test_size_change_replaces_the_rung() {
  start "size change"
  export LADDER_QUANTITY=0.002
  # The same price, the old size. Because the size is part of the client order id,
  # this rung is a different rung now: cancelled, and replaced under the id that
  # names the new size. No `order amend` anywhere.
  jq -n '[
    { id: "s1", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "69300", quantity: "0.001", filled_qty: "0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-138600-1" } ]' \
    >"$STUB_DIR/orders.json"
  run_app --commit
  expect_status 0
  expect_contains "cancel ql-b-138600-1: resting at 69300 × 0.001 but no longer on the ladder"
  expect_file_contains "$STUB_DIR/cancels.log" "ql-b-138600-1"
  expect_file_contains "$STUB_DIR/batch-payload.json" '"client_order_id": "ql-b-138600-2"'
  if ! grep -q -E '(^| )order amend' "$STUB_DIR/calls.log"; then pass "$CURRENT: never used order amend"
  else fail "$CURRENT: never used order amend" "$(cat "$STUB_DIR/calls.log")"; fi
  finish
}

test_venue_disagreeing_is_an_anomaly() {
  start "venue reports a different size"
  # An id that says one lot, resting as two. Impossible by construction, so it is
  # treated as the venue not resting what this app placed: cancelled, and named.
  jq -n '[
    { id: "s9", market_id: "BTC-USDX-PERP", side: "buy", order_type: "Limit",
      price: "69300", quantity: "0.002", filled_qty: "0", status: "open",
      time_in_force: "PostOnly", client_order_id: "ql-b-138600-1" } ]' \
    >"$STUB_DIR/orders.json"
  run_app --commit
  expect_status 0
  expect_contains "cancel ql-b-138600-1 (venue order s9): reported size '0.002' where this rung is '0.001'"
  expect_file_contains "$STUB_DIR/cancels.log" "ql-b-138600-1"
  finish
}

test_rejected_batch_entry_fails_the_run() {
  start "rejected batch entry"
  cat >"$STUB_DIR/batch-response.json" <<'JSON'
[ { "outcome": "ok", "order": { "id": "srv-1", "client_order_id": "ql-b-138600-1" }, "fills": [] },
  { "outcome": "err", "error": "post_only_would_cross", "message": "order would take liquidity" },
  { "outcome": "err", "error": "insufficient_margin", "message": "not enough collateral" } ]
JSON
  run_app --commit
  expect_status 4
  expect_contains "batch reported 1 placed, 2 rejected"
  expect_contains "post_only_would_cross"
  expect_contains "not enough collateral"
  finish
}

test_crossing_rung_is_dropped() {
  start "rung that would cross"
  # An ask sitting inside the ladder: the 100bps rung would be priced through it.
  printf '{"bids":[["68000","1"]],"asks":[["69000","1"]]}\n' >"$STUB_DIR/orderbook.json"
  run_app
  expect_status 0
  expect_contains "buy rung 1 skipped: 69300 is at or above the best ask 69000, so it would cross"
  expect_contains "0 to cancel, 2 to place"
  finish
}

test_empty_ask_side_still_quotes() {
  start "one-sided book"
  printf '{"bids":[["69990","1"]],"asks":[]}\n' >"$STUB_DIR/orderbook.json"
  run_app
  expect_status 0
  expect_contains "best ask —"
  expect_contains "3 to place"
  finish
}

test_halted_market_refuses_to_place() {
  start "halted market"
  cat >"$STUB_DIR/market-status.json" <<'JSON'
{ "market_id": "BTC-USDX-PERP", "status": "halted",
  "halted_at": "2026-08-19T00:00:00Z", "halt_reason": "maintenance" }
JSON
  run_app --commit
  expect_status 3
  expect_contains "refusing to place orders on a market that is not active"
  expect_no_writes
  finish
}

test_flatten_cancels_only_our_orders() {
  start "flatten"
  jq -s 'add' \
    <(resting ql-b-138600-1 69300 0.001) \
    <(jq -n '[{ id: "h1", market_id: "BTC-USDX-PERP", side: "buy",
                order_type: "Limit", price: "60000", quantity: "0.5",
                filled_qty: "0", status: "open", time_in_force: "Gtc",
                client_order_id: "handmade-1" }]') \
    >"$STUB_DIR/orders.json"
  run_app --flatten
  expect_status 0
  expect_file_contains "$STUB_DIR/cancels.log" "ql-b-138600-1"
  if ! grep -q handmade-1 "$STUB_DIR/cancels.log"; then pass "$CURRENT: left handmade-1 alone"
  else fail "$CURRENT: left handmade-1 alone" "$(cat "$STUB_DIR/cancels.log")"; fi
  # `order cancel --all` is the one command that would have taken out both.
  if ! grep -q -- '--all' "$STUB_DIR/calls.log"; then pass "$CURRENT: never used --all"
  else fail "$CURRENT: never used --all" "$(cat "$STUB_DIR/calls.log")"; fi
  finish
}

test_flatten_works_on_a_halted_market() {
  start "flatten while halted"
  # The case flatten exists for. Nothing that could refuse — the mark price, the
  # book, the tradable check — is allowed to run before the cancels.
  cat >"$STUB_DIR/market-status.json" <<'JSON'
{ "market_id": "BTC-USDX-PERP", "status": "halted",
  "halted_at": "2026-08-19T00:00:00Z", "halt_reason": "maintenance" }
JSON
  rm -f "$STUB_DIR/mark-price.json" "$STUB_DIR/orderbook.json"
  resting ql-b-138600-1 69300 0.001 >"$STUB_DIR/orders.json"
  run_app --flatten
  expect_status 0
  expect_contains "standing down"
  expect_file_contains "$STUB_DIR/cancels.log" "ql-b-138600-1"
  if ! grep -q -E '(^| )(mark-price|orderbook)' "$STUB_DIR/calls.log"; then
    pass "$CURRENT: read no price and no book"
  else
    fail "$CURRENT: read no price and no book" "$(cat "$STUB_DIR/calls.log")"
  fi
  finish
}

test_other_market_is_reported_not_cancelled() {
  start "owned order on another market"
  resting ql-b-999-10 3000 0.01 0 ETH-USDX-PERP >"$STUB_DIR/orders.json"
  run_app
  expect_status 0
  expect_contains "ql-b-999-10 on ETH-USDX-PERP"
  expect_contains "not touched by this run"
  expect_no_writes
  finish
}

test_lock_is_held_by_a_live_run() {
  start "lock held"
  mkdir -p "$LADDER_STATE_DIR/lock"
  printf '%s\n' "$$" >"$LADDER_STATE_DIR/lock/pid"      # this test's own pid: alive
  run_app --commit
  expect_status 75
  expect_contains "another run holds"
  expect_no_writes
  finish
}

test_stale_lock_is_cleared() {
  start "stale lock"
  mkdir -p "$LADDER_STATE_DIR/lock"
  # A pid that is certainly gone: start a process and reap it.
  ( exit 0 ) & local dead=$!
  wait "$dead" 2>/dev/null || true
  printf '%s\n' "$dead" >"$LADDER_STATE_DIR/lock/pid"
  run_app --commit
  expect_status 0
  expect_contains "clearing a stale lock"
  expect_contains "batch reported 3 placed"
  finish
}

test_lock_with_no_pid_yet_refuses() {
  start "lock with no pid recorded"
  mkdir -p "$LADDER_STATE_DIR/lock"                      # created, pid not written yet
  run_app --commit
  expect_status 75
  expect_contains "no pid recorded yet"
  expect_no_writes
  finish
}

test_lock_is_released() {
  start "lock released on exit"
  run_app --commit
  expect_status 0
  if [[ ! -d "$LADDER_STATE_DIR/lock" ]]; then pass "$CURRENT: lock directory is gone"
  else fail "$CURRENT: lock directory is gone" "it is still there"; fi
  finish
}

test_mainnet_is_refused() {
  start "mainnet"
  export LADDER_NETWORK=mainnet
  run_app --commit
  expect_status 2
  expect_contains "refusing to run against mainnet"
  expect_no_writes
  finish
}

test_mainnet_cannot_be_allowed() {
  start "mainnet via the allow-list"
  export LADDER_NETWORK=mainnet
  export LADDER_ALLOW_NETWORK=mainnet
  run_app --commit
  expect_status 2
  expect_no_writes
  finish
}

test_custom_network_needs_opting_in() {
  start "custom network"
  export LADDER_NETWORK=someplace
  run_app
  expect_status 2
  expect_contains "opt in explicitly with LADDER_ALLOW_NETWORK=someplace"
  export LADDER_ALLOW_NETWORK=someplace
  run_app
  expect_status 0
  finish
}

test_base_url_override_is_refused() {
  start "NEXUS_BASE_URL set"
  export NEXUS_BASE_URL=https://example.invalid/api/v1
  run_app --commit
  expect_status 2
  expect_contains "overrides --network"
  expect_no_writes
  unset NEXUS_BASE_URL
  finish
}

test_config_file_override_is_caught() {
  start "base_url in the CLI config file"
  # The CLI's own deprecation notice on stderr is the only evidence available.
  cat >"$STUB_DIR/fail-orders" <<'ERR'
warning: the config file's "base_url" is deprecated (ENG-10956). It redirects to "https://elsewhere.invalid", which declares neither what that host moves nor a credential namespace of its own.
Error: something else went wrong
ERR
  run_app
  expect_status 2
  expect_contains "base-URL override in effect"
  finish
}

test_unpinned_cli_is_refused() {
  start "wrong CLI version"
  printf 'nexus 0.9.9 (spec v9.9.9, nexus-exchange 9.9.9)\n' >"$STUB_DIR/version"
  run_app
  expect_status 2
  expect_contains "pinned to nexus 0.4.0"
  export LADDER_ALLOW_CLI_VERSION=1
  run_app
  expect_status 0
  expect_contains "continuing because LADDER_ALLOW_CLI_VERSION=1"
  finish
}

test_broken_credentials_are_not_read_only() {
  start "credentials that fail"
  printf 'Error: unauthorized [401]: signature mismatch\n' >"$STUB_DIR/fail-orders"
  run_app
  expect_status 2
  expect_contains "cannot tell an empty book from an unreadable one"
  finish
}

test_missing_credentials_plan_only() {
  start "no credentials"
  printf "Error: 'orders' is an authenticated command but no credentials are configured (run \`nexus setup\` or set NEXUS_API_KEY/NEXUS_API_SECRET)\n" \
    >"$STUB_DIR/fail-orders"
  run_app
  expect_status 0
  expect_contains "running read-only"
  run_app --commit
  expect_status 2
  expect_contains "no credentials are configured"
  expect_no_writes
  finish
}

test_unknown_market_is_refused() {
  start "market that is not listed"
  export LADDER_MARKET=DOGE-USDX-PERP
  run_app
  expect_status 3
  expect_contains "Available: BTC-USDX-PERP, ETH-USDX-PERP"
  finish
}

test_quantity_below_the_minimum_is_refused() {
  start "quantity under the lot size"
  export LADDER_QUANTITY=0.0001
  run_app
  expect_status 1
  expect_contains "snaps down to zero on this market's lot size"
  finish

  # A market whose lot size is finer than its minimum order size — the case where
  # a quantity can be a whole number of lots and still be too small to send.
  start "quantity under the market minimum"
  cat >"$STUB_DIR/markets.json" <<'JSON'
[ { "market_id": "BTC-USDX-PERP", "tick_size": "0.5", "lot_size": "0.001",
    "min_order_size": "0.01", "max_order_size": "100", "max_leverage": 50 } ]
JSON
  export LADDER_QUANTITY=0.002
  run_app
  expect_status 1
  expect_contains "below this market's minimum order size of 0.01"
  finish

  start "quantity over the market maximum"
  export LADDER_QUANTITY=200
  run_app
  expect_status 1
  expect_contains "above this market's maximum order size"
  expect_contains "rather than quietly shrinking"
  finish
}

test_bad_configuration_is_refused() {
  start "bad configuration"
  export LADDER_RUNGS=0
  run_app
  expect_status 1
  expect_contains "LADDER_RUNGS must be between 1 and 20"
  export LADDER_RUNGS=3
  export LADDER_TAG="ql;rm -rf /"
  run_app
  expect_status 1
  expect_contains "LADDER_TAG must be"
  finish
}

test_collapsed_rungs_are_reported() {
  start "rungs that collapse onto one tick"
  # A 1bps step on a 0.5 tick at 70000 moves the price by 7 — less than a step,
  # so rungs 2 and 3 land on ticks the first one already claimed.
  export LADDER_START_BPS=1
  export LADDER_STEP_BPS=0
  run_app
  expect_status 0
  expect_contains "collapsed onto an earlier rung"
  expect_contains "1 to place"
  finish
}

test_both_sides() {
  start "two-sided ladder"
  export LADDER_SIDES=both
  export LADDER_RUNGS=2
  run_app
  expect_status 0
  expect_contains "place    buy   69300"
  expect_contains "place    sell  70700"
  expect_contains "4 to place"
  finish
}

# ── the .env parser, directly ───────────────────────────────────────────────

# `load_dotenv` is the one function here that reads attacker-shaped input — the
# file whose whole purpose is to hold a credential — so it is exercised on its
# own rather than through a run. Called in a subshell so the exports it makes
# cannot leak into the next test.
test_dotenv() {
  CURRENT="dotenv"
  local dir env_file canary got
  dir=$(mktemp -d "${TMPDIR:-/tmp}/quote-ladder-dotenv.XXXXXX")
  env_file="$dir/.env"
  canary="$dir/executed"

  # Note what is in here: two shell expansions that would run if this file were
  # sourced, and both must survive as literal text instead.
  # shellcheck disable=SC2016  # the unexpanded $(...) and backticks are the point
  {
    printf '# a comment\n'
    printf '\n'
    printf 'PLAIN=1\n'
    printf 'export EXPORTED=2\n'
    printf '  INDENTED=3\n'
    printf 'DQUOTED="a value"\n'
    printf 'SQUOTED=%s\n' "'other value'"
    printf 'EMPTY=\n'
    printf 'SUBST=$(touch %s)\n' "$canary"
    printf 'BACKTICK=`touch %s`\n' "$canary"
    printf 'ALREADY_SET=from-file\n'
    printf 'this line is not KEY=VALUE\n'
    printf 'CRLF=ok\r\n'
  } >"$env_file"

  got=$(
    set -uo pipefail
    source "$APP_DIR/lib/common.sh"
    source "$APP_DIR/lib/preflight.sh"
    export ALREADY_SET=from-environment
    load_dotenv "$env_file" 2>"$dir/warnings"
    printf 'PLAIN=%s\n' "${PLAIN-unset}"
    printf 'EXPORTED=%s\n' "${EXPORTED-unset}"
    printf 'INDENTED=%s\n' "${INDENTED-unset}"
    printf 'DQUOTED=%s\n' "${DQUOTED-unset}"
    printf 'SQUOTED=%s\n' "${SQUOTED-unset}"
    printf 'EMPTY=[%s]\n' "${EMPTY-unset}"
    printf 'SUBST=%s\n' "${SUBST-unset}"
    printf 'BACKTICK=%s\n' "${BACKTICK-unset}"
    printf 'ALREADY_SET=%s\n' "${ALREADY_SET-unset}"
    printf 'CRLF=[%s]\n' "${CRLF-unset}"
  )
  OUT="$got"$'\n'"$(cat "$dir/warnings")"
  STATUS=0

  expect_contains 'PLAIN=1'
  expect_contains 'EXPORTED=2'
  expect_contains 'INDENTED=3'
  expect_contains 'DQUOTED=a value'
  expect_contains 'SQUOTED=other value'
  expect_contains 'EMPTY=[]'
  expect_contains 'ALREADY_SET=from-environment'   # the environment wins over the file
  expect_contains 'CRLF=[ok]'                      # no stray carriage return

  # The whole point: the file is data, not code.
  # shellcheck disable=SC2016  # asserting the literal text survived unexpanded
  expect_contains 'SUBST=$(touch'
  expect_contains 'BACKTICK=`touch'
  if [[ ! -e $canary ]]; then pass "$CURRENT: nothing in the file was executed"
  else fail "$CURRENT: nothing in the file was executed" "$canary exists"; fi

  # An unparsable line is reported by number, never by content — a mangled line
  # in this file is as likely as not to be a mangled secret.
  expect_contains "line 12 is not KEY=VALUE"
  expect_missing "this line is not"

  # A missing file is not an error: credentials may come from the environment.
  if ( set -euo pipefail
       source "$APP_DIR/lib/common.sh"
       source "$APP_DIR/lib/preflight.sh"
       load_dotenv "$dir/nonexistent" ) 2>/dev/null; then
    pass "$CURRENT: a missing .env is not an error"
  else
    fail "$CURRENT: a missing .env is not an error" "load_dotenv returned non-zero"
  fi

  rm -rf -- "$dir"
}

# ── decimal arithmetic, directly ────────────────────────────────────────────

dec() { ( set -euo pipefail; source "$APP_DIR/lib/common.sh"; source "$APP_DIR/lib/decimal.sh"; "$@" ); }

check_dec() {
  local want=$1 got; shift
  got=$(dec "$@" 2>&1) || got="ERROR: $got"
  if [[ $got == "$want" ]]; then pass "decimal: $* = $want"
  else fail "decimal: $*" "wanted $(printf '%q' "$want"), got $(printf '%q' "$got")"; fi
}

check_dec_fails() {
  local label=$1; shift
  if dec "$@" >/dev/null 2>&1; then fail "decimal: $label" "expected a refusal, got success"
  else pass "decimal: $label is refused"; fi
}

test_decimal() {
  CURRENT="decimal"
  check_dec "0.1"        dec_norm "0.10"
  check_dec "0"          dec_norm "-0.000"
  check_dec "69694.1125" dec_norm "69694.11250"
  check_dec "0"          dec_cmp "0.10" "0.1000"
  check_dec "1"          dec_cmp "0.2" "0.1"
  check_dec "-1"         dec_cmp "-3" "-2"
  check_dec "696.227"    dec_bps "69622.725" 100
  check_dec "700"        dec_bps "70000" 100
  check_dec "0"          dec_bps "0.001" 100          # floors, never rounds up
  check_dec "68926"      dec_snap "68926.498" "0.5" down
  check_dec "68926.5"    dec_snap "68926.498" "0.5" up
  check_dec "68926.5"    dec_snap "68926.5" "0.5" up  # already on the grid
  check_dec "-3"         dec_snap "-2.5" "1" down     # floors below zero, not toward it
  check_dec "137852"     dec_units "68926" "0.5"
  check_dec "0.99"       dec_sub "1" "0.01"
  check_dec "1.01"       dec_add "1" "0.01"
  # The refusals matter as much as the answers.
  check_dec_fails "exponent notation" dec_parse "1e-8"
  check_dec_fails "a non-number"      dec_parse "69,000"
  check_dec_fails "a bare leading dot" dec_parse ".5"
  check_dec_fails "an empty string"   dec_parse ""
  check_dec_fails "a value wider than 64 bits" dec_parse "1234567890123456789012"
  check_dec_fails "an off-grid tick count"     dec_units "68926.3" "0.5"
  check_dec_fails "a zero grid"                dec_snap "1" "0" down
  check_dec_fails "bps over 100%"              dec_bps "1" 10001
}

# ── main ────────────────────────────────────────────────────────────────────

main() {
  command -v jq >/dev/null || { printf 'jq is required to run these tests\n' >&2; exit 1; }
  if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
    printf 'bash 4.4+ is required to run these tests (this is %s)\n' "$BASH_VERSION" >&2
    exit 1
  fi

  local t
  for t in $(declare -F | awk '{print $3}' | grep '^test_' | sort); do
    printf '\n%s\n' "${t#test_}"
    "$t"
  done

  printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
  (( FAILED == 0 ))
}

main "$@"
