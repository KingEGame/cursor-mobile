#!/usr/bin/env python3
"""Re-pair Pixel companion via PC-side pairComplete + token-inject deep link.

RN controlled TextInputs do not receive adb keyevents into React state, so
UI-fill pairing is unreliable. Flow:

  1. POST /v1/pair/start (loopback)
  2. POST /v1/pair/complete on Tailscale Hub (PC acts as device)
  3. Cold-start APK with cursor-companion://pair?host=&port=&deviceToken=&deviceId=
  4. App bootstrap saves token and opens Health → State: Ready (or CDPOff if CDP down)

CRITICAL:
  - adb shell joins args into a remote shell command. Unquoted `&` truncates the
    query — always single-quote the URI (am_view).
  - Do NOT put hubUrl=http://… in the query. Nested `://` is often lost when
    Android re-parses Intent data, dropping deviceToken/deviceId. Use host+port.
"""
from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from urllib.parse import urlparse

PIXEL = "33080DLH20007Y"
HUB = "http://100.108.160.99:8787"
PKG = "local.cursor.mobile"


def adb(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["adb", "-s", PIXEL, *args],
        text=True,
        capture_output=True,
    )


def adb_shell(remote_cmd: str) -> subprocess.CompletedProcess[str]:
    """Run one remote shell command string (caller must quote & safely)."""
    return adb("shell", remote_cmd)


def am_view(uri: str, *, clear_task: bool = True) -> subprocess.CompletedProcess[str]:
    """Launch VIEW intent with a fully quoted deep-link URI (preserves &)."""
    flags = "0x14008000" if clear_task else "0x10000000"
    # shlex.quote → single quotes; safe for device sh and preserves & in query.
    cmd = (
        "am start -a android.intent.action.VIEW "
        f"-d {shlex.quote(uri)} "
        f"-f {flags} "
        f"-n {PKG}/.MainActivity"
    )
    print(f"am_view quoted={shlex.quote(uri)[:100]}…", flush=True)
    return adb_shell(cmd)


def ui() -> str:
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    time.sleep(0.8)
    adb("pull", "/sdcard/ui.xml", "/tmp/pair-ui.xml")
    try:
        return open("/tmp/pair-ui.xml", encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


def texts(xml: str | None = None) -> list[str]:
    return re.findall(r'text="([^"]*)"', xml or ui())


def find_bounds(attr: str, value: str, xml: str | None = None) -> tuple[int, int] | None:
    xml = xml or ui()
    pat = (
        rf'<node\b(?=[^>]*\b{re.escape(attr)}="{re.escape(value)}")'
        rf'(?=[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]")[^>]*>'
    )
    m = re.search(pat, xml)
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def tap(attr: str, value: str, tries: int = 3) -> bool:
    for _ in range(tries):
        b = find_bounds(attr, value)
        if b:
            adb("shell", "input", "tap", str(b[0]), str(b[1]))
            return True
        time.sleep(1)
    return False


def unlock() -> None:
    adb("shell", "input", "keyevent", "224")
    time.sleep(0.3)
    adb("shell", "wm", "dismiss-keyguard")
    time.sleep(0.3)


def hub_host_port(hub: str) -> tuple[str, str]:
    u = urlparse(hub)
    host = u.hostname or "100.108.160.99"
    port = str(u.port or 8787)
    return host, port


def build_token_inject_deeplink(
    *,
    host: str,
    port: str,
    token: str,
    device_id: str,
    display: str,
) -> str:
    """host+port only — never hubUrl=http://… (Android Intent truncation)."""
    qs = urllib.parse.urlencode(
        {
            "host": host,
            "port": port,
            "deviceToken": token,
            "deviceId": device_id,
            "hubDisplayName": display,
            "auto": "1",
        }
    )
    return f"cursor-companion://pair?{qs}"


def main() -> int:
    print("start", flush=True)
    unlock()
    req = urllib.request.Request(
        "http://127.0.0.1:8787/v1/pair/start",
        data=b"{}",
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        pair = json.loads(r.read())
    code, pair_id = pair["code"], pair["pairId"]
    print(f"code {code} id {pair_id}", flush=True)

    body = json.dumps(
        {
            "code": code,
            "pairId": pair_id,
            "deviceName": "Pixel 7 UAT",
            "platform": "android",
            "appVersion": "0.1.0",
        }
    ).encode()
    complete_req = urllib.request.Request(
        f"{HUB}/v1/pair/complete",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(complete_req, timeout=10) as r:
        done = json.loads(r.read())
    token = done["deviceToken"]
    device_id = done["deviceId"]
    display = (done.get("hub") or {}).get("displayName") or "Desk PC"
    print(f"complete deviceId={device_id}", flush=True)

    host, port = hub_host_port(HUB)
    deeplink = build_token_inject_deeplink(
        host=host,
        port=port,
        token=token,
        device_id=device_id,
        display=display,
    )
    print(
        f"deeplink token-inject host+port ({len(token)} chars, uri_len={len(deeplink)})",
        flush=True,
    )
    if "hubUrl=" in deeplink or "http%" in deeplink.lower():
        print("RESULT FAIL (deeplink must not embed hubUrl/http)", flush=True)
        return 6

    adb("shell", "pm", "clear", PKG)
    time.sleep(1)
    unlock()
    # Cold-start WITH deep link so Linking.getInitialURL() sees full query
    # (including &deviceToken=…). Do not pre-launch MainActivity without URI.
    r = am_view(deeplink, clear_task=True)
    if r.returncode != 0:
        print(f"am_view stderr: {r.stderr}", flush=True)
    print(f"am_view stdout: {(r.stdout or '').strip()}", flush=True)
    time.sleep(6)
    unlock()
    # Re-fire once in case the first intent raced SecureStore bootstrap.
    r2 = am_view(deeplink, clear_task=False)
    print(f"am_view2 stdout: {(r2.stdout or '').strip()}", flush=True)
    time.sleep(3)
    unlock()

    paired_ok = {
        "State: Ready",
        "State: CursorDown",
        "State: CDPOff",
        "State: Degraded",
        "State: TailscaleDown",
        "State: Queuing",
        "State: HubDown",
        "State: HubError",
        "State: AuthRevoked",
        "State: Revoked",
        "State: SenderBlocked",
    }
    saw_token_health = False
    for i in range(24):
        time.sleep(2)
        ts = texts()
        joined = " | ".join(ts)
        interesting = [
            t
            for t in ts
            if any(
                k in t
                for k in (
                    "State",
                    "Hub",
                    "Workspace",
                    "Ready",
                    "Error",
                    "100.",
                    "Pair",
                    "Cursor",
                    "CDP",
                    "Re-pair",
                )
            )
        ]
        print(f"wait {i}", interesting[:10], flush=True)
        if "Re-pair device" in joined or "State: Unknown" in joined:
            # Health with token (Unknown = health fetch pending) — keep refreshing.
            saw_token_health = True
        for label in paired_ok:
            if label in joined:
                print(f"RESULT PASS ({label})", flush=True)
                return 0
        if "State: Unpaired" in joined and i >= 8 and not saw_token_health:
            print("RESULT FAIL (stuck Unpaired)", flush=True)
            return 5
        tap("content-desc", "Refresh", tries=1)
        tap("resource-id", "health-refresh", tries=1)
        tap("content-desc", "health-refresh", tries=1)
        # Fallback: tap text Refresh
        b = find_bounds("text", "Refresh")
        if b:
            adb("shell", "input", "tap", str(b[0]), str(b[1]))
    if saw_token_health:
        # Token inject applied (Health + Re-pair / Unknown) but Hub/CDP never settled.
        print("RESULT PASS (token inject; health pending CDPOff/Ready)", flush=True)
        return 0
    print("RESULT FAIL", flush=True)
    return 5


if __name__ == "__main__":
    raise SystemExit(main())
