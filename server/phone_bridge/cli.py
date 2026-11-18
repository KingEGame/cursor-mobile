#!/usr/bin/env python3
"""
CLI entry point for `hermes phone devices list/revoke`.

Usage:
    hermes phone devices list                        # list all paired devices
    hermes phone devices revoke <device-id>          # revoke a device token
    hermes phone devices fingerprint                 # show TLS certificate fingerprint

Requires a running Hermes Gateway on the same machine (connects via localhost).
The token comes from ~/.hermes/phone_bridge/devices.json.
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path


def _hermes_home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def _load_devices(path: Path) -> dict:
    try:
        return json.loads(path.read_text("utf-8")).get("devices", {})
    except (OSError, ValueError):
        return {}


def cmd_list(args) -> None:
    path = args.devices_path or _hermes_home() / "phone_bridge" / "devices.json"
    devices = _load_devices(path)
    if not devices:
        print("No paired devices.")
        return
    print(f"Paired devices ({len(devices)}):")
    print()
    for did, d in sorted(devices.items(), key=lambda x: x[1].get("name", "")):
        name = d.get("name", "?")
        platform = d.get("platform", "?")
        app_ver = d.get("appVersion", "?")
        created = d.get("createdAt", "?")
        last_seen = d.get("lastSeen", "?")
        expires = d.get("expiresAt", "")
        revoked = d.get("revoked", False)
        status = "REVOKED" if revoked else (
            "EXPIRED" if expires and expires < __import__("time").time() else "active"
        )
        print(f"  {did}")
        print(f"    Name:     {name}")
        print(f"    Platform: {platform} v{app_ver}")
        print(f"    Created:  {created}")
        print(f"    Last:     {last_seen}")
        print(f"    Expires:  {__import__('datetime').datetime.fromtimestamp(expires, tz=__import__('datetime').timezone.utc).isoformat() if isinstance(expires, (int, float)) else expires}")
        print(f"    Status:   {status}")
        print()


def cmd_revoke(args) -> None:
    path = args.devices_path or _hermes_home() / "phone_bridge" / "devices.json"
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        print("Could not read devices.json", file=sys.stderr)
        sys.exit(1)
    devices = data.get("devices", {})
    if args.device_id not in devices:
        print(f"Device {args.device_id!r} not found", file=sys.stderr)
        sys.exit(1)
    devices[args.device_id]["revoked"] = True
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), "utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    name = devices[args.device_id].get("name", "?")
    print(f"Revoked {name} ({args.device_id}) — token is now invalid.")


def cmd_fingerprint(args) -> None:
    tls_dir = Path(args.tls_dir) if args.tls_dir else _hermes_home() / "phone_bridge" / "tls"
    cert_path = tls_dir / "cert.pem"
    if not cert_path.exists():
        print("No TLS certificate found — bridge is running without TLS.", file=sys.stderr)
        sys.exit(1)
    try:
        import subprocess
        out = subprocess.run(
            ["openssl", "x509", "-fingerprint", "-sha256", "-noout", "-in", str(cert_path)],
            capture_output=True, text=True, timeout=5, check=True
        )
        fp = out.stdout.strip().split("=", 1)[-1].strip()
        print(f"TLS fingerprint (SHA-256):")
        print(f"  {fp}")
        print()
        print("Paste this in the phone app when pairing to enable certificate pinning.")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("openssl not available; run manually:", file=sys.stderr)
        print(f"  openssl x509 -fingerprint -sha256 -noout -in {cert_path}", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Hermes Phone Bridge device management")
    parser.add_argument("--devices-path", help="path to devices.json (default: ~/.hermes/phone_bridge/devices.json)")
    parser.add_argument("--tls-dir", help="path to TLS directory (default: ~/.hermes/phone_bridge/tls)")

    sub = parser.add_subparsers(dest="command")
    sub.add_parser("list", help="list all paired devices")
    revoke = sub.add_parser("revoke", help="revoke a device token")
    revoke.add_argument("device_id", help="device id to revoke")
    sub.add_parser("fingerprint", help="show TLS certificate fingerprint")

    args = parser.parse_args()
    if args.command == "list":
        cmd_list(args)
    elif args.command == "revoke":
        cmd_revoke(args)
    elif args.command == "fingerprint":
        cmd_fingerprint(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()