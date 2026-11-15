"""E2E server for the mobile client: real PhoneBridgeAdapter + REAL gateway SessionStore (routing,
switch_session) on a COPY of state.db under a temp HERMES_HOME. A fake agent resolves the route the
way the gateway does and writes like it (user msg, turn lease, tool call, tool result, reply, lease
released). Prints PAIR <pairId> <code> when ready.

    <gateway venv python> e2e_server.py <port>
"""
import asyncio, json, os, sqlite3, sys, tempfile, time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="phone_bridge_e2e_"))
os.environ["HERMES_HOME"] = str(TMP)   # before any hermes import
_src = sqlite3.connect("file:" + os.path.expanduser("~/.hermes/state.db") + "?mode=ro", uri=True)
_dst = sqlite3.connect(TMP / "state.db"); _src.backup(_dst); _src.close()
_dst.execute("PRAGMA journal_mode=WAL"); _dst.execute("DELETE FROM session_turn_leases"); _dst.commit(); _dst.close()

sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # this checkout's server/

from gateway.config import GatewayConfig, PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from gateway.session import AsyncSessionStore, SessionStore
from phone_bridge.adapter import PhoneBridgeAdapter, register


class _Ctx:
    def register_platform(self, name, label, adapter_factory, check_fn, validate_config=None,
                          required_env=None, install_hint="", **kw):
        platform_registry.register(PlatformEntry(
            name=name, label=label, adapter_factory=adapter_factory, check_fn=check_fn,
            validate_config=validate_config, required_env=required_env or [],
            install_hint=install_hint, source="plugin", **kw))


register(_Ctx())
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18098
DB = TMP / "state.db"


class Runner:
    """The subset of GatewayRunner the bridge uses, backed by the real SessionStore."""
    def __init__(self, store):
        self.session_store, self.async_session_store, self._session_db = store, AsyncSessionStore(store), None

    def _session_key_for_source(self, source):
        return self.session_store._generate_session_key(source)

    def _profile_name_for_source(self, source, adapter_profile=None):
        return adapter_profile

    def _evict_cached_agent(self, key): pass
    def _clear_conversation_scope(self, key, reason): pass


async def main() -> None:
    cfg = GatewayConfig()
    cfg.sessions_dir = TMP / "sessions"; cfg.sessions_dir.mkdir(exist_ok=True)
    runner = Runner(SessionStore(cfg.sessions_dir, cfg))
    ad = PhoneBridgeAdapter(PlatformConfig(enabled=True, extra={
        "port": PORT, "host": "127.0.0.1", "db_path": str(DB), "devices_path": str(TMP / "devices.json")}))
    ad.gateway_runner = runner

    async def fake_agent(event):
        sid = (await runner.async_session_store.get_or_create_session(event.source)).session_id
        text, now = event.text, time.time()
        c = sqlite3.connect(DB)
        c.execute("INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)", (sid, text, now))
        c.execute("INSERT OR REPLACE INTO session_turn_leases VALUES (?, 'pid=0:turn=e2e:platform=phone', ?, ?)",
                  (sid, now, now + 60))
        c.commit()
        await asyncio.sleep(1.2)
        calls = json.dumps([{"id": "t1", "function": {"name": "terminal", "arguments": "{}"}}])
        c.execute("INSERT INTO messages(session_id, role, content, tool_calls, timestamp) VALUES (?, 'assistant', '', ?, ?)",
                  (sid, calls, time.time()))
        c.execute("INSERT INTO messages(session_id, role, content, tool_name, tool_call_id, timestamp)"
                  " VALUES (?, 'tool', 'ok', 'terminal', 't1', ?)", (sid, time.time()))
        c.commit()
        await asyncio.sleep(0.8)
        c.execute("INSERT INTO messages(session_id, role, content, finish_reason, timestamp)"
                  " VALUES (?, 'assistant', ?, 'stop', ?)", (sid, f"**echo:** {text}", time.time()))
        c.execute("UPDATE sessions SET message_count = message_count + 4 WHERE id=?", (sid,))
        c.execute("DELETE FROM session_turn_leases WHERE conversation_id=?", (sid,))
        c.commit(); c.close()
        await ad.send(event.source.chat_id, "done")

    ad.handle_message = fake_agent
    assert await ad.connect(), "adapter failed to start"
    p = ad._devices.start_pair()
    print(f"PAIR {p['pairId']} {p['code']}", flush=True)
    while True:
        await asyncio.sleep(3600)


asyncio.run(main())
