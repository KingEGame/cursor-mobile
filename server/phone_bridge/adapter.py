"""Phone bridge adapter.

REST + WebSocket server (aiohttp) that lets the phone app work on the SAME Hermes sessions as the PC.

* Source of truth is ``state.db``. The bridge never keeps its own history: it reads sessions/messages
  (read-only) and pushes changes, so CLI / desktop / Telegram / Discord / phone all look identical.
* "Working" = a live row in ``session_turn_leases`` (``expires_at > now``); "idle" otherwise. The phone
  therefore always knows whether a session finished and what its last message was.
* Reconnect-safe: every message has a monotonically increasing id; a client sends ``since`` in
  ``client.hello`` and the server replays what it missed.
* Phone -> agent: ``POST /v1/chats/{chat_id}/messages`` becomes a normal inbound ``MessageEvent`` on
  platform ``phone`` (so ``/stop``, ``/resume`` and every other gateway command work from the phone).

Config: env ``PHONE_BRIDGE_ENABLED`` / ``_PORT`` (8097) / ``_HOST`` (0.0.0.0) /
``_ALLOW_ALL_USERS`` or ``platforms.phone.extra`` (``port``, ``host``, ``db_path``).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import shutil
import socket
import sqlite3
import ssl
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    from aiohttp import WSMsgType, web
    AIOHTTP_AVAILABLE = True
except ImportError:  # pragma: no cover
    AIOHTTP_AVAILABLE = False
    web = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult, cache_media_bytes_async
from gateway.platforms.event import MessageEvent, MessageType
from gateway.platforms.helpers import MessageDeduplicator
from gateway.platforms._shared import get_scoped_secret as _secret

try:
    from .projects import ChatProjects, ProjectIndex, prompt_section
except ImportError:  # loaded as a top-level module (tests)
    from projects import ChatProjects, ProjectIndex, prompt_section  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

API_VERSION = 1
DEFAULT_PORT = 8097
POLL_INTERVAL_S = 0.5
PAIR_REQUEST_TTL_S = 120
ADDRESS_CACHE_S = 60
PAIR_TTL_S = 300
PAIR_MAX_ATTEMPTS = 5          # per client IP per minute
REPLAY_LIMIT = 2000
MAX_UPLOAD_BYTES = 25 * 1024 * 1024   # per request (photos, PDFs, logs from the phone)
MAX_ATTACHMENTS = 10
# T16: token lifecycle
TOKEN_TTL_DAYS = 90
# T16: tus uploads
UPLOADS_DIR = "tmp/uploads"     # relative to mate-data
CHUNK_SIZE_MIN = 4 * 1024 * 1024
CHUNK_SIZE_MAX = 8 * 1024 * 1024
UPLOAD_EXPIRES_HOURS = 24
# T16: TLS
TLS_DIR = "tls"                 # relative to phone_bridge home
# T15: presence mirror
PRESENCE_FILE = "state/presence.json"  # relative to mate-data
PRESENCE_DEBOUNCE_S = 2
# Sessions that are internal plumbing, hidden from the phone list unless ?all=1.
HIDDEN_SOURCES = ("subagent", "oneshot", "kanban")
_TRUTHY = ("1", "true", "yes", "on")


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in _TRUTHY


def _hermes_home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def _iso(ts: Optional[float]) -> Optional[str]:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ── device pairing store ────────────────────────────────────────────────────

class DeviceStore:
    """Paired phones. Only token hashes are stored (file mode 0600)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._devices: dict[str, dict[str, Any]] = {}
        self._pending: dict[str, dict[str, Any]] = {}      # pairId -> {code, expires}
        self._attempts: dict[str, list[float]] = {}
        self._load()

    def _load(self) -> None:
        try:
            self._devices = json.loads(self.path.read_text("utf-8")).get("devices", {})
        except (OSError, ValueError):
            self._devices = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"devices": self._devices}, indent=2), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def count(self) -> int:
        return sum(1 for d in self._devices.values() if not d.get("revoked"))

    def start_pair(self, ttl: int = PAIR_TTL_S) -> dict[str, Any]:
        now = time.time()
        self._pending = {k: v for k, v in self._pending.items() if v["expires"] > now}
        pair_id = uuid.uuid4().hex[:12]
        code = f"{secrets.randbelow(10**8):08d}"
        self._pending[pair_id] = {"code": code, "expires": now + ttl}
        return {"pairId": pair_id, "code": code, "expiresAt": _iso(now + ttl)}

    def rate_limited(self, ip: str) -> bool:
        now = time.time()
        hits = [t for t in self._attempts.get(ip, []) if now - t < 60]
        hits.append(now)
        self._attempts[ip] = hits
        return len(hits) > PAIR_MAX_ATTEMPTS

    def complete_pair(self, code: str, pair_id: Optional[str], name: str, platform: str,
                      app_version: str) -> Optional[dict[str, Any]]:
        now = time.time()
        match = None
        for pid, p in self._pending.items():
            if p["expires"] > now and hmac.compare_digest(p["code"], code) and pair_id in (None, "", pid):
                match = pid
                break
        if match is None:
            return None
        del self._pending[match]                                   # one-time use
        return self.issue(name, platform, app_version)

    def issue(self, name: str, platform: str, app_version: str, *, ttl_days: int = TOKEN_TTL_DAYS) -> dict[str, Any]:
        """New device + token (only its hash is kept). expiresAt = now + ttl_days."""
        now = time.time()
        device_id, token = f"dev_{uuid.uuid4().hex[:12]}", secrets.token_urlsafe(32)
        expires_at = now + ttl_days * 86400
        self._devices[device_id] = {
            "name": name or "phone", "platform": platform, "appVersion": app_version,
            "tokenHash": _hash(token), "createdAt": _iso(now), "lastSeen": _iso(now),
            "expiresAt": expires_at, "revoked": False,
        }
        self._save()
        return {"deviceId": device_id, "deviceToken": token, "expiresAt": _iso(expires_at)}

    def authenticate(self, token: str) -> Optional[str]:
        if not token:
            return None
        h = _hash(token)
        for device_id, d in self._devices.items():
            if not d.get("revoked") and hmac.compare_digest(d["tokenHash"], h):
                return device_id
        return None

    def device_name(self, device_id: str) -> str:
        return self._devices.get(device_id, {}).get("name", "phone")

    def authenticate_with_rotation(self, token: str) -> tuple[Optional[str], Optional[dict[str, Any]]]:
        """Like authenticate() but also checks expiry and issues a new token if needed.

        Returns (device_id, new_token_dict_or_None). new_token_dict is set when
        the token was rotated (expired or near expiry). Caller should send it to the client.
        """
        if not token:
            return None, None
        h = _hash(token)
        now = time.time()
        rotated = None
        for device_id, d in list(self._devices.items()):
            if d.get("revoked") or not hmac.compare_digest(d["tokenHash"], h):
                continue
            expires = d.get("expiresAt")
            if expires and expires < now:
                # Expired — revoke and issue new
                d["revoked"] = True
                rotated = self.issue(d.get("name", "phone"), d.get("platform", ""), d.get("appVersion", ""))
                rotated["device_id"] = device_id  # keep same logical device
                rotated["old_revoked"] = True
                self._save()
                return device_id, rotated
            elif expires and expires < now + 7 * 86400:
                # Near expiry — rotate silently
                d["revoked"] = True
                rotated = self.issue(d.get("name", "phone"), d.get("platform", ""), d.get("appVersion", ""))
                rotated["device_id"] = device_id
                self._save()
                return device_id, rotated
            else:
                d["lastSeen"] = _iso(now)
                self._save()
                return device_id, None
        return None, None

    def list_devices(self) -> list[dict[str, Any]]:
        return [
            {"deviceId": did, "name": d.get("name", ""), "platform": d.get("platform", ""),
             "appVersion": d.get("appVersion", ""), "createdAt": d.get("createdAt"),
             "lastSeen": d.get("lastSeen"), "expiresAt": _iso(d.get("expiresAt")) if d.get("expiresAt") else None,
             "revoked": d.get("revoked", False)}
            for did, d in self._devices.items()
        ]

    def get_device(self, device_id: str) -> Optional[dict[str, Any]]:
        d = self._devices.get(device_id)
        if not d:
            return None
        return {"deviceId": device_id, "name": d.get("name", ""), "platform": d.get("platform", ""),
                "appVersion": d.get("appVersion", ""), "createdAt": d.get("createdAt"),
                "lastSeen": d.get("lastSeen"), "expiresAt": _iso(d.get("expiresAt")) if d.get("expiresAt") else None,
                "revoked": d.get("revoked", False)}

    def revoke(self, device_id: str) -> bool:
        if device_id in self._devices:
            self._devices[device_id]["revoked"] = True
            self._save()
            return True
        return False


# ── state.db access (read-only, per call: WAL makes this cheap and safe) ────

class StateReader:
    def __init__(self, path: Path) -> None:
        self.path = path

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=5)
        c.row_factory = sqlite3.Row
        return c

    def _session_cols(self, c: sqlite3.Connection) -> set[str]:
        return {r["name"] for r in c.execute("PRAGMA table_info(sessions)")}

    def max_message_id(self) -> int:
        with self._conn() as c:
            return int(c.execute("SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0])

    def active_leases(self) -> set[str]:
        with self._conn() as c:
            rows = c.execute("SELECT conversation_id FROM session_turn_leases WHERE expires_at > ?",
                             (time.time(),)).fetchall()
        return {r[0] for r in rows}

    def lease_holder(self, session_id: str) -> Optional[str]:
        with self._conn() as c:
            r = c.execute("SELECT holder FROM session_turn_leases WHERE conversation_id=? AND expires_at > ?",
                          (session_id, time.time())).fetchone()
        return r[0] if r else None

    def session_row(self, session_id: str) -> Optional[dict[str, Any]]:
        with self._conn() as c:
            r = c.execute("SELECT id, source, chat_id, ended_at, COALESCE(title, display_name) AS title "
                          "FROM sessions WHERE id=?", (session_id,)).fetchone()
        return dict(r) if r else None

    def list_sessions(self, limit: int, before: Optional[float], source: Optional[str],
                      include_hidden: bool) -> list[dict[str, Any]]:
        working = self.active_leases()
        where, args = [], []
        if source:
            where.append("s.source = ?"); args.append(source)
        elif not include_hidden:
            where.append(f"s.source NOT IN ({','.join('?' * len(HIDDEN_SOURCES))})"); args += list(HIDDEN_SOURCES)
        # Empty, already-closed rows (e.g. the throwaway route row a phone /resume replaces) are noise.
        where.append("NOT (s.ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id))")
        if before:
            where.append("COALESCE((SELECT MAX(timestamp) FROM messages m WHERE m.session_id = s.id), s.started_at) < ?")
            args.append(before)
        with self._conn() as c:
            cols = self._session_cols(c)
        path_cols = ", ".join(f"s.{k}" if k in cols else f"NULL AS {k}" for k in ("cwd", "git_repo_root"))
        sql = f"""
            SELECT s.id, s.source, s.chat_id, s.session_key, COALESCE(s.title, s.display_name) AS display_name, s.started_at, s.ended_at,
                   {path_cols},
                   s.end_reason, s.message_count, s.model,
                   COALESCE((SELECT MAX(timestamp) FROM messages m WHERE m.session_id = s.id), s.started_at) AS last_ts,
                   (SELECT role FROM messages m WHERE m.session_id = s.id AND m.active = 1
                      AND m.role IN ('user','assistant') AND COALESCE(m.content,'') <> '' ORDER BY m.id DESC LIMIT 1) AS last_role,
                   (SELECT substr(content,1,200) FROM messages m WHERE m.session_id = s.id AND m.active = 1
                      AND m.role IN ('user','assistant') AND COALESCE(m.content,'') <> '' ORDER BY m.id DESC LIMIT 1) AS preview
            FROM sessions s {'WHERE ' + ' AND '.join(where) if where else ''}
            ORDER BY last_ts DESC LIMIT ?"""
        with self._conn() as c:
            rows = c.execute(sql, (*args, limit)).fetchall()
        out = []
        for r in rows:
            out.append({
                "id": r["id"], "source": r["source"], "title": r["display_name"] or r["preview"] or r["id"],
                "chatId": r["chat_id"], "model": r["model"],
                "messageCount": r["message_count"], "startedAt": _iso(r["started_at"]),
                "updatedAt": _iso(r["last_ts"]), "endedAt": _iso(r["ended_at"]), "endReason": r["end_reason"],
                "status": "working" if r["id"] in working else ("ended" if r["ended_at"] else "idle"),
                "lastRole": r["last_role"], "preview": r["preview"],
                # Any visible session can be continued from the phone (internal plumbing cannot).
                "canSend": r["source"] not in HIDDEN_SOURCES,
                "_ts": r["last_ts"], "_cwd": r["cwd"], "_root": r["git_repo_root"],
            })
        return out

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        rows = [s for s in self.list_sessions(5000, None, None, True) if s["id"] == session_id]
        return rows[0] if rows else None

    def find_phone_session(self, chat_id: str) -> Optional[str]:
        with self._conn() as c:
            r = c.execute("SELECT id FROM sessions WHERE source='phone' AND chat_id=? ORDER BY started_at DESC LIMIT 1",
                          (chat_id,)).fetchone()
        return r[0] if r else None

    @staticmethod
    def _msg(r: sqlite3.Row) -> dict[str, Any]:
        calls = None
        if r["tool_calls"]:
            try:
                calls = [(tc.get("function") or {}).get("name") or tc.get("name") for tc in json.loads(r["tool_calls"])]
            except (ValueError, AttributeError, TypeError):
                calls = None
        return {"id": r["id"], "sessionId": r["session_id"], "role": r["role"], "content": r["content"] or "",
                "toolName": r["tool_name"], "toolCalls": calls, "createdAt": _iso(r["timestamp"]),
                "finishReason": r["finish_reason"]}

    _MSG_COLS = "id, session_id, role, content, tool_calls, tool_name, timestamp, finish_reason"

    def messages(self, session_id: str, after: int, limit: int) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute(f"SELECT {self._MSG_COLS} FROM messages WHERE session_id=? AND id>? AND active=1 "
                             "ORDER BY id LIMIT ?", (session_id, after, limit)).fetchall()
        return [self._msg(r) for r in rows]

    def tail(self, session_id: str, limit: int) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute(f"SELECT {self._MSG_COLS} FROM messages WHERE session_id=? AND active=1 "
                             "ORDER BY id DESC LIMIT ?", (session_id, limit)).fetchall()
        return [self._msg(r) for r in reversed(rows)]

    def since(self, after: int, limit: int) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute(f"SELECT {self._MSG_COLS} FROM messages WHERE id>? AND active=1 ORDER BY id LIMIT ?",
                             (after, limit)).fetchall()
        return [self._msg(r) for r in rows]


# ── T16: tus upload store ────────────────────────────────────────────────────

class UploadStore:
    """Manages resumable (tus) file uploads from the phone.

    Each upload creates two files in mate-data's tmp/uploads/:
      <uploadId>.part  — the bytes received so far
      <uploadId>.json  — metadata {sha256, size, offset, recordingId, device, startedAt, expiresAt}
    On completion the .part is moved to inbox/<sha256>.<ext> and a companion .json is written.
    """

    def __init__(self, base_dir: Path, mate_data: Path) -> None:
        self.dir = mate_data / UPLOADS_DIR
        self.dir.mkdir(parents=True, exist_ok=True)
        self._inbox = mate_data / "inbox"
        self._inbox.mkdir(parents=True, exist_ok=True)
        self._base = base_dir  # phone_bridge home
        self._prune()

    def _meta_path(self, upload_id: str) -> Path:
        return self.dir / f"{upload_id}.json"

    def _data_path(self, upload_id: str) -> Path:
        return self.dir / f"{upload_id}.part"

    def _prune(self) -> None:
        """Remove expired uploads."""
        now = time.time()
        for f in self.dir.glob("*.json"):
            try:
                meta = json.loads(f.read_text("utf-8"))
                if meta.get("expiresAt", 0) < now:
                    f.unlink(missing_ok=True)
                    self._data_path(f.stem).unlink(missing_ok=True)
            except (OSError, ValueError):
                pass

    def create(self, sha256: str, size: int, recording_id: str, device: str, started_at: float,
               ext: str = ".bin") -> Optional[dict[str, Any]]:
        """Start or resume an upload by sha256. Returns existing if already completed."""
        now = time.time()
        # Idempotency: check inbox for a completed file with this sha256
        inbox_file = self._inbox / f"{sha256}{ext}"
        inbox_meta = self._inbox / f"{sha256}.json"
        if inbox_file.exists():
            try:
                existing = json.loads(inbox_meta.read_text("utf-8"))
                return {"uploadId": existing.get("uploadId", f"done_{sha256[:12]}"),
                        "offset": size, "complete": True,
                        "sha256": sha256, "path": str(inbox_file)}
            except (OSError, ValueError):
                pass
        # Also check partial uploads with same sha256
        for f in self.dir.glob("*.json"):
            try:
                meta = json.loads(f.read_text("utf-8"))
                if meta.get("sha256") == sha256 and meta.get("expiresAt", 0) > now:
                    upload_id = f.stem
                    offset = os.path.getsize(self._data_path(upload_id))
                    return {"uploadId": upload_id, "offset": offset, "complete": offset >= meta["size"]}
            except (OSError, ValueError):
                continue
        # Create new upload
        upload_id = f"up_{uuid.uuid4().hex[:16]}"
        expires_at = now + UPLOAD_EXPIRES_HOURS * 3600
        meta = {
            "sha256": sha256, "size": size, "offset": 0,
            "recordingId": recording_id, "device": device, "startedAt": started_at,
            "ext": ext, "createdAt": now, "expiresAt": expires_at,
        }
        self._meta_path(upload_id).write_text(json.dumps(meta, indent=2), "utf-8")
        self._data_path(upload_id).touch()
        return {"uploadId": upload_id, "offset": 0, "complete": False, "expiresAt": expires_at}

    def info(self, upload_id: str) -> Optional[dict[str, Any]]:
        """HEAD: return current upload state or None."""
        mp = self._meta_path(upload_id)
        if not mp.exists():
            return None
        try:
            meta = json.loads(mp.read_text("utf-8"))
            dp = self._data_path(upload_id)
            meta["offset"] = os.path.getsize(dp) if dp.exists() else meta.get("offset", 0)
            return meta
        except (OSError, ValueError):
            return None

    def append(self, upload_id: str, chunk: bytes, offset: int, chunk_sha256: str) -> Optional[str]:
        """Append a chunk. Returns error message or None on success."""
        mp = self._meta_path(upload_id)
        if not mp.exists():
            return "upload not found"
        try:
            meta = json.loads(mp.read_text("utf-8"))
        except (OSError, ValueError):
            return "corrupt upload metadata"
        if time.time() > meta.get("expiresAt", 0):
            return "upload expired"
        if offset != meta.get("offset", 0):
            return f"offset mismatch: expected {meta['offset']}, got {offset}"
        # Verify chunk sha256
        actual = hashlib.sha256(chunk).hexdigest()
        if not hmac.compare_digest(actual, chunk_sha256):
            return f"checksum mismatch: expected {chunk_sha256}, got {actual}"
        dp = self._data_path(upload_id)
        with open(dp, "ab") as f:
            f.write(chunk)
        meta["offset"] = os.path.getsize(dp)
        if meta["offset"] >= meta["size"]:
            # File complete — verify full sha256
            full_hash = hashlib.sha256()
            with open(dp, "rb") as f:
                while True:
                    buf = f.read(64 * 1024)
                    if not buf:
                        break
                    full_hash.update(buf)
            if not hmac.compare_digest(full_hash.hexdigest(), meta["sha256"]):
                return "full file checksum mismatch"
            # Move to inbox
            ext = meta.get("ext", ".bin")
            dest = self._inbox / f"{meta['sha256']}{ext}"
            dp.replace(dest)
            # Write companion metadata
            inbox_meta = self._inbox / f"{meta['sha256']}.json"
            inbox_meta.write_text(json.dumps({
                "uploadId": upload_id, "sha256": meta["sha256"], "size": meta["size"],
                "recordingId": meta.get("recordingId"), "device": meta.get("device"),
                "startedAt": meta.get("startedAt"), "completedAt": _iso(time.time()),
            }, indent=2), "utf-8")
            mp.unlink(missing_ok=True)
            meta["offset"] = meta["size"]
            meta["complete"] = True
        else:
            mp.write_text(json.dumps(meta, indent=2), "utf-8")
        return None

    def delete(self, upload_id: str) -> bool:
        mp = self._meta_path(upload_id)
        dp = self._data_path(upload_id)
        any_deleted = False
        if mp.exists():
            mp.unlink()
            any_deleted = True
        if dp.exists():
            dp.unlink()
            any_deleted = True
        return any_deleted

    def prune_now(self) -> int:
        """Remove expired uploads. Returns count removed."""
        now = time.time()
        removed = 0
        for f in list(self.dir.glob("*.json")):
            try:
                meta = json.loads(f.read_text("utf-8"))
                if meta.get("expiresAt", 0) < now:
                    f.unlink(missing_ok=True)
                    self._data_path(f.stem).unlink(missing_ok=True)
                    removed += 1
            except (OSError, ValueError):
                pass
        return removed


# ── adapter ─────────────────────────────────────────────────────────────────

class _Client:
    __slots__ = ("ws", "device_id", "sessions")

    def __init__(self, ws: Any, device_id: str) -> None:
        self.ws, self.device_id, self.sessions = ws, device_id, set()   # empty set = every session


class PhoneBridgeAdapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = 0

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("phone"))
        extra = config.extra or {}
        self._host = str(extra.get("host") or _secret("PHONE_BRIDGE_HOST", "") or "0.0.0.0")
        self._port = int(extra.get("port") or _secret("PHONE_BRIDGE_PORT", "") or DEFAULT_PORT)
        home = _hermes_home()
        db = extra.get("db_path") or str(home / "state.db")
        self._state = StateReader(Path(db))
        self._bridge_home = home / "phone_bridge"
        self._bridge_home.mkdir(parents=True, exist_ok=True)
        self._devices = DeviceStore(Path(extra.get("devices_path") or self._bridge_home / "devices.json"))
        self._hub_id = hashlib.sha256(f"{socket.gethostname()}:{home}".encode()).hexdigest()[:12]
        self._dedup = MessageDeduplicator(max_size=1000, ttl_seconds=600)
        self._clients: set[_Client] = set()
        self._runner: Optional["web.AppRunner"] = None
        self._poll_task: Optional[asyncio.Task] = None
        self._wake = asyncio.Event()
        self._cursor = 0
        self._last_status: dict[str, str] = {}
        self._pair_requests: dict[str, dict[str, Any]] = {}   # one-tap pairing waiting for the PC owner
        self._addresses: list[str] = []
        self._addresses_at = 0.0
        self._started = time.time()
        # Desktop notification for one-tap pairing; tests/e2e servers turn it off (they share this desktop).
        self._notify = _truthy(extra.get("notify", True))
        self._notify_id: Optional[str] = None
        self._projects = ProjectIndex()
        self._chat_projects = ChatProjects(Path(extra.get("projects_path") or self._bridge_home / "projects.json"))
        # T16: tus uploads
        mate_data = Path(extra.get("mate_data") or os.path.expanduser("~/mate-data"))
        self._uploads = UploadStore(self._bridge_home, mate_data)
        # T16: TLS
        self._tls_dir = self._bridge_home / TLS_DIR
        self._tls_dir.mkdir(parents=True, exist_ok=True)
        self._ssl_ctx: Optional[ssl.SSLContext] = None
        # T15: presence mirror
        self._mate_data = mate_data
        self._presence: dict[str, Any] = {}
        self._presence_mtime: float = 0.0
        self._presence_changed_at: float = 0.0

    # lifecycle ------------------------------------------------------------
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not AIOHTTP_AVAILABLE:
            logger.warning("[phone] aiohttp not installed")
            return False
        try:
            self._cursor = await asyncio.to_thread(self._state.max_message_id)
            # T16: TLS
            self._ssl_ctx = await asyncio.to_thread(self._ensure_tls)
            app = web.Application(middlewares=[self._auth_middleware], client_max_size=MAX_UPLOAD_BYTES + 1024 * 1024)
            r = app.router
            r.add_get("/v1/health", self._h_health)
            r.add_post("/v1/pair/start", self._h_pair_start)
            r.add_post("/v1/pair/complete", self._h_pair_complete)
            r.add_get("/v1/projects", self._h_projects)
            r.add_get("/v1/sessions", self._h_sessions)
            r.add_get("/v1/sessions/{sid}", self._h_session)
            r.add_get("/v1/sessions/{sid}/messages", self._h_messages)
            r.add_post("/v1/chats", self._h_new_chat)
            r.add_post("/v1/chats/{chat_id}/messages", self._h_send)
            r.add_get("/v1/chats/{chat_id}/session", self._h_chat_session)
            r.add_post("/v1/sessions/{sid}/messages", self._h_send_to_session)
            r.add_get("/pair", self._h_pair_page)
            r.add_post("/v1/device/revoke", self._h_device_revoke)
            r.add_post("/v1/pair/request", self._h_pair_request)
            r.add_get("/v1/pair/request/{rid}", self._h_pair_request_status)
            r.add_get("/pair/requests", self._h_pair_requests_list)
            r.add_post("/pair/requests/{rid}/{decision}", self._h_pair_decide)
            r.add_get("/v1/ws", self._h_ws)
            # T16: tus upload endpoints
            r.add_post("/v1/uploads", self._h_uploads_create)
            r.add_head("/v1/uploads/{uid}", self._h_uploads_head)
            r.add_patch("/v1/uploads/{uid}", self._h_uploads_patch)
            r.add_delete("/v1/uploads/{uid}", self._h_uploads_delete)
            # T16: device management
            r.add_get("/v1/devices", self._h_devices_list)
            self._runner = web.AppRunner(app)
            await self._runner.setup()
            await web.TCPSite(self._runner, self._host, self._port, ssl_context=self._ssl_ctx).start()
            self._poll_task = asyncio.create_task(self._poll_loop(), name="phone-bridge-poll")
            self._mark_connected()
            self._wire_plugin_handlers(None)
            scheme = "https" if self._ssl_ctx else "http"
            logger.info("[phone] listening on %s://%s:%s (cursor=%s, paired devices=%s, tls=%s)",
                        scheme, self._host, self._port, self._cursor, self._devices.count(), bool(self._ssl_ctx))
            return True
        except Exception as e:
            logger.error("[phone] failed to start: %s", e)
            self._set_fatal_error("phone_bind_failed", str(e), retryable=True)
            return False

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):
                pass
            self._poll_task = None
        for c in list(self._clients):
            try:
                await c.ws.close()
            except Exception:
                pass
        self._clients.clear()
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

    # gateway -> phone -----------------------------------------------------
    SUPPORTS_MESSAGE_EDITING = True

    async def _live(self, chat_id: str, live_id: str, text: Optional[str], final: bool = False) -> None:
        """Ephemeral, not persisted: streaming previews, tool progress, slash-command replies.
        The phone drops a preview once the persisted message lands via ``message.created``."""
        sid = await asyncio.to_thread(self._state.find_phone_session, chat_id)
        ev: dict[str, Any] = {"type": "live.remove" if text is None else "live.update", "chatId": chat_id,
                              "sessionId": sid, "liveId": live_id, "at": _iso(time.time())}
        if text is not None:
            ev.update(text=text, final=final)
        await self._broadcast(ev, session_id=sid)

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> SendResult:
        # Persisted replies reach the phone through the DB poller (woken now); everything the gateway
        # sends is also pushed live, so streaming previews and command replies show up immediately.
        live_id = uuid.uuid4().hex[:12]
        if _is_home_channel_nag(content):
            # Cron results must not land on a phone by accident; the hint is noise in every new chat.
            return SendResult(success=True, message_id=live_id)
        await self._live(chat_id, live_id, content or "")
        self._wake.set()
        return SendResult(success=True, message_id=live_id)

    async def edit_message(self, chat_id: str, message_id: str, content: str, *,
                           finalize: bool = False) -> SendResult:
        await self._live(chat_id, message_id, content or "", final=finalize)
        if finalize:
            self._wake.set()
        return SendResult(success=True, message_id=message_id)

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        await self._live(chat_id, message_id, None)
        return True

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": f"phone:{chat_id[:8]}", "type": "dm", "chat_id": chat_id}

    # poller: DB changes -> websocket -------------------------------------
    async def _poll_loop(self) -> None:
        while True:
            try:
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=POLL_INTERVAL_S)
                except asyncio.TimeoutError:
                    pass
                self._wake.clear()
                # T15: check presence.json for changes
                await self._poll_presence()

                if not self._clients:
                    # Nobody listening: keep the cursor current so a later hello replays via ``since``.
                    self._cursor = await asyncio.to_thread(self._state.max_message_id)
                    continue
                msgs = await asyncio.to_thread(self._state.since, self._cursor, 500)
                for m in msgs:
                    self._cursor = max(self._cursor, m["id"])
                    await self._broadcast({"type": "message.created", "sessionId": m["sessionId"], "message": m},
                                          session_id=m["sessionId"])
                await self._emit_status_changes(touched={m["sessionId"] for m in msgs})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("[phone] poll failed: %s", e)
                await asyncio.sleep(2)

    async def _emit_status_changes(self, touched: set[str]) -> None:
        working = await asyncio.to_thread(self._state.active_leases)
        changed = {s for s in working | set(self._last_status) if
                   ("working" if s in working else "idle") != self._last_status.get(s, "idle")}
        for sid in changed | {s for s in touched if s in working}:
            status = "working" if sid in working else "idle"
            if self._last_status.get(sid) == status and sid not in changed:
                continue
            self._last_status[sid] = status
            tail = await asyncio.to_thread(self._state.tail, sid, 1) if status == "idle" else []
            row = await asyncio.to_thread(self._state.session_row, sid)
            # source/title let the phone's background service decide what deserves a notification.
            await self._broadcast({"type": "session.updated", "sessionId": sid, "status": status,
                                   "lastMessage": tail[-1] if tail else None, "at": _iso(time.time()),
                                   "source": row["source"] if row else None,
                                   "title": (row["title"] if row else None) or None},
                                  session_id=sid)
        self._last_status = {s: v for s, v in self._last_status.items() if v == "working" or s in changed}

    async def _broadcast(self, event: dict[str, Any], session_id: Optional[str] = None) -> None:
        raw = json.dumps(event, ensure_ascii=False)
        for c in list(self._clients):
            if session_id and c.sessions and session_id not in c.sessions:
                continue
            try:
                await c.ws.send_str(raw)
            except Exception:
                self._clients.discard(c)

    # T15: presence mirror --------------------------------------------------------
    async def _poll_presence(self) -> None:
        """Poll presence.json, debounce 2s, broadcast ``presence.updated`` on change."""
        path = self._mate_data / PRESENCE_FILE
        try:
            mtime = await asyncio.to_thread(lambda: path.stat().st_mtime)
        except OSError:
            return
        if mtime == self._presence_mtime:
            return
        # File changed — start or extend debounce window
        now = time.time()
        if self._presence_changed_at == 0:
            self._presence_changed_at = now
        elif now - self._presence_changed_at < PRESENCE_DEBOUNCE_S:
            return  # still in debounce window
        # Debounce elapsed: read and broadcast
        self._presence_mtime = mtime
        self._presence_changed_at = 0
        try:
            data = json.loads(await asyncio.to_thread(lambda: path.read_text("utf-8")))
        except (OSError, ValueError):
            return
        if data == self._presence:
            return
        self._presence = data
        event: dict[str, Any] = {
            "type": "presence.updated",
            "state": data.get("state"),
            "current_block": data.get("current_block"),
            "last_kick": data.get("last_kick"),
            "last_brief": data.get("last_brief"),
            "avatar": data.get("avatar"),
            "updated_at": data.get("updated_at"),
        }
        await self._broadcast(event)

    # http -----------------------------------------------------------------
    @web.middleware
    async def _auth_middleware(self, request: "web.Request", handler):
        if (request.path in ("/v1/health", "/v1/pair/complete", "/v1/pair/start", "/v1/pair/request", "/pair", "/v1/ws")
                or request.path.startswith(("/v1/pair/request/", "/pair/requests", "/v1/uploads"))):
            return await handler(request)
        auth = request.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        device_id = self._devices.authenticate(token)
        if not device_id:
            return web.json_response({"error": {"code": "UNAUTHORIZED", "message": "pair this device first"}}, status=401)
        request["device_id"] = device_id
        return await handler(request)

    @staticmethod
    def _err(status: int, code: str, message: str) -> "web.Response":
        return web.json_response({"error": {"code": code, "message": message}}, status=status)

    async def _h_health(self, request: "web.Request") -> "web.Response":
        return web.json_response({
            "ok": True, "apiVersion": API_VERSION, "time": _iso(time.time()),
            "hub": {"status": "up", "uptimeSec": int(time.time() - self._started),
                    "displayName": socket.gethostname().split(".")[0], "hubId": self._hub_id,
                    "addresses": await self._get_addresses()},
            "pairing": {"required": True, "devicesPaired": self._devices.count(), "oneTap": True},
            "cursor": self._cursor, "clients": len(self._clients),
        })

    async def _h_pair_start(self, request: "web.Request") -> "web.Response":
        if request.remote not in ("127.0.0.1", "::1"):
            return self._err(403, "LOCAL_ONLY", "pairing codes can only be created on this PC")
        return web.json_response(self._devices.start_pair(), status=201)

    async def _h_pair_complete(self, request: "web.Request") -> "web.Response":
        if self._devices.rate_limited(request.remote or "?"):
            return self._err(429, "RATE_LIMITED", "too many attempts, wait a minute")
        try:
            body = await request.json()
        except ValueError:
            return self._err(400, "VALIDATION_ERROR", "invalid JSON")
        res = self._devices.complete_pair(str(body.get("code", "")).strip(), body.get("pairId"),
                                          str(body.get("deviceName", "")).strip(), str(body.get("platform", "")),
                                          str(body.get("appVersion", "")))
        if not res:
            return self._err(400, "PAIR_CODE_INVALID", "unknown, used or expired code")
        return web.json_response({**res, "tokenType": "Bearer", "hub": await self._hub_info()},
                                 status=201)

    async def _get_addresses(self) -> list[str]:
        if time.time() - self._addresses_at > ADDRESS_CACHE_S or not self._addresses:
            self._addresses = await asyncio.to_thread(self._phone_urls)
            self._addresses_at = time.time()
        return self._addresses

    async def _hub_info(self) -> dict[str, Any]:
        info = {"displayName": socket.gethostname().split(".")[0], "hubId": self._hub_id,
                "addresses": await self._get_addresses()}
        fp = await asyncio.to_thread(lambda: self._tls_fingerprint)
        if fp:
            info["tlsFingerprint"] = fp
        return info

    # one-tap pairing ---------------------------------------------------------
    def _is_local(self, request: "web.Request") -> bool:
        if request.remote not in ("127.0.0.1", "::1"):
            return False
        origin = request.headers.get("Origin")
        # A web page open in the PC browser must not approve phones behind the owner's back (CSRF).
        return origin in (None, "null", f"http://127.0.0.1:{self._port}", f"http://localhost:{self._port}")

    def _prune_requests(self) -> None:
        now = time.time()
        self._pair_requests = {k: v for k, v in self._pair_requests.items()
                               if v["expires"] > now or v["status"] == "approved" and v["expires"] + 60 > now}

    def _notify_pc(self, name: str, confirm: str, ip: str = "") -> None:
        """One normal-urgency notification that REPLACES the previous one (never a growing stack),
        expiring with the request. Off for test servers."""
        import shutil, subprocess
        if not self._notify or not shutil.which("notify-send"):
            return
        cmd = ["notify-send", "-a", "Hermes", "-u", "normal", "-t", str(PAIR_REQUEST_TTL_S * 1000), "-p"]
        if self._notify_id:
            cmd += ["-r", self._notify_id]
        cmd += ["Hermes Phone: connection request",
                f"{name}{f' ({ip})' if ip else ''} wants to connect — code {confirm}.\n"
                f"Allow on http://127.0.0.1:{self._port}/pair (ignore it if this isn't your phone)."]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout.strip()
            self._notify_id = out if out.isdigit() else self._notify_id
        except Exception:
            pass

    async def _h_device_revoke(self, request: "web.Request") -> "web.Response":
        """The phone disconnects itself: its token stops working on this PC immediately."""
        ok = self._devices.revoke(request["device_id"])
        for c in [c for c in self._clients if c.device_id == request["device_id"]]:
            try:
                await c.ws.close()
            except Exception:
                pass
        return web.json_response({"ok": ok})

    async def _h_pair_request(self, request: "web.Request") -> "web.Response":
        if self._devices.rate_limited(request.remote or "?"):
            return self._err(429, "RATE_LIMITED", "too many attempts, wait a minute")
        try:
            body = await request.json()
        except ValueError:
            return self._err(400, "VALIDATION_ERROR", "invalid JSON")
        self._prune_requests()
        if sum(1 for r in self._pair_requests.values() if r["status"] == "pending") >= 5:
            return self._err(429, "RATE_LIMITED", "too many phones waiting for approval")
        rid = secrets.token_urlsafe(18)   # unguessable: only the requesting phone can collect the token
        confirm = f"{secrets.randbelow(10**4):04d}"
        name = "".join(ch for ch in str(body.get("deviceName", "")) if ch.isprintable()).strip()[:60] or "phone"
        now = time.time()
        self._pair_requests[rid] = {"name": name, "platform": str(body.get("platform", ""))[:20],
                                    "appVersion": str(body.get("appVersion", ""))[:20], "ip": request.remote,
                                    "confirm": confirm, "created": now, "expires": now + PAIR_REQUEST_TTL_S,
                                    "status": "pending", "result": None}
        await asyncio.to_thread(self._notify_pc, name, confirm, request.remote or "")
        logger.info("[phone] pairing request from %s (%s), code %s", name, request.remote, confirm)
        return web.json_response({"requestId": rid, "confirm": confirm, "expiresAt": _iso(now + PAIR_REQUEST_TTL_S),
                                  "hub": await self._hub_info()}, status=201)

    async def _h_pair_request_status(self, request: "web.Request") -> "web.Response":
        self._prune_requests()
        r = self._pair_requests.get(request.match_info["rid"])
        if not r:
            return web.json_response({"status": "expired"})
        if r["status"] == "approved" and r["result"]:
            res = r["result"]
            del self._pair_requests[request.match_info["rid"]]          # token handed out exactly once
            return web.json_response({"status": "approved", **res, "tokenType": "Bearer", "expiresAt": None,
                                      "hub": await self._hub_info()})
        return web.json_response({"status": r["status"]})

    async def _h_pair_requests_list(self, request: "web.Request") -> "web.Response":
        if not self._is_local(request):
            return self._err(403, "LOCAL_ONLY", "open this page on the PC itself")
        self._prune_requests()
        return web.json_response({"items": [
            {"id": k, "name": v["name"], "platform": v["platform"], "ip": v["ip"], "confirm": v["confirm"],
             "expiresIn": int(v["expires"] - time.time())}
            for k, v in self._pair_requests.items() if v["status"] == "pending"]})

    async def _h_pair_decide(self, request: "web.Request") -> "web.Response":
        if not self._is_local(request):
            return self._err(403, "LOCAL_ONLY", "approve phones on the PC itself")
        self._prune_requests()
        rid, decision = request.match_info["rid"], request.match_info["decision"]
        r = self._pair_requests.get(rid)
        if not r or r["status"] != "pending":
            return self._err(404, "REQUEST_NOT_FOUND", "request expired or already handled")
        if decision == "approve":
            r["result"] = self._devices.issue(r["name"], r["platform"], r["appVersion"])
            r["status"] = "approved"
        elif decision == "deny":
            r["status"] = "denied"
        else:
            return self._err(400, "VALIDATION_ERROR", "approve or deny")
        logger.info("[phone] pairing request %s: %s", r["name"], r["status"])
        return web.json_response({"ok": True, "status": r["status"]})

    # T16: tus upload handlers --------------------------------------------------
    @staticmethod
    def _parse_tus_meta(value: str) -> dict[str, str]:
        """Parse tus Upload-Metadata header: name <base64>,name <base64>,..."""
        out = {}
        if not value:
            return out
        for part in value.split(","):
            part = part.strip()
            if " " in part:
                k, b64 = part.split(" ", 1)
            else:
                k, b64 = part, ""
            out[k.strip()] = b64.strip()
        return out

    async def _h_uploads_create(self, request: "web.Request") -> "web.Response":
        """POST /v1/uploads — tus creation. Idempotent by sha256 content."""
        try:
            body = await request.json()
        except ValueError:
            return self._err(400, "VALIDATION_ERROR", "invalid JSON")
        sha256 = str(body.get("sha256", "")).strip()
        if not sha256 or len(sha256) != 64:
            return self._err(400, "VALIDATION_ERROR", "sha256 required (64 hex chars)")
        try:
            size = int(body.get("size", 0))
        except (ValueError, TypeError):
            return self._err(400, "VALIDATION_ERROR", "size must be an integer")
        if size <= 0 or size > MAX_UPLOAD_BYTES * 4:
            return self._err(400, "VALIDATION_ERROR", f"size must be 1..{MAX_UPLOAD_BYTES * 4}")
        recording_id = str(body.get("recordingId", "")).strip()
        kind = str(body.get("kind", "audio")).strip()
        ext = ".wav" if kind == "audio" else ".bin"
        device = request.get("device_id", "unknown")
        started_at = body.get("startedAt", time.time())
        result = await asyncio.to_thread(self._uploads.create, sha256, size, recording_id, device, started_at, ext)
        if not result:
            return self._err(500, "UPLOAD_FAILED", "could not create upload")
        if result.get("complete"):
            return web.json_response({
                "uploadId": result["uploadId"], "offset": result["offset"],
                "complete": True, "sha256": sha256, "path": result.get("path"),
            }, status=200)
        return web.json_response({
            "uploadId": result["uploadId"], "offset": result["offset"],
            "complete": False, "expiresAt": result.get("expiresAt"),
        }, status=201)

    async def _h_uploads_head(self, request: "web.Request") -> "web.Response":
        """HEAD /v1/uploads/{uid} — return current offset."""
        uid = request.match_info["uid"]
        meta = await asyncio.to_thread(self._uploads.info, uid)
        if not meta:
            return self._err(404, "UPLOAD_NOT_FOUND", "no such upload")
        return web.Response(
            headers={"Upload-Offset": str(meta.get("offset", 0)),
                     "Upload-Length": str(meta.get("size", 0)),
                     "Upload-Expires": _iso(meta.get("expiresAt")) or ""},
        )

    async def _h_uploads_patch(self, request: "web.Request") -> "web.Response":
        """PATCH /v1/uploads/{uid} — append a chunk with sha256 checksum."""
        uid = request.match_info["uid"]
        offset_header = request.headers.get("Upload-Offset", "")
        try:
            offset = int(offset_header)
        except (ValueError, TypeError):
            return self._err(400, "VALIDATION_ERROR", "Upload-Offset header required")
        checksum_header = request.headers.get("Upload-Checksum", "")
        # Format: sha256 <hex>
        if " " not in checksum_header:
            return self._err(400, "VALIDATION_ERROR", "Upload-Checksum header required: sha256 <hex>")
        algo, expected = checksum_header.split(" ", 1)
        if algo.lower() != "sha256" or len(expected.strip()) != 64:
            return self._err(400, "VALIDATION_ERROR", "Upload-Checksum must be sha256 <64 hex chars>")
        expected = expected.strip().lower()
        chunk = await request.read()
        if not chunk:
            return self._err(400, "VALIDATION_ERROR", "empty chunk")
        if len(chunk) > CHUNK_SIZE_MAX:
            return self._err(413, "CHUNK_TOO_LARGE", f"max chunk size is {CHUNK_SIZE_MAX} bytes")
        error = await asyncio.to_thread(self._uploads.append, uid, chunk, offset, expected)
        if error:
            if "checksum mismatch" in error.lower():
                return self._err(460, "CHECKSUM_MISMATCH", error)
            if "expired" in error.lower():
                return self._err(410, "UPLOAD_EXPIRED", error)
            if "not found" in error.lower():
                return self._err(404, "UPLOAD_NOT_FOUND", error)
            return self._err(400, "UPLOAD_ERROR", error)
        meta = await asyncio.to_thread(self._uploads.info, uid)
        offset = meta.get("offset", 0) if meta else 0
        complete = meta.get("complete", False) if meta else False
        resp = web.Response(headers={"Upload-Offset": str(offset)})
        if complete:
            resp.headers["Upload-Completed"] = "1"
        return resp

    async def _h_uploads_delete(self, request: "web.Request") -> "web.Response":
        """DELETE /v1/uploads/{uid} — cancel an upload."""
        uid = request.match_info["uid"]
        ok = await asyncio.to_thread(self._uploads.delete, uid)
        if not ok:
            return self._err(404, "UPLOAD_NOT_FOUND", "no such upload")
        return web.json_response({"ok": True})

    async def _h_devices_list(self, request: "web.Request") -> "web.Response":
        """GET /v1/devices — list all paired devices."""
        devices = await asyncio.to_thread(self._devices.list_devices)
        return web.json_response({"items": devices})

    # projects ---------------------------------------------------------------
    def _project_of(self, item: dict[str, Any]) -> Optional[str]:
        return (self._chat_projects.session(item["id"])
                or (self._chat_projects.chat(item.get("chatId")) if item.get("source") == "phone" else None)
                or self._projects.for_path(item.get("_root"), item.get("_cwd")))

    def _annotate(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for i in items:
            slug = self._project_of(i)
            p = self._projects.get(slug)
            i["project"] = {"slug": p["slug"], "name": p["name"]} if p else None
            i.pop("_cwd", None); i.pop("_root", None)
        return items

    def _all_annotated(self) -> list[dict[str, Any]]:
        return self._annotate(self._state.list_sessions(5000, None, None, False))

    async def _h_projects(self, request: "web.Request") -> "web.Response":
        projects = await asyncio.to_thread(self._projects.list)
        sessions = await asyncio.to_thread(self._all_annotated)
        stats: dict[str, dict[str, Any]] = {}
        for s in sessions:
            if s["project"]:
                st = stats.setdefault(s["project"]["slug"], {"count": 0, "last": 0.0, "working": 0})
                st["count"] += 1
                st["last"] = max(st["last"], s["_ts"] or 0)
                st["working"] += s["status"] == "working"
        out = []
        for p in projects:
            st = stats.get(p["slug"], {"count": 0, "last": 0.0, "working": 0})
            out.append({"slug": p["slug"], "name": p["name"], "icon": p.get("icon"), "color": p.get("color"),
                        "description": p.get("description"), "path": p.get("path"),
                        "sessionCount": st["count"], "workingCount": st["working"],
                        "updatedAt": _iso(st["last"]) if st["last"] else None, "_last": st["last"]})
        out.sort(key=lambda p: (-p["_last"], p["name"].lower()))
        for p in out:
            p.pop("_last", None)
        return web.json_response({"items": out})

    async def _h_sessions(self, request: "web.Request") -> "web.Response":
        q = request.query
        try:
            limit = max(1, min(int(q.get("limit", 50)), 200))
            before = float(q["before"]) if q.get("before") else None
        except ValueError:
            return self._err(400, "VALIDATION_ERROR", "bad limit/before")
        project = q.get("project")
        if project:
            def _filtered() -> list[dict[str, Any]]:
                rows = self._annotate(self._state.list_sessions(5000, before, q.get("source"), q.get("all") == "1"))
                return [r for r in rows if r["project"] and r["project"]["slug"] == project][:limit]
            items = await asyncio.to_thread(_filtered)
        else:
            items = await asyncio.to_thread(
                lambda: self._annotate(self._state.list_sessions(limit, before, q.get("source"), q.get("all") == "1")))
        next_before = items[-1]["_ts"] if len(items) == limit else None
        for i in items:
            i.pop("_ts", None)
        return web.json_response({"items": items, "nextBefore": next_before, "cursor": self._cursor})

    async def _h_session(self, request: "web.Request") -> "web.Response":
        s = await asyncio.to_thread(self._state.get_session, request.match_info["sid"])
        if not s:
            return self._err(404, "SESSION_NOT_FOUND", "no such session")
        self._annotate([s])
        s.pop("_ts", None)
        return web.json_response(s)

    async def _h_messages(self, request: "web.Request") -> "web.Response":
        sid = request.match_info["sid"]
        try:
            limit = max(1, min(int(request.query.get("limit", 100)), 1000))
            after = int(request.query.get("after", 0))
        except ValueError:
            return self._err(400, "VALIDATION_ERROR", "bad limit/after")
        # No cursor => the latest page; with ``after`` => everything newer (incremental sync).
        msgs = (await asyncio.to_thread(self._state.messages, sid, after, limit) if after
                else await asyncio.to_thread(self._state.tail, sid, limit))
        working = sid in await asyncio.to_thread(self._state.active_leases)
        return web.json_response({"sessionId": sid, "status": "working" if working else "idle",
                                  "messages": msgs, "cursor": self._cursor})

    async def _h_chat_session(self, request: "web.Request") -> "web.Response":
        sid = await asyncio.to_thread(self._state.find_phone_session, request.match_info["chat_id"])
        return web.json_response({"chatId": request.match_info["chat_id"], "sessionId": sid})

    def _phone_urls(self) -> list[str]:
        """Addresses a phone can use: Tailscale first (works anywhere), then LAN.
        T16: all URLs use https:// (TLS on the bridge)."""
        urls: list[str] = []
        scheme = "https"
        try:
            out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3).stdout
            urls += [f"{scheme}://{ip.strip()}:{self._port}" for ip in out.split() if ip.strip()]
            st = subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=3).stdout
            dns = (json.loads(st).get("Self") or {}).get("DNSName", "").rstrip(".") if st else ""
            if dns:
                urls.append(f"{scheme}://{dns}:{self._port}")
        except Exception:
            pass
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
                sk.connect(("10.255.255.255", 1))
                urls.append(f"{scheme}://{sk.getsockname()[0]}:{self._port}")
        except OSError:
            pass
        return list(dict.fromkeys(urls))

    # T16: TLS -----------------------------------------------------------------
    def _ensure_tls(self) -> Optional[ssl.SSLContext]:
        """Create or load a self-signed TLS certificate for the bridge.
        Returns None if TLS setup fails (fallback to plain HTTP)."""
        cert_path = self._tls_dir / "cert.pem"
        key_path = self._tls_dir / "key.pem"
        if not cert_path.exists() or not key_path.exists():
            logger.info("[phone] generating self-signed TLS certificate in %s", self._tls_dir)
            try:
                subprocess.run([
                    "openssl", "req", "-x509", "-newkey", "rsa:4096", "-sha256", "-days", "3650", "-nodes",
                    "-keyout", str(key_path), "-out", str(cert_path),
                    "-subj", "/CN=hermes-phone-bridge.local",
                    "-addext", "subjectAltName=DNS:hermes-phone-bridge.local,DNS:localhost,IP:127.0.0.1",
                ], capture_output=True, text=True, timeout=10, check=True)
                key_path.chmod(0o600)
                cert_path.chmod(0o644)
            except (subprocess.CalledProcessError, FileNotFoundError) as e:
                logger.warning("[phone] cannot generate TLS cert (openssl not found?): %s", e)
                return None
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        try:
            ctx.load_cert_chain(str(cert_path), str(key_path))
        except Exception as e:
            logger.warning("[phone] cannot load TLS cert: %s", e)
            return None
        return ctx

    @property
    def _tls_fingerprint(self) -> str:
        """SHA-256 fingerprint of the TLS certificate, as shown by openssl x509 -fingerprint -sha256."""
        cert_path = self._tls_dir / "cert.pem"
        if not cert_path.exists():
            return ""
        try:
            out = subprocess.run(
                ["openssl", "x509", "-fingerprint", "-sha256", "-noout", "-in", str(cert_path)],
                capture_output=True, text=True, timeout=5
            )
            if out.returncode == 0:
                # "SHA256 Fingerprint=AB:CD:..." -> "AB:CD:..."
                fp = out.stdout.strip().split("=", 1)[-1].strip()
                return fp
        except (FileNotFoundError, Exception):
            pass
        return ""

    @staticmethod
    def _qr_svg(text: str) -> str:
        """SVG QR via the qrcode package that ships in the hermes-agent checkout (node). '' if unavailable."""
        import shutil, subprocess
        lib = Path(__file__).resolve().parents[2] / "hermes-agent" / "node_modules" / "qrcode"
        lib = lib if lib.exists() else Path.home() / ".hermes" / "hermes-agent" / "node_modules" / "qrcode"
        node = shutil.which("node")
        if not node or not lib.exists():
            return ""
        js = ("require(process.argv[1]).toString(process.argv[2],{type:'svg',margin:1,width:240},"
              "(e,s)=>{if(e){process.exit(1)}process.stdout.write(s)})")
        try:
            out = subprocess.run([node, "-e", js, str(lib), text], capture_output=True, text=True, timeout=5)
            return out.stdout if out.returncode == 0 and out.stdout.startswith("<svg") else ""
        except Exception:
            return ""

    async def _h_pair_page(self, request: "web.Request") -> "web.Response":
        if request.remote not in ("127.0.0.1", "::1"):
            return self._err(403, "LOCAL_ONLY", "open this page on the PC itself")
        p = self._devices.start_pair()
        urls = await asyncio.to_thread(self._phone_urls)
        name = socket.gethostname().split(".")[0]
        from urllib.parse import quote
        first = (f"hermes-phone://pair?hubUrl={quote(urls[0], safe='')}&code={p['code']}"
                 f"&pairId={p['pairId']}&name={quote(name)}") if urls else ""
        svg = await asyncio.to_thread(self._qr_svg, first) if first else ""
        qr_block = (f"<p>Or scan with the app (Pair → Scan QR):</p><div style='width:240px'>{svg}</div>"
                    if svg else "")
        links = "".join(
            f"<li><code>{u}</code><br><small>hermes-phone://pair?hubUrl={quote(u, safe='')}&amp;code={p['code']}"
            f"&amp;pairId={p['pairId']}&amp;name={quote(name)}</small></li>" for u in urls) or "<li>no address found</li>"
        html = f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">
<title>Pair phone — {name}</title>
<style>body{{font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#1a1c1e}}
.code{{font:600 44px ui-monospace,monospace;letter-spacing:6px;margin:12px 0}}small{{color:#5f6368;word-break:break-all}}
li{{margin:8px 0}}.ask{{border:2px solid #1e6b4a;border-radius:12px;padding:12px;margin:12px 0;background:#e6f2ec}}
.conf{{font:600 28px ui-monospace,monospace;letter-spacing:4px;margin:0 8px}}button{{font:inherit;padding:6px 14px;margin-left:6px}}</style>
<h1>Pair a phone with Hermes on {name}</h1>
<div id=req></div>
<script>
const esc = v => String(v).replace(/[&<>"']/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}})[c]);
async function load(){{
  const r = await fetch('/pair/requests'); const j = await r.json(); const box = document.getElementById('req');
  box.innerHTML = (j.items||[]).map(x => `<div class=ask><b>${{esc(x.name)}}</b> (${{esc(x.ip)}}) wants to connect.<br>
    Check that the phone shows <span class=conf>${{esc(x.confirm)}}</span>
    <button data-id="${{esc(x.id)}}" data-d=approve>Allow</button> <button data-id="${{esc(x.id)}}" data-d=deny>Deny</button></div>`).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = () => act(b.dataset.id, b.dataset.d));
}}
async function act(id, d){{ await fetch(`/pair/requests/${{id}}/${{d}}`, {{method:'POST'}}); load(); }}
load(); setInterval(load, 1500);
</script>
<p>Easiest: in the phone app tap <b>Find PC on this Wi-Fi</b> and allow it here. Otherwise:</p>
<p>In the phone app enter the address and this code (valid 5 minutes, single use):</p>
<div class=code>{p['code'][:4]} {p['code'][4:]}</div>
{qr_block}
<p>Address (Tailscale first):</p><ul>{links}</ul>
<p><a href="/pair">New code</a> · paired devices: {self._devices.count()}</p>"""
        return web.Response(text=html, content_type="text/html")

    async def _h_new_chat(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json() if request.can_read_body else {}
        except ValueError:
            body = {}
        chat_id = f"p_{uuid.uuid4().hex[:16]}"
        slug = str((body or {}).get("project") or "").strip()
        project = None
        if slug:
            p = await asyncio.to_thread(self._projects.get, slug)
            if not p:
                self._projects.invalidate()   # created on the PC a moment ago?
                p = await asyncio.to_thread(self._projects.get, slug)
            if not p:
                return self._err(404, "PROJECT_NOT_FOUND", f"no project {slug!r}")
            self._chat_projects.set_chat(chat_id, p["slug"])
            project = {"slug": p["slug"], "name": p["name"]}
        return web.json_response({"chatId": chat_id, "project": project}, status=201)

    async def _remember_project_session(self, source: Any, slug: str) -> None:
        """Learn which session this project chat maps to BEFORE the agent builds its system prompt, so the
        prompt section can name the project (the gateway resolves the same entry right after us)."""
        runner = getattr(self, "gateway_runner", None)
        store = getattr(runner, "async_session_store", None)
        if store is None:
            return
        try:
            if hasattr(runner, "_normalize_source_for_session_key"):
                source = await asyncio.to_thread(runner._normalize_source_for_session_key, source)
            entry = await store.get_or_create_session(source)
            sid = getattr(entry, "session_id", None)
            if sid:
                self._chat_projects.set_session(sid, slug)
        except Exception as e:
            logger.debug("[phone] project pre-resolve failed: %s", e)

    async def _read_message(self, request: "web.Request") -> tuple[str, str, list[Any]] | "web.Response":
        """JSON ``{text, clientMessageId}`` or multipart (``text``, ``clientMessageId``, ``file`` parts).
        Files are cached exactly like Telegram/Teams attachments (``cache_media_bytes``)."""
        files: list[tuple[bytes, str, str]] = []
        if request.content_type.startswith("multipart/"):
            fields: dict[str, str] = {}
            total = 0
            reader = await request.multipart()
            async for part in reader:
                if part.filename is not None:
                    if len(files) >= MAX_ATTACHMENTS:
                        return self._err(400, "VALIDATION_ERROR", f"at most {MAX_ATTACHMENTS} files")
                    data = await part.read(decode=False)
                    total += len(data)
                    if total > MAX_UPLOAD_BYTES:
                        return self._err(413, "TOO_LARGE", "attachments exceed 25 MB")
                    files.append((bytes(data), part.filename or "file",
                                  part.headers.get("Content-Type", "application/octet-stream")))
                else:
                    fields[part.name or ""] = (await part.text())[:100_000]
            text, cmid = fields.get("text", "").strip(), fields.get("clientMessageId", "")
        else:
            try:
                body = await request.json()
            except ValueError:
                return self._err(400, "VALIDATION_ERROR", "invalid JSON")
            text, cmid = str(body.get("text", "")).strip(), str(body.get("clientMessageId") or "")
        if not text and not files:
            return self._err(400, "VALIDATION_ERROR", "text or a file is required")
        media = []
        for data, name, mime in files:
            try:
                cached = await cache_media_bytes_async(data, filename=name, mime_type=mime)
            except ValueError as e:
                return self._err(400, "BAD_ATTACHMENT", f"{name}: {e}")
            if cached is None:
                return self._err(400, "BAD_ATTACHMENT", f"{name} is not a valid image")
            media.append(cached)
        return text, cmid or uuid.uuid4().hex, media

    @staticmethod
    def _event(source: Any, text: str, msg_id: str, media: list[Any], raw: dict[str, Any]) -> MessageEvent:
        kinds = [m.kind for m in media]
        mtype = (MessageType.COMMAND if text.startswith("/") and not media else
                 MessageType.PHOTO if "image" in kinds else MessageType.VIDEO if "video" in kinds else
                 MessageType.AUDIO if "audio" in kinds else MessageType.DOCUMENT if kinds else MessageType.TEXT)
        # Non-image files reach the agent as paths (it reads them with its tools), like other platforms.
        notes = [m.context_note() for m in media if m.kind != "image"]
        full = "\n".join([t for t in [text, *notes] if t])
        return MessageEvent(text=full, message_type=mtype, source=source, message_id=msg_id,
                            media_urls=[m.path for m in media], media_types=[m.media_type for m in media],
                            raw_message=raw)

    async def _h_send(self, request: "web.Request") -> "web.Response":
        chat_id = request.match_info["chat_id"]
        parsed = await self._read_message(request)
        if isinstance(parsed, web.Response):
            return parsed
        text, msg_id, media = parsed
        if self._dedup.is_duplicate(msg_id):
            return web.json_response({"accepted": True, "duplicate": True, "chatId": chat_id, "messageId": msg_id})
        device_id = request["device_id"]
        source = self.build_source(chat_id=chat_id, chat_name=f"phone:{chat_id[:8]}", chat_type="dm",
                                   user_id=device_id, user_name=self._devices.device_name(device_id),
                                   message_id=msg_id)
        slug = self._chat_projects.chat(chat_id)
        if slug:
            await self._remember_project_session(source, slug)
        event = self._event(source, text, msg_id, media, {"device": device_id})
        asyncio.create_task(self.handle_message(event), name=f"phone-inbound-{msg_id[:8]}")
        self._wake.set()
        return web.json_response({"accepted": True, "chatId": chat_id, "messageId": msg_id}, status=202)

    # continue any session ----------------------------------------------------
    @staticmethod
    async def _maybe_await(v: Any) -> Any:
        return await v if asyncio.iscoroutine(v) or isinstance(v, asyncio.Future) else v

    async def _bind_route(self, source: Any, target_sid: str) -> Optional[str]:
        """Point this phone route's session key at ``target_sid`` exactly like gateway ``/resume``
        does (switch_session + conversation-scope reset + agent eviction). The paired phone acts for
        the PC owner, so the cross-origin IDOR guard of the slash command does not apply here.
        Returns an error string, or None when the route now targets the session."""
        runner = getattr(self, "gateway_runner", None)
        store = getattr(runner, "async_session_store", None)
        if runner is None or store is None or not hasattr(runner, "_session_key_for_source"):
            return "gateway runner not available"
        try:
            if hasattr(runner, "_normalize_source_for_session_key"):
                source = await asyncio.to_thread(runner._normalize_source_for_session_key, source)
            key = runner._session_key_for_source(source)
            db = getattr(runner, "_session_db", None)
            if db is not None and hasattr(db, "resolve_resume_session_id"):
                try:  # follow compression continuations to the live transcript (as /resume does)
                    target_sid = await self._maybe_await(db.resolve_resume_session_id(target_sid)) or target_sid
                except Exception:
                    pass
            entry = await store.get_or_create_session(source)
            if getattr(entry, "session_id", None) == target_sid:
                return None
            if hasattr(runner, "_release_running_agent_state"):
                runner._release_running_agent_state(key)
            new_entry = await store.switch_session(key, target_sid, preserve_prompt_pin=False)
            if not new_entry:
                return "session switch refused"
            if hasattr(runner, "_clear_conversation_scope"):
                runner._clear_conversation_scope(key, reason="resume")
            try:
                await store.set_model_override(key, None)
            except Exception:
                pass
            if hasattr(runner, "_evict_cached_agent"):
                runner._evict_cached_agent(key)
            logger.info("[phone] route %s -> session %s", key, target_sid)
            return None
        except Exception as e:  # never let a gateway-internal change crash the bridge
            logger.warning("[phone] bind to %s failed: %s", target_sid, e)
            return str(e)

    async def _h_send_to_session(self, request: "web.Request") -> "web.Response":
        sid = request.match_info["sid"]
        row = await asyncio.to_thread(self._state.session_row, sid)
        if not row:
            return self._err(404, "SESSION_NOT_FOUND", "no such session")
        if row["source"] in HIDDEN_SOURCES:
            return self._err(403, "SESSION_READ_ONLY", "internal sessions cannot be continued")
        parsed = await self._read_message(request)
        if isinstance(parsed, web.Response):
            return parsed
        text, msg_id, media = parsed
        if self._dedup.is_duplicate(msg_id):
            return web.json_response({"accepted": True, "duplicate": True, "sessionId": sid, "messageId": msg_id})
        holder = await asyncio.to_thread(self._state.lease_holder, sid)
        if holder and "platform=phone" not in holder:
            where = holder.rsplit("platform=", 1)[-1] if "platform=" in holder else "another client"
            return self._err(409, "SESSION_BUSY", f"the agent is working in this session on {where}; try when it finishes")
        # Phone sessions keep their own chat; any other session gets a stable phone route of its own.
        chat_id = row["chat_id"] if row["source"] == "phone" and row["chat_id"] else f"r_{sid}"
        device_id = request["device_id"]
        source = self.build_source(chat_id=chat_id, chat_name=f"phone:{chat_id[:10]}", chat_type="dm",
                                   user_id=device_id, user_name=self._devices.device_name(device_id),
                                   message_id=msg_id)
        err = await self._bind_route(source, sid)
        if err:
            return self._err(503, "BIND_FAILED", f"could not attach to the session: {err}")
        event = self._event(source, text, msg_id, media, {"device": device_id, "session": sid})
        asyncio.create_task(self.handle_message(event), name=f"phone-inbound-{msg_id[:8]}")
        self._wake.set()
        return web.json_response({"accepted": True, "sessionId": sid, "chatId": chat_id, "messageId": msg_id},
                                 status=202)

    # websocket ------------------------------------------------------------
    async def _h_ws(self, request: "web.Request") -> "web.WebSocketResponse":
        ws = web.WebSocketResponse(heartbeat=25)
        await ws.prepare(request)
        # T16: token comes from client.hello, not URL
        client = _Client(ws, "pending")
        self._clients.add(client)
        authenticated = False
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    frame = json.loads(msg.data)
                except ValueError:
                    await ws.send_json({"type": "error", "code": "WS_BAD_JSON"})
                    continue
                kind = frame.get("type")
                if kind == "client.hello":
                    rotated = None
                    if not authenticated:
                        # Authenticate from the token in the hello frame
                        token = str(frame.get("token", "") or "")
                        device_id, rotated = await asyncio.to_thread(
                            self._devices.authenticate_with_rotation, token)
                        if not device_id:
                            await ws.send_json({"type": "error", "code": "UNAUTHORIZED",
                                                "message": "pair this device first"})
                            await ws.close(4001, "unauthorized")
                            return ws
                        client.device_id = device_id
                        authenticated = True
                    client.sessions = {s for s in frame.get("sessions", []) if isinstance(s, str)}
                    hello: dict[str, Any] = {"type": "server.hello", "apiVersion": API_VERSION,
                                              "cursor": self._cursor, "serverTime": _iso(time.time())}
                    if rotated:
                        hello["token"] = rotated.get("deviceToken")
                        hello["tokenExpiresAt"] = rotated.get("expiresAt")
                    await ws.send_json(hello)
                    since = frame.get("since")
                    if isinstance(since, int) and since < self._cursor:
                        missed = await asyncio.to_thread(self._state.since, since, REPLAY_LIMIT)
                        for m in missed:
                            if not client.sessions or m["sessionId"] in client.sessions:
                                await ws.send_json({"type": "message.created", "sessionId": m["sessionId"],
                                                    "message": m, "replay": True})
                    working = await asyncio.to_thread(self._state.active_leases)
                    await ws.send_json({"type": "status.snapshot", "working": sorted(working)})
                    # T15: push current presence state immediately on connect
                    if self._presence:
                        presence_ev: dict[str, Any] = {
                            "type": "presence.updated",
                            "state": self._presence.get("state"),
                            "current_block": self._presence.get("current_block"),
                            "last_kick": self._presence.get("last_kick"),
                            "last_brief": self._presence.get("last_brief"),
                            "avatar": self._presence.get("avatar"),
                            "updated_at": self._presence.get("updated_at"),
                        }
                        await ws.send_json(presence_ev)
                elif kind == "client.subscribe":
                    client.sessions |= {s for s in frame.get("sessions", []) if isinstance(s, str)}
                elif kind == "client.unsubscribe":
                    client.sessions -= set(frame.get("sessions", []))
                elif kind == "ping":
                    await ws.send_json({"type": "pong", "ts": frame.get("ts") or int(time.time() * 1000)})
                else:
                    await ws.send_json({"type": "error", "code": "WS_UNKNOWN_TYPE", "message": str(kind)})
        finally:
            self._clients.discard(client)
        return ws


# ── plugin registration ─────────────────────────────────────────────────────

def _is_home_channel_nag(content: Optional[str]) -> bool:
    t = (content or "").lstrip()
    return t.startswith("\U0001F4EC") and "/sethome" in t


def _project_for_session(sid: str) -> Optional[dict[str, Any]]:
    """Project a phone session was started in, read from the files the adapter writes.

    Must not rely on module globals: Hermes may import this plugin several times (per-profile module names,
    hot reload evicts and re-executes it), so the module instance that registered a callback is not
    necessarily the one holding the live adapter."""
    if not sid:
        return None
    home = _hermes_home()
    store = ChatProjects(Path(os.environ.get("PHONE_BRIDGE_PROJECTS_PATH") or home / "phone_bridge" / "projects.json"))
    slug = store.session(sid)
    if not slug:
        try:
            row = StateReader(Path(os.environ.get("PHONE_BRIDGE_DB_PATH") or home / "state.db")).session_row(sid)
        except Exception:
            row = None
        slug = store.chat(row["chat_id"]) if row and row.get("source") == "phone" else None
    return ProjectIndex().get(slug) if slug else None


def _project_prompt_section(info: Any) -> str:
    """Frozen into each NEW phone session's system prompt: which project the chat was started in."""
    if str(info.get("platform") or "") != "phone":
        return ""
    p = _project_for_session(str(info.get("session_id") or ""))
    return prompt_section(p) if p else ""


_PINNED: set[str] = set()


def _pin_project_cwd(tool_name: str = "", args: Any = None, task_id: Optional[str] = None,
                     session_id: Optional[str] = None, **_: Any) -> None:
    """``pre_tool_call``: on a project session's first tool call, make the project folder the session's
    working directory (terminal + file tools resolve relative paths against it) — the same record a ``cd``
    writes, so the agent can still move elsewhere. Never blocks or modifies the call."""
    if not session_id or session_id in _PINNED:
        return None
    _PINNED.add(session_id)
    try:
        p = _project_for_session(session_id)
        path = p and p.get("path")
        if not path or not os.path.isdir(path):
            return None
        from tools.terminal_tool import get_session_cwd, record_session_cwd
        key = task_id or session_id
        if not get_session_cwd(key):
            record_session_cwd(key, path)
            logger.info("[phone] session %s works in project %s (%s)", session_id, p["slug"], path)
    except Exception as e:  # internal API moved? the prompt section still names the folder
        logger.debug("[phone] project cwd pin skipped: %s", e)
    return None


def check_requirements() -> bool:
    return AIOHTTP_AVAILABLE


def validate_config(config) -> bool:
    return True


def is_connected(config) -> bool:
    return _truthy(_secret("PHONE_BRIDGE_ENABLED", "")) or bool((getattr(config, "extra", {}) or {}).get("enabled"))


def _env_enablement() -> Optional[dict]:
    if not _truthy(_secret("PHONE_BRIDGE_ENABLED", "")):
        return None
    out: dict[str, Any] = {"enabled": True}
    if _secret("PHONE_BRIDGE_PORT", ""):
        out["port"] = int(_secret("PHONE_BRIDGE_PORT", ""))
    if _secret("PHONE_BRIDGE_HOST", ""):
        out["host"] = _secret("PHONE_BRIDGE_HOST", "")
    return out


def register(ctx) -> None:
    ctx.register_platform(
        name="phone", label="Phone Bridge", adapter_factory=lambda cfg: PhoneBridgeAdapter(cfg),
        check_fn=check_requirements, validate_config=validate_config, is_connected=is_connected,
        required_env=[], env_enablement_fn=_env_enablement,
        allowed_users_env="PHONE_BRIDGE_ALLOWED_USERS", allow_all_env="PHONE_BRIDGE_ALLOW_ALL_USERS",
        max_message_length=0, emoji="📱", pii_safe=True, allow_update_command=True,
        platform_hint=("You are talking to the user through their phone app. Replies are shown in a chat UI; "
                       "keep them concise. The same conversation is also available on their PC."),
    )
    try:
        ctx.register_system_prompt_section("phone-bridge.project", _project_prompt_section, max_chars=2000)
    except Exception as e:  # older Hermes without prompt sections: projects still list, just no context
        logger.info("[phone] project prompt section unavailable: %s", e)
    try:
        ctx.register_hook("pre_tool_call", _pin_project_cwd)
    except Exception as e:
        logger.info("[phone] project cwd hook unavailable: %s", e)
