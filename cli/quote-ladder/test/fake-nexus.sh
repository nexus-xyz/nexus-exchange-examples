#!/usr/bin/env bash
# shellcheck shell=bash
#
# A stand-in for the `nexus` binary, so the reconciler's write path can be tested
# without an account and without touching a venue.
#
# It is symlinked into a temp directory as `nexus`, that directory goes on PATH,
# and it answers from files the test wrote first — `$STUB_DIR/orders.json` and
# friends. Every invocation is appended to `$STUB_DIR/calls.log`, which is how the
# tests assert on what the app *did not* do: "no order command was issued" is the
# most important assertion in the suite and it cannot be made from stdout.

set -euo pipefail
: "${STUB_DIR:?fake-nexus needs STUB_DIR}"

printf '%s\n' "$*" >>"$STUB_DIR/calls.log"

# Strip the global flags, keeping the positional command path. The flags with
# values have to be consumed in pairs, or `--market BTC-USDX-PERP` would leave
# the market id looking like a subcommand.
args=()
while (( $# )); do
  case $1 in
    --version)
      cat "$STUB_DIR/version" 2>/dev/null || printf 'nexus 0.4.0 (spec v0.8.1, nexus-exchange 0.9.1)\n'
      exit 0
      ;;
    --network|--output|--market|--quantity|--price|--limit|--side|--type|--tif|--api-key|--api-secret|--base-url)
      shift 2
      ;;
    --yes|--all|--reduce-only)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

# `nexus markets` and `nexus mark-price BTC-USDX-PERP` are both one command; only
# the grouped ones (`order batch`, `account state`) take a second word. Joining
# args blindly would turn every market id into part of the command name.
command_path="${args[0]:-}"
case $command_path in
  order|account|market|keys|agents|transfers|sub-accounts|auth)
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

emit() {
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
  markets)       emit markets.json ;;
  market-status) emit market-status.json ;;
  mark-price)    emit mark-price.json ;;
  orderbook)     emit orderbook.json ;;
  orders)        emit orders.json '[]' ;;
  fills)         emit fills.json '[]' ;;
  "account state") emit account-state.json ;;

  "order batch")
    # The payload matters more than the reply: the tests assert on the JSON this
    # app built, including the `postonly` spelling and the client order ids.
    cat >"$STUB_DIR/batch-payload.json"
    if [[ -f "$STUB_DIR/batch-response.json" ]]; then
      cat "$STUB_DIR/batch-response.json"
    else
      jq 'map({ outcome: "ok",
                order: { id: ("srv-" + .client_order_id),
                         client_order_id: .client_order_id,
                         market_id: .market, side: .side,
                         price: .price, quantity: .quantity,
                         filled_qty: "0", status: "open",
                         time_in_force: "PostOnly" },
                fills: [] })' <"$STUB_DIR/batch-payload.json"
    fi
    ;;

  "order cancel-by-client-id")
    printf '%s\n' "${args[2]}" >>"$STUB_DIR/cancels.log"
    printf '{"cancelled":"%s"}\n' "${args[2]}"
    ;;

  *)
    # Deliberately including `order amend`: this app must never reach for it (see
    # `rung_client_id`), so an unimplemented stub turns a regression into a loud
    # failure rather than a passing test.
    printf 'Error: fake-nexus does not implement %s\n' "$command_path" >&2
    exit 1
    ;;
esac
