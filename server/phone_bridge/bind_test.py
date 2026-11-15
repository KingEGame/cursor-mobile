"""Integration test: phone continues a NON-phone session through the REAL gateway SessionStore
(switch_session, routing index, DB reopen) on a COPY of state.db under a temp HERMES_HOME.

    <gateway venv python> bind_test.py
"""
import asyncio, os, shutil, sqlite3, sys, tempfile, time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="phone_bind_"))
os.environ["HERMES_HOME"] = str(TMP)          # before any hermes import
src = sqlite3.connect("file:" + os.path.expanduser("~/.hermes/state.db") + "?mode=ro", uri=True)
dst = sqlite3.connect(TMP / "state.db"); src.backup(dst); src.close()
dst.execute("DELETE FROM session_turn_leases"); dst.commit(); dst.close()

sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # this checkout's server/
import aiohttp
from gateway.config import GatewayConfig, PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from gateway.session import AsyncSessionStore, SessionStore
from phone_bridge.adapter import PhoneBridgeAdapter, register


class _Ctx:
    def register_platform(self, name, label, adapter_factory, check_fn, validate_config=None,
                          required_env=None, install_hint="", **kw):
        platform_registry.register(PlatformEntry(name=name, label=label, adapter_factory=adapter_factory,
                                                 check_fn=check_fn, validate_config=validate_config,
                                                 required_env=required_env or [], install_hint=install_hint,
                                                 source="plugin", **kw))


register(_Ctx())
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += not ok
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


class Runner:  # the subset of GatewayRunner the bridge touches, backed by the real store
    def __init__(self, store):
        self.session_store = store
        self.async_session_store = AsyncSessionStore(store)
        self._session_db = None
        self.evicted, self.cleared = [], []

    def _session_key_for_source(self, source):
        return self.session_store._generate_session_key(source)

    def _profile_name_for_source(self, source, adapter_profile=None):
        return None

    def _evict_cached_agent(self, key):
        self.evicted.append(key)

    def _clear_conversation_scope(self, key, reason):
        self.cleared.append((key, reason))


async def main():
    db = sqlite3.connect(TMP / "state.db")
    target = db.execute("""SELECT s.id, s.source FROM sessions s WHERE s.source IN ('desktop','cli','telegram','discord')
                           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id)
                           ORDER BY s.started_at DESC LIMIT 1""").fetchone()
    sid, src_name = target
    before_rows = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]

    cfg = GatewayConfig()
    cfg.sessions_dir = TMP / "sessions"; cfg.sessions_dir.mkdir(exist_ok=True)
    store = SessionStore(cfg.sessions_dir, cfg)
    runner = Runner(store)
    port = 18099
    ad = PhoneBridgeAdapter(PlatformConfig(enabled=True, extra={"notify": False, 
        "port": port, "host": "127.0.0.1", "db_path": str(TMP / "state.db"), "devices_path": str(TMP / "devices.json")}))
    ad.gateway_runner = runner
    events = []

    async def fake_handle(ev):
        events.append(ev)
        # What the gateway does first for every inbound turn: resolve the route for this source.
        entry = await runner.async_session_store.get_or_create_session(ev.source)
        ev.routed_session = entry.session_id
    ad.handle_message = fake_handle
    assert await ad.connect()
    base = f"http://127.0.0.1:{port}"
    p = ad._devices.start_pair()
    try:
        async with aiohttp.ClientSession() as http:
            tok = (await (await http.post(f"{base}/v1/pair/complete", json={
                "code": p["code"], "pairId": p["pairId"], "deviceName": "t", "platform": "t", "appVersion": "t"})).json())["deviceToken"]
            H = {"Authorization": f"Bearer {tok}"}
            lst = await (await http.get(f"{base}/v1/sessions?limit=200", headers=H)).json()
            row = next((s for s in lst["items"] if s["id"] == sid), None)
            check(f"{src_name} session is writable from phone", row and row["canSend"] is True)

            r = await http.post(f"{base}/v1/sessions/{sid}/messages", headers=H, json={"text": "from phone", "clientMessageId": "c1"})
            body = await r.json()
            check("send to foreign session accepted", r.status == 202, f"{r.status} {body}")
            await asyncio.sleep(0.3)
            check("inbound event emitted on route r_<sid>", events and events[-1].source.chat_id == f"r_{sid}")
            check("gateway routes that event INTO the target session", getattr(events[-1], "routed_session", None) == sid,
                  f"routed={getattr(events[-1], 'routed_session', None)} target={sid}")
            check("conversation scope reset + agent evicted (like /resume)", runner.cleared and runner.evicted)
            ended = db.execute("SELECT ended_at FROM sessions WHERE id=?", (sid,)).fetchone()[0]
            check("target row is open", ended is None)

            n_evicted = len(runner.evicted)
            r = await http.post(f"{base}/v1/sessions/{sid}/messages", headers=H, json={"text": "again", "clientMessageId": "c2"})
            await asyncio.sleep(0.3)
            check("second message reuses the binding (no re-switch)", r.status == 202 and len(runner.evicted) == n_evicted)
            check("…and still lands in the target", events[-1].routed_session == sid)

            dup = await (await http.post(f"{base}/v1/sessions/{sid}/messages", headers=H, json={"text": "again", "clientMessageId": "c2"})).json()
            check("duplicate clientMessageId deduped", dup.get("duplicate") is True)

            lst2 = await (await http.get(f"{base}/v1/sessions?limit=200", headers=H)).json()
            junk = [s for s in lst2["items"] if s["source"] == "phone" and s["messageCount"] == 0 and s["endedAt"]]
            check("throwaway route rows are hidden from the list", not junk, f"{len(junk)} visible")
            after_rows = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            check("at most one helper row created", after_rows - before_rows <= 1, f"+{after_rows - before_rows}")

            now = time.time()
            db.execute("INSERT INTO session_turn_leases VALUES (?, 'pid=1:turn=x:platform=desktop', ?, ?)", (sid, now, now + 60)); db.commit()
            r = await http.post(f"{base}/v1/sessions/{sid}/messages", headers=H, json={"text": "busy?", "clientMessageId": "c3"})
            b = await r.json()
            check("busy on desktop -> 409 SESSION_BUSY", r.status == 409 and b["error"]["code"] == "SESSION_BUSY", b["error"]["message"])
            db.execute("DELETE FROM session_turn_leases"); db.commit()

            r = await http.post(f"{base}/v1/sessions/nope/messages", headers=H, json={"text": "x"})
            check("unknown session -> 404", r.status == 404)
    finally:
        await ad.disconnect()
        shutil.rmtree(TMP, ignore_errors=True)
    print("\nALL PASSED" if not fails else f"\n{fails} FAILED")
    return 1 if fails else 0


sys.exit(asyncio.run(main()))
