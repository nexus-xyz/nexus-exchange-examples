"""Offline tests. No network, no credentials, no live venue.

Three kinds here, and the split is deliberate.

The rules in `config.py` and `domain.py` are pure, so most of this is
table-driven: hand them a value, assert what they do with it. That is where the
decisions that matter live — above all the refusals, which are the behaviour this
example exists to demonstrate and therefore the behaviour a version bump must not
be able to quietly remove.

The EIP-712 digest is pinned by a **known answer**. The domain and the struct
hash are computed here from the spec text, independently of the SDK, and the
signature the SDK produces is recovered back to the signing address. A test that
only checked "the SDK returned 65 bytes" would pass against a signer that used
the wrong domain, which is the single failure this example is about.

The rest runs the real `nexus_exchange.Client` and the real `httpx` against a
**real HTTP server on the loopback interface** rather than a mock. A mock of an
SDK proves the mock matches the test's idea of it; a socket proves the SDK
composes the URL, signs the request and decodes the body the way this app
assumes.

Run with:  python -m unittest -q
"""

from __future__ import annotations

import json
import os
import threading
import unittest
import unittest.mock
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import config
import domain
import enroll
from config import ConfigError, HelpRequested

# Fixed test vectors, and worth being explicit about against CONTRIBUTING § 4's
# "never commit a key, secret, token, or seed phrase".
#
# These are not credentials. They are two constants anyone can type from this
# comment, they have never held funds on any network, and nothing in this repo
# or in the venue is reachable with them. A known-answer test needs a *fixed*
# input by definition: the digest below is only a known answer if the key that
# produced the signature cannot change, and generating one per run would turn the
# one assertion that matters — that the SDK signs under the domain this example
# read, and not some other — back into "65 bytes came back".
#
# The rule they are being weighed against exists to stop a real key reaching a
# public repo. A published constant in a test is the opposite case, and the
# example itself reads every key it actually uses from the environment.
WALLET_KEY = "0x" + "11" * 32
AGENT_KEY = "0x" + "22" * 32


def metadata(chain_id: object = 11155111) -> dict[str, Any]:
    """A `/metadata` body shaped the way the spec publishes one."""
    return {
        "api_version": {"current": "0.8.1", "min_supported": "0.8.0"},
        "signing_domain": {"name": "Nexus Exchange", "version": "1", "chain_id": chain_id},
    }


class ChainIdRules(unittest.TestCase):
    """Refusing to sign is the feature. Every branch of it is pinned."""

    def read(self, payload: object) -> int:
        return domain.chain_id_from_metadata(payload, "http://test/metadata")

    def test_a_published_chain_id_is_read(self) -> None:
        self.assertEqual(self.read(metadata(11155111)), 11155111)

    def test_null_chain_id_refuses(self) -> None:
        """Null means *unknown*, not zero, and not another network's value."""
        with self.assertRaises(domain.DomainUnavailable) as caught:
            self.read(metadata(None))
        self.assertIn("unknown, not zero", str(caught.exception))

    def test_missing_signing_domain_refuses(self) -> None:
        with self.assertRaises(domain.DomainUnavailable):
            self.read({"api_version": {"current": "0.8.1"}})

    def test_a_string_chain_id_is_refused_not_parsed(self) -> None:
        """JSON has a number type and the spec uses it.

        `int("11155111")` would work and would be the wrong thing to do: a string
        here means the payload is not the shape this app was written against.
        """
        with self.assertRaises(domain.DomainUnavailable):
            self.read(metadata("11155111"))

    def test_true_does_not_become_ethereum_mainnet(self) -> None:
        """`bool` is an `int` subclass, so `True` would otherwise sign as chain 1."""
        with self.assertRaises(domain.DomainUnavailable):
            self.read(metadata(True))

    def test_zero_and_negative_are_refused(self) -> None:
        for value in (0, -1):
            with self.subTest(value=value), self.assertRaises(domain.DomainUnavailable):
                self.read(metadata(value))

    def test_a_non_object_body_refuses(self) -> None:
        bodies: tuple[object, ...] = ([], "ok", 7, None)
        for value in bodies:
            with self.subTest(value=value), self.assertRaises(domain.DomainUnavailable):
                self.read(value)

    def test_the_static_network_map_offers_no_fallback(self) -> None:
        """The claim `domain.py` is built on, checked against the SDK.

        Every entry in the SDK's copy of `x-nexus-networks` carries
        `chain_id=None`, so there is nothing to fall back *to*. If a release ever
        starts shipping one, this fails — which is the right conversation to
        have, because a chain id baked into a client is a value nobody re-reads
        when a network moves.
        """
        from nexus_exchange import Network

        for network in Network:
            with self.subTest(network=network.value):
                self.assertIsNone(domain.fallback_chain_id(network))

    def test_metadata_url_hangs_off_the_configured_base(self) -> None:
        self.assertEqual(
            domain.metadata_url("https://host.example/indexer"),
            "https://host.example/indexer/metadata",
        )
        self.assertEqual(
            domain.metadata_url("https://host.example/indexer/"),
            "https://host.example/indexer/metadata",
        )


class Eip712KnownAnswer(unittest.TestCase):
    """The signed bytes, recomputed from the spec rather than from the SDK."""

    def digest(self, agent: str, expires_at: int, nonce: int, chain_id: int) -> bytes:
        from eth_utils.crypto import keccak

        domain_separator = keccak(
            keccak(text="EIP712Domain(string name,string version,uint256 chainId)")
            + keccak(text="Nexus Exchange")
            + keccak(text="1")
            + chain_id.to_bytes(32, "big")
        )
        hash_struct = keccak(
            keccak(text="RegisterAgent(address agent,uint64 expiresAt,uint64 nonce)")
            + bytes(12)
            + bytes.fromhex(agent[2:])
            + expires_at.to_bytes(32, "big")
            + nonce.to_bytes(32, "big")
        )
        return keccak(b"\x19\x01" + domain_separator + hash_struct)

    def recover(self, digest: bytes, signature: str) -> str:
        """The address that produced `signature` over `digest`.

        `eth_keys` rather than `eth_account`'s private `_recover_hash`: the
        assertion is worth nothing if the thing checking it can change shape
        under a patch release.
        """
        from eth_keys.datatypes import Signature

        raw = bytes.fromhex(signature[2:])
        # `r || s || v` with `v in {27, 28}` (Ethereum convention); `eth_keys`
        # wants the 0/1 recovery id.
        vrs = (
            raw[64] - 27,
            int.from_bytes(raw[0:32], "big"),
            int.from_bytes(raw[32:64], "big"),
        )
        public_key = Signature(vrs=vrs).recover_public_key_from_msg_hash(digest)
        return "0x" + public_key.to_canonical_address().hex()

    def test_the_signature_recovers_to_the_wallet_under_the_read_domain(self) -> None:
        from nexus_exchange import EthSigner

        wallet = EthSigner.from_hex(WALLET_KEY)
        agent = EthSigner.from_hex(AGENT_KEY)
        registration = wallet.register_agent(
            agent=agent.address, expires_at_ms=1_800_000_000_000, nonce=7, chain_id=11155111
        )
        recovered = self.recover(
            self.digest(agent.address, 1_800_000_000_000, 7, 11155111),
            registration.signature,
        )
        self.assertEqual(recovered, wallet.address)

    def test_the_same_signature_does_not_recover_under_another_chain_id(self) -> None:
        """The security property, stated as an experiment rather than a claim.

        Verify the testnet signature against the mainnet digest and the address
        that comes back is not the wallet's — which is what "a registration
        signed for one network does not verify on another" actually means.
        """
        from nexus_exchange import EthSigner

        wallet = EthSigner.from_hex(WALLET_KEY)
        agent = EthSigner.from_hex(AGENT_KEY)
        registration = wallet.register_agent(
            agent=agent.address, expires_at_ms=1_800_000_000_000, nonce=7, chain_id=11155111
        )
        elsewhere = self.recover(
            self.digest(agent.address, 1_800_000_000_000, 7, 1),
            registration.signature,
        )
        self.assertNotEqual(elsewhere, wallet.address)

    def test_a_different_chain_id_is_a_different_signature(self) -> None:
        """Why replaying a registration across networks cannot work.

        The chain id is inside the digest, so the same agent, expiry and nonce
        signed for another network produce different bytes — which is exactly
        what makes a registration network-scoped, and why one must never be
        carried across.
        """
        from nexus_exchange import EthSigner

        wallet = EthSigner.from_hex(WALLET_KEY)
        agent = EthSigner.from_hex(AGENT_KEY)
        one, other = (
            wallet.register_agent(
                agent=agent.address, expires_at_ms=1_800_000_000_000, nonce=7, chain_id=cid
            )
            for cid in (11155111, 1)
        )
        self.assertNotEqual(one.signature, other.signature)

    def test_the_sdk_refuses_to_sign_without_a_chain_id(self) -> None:
        """The refusal is the SDK's too, so this app is a second gate, not the only one."""
        from nexus_exchange import AuthError, EthSigner

        wallet = EthSigner.from_hex(WALLET_KEY)
        for bad in (None, 0, True):
            with self.subTest(chain_id=bad), self.assertRaises(AuthError):
                wallet.register_agent(
                    agent=EthSigner.from_hex(AGENT_KEY).address,
                    expires_at_ms=1_800_000_000_000,
                    nonce=7,
                    chain_id=bad,  # type: ignore[arg-type]
                )

    def test_the_registration_body_omits_nothing_the_endpoint_needs(self) -> None:
        from nexus_exchange import EthSigner

        wallet = EthSigner.from_hex(WALLET_KEY)
        body = wallet.register_agent(
            agent=EthSigner.from_hex(AGENT_KEY).address,
            expires_at_ms=1_800_000_000_000,
            nonce=7,
            chain_id=11155111,
            label="agent-enrollment-example",
        ).to_dict()
        self.assertEqual(
            sorted(body),
            ["agent", "expires_at", "label", "nonce", "signature", "wallet"],
        )


class ConfigRules(unittest.TestCase):
    VARIABLES = (
        "NEXUS_EXCHANGE_API_KEY",
        "NEXUS_EXCHANGE_API_SECRET",
        "NEXUS_EXCHANGE_API_URL",
        "NEXUS_WALLET_PRIVATE_KEY",
        "NEXUS_AGENT_PRIVATE_KEY",
        "NEXUS_AGENT_TTL_DAYS",
        "NEXUS_AGENT_LABEL",
    )

    def setUp(self) -> None:
        self.saved = {name: os.environ.pop(name, None) for name in self.VARIABLES}

    def tearDown(self) -> None:
        for name, value in self.saved.items():
            os.environ.pop(name, None)
            if value is not None:
                os.environ[name] = value

    def complete(self) -> None:
        os.environ["NEXUS_EXCHANGE_API_KEY"] = "k"
        os.environ["NEXUS_EXCHANGE_API_SECRET"] = "00" * 32
        os.environ["NEXUS_WALLET_PRIVATE_KEY"] = WALLET_KEY

    def test_defaults_are_testnet_one_day_and_generated(self) -> None:
        self.complete()
        loaded = config.load([])
        self.assertEqual(loaded.base_url, config.TESTNET_BASE_URL)
        self.assertFalse(loaded.base_url_overridden)
        self.assertEqual(loaded.ttl_days, 1)
        self.assertEqual(loaded.label, config.DEFAULT_LABEL)
        self.assertIsNone(loaded.agent_private_key)

    def test_the_wallet_key_is_required_even_for_a_dry_run(self) -> None:
        with self.assertRaises(ConfigError) as caught:
            config.load(["--dry-run"])
        self.assertIn("NEXUS_WALLET_PRIVATE_KEY", str(caught.exception))

    def test_a_dry_run_needs_no_api_credentials(self) -> None:
        os.environ["NEXUS_WALLET_PRIVATE_KEY"] = WALLET_KEY
        self.assertTrue(config.load(["--dry-run"]).dry_run)

    def test_a_live_run_needs_both_halves_of_the_pair(self) -> None:
        os.environ["NEXUS_WALLET_PRIVATE_KEY"] = WALLET_KEY
        os.environ["NEXUS_EXCHANGE_API_KEY"] = "k"
        with self.assertRaises(ConfigError):
            config.load([])

    def test_a_bad_private_key_never_echoes_its_value(self) -> None:
        """The one parser here that must not quote what it was given."""
        secret = "deadbeef" * 9  # 72 hex chars: wrong length, valid hex
        os.environ["NEXUS_WALLET_PRIVATE_KEY"] = secret
        with self.assertRaises(ConfigError) as caught:
            config.load(["--dry-run"])
        message = str(caught.exception)
        self.assertNotIn(secret, message)
        self.assertNotIn("deadbeef", message)
        self.assertIn("NEXUS_WALLET_PRIVATE_KEY", message)

    def test_ttl_is_bounded_at_both_ends(self) -> None:
        self.complete()
        for value, ok in (("0", False), ("1", True), ("90", True), ("91", False)):
            os.environ["NEXUS_AGENT_TTL_DAYS"] = value
            with self.subTest(days=value):
                if ok:
                    self.assertEqual(config.load([]).ttl_days, int(value))
                else:
                    with self.assertRaises(ConfigError):
                        config.load([])

    def test_ttl_refuses_plausible_nonsense(self) -> None:
        self.complete()
        for value in ("1_0", "1e1", "١٠", "7.0", " 7d"):
            os.environ["NEXUS_AGENT_TTL_DAYS"] = value
            with self.subTest(value=value), self.assertRaises(ConfigError):
                config.load([])

    def test_a_label_that_could_not_be_read_back_is_refused(self) -> None:
        self.complete()
        for value in ("a b", "x" * 65, "sürf"):
            os.environ["NEXUS_AGENT_LABEL"] = value
            with self.subTest(value=value), self.assertRaises(ConfigError):
                config.load([])

    def test_an_override_is_recorded_as_one(self) -> None:
        self.complete()
        os.environ["NEXUS_EXCHANGE_API_URL"] = "http://127.0.0.1:9999"
        loaded = config.load([])
        self.assertEqual(loaded.base_url, "http://127.0.0.1:9999")
        self.assertTrue(loaded.base_url_overridden)

    def test_near_misses_for_dry_run_are_refused_not_ignored(self) -> None:
        for argv in (["--dryrun"], ["-dry-run"], ["--dry-run=true"], ["--dry"]):
            with self.subTest(argv=argv), self.assertRaises(ConfigError):
                config.parse_args(argv)

    def test_help_wins_over_everything(self) -> None:
        with self.assertRaises(HelpRequested):
            config.parse_args(["--nonsense", "--help"])


class PlanRules(unittest.TestCase):
    """What is decided before anything is sent."""

    def cfg(self, **overrides: Any) -> config.Config:
        base = {
            "base_url": "http://127.0.0.1:1",
            "base_url_overridden": False,
            "wallet_private_key": WALLET_KEY,
            "agent_private_key": AGENT_KEY,
            "api_key": "k",
            "api_secret": "00" * 32,
            "ttl_days": 1,
            "label": "agent-enrollment-example",
            "dry_run": True,
        }
        base.update(overrides)
        return config.Config(**base)  # type: ignore[arg-type]

    def test_a_wallet_delegating_to_itself_is_refused(self) -> None:
        with unittest.mock.patch.object(enroll, "read_chain_id", return_value=11155111):
            with self.assertRaises(ConfigError) as caught:
                enroll.plan(self.cfg(agent_private_key=WALLET_KEY), 1_700_000_000_000)
        self.assertIn("same key", str(caught.exception))

    def test_the_expiry_is_the_ttl_and_the_nonce_is_now(self) -> None:
        now = 1_700_000_000_000
        with unittest.mock.patch.object(enroll, "read_chain_id", return_value=11155111):
            ready = enroll.plan(self.cfg(ttl_days=3), now)
        self.assertEqual(ready.registration.nonce, now)
        self.assertEqual(
            ready.registration.expires_at, now + 3 * enroll.MILLISECONDS_PER_DAY
        )
        self.assertFalse(ready.agent_key_is_ephemeral)

    def test_an_unreadable_domain_stops_before_a_key_is_loaded(self) -> None:
        """No signature, no request, and an exit code that says which.

        The wallet key here is deliberately unusable. If `plan` loaded keys
        before reading the domain, this would fail as a config error instead —
        so the assertion is about *ordering*, which is the property that keeps
        "refused to sign" from ever being followed by a signature.
        """
        def unavailable(base_url: str, timeout: float) -> int:
            raise domain.DomainUnavailable("nope")

        with unittest.mock.patch.object(enroll, "read_chain_id", unavailable):
            with self.assertRaises(enroll.Fatal) as caught:
                enroll.plan(self.cfg(wallet_private_key="zz" * 32), 1_700_000_000_000)
        self.assertEqual(caught.exception.code, enroll.EX_UNAVAILABLE)
        self.assertIn("Refusing to sign", caught.exception.detail)

    def test_a_generated_agent_key_is_not_the_wallet(self) -> None:
        with unittest.mock.patch.object(enroll, "read_chain_id", return_value=11155111):
            ready = enroll.plan(self.cfg(agent_private_key=None), 1_700_000_000_000)
        self.assertTrue(ready.agent_key_is_ephemeral)
        self.assertNotEqual(ready.agent.address, ready.wallet.address)

    def test_the_reported_plan_never_prints_the_signature(self) -> None:
        with unittest.mock.patch.object(enroll, "read_chain_id", return_value=11155111):
            ready = enroll.plan(self.cfg(), 1_700_000_000_000)
        lines: list[str] = []
        with unittest.mock.patch.object(enroll, "log", lines.append):
            enroll.report_plan(self.cfg(), ready)
        printed = "\n".join(lines)
        self.assertNotIn(ready.registration.signature, printed)
        self.assertIn("withheld", printed)
        self.assertIn("chainId=11155111", printed)


class Presentation(unittest.TestCase):
    def test_funds_are_described_exhaustively(self) -> None:
        from nexus_exchange import Funds

        self.assertEqual(enroll.describe_funds(Funds.PLAY), "play funds")
        self.assertEqual(enroll.describe_funds(Funds.REAL), "REAL FUNDS")
        self.assertEqual(enroll.describe_funds(Funds.UNKNOWN), "funds not declared")

    def test_expiries_render_in_utc(self) -> None:
        self.assertEqual(enroll.iso(1_700_000_000_000), "2023-11-14T22:13:20Z")

    def test_one_line_bounds_an_html_error_page(self) -> None:
        html = "<html>\n<head>\n<title>403</title>\n</head>\n" + "x" * 500
        flat = enroll.one_line(html)
        self.assertNotIn("\n", flat)
        self.assertLessEqual(len(flat), 201)

    def test_a_failed_revoke_names_the_address_and_asks_for_a_retry(self) -> None:
        """The one exit that leaves state behind on someone's account."""
        from nexus_exchange import ApiError, Client, Funds, NetworkConfig

        class Refusing(Client):
            def revoke_agent(self, address: str) -> Any:
                raise ApiError(500, "nope")

        client = Refusing(
            NetworkConfig.custom(
                label="test", funds=Funds.UNKNOWN, base_url="http://127.0.0.1:1"
            )
        )
        with self.assertRaises(enroll.Fatal) as caught:
            enroll.revoke(client, "0x" + "ab" * 20)
        self.assertEqual(caught.exception.code, enroll.EX_TEMPFAIL)
        self.assertIn("STILL REGISTERED", caught.exception.detail)
        self.assertIn("0x" + "ab" * 20, caught.exception.detail)


class _Handler(BaseHTTPRequestHandler):
    #: Set per test. Class-level so the handler, which the server instantiates
    #: per request, can reach it without threading state through the server.
    body: dict[str, Any] = {}
    status: int = 200
    #: Every path the server was asked for, so a test can assert on the URL the
    #: app actually composed rather than on what it hoped it would.
    seen: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
        _Handler.seen.append(self.path)
        payload = json.dumps(_Handler.body).encode()
        self.send_response(_Handler.status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: Any) -> None:
        pass


class LoopbackBoundary(unittest.TestCase):
    """Real `httpx` and the real SDK against a real socket."""

    server: HTTPServer
    thread: threading.Thread

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def setUp(self) -> None:
        _Handler.seen.clear()
        _Handler.body = metadata()
        _Handler.status = 200

    def test_the_chain_id_comes_off_the_wire(self) -> None:
        self.assertEqual(domain.read_chain_id(self.base, 5.0), 11155111)
        self.assertEqual(_Handler.seen, ["/metadata"])

    def test_an_error_status_refuses_rather_than_parsing_the_body(self) -> None:
        """A 503 body is not metadata, however JSON-shaped it looks."""
        _Handler.status = 503
        with self.assertRaises(domain.DomainUnavailable) as caught:
            domain.read_chain_id(self.base, 5.0)
        self.assertIn("503", str(caught.exception))

    def test_an_unreachable_host_refuses(self) -> None:
        with self.assertRaises(domain.DomainUnavailable):
            # Port 1 on loopback: nothing listens, and the connection is refused
            # rather than hanging, so this stays fast and offline.
            domain.read_chain_id("http://127.0.0.1:1", 1.0)

    def test_the_metadata_read_follows_the_configured_base_not_the_network(self) -> None:
        """The trap `domain.metadata_url` exists to avoid, pinned.

        `Client(Network.TESTNET, base_url=X)` routes at `X` while
        `client.network.base_url` still reports testnet's own base. An app that
        read the chain id from that field would sign under one host's domain and
        register on another's.
        """
        from nexus_exchange import Client, Network

        client = Client(Network.TESTNET, base_url=self.base)
        self.assertNotEqual(
            client.network.base_url,
            self.base,
            "SDK behaviour changed; revisit domain.metadata_url",
        )
        loaded = config.Config(
            base_url=self.base,
            base_url_overridden=True,
            wallet_private_key=WALLET_KEY,
            agent_private_key=AGENT_KEY,
            api_key="k",
            api_secret="00" * 32,
            ttl_days=1,
            label="agent-enrollment-example",
            dry_run=True,
        )
        ready = enroll.plan(loaded, 1_700_000_000_000)
        self.assertEqual(ready.chain_id, 11155111)

    def test_naming_testnet_keeps_play_funds_while_the_override_does_not(self) -> None:
        """Both halves of `build_client`, against the same socket."""
        from nexus_exchange import Funds

        named = enroll.build_client(self.cfg(overridden=False))
        self.assertIs(named.network.funds, Funds.PLAY)

        overridden = enroll.build_client(self.cfg(overridden=True))
        self.assertIs(overridden.network.funds, Funds.UNKNOWN)
        self.assertEqual(overridden.network.label, enroll.OVERRIDE_LABEL)

    def cfg(self, *, overridden: bool) -> config.Config:
        return config.Config(
            base_url=self.base,
            base_url_overridden=overridden,
            wallet_private_key=WALLET_KEY,
            agent_private_key=AGENT_KEY,
            api_key="k",
            api_secret="00" * 32,
            ttl_days=1,
            label="agent-enrollment-example",
            dry_run=False,
        )

    def test_agent_info_decodes_the_camelcase_wire_shape(self) -> None:
        """`GET /agents` sends camelCase; this app reads snake_case attributes."""
        from nexus_exchange import AgentInfo

        agent = AgentInfo.from_dict(
            {
                "address": "0x" + "ab" * 20,
                "expiresAt": 1_700_000_000_000,
                "registeredAt": 1_699_000_000_000,
                "label": "agent-enrollment-example",
            }
        )
        self.assertEqual(agent.expires_at, 1_700_000_000_000)
        self.assertIn("2023-11-14T22:13:20Z", enroll.describe_agent(agent))
        self.assertIn("agent-enrollment-example", enroll.describe_agent(agent))


if __name__ == "__main__":
    unittest.main()
