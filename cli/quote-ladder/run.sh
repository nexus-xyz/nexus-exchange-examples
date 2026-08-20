#!/usr/bin/env bash
#
# quote-ladder — keep a ladder of resting orders on one market, using nothing but
# the `nexus` CLI, `jq`, and bash.
#
# The model, which is the whole point of the example:
#
#   desired set  — the rungs the configuration says should be resting right now,
#                  computed from the market's mark price and trading rules
#   actual set   — the rungs actually resting, read back from the venue
#   plan         — the cancels and placements that turn the second into the first
#
# Everything else follows from that. Run it twice with a still market and the
# second run does nothing. Kill it halfway through and the next run finishes the
# job. Point it at a market that halted and it places nothing and says why. None
# of that is available to a script that places three orders and exits — which is
# what makes this shaped like a reconciler rather than a sequence of steps.
#
#   ./run.sh              plan only: print the diff, change nothing (the default)
#   ./run.sh --commit     apply the plan
#   ./run.sh --flatten    cancel every order this app owns, place nothing
#
# Testnet only, play funds. See README.md.

set -euo pipefail

# ── bash version ────────────────────────────────────────────────────────────
# Before anything else, and before sourcing a single file: this app uses
# associative arrays (bash 4.0) and relies on `set -u` tolerating an empty array
# expansion (bash 4.4). macOS still ships bash 3.2, where the failure is a parse
# error inside a sourced file — an error about a file the reader did not write,
# which is a bad way to learn you need a newer bash.
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  printf 'error: bash 4.4 or newer is required (this is %s).\n' "${BASH_VERSION:-unknown}" >&2
  printf '       macOS ships bash 3.2 — install a newer one (brew install bash) and re-run.\n' >&2
  exit 1
fi

# Resolve the example's own directory, so the app can be run from anywhere —
# including out of a crontab, where the working directory is not what you think.
SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/decimal.sh
source "$SCRIPT_DIR/lib/decimal.sh"
# shellcheck source=lib/preflight.sh
source "$SCRIPT_DIR/lib/preflight.sh"
# shellcheck source=lib/nexus.sh
source "$SCRIPT_DIR/lib/nexus.sh"
# shellcheck source=lib/lock.sh
source "$SCRIPT_DIR/lib/lock.sh"
# shellcheck source=lib/ladder.sh
source "$SCRIPT_DIR/lib/ladder.sh"

MODE=plan
EXIT_CODE=$EX_OK
TMP_DIR=""

usage() {
  cat <<'USAGE'
quote-ladder — keep a ladder of resting orders on one market, via the nexus CLI.

usage: ./run.sh [--commit | --flatten | --plan] [--help]

  --plan       print the diff between the desired ladder and what is resting,
               and change nothing. The default.
  --commit     apply that diff: cancel what is off-ladder, place what is
               missing.
  --flatten    cancel every order this app owns (by client-order-id tag) and
               place nothing. The way to stand down.
  --help       this text.

Configuration is environment-only; see .env.example and README.md.
USAGE
}

parse_args() {
  while (( $# )); do
    case $1 in
      --plan) MODE=plan ;;
      --commit) MODE=commit ;;
      --flatten) MODE=flatten ;;
      -h|--help) usage; exit "$EX_OK" ;;
      *) usage >&2; die "$EX_USAGE" "unknown argument $(quoted "$1")" ;;
    esac
    shift
  done
}

# One trap, every exit path: a clean finish, a `die`, an uncaught failure under
# `set -e`, Ctrl-C, or a SIGTERM from whatever supervisor is running this. The
# lock is the thing that must not survive the process, so releasing it cannot be
# left to the happy path.
# shellcheck disable=SC2317  # reached via `trap`, which shellcheck does not follow
cleanup() {
  local code=$?
  # Disarmed first: on SIGINT this trap calls `exit`, which would otherwise fire
  # the EXIT trap and run the whole thing a second time.
  trap - EXIT INT TERM
  lock_release
  [[ -n $TMP_DIR && -d $TMP_DIR ]] && rm -rf -- "$TMP_DIR"
  exit "$code"
}

# ── report ──────────────────────────────────────────────────────────────────

hr() { printf -- '─%.0s' {1..78}; printf '\n'; }

report_header() {
  printf 'quote-ladder  %s  (%s)\n' "$LADDER_MARKET" "$LADDER_NETWORK"
  hr
  printf '%-12s%s\n' "cli" "$CLI_VERSION_LINE"
  local auth_note="no — read-only, public market data only"
  (( AUTHENTICATED )) && auth_note="yes (open orders and account state are readable)"
  printf '%-12s%s\n' "auth" "$auth_note"
  printf '%-12stick %s   lot %s   min %s   max %s\n' \
    "rules" "$MARKET_TICK" "$MARKET_LOT" "$MARKET_MIN" "$MARKET_MAX"
  printf '%-12s%s   status %s\n' "market" "$LADDER_MARKET" "$MARKET_STATUS"
  printf '%-12smark %s   best bid %s   best ask %s\n' \
    "price" "$MARK_PRICE" "${BEST_BID:-—}" "${BEST_ASK:-—}"
  printf '%-12s%s × %s, from %sbps, %sbps apart, %s per rung, post-only\n' \
    "ladder" "$LADDER_SIDES" "$LADDER_RUNGS" "$LADDER_START_BPS" "$LADDER_STEP_BPS" "$LADDER_RUNG_QTY"
  printf '%-12s%s-*\n' "owns" "$LADDER_TAG"
  hr
}

# One row per action, in the order the actions will be taken.
report_plan() {
  printf '%-9s%-6s%-16s%-12s%s\n' "ACTION" "SIDE" "PRICE" "QTY" "CLIENT ORDER ID"
  local cid
  for cid in "${PLAN_CANCEL[@]}"; do
    printf '%-9s%-6s%-16s%-12s%s\n' cancel "${ACTUAL_SIDE[$cid]}" \
      "${ACTUAL_PRICE[$cid]:-?}" "${ACTUAL_QTY[$cid]}" "$cid"
  done
  for cid in "${PLAN_PLACE[@]}"; do
    printf '%-9s%-6s%-16s%-12s%s\n' place "${DESIRED_SIDE[$cid]}" \
      "${DESIRED_PRICE[$cid]}" "${DESIRED_QTY[$cid]}" "$cid"
  done
  for cid in "${PLAN_KEEP[@]}"; do
    printf '%-9s%-6s%-16s%-12s%s\n' keep "${DESIRED_SIDE[$cid]}" \
      "${DESIRED_PRICE[$cid]}" "${DESIRED_QTY[$cid]}" "$cid"
  done

  printf '\n%d to cancel, %d to place, %d already correct.\n' \
    "${#PLAN_CANCEL[@]}" "${#PLAN_PLACE[@]}" "${#PLAN_KEEP[@]}"

  if (( ${#FOREIGN_OWNED[@]} )); then
    printf '\nowned, but on another market — not touched by this run:\n'
    printf '  %s\n' "${FOREIGN_OWNED[@]}"
    printf '  (set LADDER_MARKET to that market and run --flatten to clear them)\n'
  fi

  if (( ${#PLAN_NOTES[@]} )); then
    printf '\nnotes:\n'
    printf '  · %s\n' "${PLAN_NOTES[@]}"
  fi
}

# The account, read back after the fact.
#
# `account state` rather than `account summary` plus `positions`: those are two
# requests, and a fill landing between them returns an aggregate that disagrees
# with the position list it is printed next to. One request cannot disagree with
# itself.
report_account() {
  (( AUTHENTICATED )) || return 0

  if nx account state; then
    printf '\naccount\n'
    printf '%s' "$NX_OUT" | jq -r '
      .summary as $s
      | "  equity           \($s.total_equity // "not reported")",
        "  available margin \($s.available_margin // "not reported")",
        "  unrealized pnl   \($s.total_unrealized_pnl // "not reported")",
        "  open orders      \($s.open_orders_count // "not reported")",
        "  open positions   \($s.open_positions_count // "not reported")"'
    printf '%s' "$NX_OUT" | jq -r '
      if (.positions | length) == 0 then "  positions        none"
      else (.positions[] | "  position         \(.market_id) \(.side) \(.size) @ \(.entry_price), unrealized \(.unrealized_pnl)")
      end'
  else
    warn "could not read account state: ${NX_ERR%%$'\n'*}"
  fi

  # Recent fills, because a ladder that is quietly being filled is the one thing
  # a plan-versus-actual diff cannot show you: a fully filled rung is simply
  # absent from the book, which looks exactly like a rung that was never placed.
  if nx fills --limit 5; then
    printf '\nrecent fills (last 5 on the account)\n'
    printf '%s' "$NX_OUT" | jq -r '
      if length == 0 then "  none"
      else (.[] | "  \(.market_id) \(.side) \(.size) @ \(.price)  fee \(.fee)  \(.taker_or_maker // "?")")
      end' 2>/dev/null || printf '  (unrecognised fills payload; skipped)\n'
  fi
}

# ── execution ───────────────────────────────────────────────────────────────

# Cancel by client order id, one at a time.
#
# Not `order cancel --all`, which would take out every resting order on the
# account including ones a human placed by hand, and not `order cancel --market`,
# which does the same thing one market at a time. This app cancels orders it can
# name, and nothing else.
#
# One request per order rather than `order cancel-batch`, which does exist and
# would be one round trip: the batch endpoint's body is not pinned by the spec, so
# a partial failure inside it cannot be reported per-order. Twenty sequential
# cancels with an individually readable outcome is the better trade for a tool
# whose output is meant to be read out of a log after the fact.
do_cancels() {
  local cid failures=0
  for cid in "${PLAN_CANCEL[@]}"; do
    if nx_write_once "cancel $cid" order cancel-by-client-id "$cid" --yes; then
      info "cancelled $cid"
    else
      failures=$(( failures + 1 ))
      error "cancel $cid failed: ${NX_ERR%%$'\n'*}"
    fi
  done
  (( failures == 0 )) || EXIT_CODE=$EX_PARTIAL
}

# Place every missing rung in one `order batch`.
#
# The batch is built by `jq`, never by string concatenation: every value in it —
# a market id, a client order id, a price — is escaped by a JSON encoder rather
# than by hoping it contains no quotes.
#
# Two things about this endpoint that are easy to get wrong:
#
#  · **`"tif": "postonly"`, not `"post-only"`.** The command-line flag really is
#    `--tif post-only`, and the same value inside a batch file has to be spelled
#    `postonly`. Two different serialisers, one for clap and one for serde, and
#    only the flag gets the dash. The batch file is also the only placement path
#    that carries `client_order_id`, so this app cannot avoid the batch and take
#    the flag's spelling instead.
#
#  · **The batch is not atomic.** Each entry independently reports `outcome:
#    "ok"` or `outcome: "err"`, so a zero exit status means "the request was
#    processed", not "every order was placed". The outcomes are what this reads.
do_places() {
  local rows=() cid payload
  for cid in "${PLAN_PLACE[@]}"; do
    rows+=("$(printf '%s\t%s\t%s\t%s\t%s' \
      "$LADDER_MARKET" "${DESIRED_SIDE[$cid]}" "${DESIRED_PRICE[$cid]}" \
      "${DESIRED_QTY[$cid]}" "$cid")")
  done
  (( ${#rows[@]} )) || return 0

  payload=$(printf '%s\n' "${rows[@]}" | jq -R -s '
    split("\n") | map(select(length > 0) | split("\t"))
    | map({ market: .[0], side: .[1], type: "limit",
            price: .[2], quantity: .[3], tif: "postonly",
            client_order_id: .[4] })')

  info "placing ${#rows[@]} rung(s) in one batch"
  if ! nx_write_once "place ${#rows[@]} rung(s)" order batch - --yes <<<"$payload"; then
    # The request did not come back cleanly, so whether the orders exist is
    # unknown — and that is precisely the case a retry must not be used for. The
    # read-back below reports what is actually resting; the next run reconciles
    # whatever this one left behind.
    error "the placement batch did not report back: ${NX_ERR%%$'\n'*}"
    EXIT_CODE=$EX_PARTIAL
    return 0
  fi

  local placed rejected
  placed=$(printf '%s' "$NX_OUT" | jq '[.[] | select(.outcome == "ok")] | length')
  rejected=$(printf '%s' "$NX_OUT" | jq '[.[] | select(.outcome != "ok")] | length')
  info "batch reported $placed placed, $rejected rejected"
  if (( rejected > 0 )); then
    printf '%s' "$NX_OUT" | jq -r '.[] | select(.outcome != "ok")
      | "  rejected: \(.error // "?") — \(.message // "no message")"' >&2
    EXIT_CODE=$EX_PARTIAL
  fi
}

# What is actually resting now, after the writes.
#
# A read, not an assumption. `nx_write_once` may have failed with the order
# already placed, so this is the only honest source for the final state. It is
# reported and never used to fail the run: a rung placed a moment ago may not be
# visible yet, and "the venue has not caught up" is not the same thing as "the
# write did not land".
report_settled() {
  (( AUTHENTICATED )) || return 0
  if ! nx orders; then
    warn "could not read orders back: ${NX_ERR%%$'\n'*}"
    return 0
  fi
  OPEN_ORDERS_JSON=$NX_OUT
  load_actual
  build_plan
  printf '\nresting now: %d rung(s) owned by %s-* on %s\n' \
    "${#ACTUAL_IDS[@]}" "$LADDER_TAG" "$LADDER_MARKET"
  if ! plan_is_empty; then
    printf 'still %d cancel / %d place away from the target ladder — the next run reconciles it.\n' \
      "${#PLAN_CANCEL[@]}" "${#PLAN_PLACE[@]}"
  fi
}

# ── main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  load_dotenv "$SCRIPT_DIR/.env"
  resolve_config
  check_network
  check_cli_version

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/quote-ladder.XXXXXX")
  trap cleanup EXIT INT TERM
  nx_init "$TMP_DIR/stderr"

  check_auth

  if [[ $MODE != plan ]] && (( ! AUTHENTICATED )); then
    die "$EX_CONFIG" "--$MODE writes to the venue and no credentials are configured. Copy .env.example to .env and add a testnet key pair, or run without --$MODE to plan only."
  fi

  load_market_rules
  resolve_quantity
  load_mark_price
  load_top_of_book

  local tradable=1
  check_market_tradable || tradable=0

  if [[ $MODE == flatten ]]; then
    # Standing down does not need a tradable market, a mark price, or a ladder:
    # cancelling is allowed while a market is halted, and it is exactly when you
    # are most likely to want it.
    DESIRED_IDS=()
    DESIRED_SIDE=()
    DESIRED_PRICE=()
    DESIRED_QTY=()
  else
    build_desired
  fi

  load_actual
  build_plan

  report_header
  report_plan

  if [[ $MODE == plan ]]; then
    printf '\nplan only — nothing was sent. Re-run with --commit to apply it.\n'
    report_account
    exit "$EXIT_CODE"
  fi

  if (( ! tradable )) && (( ${#PLAN_PLACE[@]} > 0 )); then
    error "market status is $(quoted "$MARKET_STATUS")${MARKET_HALT_REASON:+ ($MARKET_HALT_REASON)}"
    die "$EX_MARKET" "refusing to place orders on a market that is not active. Cancels are still allowed: re-run with --flatten."
  fi

  if plan_is_empty; then
    printf '\nnothing to do.\n'
    report_account
    exit "$EXIT_CODE"
  fi

  # The lock is taken here and nowhere earlier: reads do not conflict, so a plan
  # run never blocks a committing one, and the window in which two runs could
  # both be writing is as short as the writes themselves.
  lock_acquire "$LADDER_STATE_DIR/lock"

  # Cancels before placements — margin is freed before it is consumed. A ladder
  # being moved wholesale would otherwise need the collateral for both the old
  # rungs and the new ones at the same moment, and would half-fail on an account
  # sized for one ladder.
  do_cancels
  do_places

  report_settled
  report_account
  exit "$EXIT_CODE"
}

main "$@"
