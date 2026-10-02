#!/usr/bin/env python3
"""Exclusive Pixel re-pair via UI fill (digit keyevents for pair code).

Installed APK deep-link auto-pair / token-inject stays on Pair screen.
This path previously reached State: Ready (2026-09-30).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import urllib.request

PIXEL = "33080DLH20007Y"
HUB = "http://100.108.160.99:8787"
PKG = "local.cursor.mobile"


def adb(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["adb", "-s", PIXEL, *args],
        text=True,
        capture_output=True,
    )


def ui() -> str:
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    time.sleep(0.7)
    adb("pull", "/sdcard/ui.xml", "/tmp/pair-ui-excl.xml")
    try:
        return open("/tmp/pair-ui-excl.xml", encoding="utf-8", errors="replace").read()
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


def find_edit_by_desc(desc: str, xml: str | None = None) -> re.Match[str] | None:
    xml = xml or ui()
    pat = (
        rf'<node\b(?=[^>]*class="[^"]*EditText")'
        rf'(?=[^>]*content-desc="{re.escape(desc)}")'
        rf'(?=[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]")[^>]*>'
    )
    return re.search(pat, xml)


def tap(attr: str, value: str, tries: int = 5) -> bool:
    for _ in range(tries):
        b = find_bounds(attr, value)
        if b:
            adb("shell", "input", "tap", str(b[0]), str(b[1]))
            return True
        time.sleep(1)
    return False


def tap_edit(m: re.Match[str]) -> None:
    x1, y1, x2, y2 = map(int, m.groups())
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def unlock() -> None:
    adb("shell", "input", "keyevent", "224")
    time.sleep(0.3)
    adb("shell", "wm", "dismiss-keyguard")
    time.sleep(0.3)
    adb("shell", "input", "keyevent", "82")
    time.sleep(0.2)


def field_text(desc: str, xml: str | None = None) -> str:
    m = find_edit_by_desc(desc, xml)
    if not m:
        return ""
    tm = re.search(r'text="([^"]*)"', m.group(0))
    return tm.group(1) if tm else ""


def type_digits(code: str) -> None:
    m = find_edit_by_desc("Pair code")
    if not m:
        raise RuntimeError("Pair code EditText missing")
    tap_edit(m)
    time.sleep(0.4)
    adb(
        "shell",
        "sh",
        "-c",
        "input keyevent 123; i=0; while [ $i -lt 24 ]; do input keyevent 67; i=$((i+1)); done",
    )
    for ch in code:
        adb("shell", "input", "keyevent", str(7 + int(ch)))
        time.sleep(0.05)
    adb("shell", "input", "keyevent", "111")
    time.sleep(0.3)
    shown = field_text("Pair code")
    if shown != code:
        raise RuntimeError(f"Pair code fill miss: {shown!r} want {code!r}")


def main() -> int:
    print("start exclusive-uifill", flush=True)
    unlock()
    req = urllib.request.Request(
        "http://127.0.0.1:8787/v1/pair/start",
        data=b"{}",
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        pair = json.loads(r.read())
    code = pair["code"]
    print(f"code {code} id {pair['pairId']}", flush=True)

    adb("shell", "pm", "clear", PKG)
    time.sleep(1)
    unlock()
    adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "cursor-companion://health",
        "-f",
        "0x14008000",
        "-n",
        f"{PKG}/.MainActivity",
    )
    time.sleep(4)
    unlock()

    xml = ui()
    print("launch", texts(xml)[:12], flush=True)
    if not find_edit_by_desc("Hub base URL", xml):
        tap("resource-id", "health-repair") or tap("text", "Go to Pair") or tap(
            "content-desc", "Pair"
        )
        time.sleep(2)
        xml = ui()
        print("after-nav", texts(xml)[:12], flush=True)

    hub = field_text("Hub base URL")
    print(f"hub field {hub!r}", flush=True)
    if hub.strip() != HUB:
        m = find_edit_by_desc("Hub base URL")
        if not m:
            print("FAIL no Hub URL field", flush=True)
            return 2
        tap_edit(m)
        time.sleep(0.3)
        adb(
            "shell",
            "sh",
            "-c",
            "input keycombination 113 29 || true; "
            "input keyevent 122; "
            "i=0; while [ $i -lt 80 ]; do input keyevent 112; i=$((i+1)); done",
        )
        esc = HUB.replace(":", "\\:").replace("/", "\\/")
        adb("shell", "input", "text", esc)
        adb("shell", "input", "keyevent", "111")
        time.sleep(0.3)
        hub = field_text("Hub base URL")
        print(f"hub after type {hub!r}", flush=True)
        if hub.strip() != HUB:
            print("FAIL hub URL", flush=True)
            return 3

    try:
        type_digits(code)
    except RuntimeError as e:
        print(f"FAIL {e}", flush=True)
        return 3
    print(f"fields code={field_text('Pair code')!r}", flush=True)

    if not (
        tap("content-desc", "Pair")
        or tap("text", "Pair device")
        or tap("text", "Pair")
    ):
        print("FAIL pair button", texts()[:20], flush=True)
        return 4

    for i in range(20):
        time.sleep(2)
        ts = texts()
        joined = " | ".join(ts)
        interesting = [
            t
            for t in ts
            if any(k in t for k in ("State", "Ready", "Error", "Workspace", "Hub", "NETWORK", "INVALID"))
        ]
        print(f"wait {i}", interesting[:10], flush=True)
        if "State: Ready" in joined:
            print("RESULT PASS", flush=True)
            return 0
        tap("resource-id", "health-refresh", tries=1)
        tap("content-desc", "health-refresh", tries=1)
    print("RESULT FAIL", flush=True)
    return 5


if __name__ == "__main__":
    raise SystemExit(main())
