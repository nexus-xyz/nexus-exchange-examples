# shellcheck shell=bash
# shellcheck disable=SC2034  # this file is only ever sourced; run.sh is what reads these
#
# The checks. One function each, one `record` each, in the order they run.
#
# They run in dependency order and later ones read what earlier ones learned:
# there is no point asking whether your credentials work if the host does not
# resolve, and every check that would produce a misleading verdict without its
# prerequisite records `skip` and says which prerequisite was missing. A `skip`
# is information — "not checked" is a different answer from "fine".

# ── environment ─────────────────────────────────────────────────────────────

# The CLI and the SDKs read different variable names for the same thing, and a
# reader who copies a `.env` between two examples in this catalog gets a tool
# that runs unauthenticated with no error at all. That is a real support
# question, so it is a check rather than a footnote.
check_env() {
  local cli_key=${NEXUS_API_KEY:-} cli_secret=${NEXUS_API_SECRET:-}
  local sdk_key=${NEXUS_EXCHANGE_API_KEY:-} sdk_secret=${NEXUS_EXCHANGE_API_SECRET:-}

  HAVE_CLI_CREDENTIALS=0
  [[ -n $cli_key && -n $cli_secret ]] && HAVE_CLI_CREDENTIALS=1

  # Values are never printed — only shapes. `describe_secret` gives a length and
  # a character class, which is enough to spot a truncated paste or a secret
  # pasted into the key slot, and not enough to be worth anything to a reader of
  # the bug report this output ends up in.
  local detail
  detail="NEXUS_API_KEY $(describe_secret "$cli_key"), NEXUS_API_SECRET $(describe_secret "$cli_secret")"

  if (( HAVE_CLI_CREDENTIALS )); then
    record env ok "credentials present in the CLI's namespace — $detail" \
      "nothing to do."
    return
  fi

  if [[ -n $sdk_key || -n $sdk_secret ]]; then
    record env warn \
      "NEXUS_EXCHANGE_API_KEY/SECRET are set but NEXUS_API_KEY/SECRET are not — the CLI reads the second pair and will run unauthenticated" \
      "the SDKs read NEXUS_EXCHANGE_*, the CLI reads NEXUS_*. Copy the values across, or export both."
    return
  fi

  # `skip`, not `warn`. The README promises "everything optional degrades to a
  # `skip`" and defines exit 3 as "a warning will bite you later" — so a
  # credential-less run, which is the documented CI happy path, could never
  # reach exit 0 and a CI step following the README could never go green
  # (@nvizble, #21).
  #
  # The distinction that resolves it: absent is a SKIP, because the check could
  # not run. Present-but-wrong stays a WARN, because something is actually
  # misconfigured — the half-configured pair above is still a warning, and so
  # is every other branch here. Nothing loses signal; the no-signal case stops
  # pretending to be one.
  record env skip "no credentials configured — $detail" \
    "the transport checks below need none. For the credential check, mint a testnet pair with \`nexus keys create\`, or run \`nexus setup\`."
}

# `NEXUS_BASE_URL` outranks `--network` inside the CLI, so it can send a run
# labelled `testnet` somewhere else entirely while every log line still says
# testnet.
#
# `cli/quote-ladder` refuses to start when one is set, and that is right for a
# tool that places orders. It is wrong here. A diagnostic that refuses to run
# under the exact configuration it is meant to explain has abandoned the reader
# at the moment they needed it, and today the override is the only way to point
# an installed CLI at a host that works. So it is reported, loudly, with its
# value and its effect — and never set by this tool.
check_base_url_override() {
  if [[ -z ${NEXUS_BASE_URL:-} ]]; then
    record override ok "no NEXUS_BASE_URL is set, so the CLI will use its own --network default" \
      "nothing to do."
    return
  fi

  record override warn \
    "NEXUS_BASE_URL=$(quoted "$NEXUS_BASE_URL") is set, and it outranks --network inside the CLI" \
    "every CLI call goes there regardless of the network label in your command. Intended? Fine. Not intended? \`unset NEXUS_BASE_URL\`. This tool's own probes use the base shown above and ignore it."
}

# ── the CLI ─────────────────────────────────────────────────────────────────

# The CLI is a *component* here, not the transport. Every check above and below
# this one runs without it, deliberately: a reader whose CLI will not start
# still needs to know whether the venue is up, and a diagnostic that cannot run
# until the thing it diagnoses is working is not a diagnostic.
check_cli() {
  CLI_PRESENT=0
  CLI_VERSION=""
  CLI_VERSION_LINE=""

  if ! command -v nexus >/dev/null 2>&1; then
    # Skip for the same reason as `check_env`'s absent-credentials branch: the
    # check could not run, which is not the same as finding something wrong.
    # A CLI that IS present but misbehaves stays a warn below.
    record cli skip "the \`nexus\` CLI is not on PATH" \
      "install it with \`curl https://cli.nexus.xyz | sh\`. The transport checks below do not need it; the credential check does."
    return
  fi

  local line
  if ! line=$(nexus --version 2>/dev/null); then
    record cli warn "\`nexus --version\` did not run cleanly" \
      "reinstall the CLI, or check it is executable. See the README's Prerequisites."
    return
  fi

  CLI_PRESENT=1
  CLI_VERSION_LINE=$line
  # `nexus --version` prints, e.g. `nexus 0.4.0 (spec v0.8.1, nexus-exchange 0.9.1)`
  read -r _ CLI_VERSION _ <<<"$line"

  if [[ $CLI_VERSION != "$PINNED_CLI_VERSION" ]]; then
    record cli warn \
      "the CLI is $(quoted "$CLI_VERSION"); this example was verified against $PINNED_CLI_VERSION" \
      "the command surface has changed incompatibly between releases before (\`--network stable\` was removed; \`order get\`/\`order cancel\` grew a required \`--market\`), so a difference here is worth knowing. Everything below still runs."
    return
  fi

  local spec_note=""
  [[ $line == *"$EXPECTED_SPEC_TAG"* ]] ||
    spec_note=" — though it reports a different API spec tag than the $EXPECTED_SPEC_TAG this example was written against"
  record cli ok "nexus $CLI_VERSION, the pinned release$spec_note" "nothing to do."
}

# ── DNS ─────────────────────────────────────────────────────────────────────

# Answered before anything tries to connect, so "this network is not deployed"
# arrives as a sentence rather than as a timeout the reader has to interpret.
check_dns() {
  DNS_OK=0
  resolve_host "$REST_HOST"

  if (( RESOLVE_COUNT > 0 )); then
    DNS_OK=1
    record dns ok "$REST_HOST resolves to $RESOLVE_COUNT address(es): $RESOLVE_ADDRESSES" \
      "nothing to do."
    return
  fi

  # Deliberately not phrased as "the record does not exist". Under this zone a
  # host with no address and a host that was never created answer identically —
  # NOERROR with an empty answer section — so the two cannot be told apart from
  # a resolver, and claiming otherwise would be a guess dressed as a finding.
  local rcode_note=""
  [[ -n $RESOLVE_RCODE ]] && rcode_note=" (DNS response code $RESOLVE_RCODE, no address records)"

  if [[ $DOCTOR_NETWORK == mainnet ]]; then
    record dns fail \
      "$REST_HOST resolves to no address at all$rcode_note — mainnet is not deployed" \
      "there is nothing to connect to and no amount of credential fixing will change that. Use testnet. Do not point a client at a guessed mainnet host."
    return
  fi

  record dns fail "$REST_HOST resolves to no address at all$rcode_note" \
    "check the hostname for a typo, then your resolver. Everything below is skipped: there is no host to ask."
}

# ── reachability and the prefix ─────────────────────────────────────────────

# The check this whole tool is built around.
#
# Two probes against the configured base: a path the venue serves publicly, and
# a path that certainly does not exist. The pair is what makes the verdict
# defensible rather than a guess — the second one establishes, on this
# deployment, right now, whether a 401 carries any information about the path.
check_reach() {
  REACH_OK=0
  REACH_REQUEST_ID=""
  if (( ! DNS_OK )); then
    record reach skip "not checked — $REST_HOST does not resolve" \
      "fix DNS first."
    return
  fi

  probe_http GET "${REST_BASE}${PUBLIC_PATH}"
  local status=$PROBE_STATUS class=$PROBE_CLASS body=$PROBE_BODY
  REACH_CLASS=$PROBE_CLASS
  local rid=$PROBE_REQUEST_ID curl_exit=$PROBE_CURL_EXIT
  REACH_DATE=$PROBE_DATE
  REACH_LAG_MS=$(header_value 'x-indexer-lag-ms')

  # Corroboration, never the rule. `x-request-id` is present exactly when the
  # venue's own application produced the response, and absent when the gateway
  # answered on its behalf — which is useful, and is an implementation detail
  # that could change tomorrow. The status code is what the verdict rests on.
  #
  # The id itself is deliberately *not* put in the finding. A request id is 32
  # hex characters, which is exactly what the redactor's catch-all treats as a
  # credential, so it would come out as `<redacted:hex>` — over-redaction
  # working as designed, and useless to a reader who needs to quote the id in a
  # support ticket. So it is kept out of the redacted text and printed once, in
  # the report header, by code that knows what it is holding. That is the rule
  # this tool follows generally: anything worth reading in the output is
  # extracted deliberately, never smuggled through the filter and hoped for.
  local answered_by="the gateway"
  if [[ -n $rid ]]; then
    answered_by="the venue"
    REACH_REQUEST_ID=$rid
  fi

  case $class in
    served)
      REACH_OK=1
      record reach ok "$REST_BASE_SAFE serves $PUBLIC_PATH — HTTP $status from $answered_by" \
        "nothing to do. This base URL is correct."
      ;;
    not_routed)
      # The only status that means this. Everything else below reached a route.
      local hint=""
      [[ $body == *"fault filter abort"* ]] && hint=" (the gateway answered $(quoted "$body"), which is its no-such-route reply)"
      record reach fail \
        "HTTP 404 — nothing is mounted at $REST_PREFIX on $REST_HOST$hint" \
        "this is a wrong path prefix, not a credential problem. On testnet the API is served under \`/indexer\`: the base is \`https://api.testnet.nexus.xyz/indexer\` and the bare host 404s. Set NEXUS_EXCHANGE_API_URL to the base with the prefix."
      ;;
    auth_required)
      # A 401 on a *public* path is a real surprise and worth its own verdict:
      # it means the deployment gates everything, so nothing below can
      # distinguish a routing problem from a credential one.
      record reach warn \
        "HTTP $status on $PUBLIC_PATH, which is normally public — the prefix is right, but this deployment authenticates everything" \
        "routing is proven correct: the request reached the venue. See the credential check below."
      REACH_OK=1
      ;;
    upstream_down)
      # Measured live while this example was being written: every path under
      # `/indexer` answered 503 while the bare host still answered 404. The
      # reader's configuration is *correct* and there is nothing for them to fix
      # — saying anything that implies otherwise sends them to edit a URL that
      # was already right.
      local why=""
      [[ $body == *"no healthy upstream"* ]] && why=" — the gateway matched the route and found no healthy backend behind it"
      record reach fail \
        "HTTP $status from $REST_BASE_SAFE$why" \
        "your configuration is right and the venue is down. The prefix matched, so there is nothing here to change: wait and re-run. Check https://status.nexus.xyz or ask in the developer channel if it persists."
      ;;
    dead_upstream)
      record reach fail \
        "HTTP 500 from $REST_BASE_SAFE — the host answered but its upstream did not" \
        "if this base is \`$LEGACY_BASE_URL\`, see the \`legacy\` check below: that host proxies to a decommissioned service and 500s on every route. Otherwise the venue has an internal error; re-run and report the request id."
      ;;
    rate_limited)
      record reach warn "HTTP 429 — this client is being rate limited" \
        "wait for the window named in \`retry-after\` and re-run. Nothing is misconfigured."
      REACH_OK=1
      ;;
    version_skew)
      record reach fail "HTTP 426 — the venue requires a newer client than this one" \
        "upgrade the SDK or CLI. See the \`version\` check for the minimum the venue publishes."
      ;;
    transport)
      record reach fail \
        "nothing answered at $REST_BASE_SAFE — $(curl_exit_meaning "$curl_exit")" \
        "the name resolved, so this is below HTTP: check a proxy, a firewall, or TLS interception on this network."
      ;;
    *)
      record reach warn "HTTP $status from $REST_BASE_SAFE, which this tool has no opinion about" \
        "report the status and the request id if it persists."
      ;;
  esac
}

# Prove, rather than assume, what a 401 means on this deployment.
#
# This is the check that keeps the tool honest. If a path that certainly does
# not exist answers 401, then a 401 on *your* path is not evidence your path
# exists — and a reader who does not know that will read "401" as "my key is
# wrong" and go re-mint a perfectly good key.
check_prefix_semantics() {
  AUTH_BEFORE_ROUTING=unknown
  if (( ! DNS_OK )); then
    record routing skip "not checked — $REST_HOST does not resolve" "fix DNS first."
    return
  fi

  # If the base prefix itself is not routed, every path under it 404s and this
  # probe learns nothing — it would report "routing runs ahead of
  # authentication here", which is true of the observation and false as a
  # conclusion. A check that cannot distinguish its two answers has to say so
  # rather than pick one.
  if [[ ${REACH_CLASS:-} == not_routed ]]; then
    record routing skip \
      "not determined — the base prefix is not routed, so every path under it answers 404" \
      "fix the prefix first; this reading only means something once something under the base answers."
    return
  fi

  probe_http GET "${REST_BASE}${ABSENT_PATH}"

  case $PROBE_CLASS in
    auth_required)
      AUTH_BEFORE_ROUTING=yes
      record routing ok \
        "authentication runs ahead of routing here: a path that does not exist also answers HTTP $PROBE_STATUS" \
        "so a 401 proves your prefix is right and says nothing about whether your path exists. Only a 404 means a wrong prefix."
      ;;
    not_routed)
      AUTH_BEFORE_ROUTING=no
      record routing ok \
        "routing runs ahead of authentication here: a path that does not exist answers 404" \
        "so on this deployment a 404 can mean either a wrong prefix or a wrong path, and a 401 does mean the path exists."
      ;;
    upstream_down)
      record routing skip \
        "not determined — the backend is down, so every path answers HTTP $PROBE_STATUS" \
        "re-run once the venue is back."
      ;;
    *)
      record routing skip \
        "not determined — a nonexistent path answered HTTP $PROBE_STATUS ($PROBE_CLASS)" \
        "the 404-versus-401 reading below is reported without this corroboration."
      ;;
  esac
}

# The legacy base is checked on every run whatever network is selected, because
# it is the base an unmodified SDK or CLI is pointed at today. A reader whose
# own base works can still have a broken client, and this is the check that
# tells them so.
check_legacy_base() {
  if [[ $REST_BASE == "$LEGACY_BASE_URL"* ]]; then
    # Already probed as the configured base; do not spend a second request.
    if (( REACH_OK )); then
      record legacy ok "the configured base is the legacy base, and it answered" \
        "unexpected but fine. It was 500ing on every route as of 2026-09-09."
    else
      record legacy fail \
        "the configured base is $LEGACY_BASE_URL, which proxies to a decommissioned service" \
        "this is the default every SDK and the CLI still ship. Point at the durable base instead: NEXUS_EXCHANGE_API_URL=https://api.testnet.nexus.xyz/indexer — and for the CLI, NEXUS_BASE_URL."
    fi
    return
  fi

  probe_http GET "${LEGACY_BASE_URL}${PUBLIC_PATH}"

  case $PROBE_CLASS in
    served)
      record legacy ok "the legacy base $LEGACY_BASE_URL still answers" \
        "an SDK or CLI left on its shipped default will still work. Migrating to the durable base is still the right move."
      ;;
    transport)
      record legacy warn "the legacy base $LEGACY_BASE_URL did not answer — $(curl_exit_meaning "$PROBE_CURL_EXIT")" \
        "an SDK or CLI left on its shipped default will not work. Set NEXUS_EXCHANGE_API_URL (and NEXUS_BASE_URL for the CLI) to $DURABLE_TESTNET_BASE."
      ;;
    *)
      record legacy warn \
        "the legacy base $LEGACY_BASE_URL answers HTTP $PROBE_STATUS — it proxies to a decommissioned service" \
        "this is the default every published SDK and the CLI still ship, so an unconfigured client is pointed at a dead host. Set NEXUS_EXCHANGE_API_URL=$DURABLE_TESTNET_BASE, and NEXUS_BASE_URL=$DURABLE_TESTNET_BASE for the CLI."
      ;;
  esac
}

# ── the clock ───────────────────────────────────────────────────────────────

# The one cause of an opaque 401 this tool can eliminate outright. An HMAC
# request carries a timestamp the venue checks against a narrow window, and a
# drifted clock signs requests that are rejected as replays — with the same 401
# a wrong key gets. Ruling it out takes the suspect list from four to three,
# which is the most any single check here manages.
check_clock() {
  if [[ -z ${REACH_DATE:-} ]]; then
    record clock skip "not checked — no response carried a Date header" \
      "re-run once the venue answers."
    return
  fi

  if ! clock_skew "$REACH_DATE"; then
    record clock skip "not checked — could not parse the server's Date header" \
      "compare \`date -u\` against the venue's clock by hand."
    return
  fi

  local skew=$CLOCK_SKEW_SECONDS abs=${CLOCK_SKEW_SECONDS#-}
  if (( abs <= DOCTOR_CLOCK_SKEW_WARN )); then
    record clock ok "this host's clock is within ${abs}s of the venue's" \
      "so a signed-request rejection is not clock skew. One cause eliminated."
    return
  fi

  record clock warn "this host's clock is ${skew}s from the venue's" \
    "an HMAC timestamp outside the venue's window is rejected as a replay, and the rejection is an opaque 401 indistinguishable from a bad key. Enable NTP before you re-mint anything."
}

# ── version skew ────────────────────────────────────────────────────────────

# A compatibility check, not a security control, and the report says so. The
# version header is unauthenticated and advisory: anyone can send any value, so
# it can tell you your client is old and cannot stop you using it. Measured
# 2026-09-09, sending `x-nexus-api-version: 0.0.1` and `99.0.0` both returned
# 200 — the venue publishes its window and does not currently enforce it.
check_version() {
  if (( ! REACH_OK )); then
    record version skip "not checked — the venue did not answer" "fix reachability first."
    return
  fi

  probe_http GET "${REST_BASE}/metadata"
  if [[ $PROBE_CLASS != served ]]; then
    record version skip "not checked — /metadata answered HTTP $PROBE_STATUS" \
      "the venue publishes its version window there; without it, skew cannot be checked."
    return
  fi

  if ! command -v jq >/dev/null 2>&1; then
    record version skip "not checked — \`jq\` is not on PATH" \
      "install jq to read the venue's published version window."
    return
  fi

  # Read the whole body again rather than reusing PROBE_BODY, which holds only
  # the first line and is sized for naming an Envoy fault, not parsing JSON.
  local body current minimum deprecated sunset
  body=$(curl -sS --max-time "$DOCTOR_TIMEOUT_SECONDS" "${REST_BASE}/metadata" 2>/dev/null) || body=""
  current=$(printf '%s' "$body" | jq -r '.api_version.current // "unknown"' 2>/dev/null || printf 'unknown')
  minimum=$(printf '%s' "$body" | jq -r '.api_version.min_supported // "unknown"' 2>/dev/null || printf 'unknown')
  deprecated=$(printf '%s' "$body" | jq -r '.api_version.deprecated_below // ""' 2>/dev/null || printf '')
  sunset=$(printf '%s' "$body" | jq -r '.api_version.sunset // ""' 2>/dev/null || printf '')

  if [[ $current == unknown ]]; then
    record version skip "not checked — /metadata did not carry an api_version block" \
      "the venue's published shape may have changed; report it."
    return
  fi

  local detail="venue API $current, minimum supported $minimum"
  if [[ -n $deprecated && $deprecated != null ]]; then
    record version warn "$detail, and clients below $deprecated are deprecated" \
      "upgrade before the sunset date${sunset:+ ($sunset)}. The version header is advisory and unauthenticated, so nothing will stop you until it does."
    return
  fi

  local against=""
  (( CLI_PRESENT )) && against=", and this example targets spec $EXPECTED_SPEC_TAG"
  record version ok "$detail$against" \
    "nothing to do. This is a compatibility signal, not a security control: the version header is unauthenticated and advisory, so it can tell you the client is old and cannot stop you using it."
}

# ── venue health ────────────────────────────────────────────────────────────

# Distinct from reachability on purpose. "I can reach it" and "it is working"
# are different questions, and a reader whose requests succeed but return stale
# data has a problem that no connectivity check would ever surface.
check_health() {
  if (( ! REACH_OK )); then
    record health skip "not checked — the venue did not answer" "fix reachability first."
    return
  fi

  # The lag header rides on every response, so it costs nothing and is read
  # first: it is the fastest way to see a venue that is up and behind.
  if [[ ${REACH_LAG_MS:-} =~ ^[0-9]+$ ]]; then
    local lag_s=$(( REACH_LAG_MS / 1000 ))
    if (( lag_s > DOCTOR_LAG_WARN_SECONDS )); then
      record lag warn "the indexer is ${lag_s}s behind the engine (x-indexer-lag-ms: $REACH_LAG_MS)" \
        "reads will answer, and they will be stale by about that much. Do not trust balances or fills from this window."
    else
      record lag ok "the indexer is ${lag_s}s behind the engine" "nothing to do."
    fi
  fi

  probe_http GET "${REST_BASE}/status"
  if [[ $PROBE_CLASS != served ]]; then
    record health warn "GET /status answered HTTP $PROBE_STATUS ($PROBE_CLASS)" \
      "the venue is reachable but not reporting health. Treat the data below as suspect."
    return
  fi

  if ! command -v jq >/dev/null 2>&1; then
    record health skip "not checked — \`jq\` is not on PATH" "install jq to read the health snapshot."
    return
  fi

  local body overall degraded
  body=$(curl -sS --max-time "$DOCTOR_TIMEOUT_SECONDS" "${REST_BASE}/status" 2>/dev/null) || body=""
  overall=$(printf '%s' "$body" | jq -r '.status // "unknown"' 2>/dev/null || printf 'unknown')
  degraded=$(printf '%s' "$body" |
    jq -r '[.services // {} | to_entries[] | select(.value.status != "ok") | .key] | join(", ")' \
    2>/dev/null || printf '')

  if [[ $overall == ok ]]; then
    record health ok "the venue reports status \"ok\"" "nothing to do."
    return
  fi

  record health warn "the venue reports status $(quoted "$overall")${degraded:+ — degraded services: $degraded}" \
    "reachable but not healthy. This is the venue's own assessment of itself, not a problem with your configuration."
}

# ── WebSocket ───────────────────────────────────────────────────────────────

# WS gets its own check because a client can have a correct REST base and still
# no stream. The TypeScript SDK derived its WS URL from the bare origin, which
# drops the `/indexer` prefix and turns a working configuration into a 404 on
# connect; nothing in a REST check would notice.
#
# Both paths are probed, because they answer differently and the difference is
# the diagnosis: `/stream` upgrades unauthenticated (public market data) while
# `/ws` is token-gated. Measured 2026-09-09.
check_ws() {
  if (( ! DNS_OK )); then
    record ws skip "not checked — $REST_HOST does not resolve" "fix DNS first."
    return
  fi

  # Three counters, not one. The distinction that matters is whether the route
  # *matched*, and a 503 matches — the gateway found the route and then found no
  # backend behind it. Collapsing "routed" and "working" into one flag is how
  # this check came to tell a reader with a correct WS base to go and fix their
  # WS base, during an outage, which is the exact misdiagnosis this whole
  # example exists to avoid.
  local path routed=0 unrouted=0 down=0 answered=0 findings=()
  for path in /stream /ws; do
    probe_ws "${WS_BASE}${path}"
    case $WS_CLASS in
      open)
        routed=1
        answered=1
        findings+=("$path upgraded (HTTP 101)")
        ;;
      token_required)
        routed=1
        answered=1
        # The accept header is the tell: the gateway completed the upgrade
        # negotiation and the venue then refused it, so the route exists and the
        # only thing missing is a token. A 401 with no accept header would be a
        # different and much less informative answer.
        local tell="HTTP $WS_STATUS"
        (( WS_HAS_ACCEPT )) && tell="$tell with a valid sec-websocket-accept"
        findings+=("$path is served and token-gated ($tell)")
        ;;
      not_routed)
        unrouted=1
        answered=1
        findings+=("$path is NOT routed (HTTP 404)")
        ;;
      upstream_down)
        # Routed. The gateway matched the path and could not reach a backend.
        routed=1
        down=1
        answered=1
        findings+=("$path reached the route, backend down (HTTP $WS_STATUS)")
        ;;
      transport)
        # Nothing came back at all, which is a different problem from a 404 and
        # must not collect the 404's advice.
        findings+=("$path did not answer")
        ;;
      *)
        answered=1
        findings+=("$path answered HTTP $WS_STATUS")
        ;;
    esac
  done

  # `${findings[*]}` with a two-character IFS joins on the *first* character
  # only, which is how `(HTTP 101);/ws` gets into a report. Joined by hand.
  local summary=""
  local finding
  for finding in "${findings[@]}"; do
    summary="${summary:+$summary; }$finding"
  done

  # A down backend is not a configuration problem, and the advice has to say so
  # — otherwise this check sends a reader whose WS base is already correct off
  # to change it.
  if (( routed && down )); then
    record ws warn "$WS_BASE_SAFE — $summary" \
      "the route matched, so this WS base is correct. The backend behind it is down; there is nothing to change here. Re-run when the venue is back."
    return
  fi

  if (( routed )); then
    local mixed=""
    (( unrouted )) && mixed=" One path is not routed, which is worth a look, but the base itself is right."
    record ws ok "$WS_BASE_SAFE — $summary" \
      "a token-gated 401 here is the healthy answer for /ws: mint a single-use token with POST /ws/token, and mint it on the same host you connect to.$mixed"
    return
  fi

  # Nothing answered on either path. That is a transport problem, not a prefix
  # one, and handing it the prefix advice below would send the reader to edit a
  # URL that may well be correct.
  if (( ! answered )); then
    record ws fail "$WS_BASE_SAFE — $summary" \
      "nothing answered on either WebSocket path. The REST checks above say whether the host itself is reachable; if they passed, suspect a proxy or firewall that allows HTTPS but blocks an Upgrade."
    return
  fi

  record ws fail "$WS_BASE_SAFE — $summary" \
    "the WS base is missing the path prefix the REST base has. Derive the WS URL from the REST base, not from the bare origin: \`$DEFAULT_WS_BASE\`, not \`wss://$REST_HOST\`. The TypeScript SDK had exactly this bug; the Rust SDK's Network::Testnet.ws_base() is still None in 0.11.0, which disables WS at the SDK level rather than the network one."
}

# ── credentials ─────────────────────────────────────────────────────────────

# Last, and only once everything above has established what a failure would
# mean. That ordering is the point: a 401 in isolation is four different
# problems, and the checks above have already ruled out two of them.
#
# The read is delegated to the CLI rather than signed here. Signing an HMAC
# request by hand is Track 1's lesson (`exchange-api/trading-terminal`), and
# this is Track 3 — but the better reason is that a diagnostic which implements
# its own signing can only ever test *its own* signing. Asking the CLI is what
# makes a pass here mean "your client can authenticate".
check_credentials() {
  if (( DOCTOR_SKIP_CREDENTIALS )); then
    record credentials skip "not checked — DOCTOR_SKIP_CREDENTIALS=1" "unset it to check."
    return
  fi
  if (( ! CLI_PRESENT )); then
    record credentials skip "not checked — the \`nexus\` CLI is not available" \
      "install the CLI; the transport verdicts above stand without it."
    return
  fi
  if (( ! HAVE_CLI_CREDENTIALS )); then
    record credentials skip "not checked — no credentials in NEXUS_API_KEY/NEXUS_API_SECRET" \
      "mint a testnet pair with \`nexus keys create\`, or run \`nexus setup\`."
    return
  fi
  if (( ! REACH_OK )); then
    record credentials skip "not checked — the venue did not answer, so a failure here would be meaningless" \
      "fix reachability first, then re-run."
    return
  fi

  # One read-only call. `nexus orders` lists open orders and mutates nothing;
  # this tool places nothing, cancels nothing and changes no account setting on
  # any path. Credentials are inherited through the environment and never passed
  # as arguments, because arguments are visible in the process list.
  local out="" status=0
  out=$(nexus --network "$DOCTOR_NETWORK" --output json orders 2>&1) || status=$?

  if (( status == 0 )); then
    record credentials ok "the CLI authenticated against $DOCTOR_NETWORK and read your open orders" \
      "nothing to do."
    return
  fi

  # The honest verdict. The venue deliberately does not distinguish a
  # wrong-network key from one that never existed — both are the same opaque
  # 401, with no hint that the key is live somewhere else — so this reports the
  # ambiguity rather than picking a favourite. Guessing here is how a reader
  # ends up deleting a working key.
  local suspects=(
    "the key was minted on a different network than $DOCTOR_NETWORK (same 401, no hint either way)"
    "the key was revoked, or never existed"
    "the signature was computed over a different path than the one sent — likely if you changed the base URL recently"
  )
  # The clock check may already have eliminated one of them.
  local clock_note="a stale request timestamp"
  local i
  for i in "${!CHECK_NAMES[@]}"; do
    if [[ ${CHECK_NAMES[$i]} == clock && ${CHECK_VERDICTS[$i]} == ok ]]; then
      clock_note=""
      break
    fi
  done
  [[ -n $clock_note ]] && suspects+=("$clock_note")

  local listed
  listed=$(printf '%s; ' "${suspects[@]}")
  listed=${listed%; }

  record credentials fail \
    "the CLI could not authenticate against $DOCTOR_NETWORK, though the venue is reachable" \
    "the transport checks above passed, so this is the credential. It is one of: $listed. The venue returns the same status for all of them — check which host minted the key before you re-mint or escalate, and do not point the same key at another host to see if it works there."
  # The CLI's own message can carry anything, including a request it tried to
  # sign, so it goes through the redactor like every other foreign string.
  DIAGNOSTIC_TAIL=$(redact "${out:0:400}")
}
