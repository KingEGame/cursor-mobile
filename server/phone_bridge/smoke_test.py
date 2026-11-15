"""End-to-end smoke test for the phone bridge. Runs against a COPY of state.db, never the live one.

    <gateway venv python> ~/.hermes/plugins/phone_bridge/smoke_test.py
"""
import asyncio, json, os, shutil, sqlite3, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # this checkout's server/

import aiohttp
from gateway.config import PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from phone_bridge.adapter import PhoneBridgeAdapter, register


class _Ctx:
    """Registers the plugin exactly like PluginContext.register_platform (minus the manager bookkeeping)."""
    def register_platform(self, name, label, adapter_factory, check_fn, validate_config=None,
                          required_env=None, install_hint="", **kw):
        platform_registry.register(PlatformEntry(
            name=name, label=label, adapter_factory=adapter_factory, check_fn=check_fn,
            validate_config=validate_config, required_env=required_env or [],
            install_hint=install_hint, source="plugin", **kw))


register(_Ctx())



async def wait_event(ws, pred, timeout=8.0):
    """First event satisfying pred; also returns every event seen (for diagnostics)."""
    seen, end = [], time.time() + timeout
    while time.time() < end:
        try:
            ev = await ws.receive_json(timeout=max(0.1, end - time.time()))
        except asyncio.TimeoutError:
            break
        seen.append(ev)
        if pred(ev):
            return ev, seen
    return None, seen

PORT = 18097
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


async def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="phone_bridge_smoke_"))
    src = sqlite3.connect("file:" + os.path.expanduser("~/.hermes/state.db") + "?mode=ro", uri=True)
    dst = sqlite3.connect(tmp / "state.db")
    src.backup(dst); src.close()
    dst.execute("PRAGMA journal_mode=WAL"); dst.commit()

    cfg = PlatformConfig(enabled=True, extra={"notify": False, "port": PORT, "host": "127.0.0.1",
                                              "db_path": str(tmp / "state.db"),
                                              "devices_path": str(tmp / "devices.json"), "projects_path": str(tmp / "projects.json")})
    os.environ["PHONE_BRIDGE_PROJECTS_PATH"] = str(tmp / "projects.json")
    os.environ["PHONE_BRIDGE_DB_PATH"] = str(tmp / "state.db")
    ad = PhoneBridgeAdapter(cfg)
    captured = []
    async def fake_handle(event):            # the real one would run the agent
        captured.append(event)
    ad.handle_message = fake_handle
    check("connect()", await ad.connect())
    check("test server never pops desktop notifications", ad._notify is False)
    base = f"http://127.0.0.1:{PORT}"
    try:
        async with aiohttp.ClientSession() as http:
            h = await (await http.get(f"{base}/v1/health")).json()
            check("health public", h["ok"] and h["pairing"]["required"])

            r = await http.get(f"{base}/v1/sessions")
            check("sessions without token -> 401", r.status == 401, str(r.status))

            start = await (await http.post(f"{base}/v1/pair/start", json={})).json()
            bad = await http.post(f"{base}/v1/pair/complete", json={"code": "00000000", "deviceName": "x"})
            check("wrong pair code rejected", bad.status == 400, str(bad.status))
            done = await (await http.post(f"{base}/v1/pair/complete", json={
                "code": start["code"], "pairId": start["pairId"], "deviceName": "Pixel 7",
                "platform": "android", "appVersion": "t"})).json()
            tok = done["deviceToken"]; H = {"Authorization": f"Bearer {tok}"}
            check("pair/complete issues token", bool(tok) and done["deviceId"].startswith("dev_"))
            again = await http.post(f"{base}/v1/pair/complete", json={"code": start["code"], "deviceName": "y"})
            check("pair code is one-time", again.status == 400, str(again.status))
            check("devices.json is 0600", oct((tmp / "devices.json").stat().st_mode & 0o777) == "0o600",
                  oct((tmp / "devices.json").stat().st_mode & 0o777))
            check("token stored hashed", tok not in (tmp / "devices.json").read_text())

            sess = await (await http.get(f"{base}/v1/sessions?limit=5", headers=H)).json()
            check("sessions list returns items", len(sess["items"]) > 0, f"{len(sess['items'])} items")
            first = sess["items"][0]
            check("session has status/updatedAt/preview",
                  first["status"] in ("working", "idle", "ended") and first["updatedAt"], first["status"])
            hidden = [i for i in sess["items"] if i["source"] in ("subagent", "oneshot", "kanban")]
            check("internal sources hidden by default", not hidden)

            m = await (await http.get(f"{base}/v1/sessions/{first['id']}/messages?limit=3", headers=H)).json()
            check("messages tail", 0 < len(m["messages"]) <= 3, f"{len(m['messages'])} msgs")

            # ---- projects (real ~/.hermes/projects.db, read-only) ----------
            pj = await (await http.get(f"{base}/v1/projects", headers=H)).json()
            slugs = {x["slug"]: x for x in pj["items"]}
            check("projects listed from projects.db", "hub-app" in slugs and slugs["hub-app"]["path"], f"{len(slugs)} projects")
            hub = await (await http.get(f"{base}/v1/sessions?project=hub-app&limit=50", headers=H)).json()
            check("project filter matches /mnt/data vs /data spellings (realpath)",
                  hub["items"] and all(i["project"]["slug"] == "hub-app" for i in hub["items"]), f"{len(hub['items'])} sessions")
            check("project session count agrees with filter", slugs["hub-app"]["sessionCount"] == len(hub["items"]))
            anyp = await (await http.get(f"{base}/v1/sessions?limit=50", headers=H)).json()
            check("plain list carries project tags", any(i.get("project") for i in anyp["items"]) and "_cwd" not in anyp["items"][0])
            nc = await http.post(f"{base}/v1/chats", headers=H, json={"project": "hub-app"})
            ncj = await nc.json()
            check("new chat inside a project", nc.status == 201 and ncj["project"]["slug"] == "hub-app")
            nc404 = await http.post(f"{base}/v1/chats", headers=H, json={"project": "no-such-project"})
            check("unknown project -> 404", nc404.status == 404, str(nc404.status))
            from phone_bridge.adapter import _project_prompt_section, _is_home_channel_nag
            ad._chat_projects.set_session("smoke_proj_sid", "hub-app")
            check("project choice stays in the test store", "smoke_proj_sid" in (tmp / "projects.json").read_text())
            sec = _project_prompt_section({"platform": "phone", "session_id": "smoke_proj_sid"})
            check("system-prompt section names the project folder", "Hub APP" in sec and "/data/projects/cursor_mobile" in sec, sec[:60])
            check("no section for other platforms / unknown chats",
                  _project_prompt_section({"platform": "telegram", "session_id": "smoke_proj_sid"}) == ""
                  and _project_prompt_section({"platform": "phone", "session_id": "nope"}) == "")
            check("home-channel hint is filtered", _is_home_channel_nag("\U0001F4EC No home channel is set for Phone. Type /sethome …")
                  and not _is_home_channel_nag("hello /sethome"))

            # ---- websocket: live push + status + replay -------------------
            cursor0 = (await (await http.get(f"{base}/v1/health")).json())["cursor"]
            ws = await http.ws_connect(f"{base}/v1/ws?access_token={tok}")
            await ws.send_json({"type": "client.hello", "sessions": []})
            hello = await ws.receive_json(timeout=5)
            check("ws server.hello", hello["type"] == "server.hello" and hello["cursor"] >= cursor0)
            snap = await ws.receive_json(timeout=5)
            check("ws status.snapshot", snap["type"] == "status.snapshot")

            sid = "smoke_session_1"
            dst.execute("INSERT INTO sessions (id, source, chat_id, started_at, message_count) VALUES (?,?,?,?,0)",
                        (sid, "phone", "p_smoke", time.time()))
            dst.execute("INSERT INTO session_turn_leases (conversation_id, holder, acquired_at, expires_at) VALUES (?,?,?,?)",
                        (sid, "smoke", time.time(), time.time() + 600))
            dst.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)",
                        (sid, "user", "привет с телефона", time.time()))
            dst.commit()
            ad._wake.set()
            ev_msg, seen1 = await wait_event(ws, lambda e: e["type"] == "message.created" and e["sessionId"] == sid)
            check("ws pushes message.created from DB", ev_msg and ev_msg["message"]["content"] == "привет с телефона")
            ev_w, more = await wait_event(ws, lambda e: e["type"] == "session.updated" and e["sessionId"] == sid) \
                if not any(e["type"] == "session.updated" and e["sessionId"] == sid for e in seen1) else (
                next(e for e in seen1 if e["type"] == "session.updated" and e["sessionId"] == sid), [])
            check("ws pushes status=working while lease live", ev_w and ev_w["status"] == "working",
                  str(ev_w and ev_w["status"]))

            dst.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?,?,?,?,?)",
                        (sid, "assistant", "готово", time.time(), "stop"))
            dst.execute("UPDATE session_turn_leases SET expires_at = ? WHERE conversation_id = ?", (time.time() - 1, sid))
            dst.commit(); ad._wake.set()
            su, seen2 = await wait_event(ws, lambda e: e["type"] == "session.updated" and e["sessionId"] == sid
                                                        and e["status"] == "idle")
            check("ws pushes status=idle when turn finished", su is not None,
                  "got: " + ",".join(f"{e['type']}:{e.get('sessionId','')[:12]}:{e.get('status','')}" for e in seen2[-5:]))
            check("idle event carries last message", su and (su.get("lastMessage") or {}).get("content") == "готово")
            await ws.close()

            # replay: reconnect with an old cursor, must receive the 2 messages again
            ws2 = await http.ws_connect(f"{base}/v1/ws?access_token={tok}")
            await ws2.send_json({"type": "client.hello", "sessions": [sid], "since": cursor0})
            replayed = []
            for _ in range(6):
                try:
                    ev = await ws2.receive_json(timeout=1.5)
                except asyncio.TimeoutError:
                    break
                if ev["type"] == "message.created" and ev.get("replay"):
                    replayed.append(ev["message"]["content"])
            check("reconnect replays missed messages via since", replayed == ["привет с телефона", "готово"], str(replayed))
            await ws2.close()

            # ---- phone -> agent ------------------------------------------
            chat = (await (await http.post(f"{base}/v1/chats", headers=H, json={})).json())["chatId"]
            r = await http.post(f"{base}/v1/chats/{chat}/messages", headers=H,
                                json={"text": "что нового?", "clientMessageId": "c1"})
            await asyncio.sleep(0.2)
            check("send accepted 202", r.status == 202, str(r.status))
            check("inbound event reaches gateway", len(captured) == 1 and captured[0].text == "что нового?"
                  and captured[0].source.platform.value == "phone" and captured[0].source.chat_id == chat)
            dup = await (await http.post(f"{base}/v1/chats/{chat}/messages", headers=H,
                                         json={"text": "что нового?", "clientMessageId": "c1"})).json()
            check("duplicate clientMessageId deduped", dup.get("duplicate") is True and len(captured) == 1)
            await http.post(f"{base}/v1/chats/{chat}/messages", headers=H, json={"text": "/stop"})
            await asyncio.sleep(0.2)
            check("slash command passes through as COMMAND", captured[-1].message_type.value == "command",
                  captured[-1].message_type.value)

            # ---- live channel: streaming previews / command replies (not persisted) ----
            ws3 = await http.ws_connect(f"{base}/v1/ws?access_token={tok}")
            await ws3.send_json({"type": "client.hello", "sessions": []})
            await ws3.receive_json(timeout=5); await ws3.receive_json(timeout=5)
            sr = await ad.send("p_smoke", "Думаю ▉")
            ev, _ = await wait_event(ws3, lambda e: e["type"] == "live.update")
            check("send() pushes live.update with session", ev and ev["text"] == "Думаю ▉" and ev["chatId"] == "p_smoke"
                  and ev["sessionId"] == sid and ev["liveId"] == sr.message_id, str(ev))
            er = await ad.edit_message("p_smoke", sr.message_id, "Думаю, готово", finalize=True)
            ev, _ = await wait_event(ws3, lambda e: e["type"] == "live.update" and e.get("final"))
            check("edit_message() streams into the same bubble", er.success and ev and ev["liveId"] == sr.message_id
                  and ev["text"] == "Думаю, готово")
            await ad.delete_message("p_smoke", sr.message_id)
            ev, _ = await wait_event(ws3, lambda e: e["type"] == "live.remove")
            check("delete_message() pushes live.remove", ev and ev["liveId"] == sr.message_id)
            await ws3.close()

            h2 = await (await http.get(f"{base}/v1/health")).json()
            check("health lists phone-reachable addresses", isinstance(h2["hub"].get("addresses"), list)
                  and all(a.startswith("http://") for a in h2["hub"]["addresses"]) and h2["pairing"]["oneTap"],
                  ",".join(h2["hub"].get("addresses", [])))

            # ---- one-tap pairing: phone asks, PC owner allows ----
            req = await (await http.post(f"{base}/v1/pair/request", json={
                "deviceName": "Pixel <img src=x>", "platform": "android", "appVersion": "t"})).json()
            check("pair request returns id + 4-digit confirm", len(req["requestId"]) >= 20 and len(req["confirm"]) == 4)
            st0 = await (await http.get(f"{base}/v1/pair/request/{req['requestId']}")).json()
            check("status pending until the PC decides", st0["status"] == "pending")
            lst = await (await http.get(f"{base}/pair/requests")).json()
            mine = [x for x in lst["items"] if x["id"] == req["requestId"]]
            check("PC page lists it with the same confirm code", mine and mine[0]["confirm"] == req["confirm"])
            evil = await http.post(f"{base}/pair/requests/{req['requestId']}/approve",
                                   headers={"Origin": "http://evil.example"})
            check("cross-site approve refused (CSRF)", evil.status == 403, str(evil.status))
            ok = await http.post(f"{base}/pair/requests/{req['requestId']}/approve",
                                 headers={"Origin": f"http://127.0.0.1:{PORT}"})
            check("PC approve accepted", ok.status == 200, str(ok.status))
            st1 = await (await http.get(f"{base}/v1/pair/request/{req['requestId']}")).json()
            tok2 = st1.get("deviceToken")
            check("phone collects token after approval", st1["status"] == "approved" and tok2
                  and st1["hub"]["hubId"] == h2["hub"]["hubId"])
            st2 = await (await http.get(f"{base}/v1/pair/request/{req['requestId']}")).json()
            check("token handed out exactly once", st2["status"] == "expired" and "deviceToken" not in st2)
            r2 = await http.get(f"{base}/v1/sessions?limit=1", headers={"Authorization": f"Bearer {tok2}"})
            check("one-tap token works", r2.status == 200, str(r2.status))
            req2 = await (await http.post(f"{base}/v1/pair/request", json={"deviceName": "x"})).json()
            await http.post(f"{base}/pair/requests/{req2['requestId']}/deny")
            st3 = await (await http.get(f"{base}/v1/pair/request/{req2['requestId']}")).json()
            check("deny is reported to the phone", st3["status"] == "denied" and "deviceToken" not in st3)
            rv = await http.post(f"{base}/v1/device/revoke", headers={"Authorization": f"Bearer {tok2}"})
            after = await http.get(f"{base}/v1/sessions?limit=1", headers={"Authorization": f"Bearer {tok2}"})
            check("phone can revoke its own token", rv.status == 200 and after.status == 401, f"{rv.status}/{after.status}")
    finally:
        await ad.disconnect()
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; FAILED: {failed}" if failed else ""))
    return 1 if failed else 0


sys.exit(asyncio.run(main()))
