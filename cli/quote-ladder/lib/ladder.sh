# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# The ladder itself: what should be resting, what is resting, and the difference.
#
# The shape of this file is the whole idea of the app. It does not "place a
# ladder" — it computes a **desired set** of resting orders, reads the **actual**
# set from the venue, and emits the smallest set of actions that moves one to the
# other. That is what makes it safe to run on a timer: run it twice with nothing
# moving and the second run does nothing at all, which is a property a script
# that just places three orders can never have.
#
# The hinge is the client order id. Every rung's id is derived from what the rung
# *is* — tag, side, and price in whole ticks — so two runs that compute the same
# rung compute the same id, and matching is an exact string comparison instead of
# a guess about which of six open orders was "probably mine".

# Trading rules for LADDER_MARKET, from `nexus markets`.
MARKET_TICK=""
MARKET_LOT=""
MARKET_MIN=""
MARKET_MAX=""

# The desired set, in the order it should be reported.
DESIRED_IDS=()
declare -A DESIRED_SIDE=()
declare -A DESIRED_PRICE=()
declare -A DESIRED_QTY=()

# The actual set, restricted to orders this app owns in this market.
ACTUAL_IDS=()
declare -A ACTUAL_ORDER_ID=()
declare -A ACTUAL_SIDE=()
declare -A ACTUAL_PRICE=()
declare -A ACTUAL_QTY=()
declare -A ACTUAL_FILLED=()
declare -A ACTUAL_STATUS=()

# The plan. Each entry is a client order id; NOTES are free text for the report.
PLAN_KEEP=()
PLAN_CANCEL=()
PLAN_PLACE=()
PLAN_NOTES=()

# Orders this app owns in some *other* market — reported, never touched.
FOREIGN_OWNED=()

# ─────────────────────────── market rules ───────────────────────────

# Read the trading rules for LADDER_MARKET.
#
# `nexus markets` returns every market, and the market this app was pointed at
# may simply not exist — a typo, or a market that was delisted since the README
# was written. That is a refusal with the available ids listed, not a null
# propagating into a price calculation.
load_market_rules() {
  nx_read "reading market rules" markets
  # `first(f)`, not `first`: `first` on an empty array is `null`, and jq indexes
  # `null` happily — `null.tick_size` is `null`, not an error — so the obvious
  # spelling of this query returns a row of empty strings for a market that does
  # not exist, and `jq -e` calls it a success because a tab-separated line of
  # nothing is still a truthy string. `first(f)` emits nothing at all instead,
  # which is a case the shell can actually see.
  local rules
  # shellcheck disable=SC2016  # $m below is a jq variable, bound by --arg
  rules=$(printf '%s' "$NX_OUT" | jq -r --arg m "$LADDER_MARKET" '
        first(.[] | select(.market_id == $m))
        | [.tick_size, .lot_size, .min_order_size, .max_order_size] | @tsv' 2>/dev/null) || rules=""
  if [[ -z $rules ]]; then
    local available
    available=$(printf '%s' "$NX_OUT" | jq -r 'map(.market_id) | join(", ")' 2>/dev/null || printf '?')
    die "$EX_MARKET" "market $(quoted "$LADDER_MARKET") is not listed on $LADDER_NETWORK. Available: $available"
  fi
  IFS=$'\t' read -r MARKET_TICK MARKET_LOT MARKET_MIN MARKET_MAX <<<"$rules"

  # Every one of these is used as a divisor or a bound below, so each is parsed
  # (and thereby validated) before anything is computed from it.
  dec_parse "$MARKET_TICK" "tick_size" >/dev/null
  dec_parse "$MARKET_LOT" "lot_size" >/dev/null
  dec_parse "$MARKET_MIN" "min_order_size" >/dev/null
  dec_parse "$MARKET_MAX" "max_order_size" >/dev/null
  dec_gt "$MARKET_TICK" 0 || die "$EX_MARKET" "market reports a non-positive tick size: $(quoted "$MARKET_TICK")"
  dec_gt "$MARKET_LOT" 0 || die "$EX_MARKET" "market reports a non-positive lot size: $(quoted "$MARKET_LOT")"
}

# Read the market's lifecycle state. True when it can be quoted.
#
# Checked rather than inferred from a failed order: an order rejected by a halted
# market is indistinguishable, at the call site, from an order rejected for being
# priced wrong. `halted_at` is consulted as well as `status`, because those are
# two independent fields and either one being set is enough to stay out.
MARKET_STATUS=""
MARKET_HALT_REASON=""
check_market_tradable() {
  nx_read "reading market status" market-status "$LADDER_MARKET"
  MARKET_STATUS=$(printf '%s' "$NX_OUT" | jq -r '.status // "unknown"')
  local halted_at
  halted_at=$(printf '%s' "$NX_OUT" | jq -r '.halted_at // ""')
  MARKET_HALT_REASON=$(printf '%s' "$NX_OUT" | jq -r '.halt_reason // ""')

  if [[ -n $halted_at ]]; then
    MARKET_STATUS="$MARKET_STATUS (halted at $halted_at)"
    return 1
  fi
  [[ $MARKET_STATUS == active ]]
}

# The price everything is quoted around.
#
# The mark price, deliberately, and not the mid. The mid needs both sides of the
# book, and this venue's testnet routinely has none on one side — at the time of
# writing `asks` comes back empty — so a mid-based ladder would be unquotable
# exactly when it is most needed. The mark is a single published number that is
# always there.
MARK_PRICE=""
load_mark_price() {
  nx_read "reading mark price" mark-price "$LADDER_MARKET"
  MARK_PRICE=$(printf '%s' "$NX_OUT" | nx_jq '.mark_price')
  dec_parse "$MARK_PRICE" "mark_price" >/dev/null
  dec_gt "$MARK_PRICE" 0 ||
    die "$EX_MARKET" "the venue reports a non-positive mark price for $LADDER_MARKET: $(quoted "$MARK_PRICE")"
}

# Top of book, used only to keep a rung from being priced through it.
#
# Either side can legitimately be absent, and absent is not zero: an empty ask
# side means nothing to cross, not "the ask is 0".
load_top_of_book() {
  BEST_BID=""
  BEST_ASK=""
  nx_read "reading the order book" orderbook "$LADDER_MARKET"
  BEST_BID=$(printf '%s' "$NX_OUT" | jq -r '.bids[0][0] // ""')
  BEST_ASK=$(printf '%s' "$NX_OUT" | jq -r '.asks[0][0] // ""')
  [[ -z $BEST_BID ]] || dec_parse "$BEST_BID" "best bid" >/dev/null
  [[ -z $BEST_ASK ]] || dec_parse "$BEST_ASK" "best ask" >/dev/null
}

# ─────────────────────────── the desired set ───────────────────────────

# The quantity every rung carries: the configured size snapped down onto the lot
# grid, or the market's own minimum when nothing is configured.
resolve_quantity() {
  local want=${LADDER_QUANTITY:-$MARKET_MIN}
  LADDER_RUNG_QTY=$(dec_snap "$want" "$MARKET_LOT" down)

  dec_gt "$LADDER_RUNG_QTY" 0 ||
    die "$EX_USAGE" "LADDER_QUANTITY=$(quoted "$want") snaps down to zero on this market's lot size of $MARKET_LOT"
  dec_lt "$LADDER_RUNG_QTY" "$MARKET_MIN" &&
    die "$EX_USAGE" "LADDER_QUANTITY=$(quoted "$want") snaps down to $LADDER_RUNG_QTY, below this market's minimum order size of $MARKET_MIN"
  dec_gt "$LADDER_RUNG_QTY" "$MARKET_MAX" &&
    die "$EX_USAGE" "LADDER_QUANTITY=$(quoted "$want") is above this market's maximum order size of $MARKET_MAX. Refusing rather than quietly shrinking the order."
  return 0
}

# The client order id for a rung: `<tag>-<b|s>-<price in ticks>-<size in lots>`.
#
# Derived, not generated, and it names the rung's *whole* intent. Both halves of
# that matter:
#
# **Derived.** A random or timestamped id would be unique — and would make every
# run see the previous run's orders as strangers, cancel all of them, and place
# the same ladder again under new ids. Churn every cycle, fees every cycle, and a
# window with nothing resting at all.
#
# **Whole intent.** Because side, price *and* size are all in the id, "the same
# rung" and "the same id" are the same statement. A rung whose size changed is a
# different id, so it is cancelled and replaced rather than modified — which is
# what lets this app avoid `order amend` entirely. Amend is an atomic
# cancel-replace at the venue, and the spec does not say whether the replacement
# inherits the client order id; since every match in this app is by that id, a
# rung that came back without one would be an orphan this app could neither
# recognise nor clean up. The cost of not amending is that a resized rung leaves
# the book for the moment between the cancel and the placement, which for an
# order resting 1% away from the mark is not a cost at all.
#
# The numbers go in as whole ticks and whole lots so the id stays `[a-z0-9-]`: it
# is echoed back by the venue, written into log lines, and passed as a CLI
# argument, and the fewer characters it can contain, the fewer of those places
# have to think about it.
rung_client_id() {
  local side=$1 price=$2 quantity=$3 letter
  case $side in
    buy) letter=b ;;
    sell) letter=s ;;
    *) die "$EX_USAGE" "unknown side $(quoted "$side")" ;;
  esac
  printf '%s-%s-%s-%s' "$LADDER_TAG" "$letter" \
    "$(dec_units "$price" "$MARKET_TICK")" "$(dec_units "$quantity" "$MARKET_LOT")"
}

# Compute the desired set from the mark price and the configuration.
build_desired() {
  DESIRED_IDS=()
  DESIRED_SIDE=()
  DESIRED_PRICE=()
  DESIRED_QTY=()

  local sides=()
  case $LADDER_SIDES in
    buy) sides=(buy) ;;
    sell) sides=(sell) ;;
    both) sides=(buy sell) ;;
  esac

  local side rung offset delta raw price cid
  for side in "${sides[@]}"; do
    for (( rung = 1; rung <= LADDER_RUNGS; rung++ )); do
      offset=$(( LADDER_START_BPS + (rung - 1) * LADDER_STEP_BPS ))
      if (( offset > 10000 )); then
        PLAN_NOTES+=("$side rung $rung skipped: offset ${offset}bps is more than 100% from the mark")
        continue
      fi
      delta=$(dec_bps "$MARK_PRICE" "$offset")

      if [[ $side == buy ]]; then
        raw=$(dec_sub "$MARK_PRICE" "$delta")
        price=$(dec_snap "$raw" "$MARKET_TICK" down)
      else
        raw=$(dec_add "$MARK_PRICE" "$delta")
        price=$(dec_snap "$raw" "$MARKET_TICK" up)
      fi

      if ! dec_gt "$price" 0; then
        PLAN_NOTES+=("$side rung $rung skipped: ${offset}bps from the mark snaps to $price, which is not a price")
        continue
      fi

      # Post-only would have the venue reject a crossing rung anyway. Dropping it
      # here instead turns a rejection with a terse code into a line that says
      # which rung, which side, and what it would have crossed.
      if [[ $side == buy && -n $BEST_ASK ]] && ! dec_lt "$price" "$BEST_ASK"; then
        PLAN_NOTES+=("buy rung $rung skipped: $price is at or above the best ask $BEST_ASK, so it would cross")
        continue
      fi
      if [[ $side == sell && -n $BEST_BID ]] && ! dec_gt "$price" "$BEST_BID"; then
        PLAN_NOTES+=("sell rung $rung skipped: $price is at or below the best bid $BEST_BID, so it would cross")
        continue
      fi

      cid=$(rung_client_id "$side" "$price" "$LADDER_RUNG_QTY")

      # Two rungs can land on the same tick when the step is small relative to
      # the tick size, and they would then share a client order id — one of them
      # rejected as a duplicate, or worse, silently accepted as the other. It is
      # a configuration problem, so it is reported as one.
      if [[ -n ${DESIRED_PRICE[$cid]:-} ]]; then
        PLAN_NOTES+=("$side rung $rung collapsed onto an earlier rung at $price (the tick size is $MARKET_TICK; raise LADDER_STEP_BPS to separate them)")
        continue
      fi

      DESIRED_IDS+=("$cid")
      DESIRED_SIDE[$cid]=$side
      DESIRED_PRICE[$cid]=$price
      DESIRED_QTY[$cid]=$LADDER_RUNG_QTY
    done
  done
}

# ─────────────────────────── the actual set ───────────────────────────

# Parse the open orders this app owns out of the JSON captured at preflight.
#
# Ownership is the tag prefix, and it is the only reason this app can be trusted
# to cancel anything: `nexus order cancel --all` exists, it is one flag, and it
# would take out a human's own resting orders on the same account without ever
# mentioning them. Nothing here cancels an order it cannot name.
load_actual() {
  ACTUAL_IDS=()
  ACTUAL_ORDER_ID=()
  ACTUAL_SIDE=()
  ACTUAL_PRICE=()
  ACTUAL_QTY=()
  ACTUAL_FILLED=()
  ACTUAL_STATUS=()
  FOREIGN_OWNED=()

  # `@tsv` escapes any tab or newline inside a value, so one order is always one
  # line however the venue spells its fields. Nothing read here is ever evaluated.
  local rows cid market side price qty filled status oid
  rows=$(printf '%s' "$OPEN_ORDERS_JSON" | jq -r '
    map(select(.client_order_id != null))
    | .[] | [.client_order_id, .market_id, .side, (.price // ""),
             .quantity, .filled_qty, (.status // ""), .id] | @tsv') || rows=""

  while IFS=$'\t' read -r cid market side price qty filled status oid; do
    [[ -n $cid ]] || continue
    [[ $cid == "$LADDER_TAG"-* ]] || continue          # not ours

    if [[ $market != "$LADDER_MARKET" ]]; then
      FOREIGN_OWNED+=("$cid on $market")
      continue
    fi

    ACTUAL_IDS+=("$cid")
    ACTUAL_ORDER_ID[$cid]=$oid
    ACTUAL_SIDE[$cid]=$side
    ACTUAL_PRICE[$cid]=$price
    ACTUAL_QTY[$cid]=$qty
    ACTUAL_FILLED[$cid]=${filled:-0}
    ACTUAL_STATUS[$cid]=$status
  done <<<"$rows"
}

# ─────────────────────────── the diff ───────────────────────────

# Decide what to do, without doing any of it.
#
# Split from execution on purpose: this is what `--plan` prints, and it is the
# same code path `--commit` acts on, so the plan a reader reads is the plan that
# runs.
build_plan() {
  PLAN_KEEP=()
  PLAN_CANCEL=()
  PLAN_PLACE=()

  local cid
  for cid in "${ACTUAL_IDS[@]}"; do
    if [[ -z ${DESIRED_PRICE[$cid]:-} ]]; then
      PLAN_CANCEL+=("$cid")
      PLAN_NOTES+=("cancel $cid: resting at ${ACTUAL_PRICE[$cid]:-?} × ${ACTUAL_QTY[$cid]} but no longer on the ladder")
      continue
    fi

    # The id encodes the price and the size, so a matching id that disagrees with
    # either of them cannot happen — which is exactly why it is checked. It would
    # mean the venue is not resting the order this app believes it placed, and the
    # right answer to a broken assumption is to stop relying on it: cancel the
    # order, name the discrepancy, and let the next run place the rung cleanly.
    if [[ -z ${ACTUAL_PRICE[$cid]} ]] || ! dec_eq "${ACTUAL_PRICE[$cid]}" "${DESIRED_PRICE[$cid]}"; then
      PLAN_CANCEL+=("$cid")
      PLAN_NOTES+=("cancel $cid (venue order ${ACTUAL_ORDER_ID[$cid]}): reported price $(quoted "${ACTUAL_PRICE[$cid]}") where this rung is $(quoted "${DESIRED_PRICE[$cid]}")")
      continue
    fi
    if ! dec_eq "${ACTUAL_QTY[$cid]}" "${DESIRED_QTY[$cid]}"; then
      PLAN_CANCEL+=("$cid")
      PLAN_NOTES+=("cancel $cid (venue order ${ACTUAL_ORDER_ID[$cid]}): reported size $(quoted "${ACTUAL_QTY[$cid]}") where this rung is $(quoted "${DESIRED_QTY[$cid]}")")
      continue
    fi

    # Partially filled: left exactly as it is, and never topped back up.
    #
    # Topping up is the tempting behaviour and it is the wrong one. A fill means
    # the position moved; replacing the filled amount re-arms the same exposure,
    # so a market walking down through the ladder would be met with an order that
    # keeps regenerating itself. Reporting it and leaving it alone puts that
    # decision back where it belongs.
    if ! dec_eq "${ACTUAL_FILLED[$cid]}" 0; then
      PLAN_KEEP+=("$cid")
      PLAN_NOTES+=("keep $cid: partially filled (${ACTUAL_FILLED[$cid]} of ${ACTUAL_QTY[$cid]}) — left alone, never topped up")
      continue
    fi

    PLAN_KEEP+=("$cid")
  done

  for cid in "${DESIRED_IDS[@]}"; do
    [[ -n ${ACTUAL_PRICE[$cid]:-} ]] && continue
    PLAN_PLACE+=("$cid")
  done
}

plan_is_empty() {
  (( ${#PLAN_CANCEL[@]} + ${#PLAN_PLACE[@]} == 0 ))
}
