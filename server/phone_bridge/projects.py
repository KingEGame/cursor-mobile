"""Hermes projects (``hermes project`` / desktop sidebar) for the phone.

Read-only view of ``$HERMES_HOME/projects.db`` through the public ``hermes_cli.projects_db`` API,
plus the phone's own chat → project choice. A session belongs to a project when its ``cwd`` /
``git_repo_root`` lies inside one of the project's folders (innermost folder wins, like the desktop
app) — compared after ``realpath`` so ``/data/...`` and ``/mnt/data/...`` spellings match — or when
it is a phone chat started "in" that project.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

CACHE_S = 30.0


def _real(p: str) -> str:
    try:
        return os.path.realpath(os.path.expanduser(p)).rstrip("/") or "/"
    except Exception:
        return p.rstrip("/")


class ProjectIndex:
    """Cached project list + path → project matching."""

    def __init__(self, loader=None) -> None:
        self._loader = loader or _load_projects
        self._at = 0.0
        self._items: list[dict[str, Any]] = []
        self._folders: list[tuple[str, str]] = []   # (real folder, slug), longest first
        self._lock = threading.Lock()

    def _refresh(self) -> None:
        if time.monotonic() - self._at < CACHE_S and self._at:
            return
        with self._lock:
            try:
                items = self._loader()
            except Exception as e:  # projects are optional — never break the bridge
                logger.warning("[phone] cannot read projects: %s", e)
                items = []
            folders: list[tuple[str, str]] = []
            for p in items:
                for f in p.get("folders") or []:
                    for v in {f.rstrip("/"), _real(f)}:
                        if v:
                            folders.append((v, p["slug"]))
            folders.sort(key=lambda t: len(t[0]), reverse=True)
            self._items, self._folders, self._at = items, folders, time.monotonic()

    def invalidate(self) -> None:
        self._at = 0.0

    def list(self) -> list[dict[str, Any]]:
        self._refresh()
        return list(self._items)

    def get(self, slug: Optional[str]) -> Optional[dict[str, Any]]:
        if not slug:
            return None
        self._refresh()
        return next((p for p in self._items if p["slug"] == slug), None)

    def for_path(self, *paths: Optional[str]) -> Optional[str]:
        self._refresh()
        if not self._folders:
            return None
        for raw in paths:
            if not raw or not str(raw).strip():
                continue
            for cand in {str(raw).rstrip("/"), _real(str(raw))}:
                for folder, slug in self._folders:
                    if cand == folder or cand.startswith(folder + "/"):
                        return slug
        return None


def _load_projects() -> list[dict[str, Any]]:
    from hermes_cli import projects_db as pdb  # gateway process: always importable

    conn = pdb.connect()
    try:
        out = []
        for p in pdb.list_projects(conn):
            folders = [f.path for f in (p.folders or [])]
            primary = p.primary_path or next((f.path for f in p.folders if f.is_primary), None) or (folders[0] if folders else None)
            out.append({"slug": p.slug, "name": p.name, "icon": p.icon, "color": p.color,
                        "description": p.description, "path": primary, "folders": folders})
        return out
    finally:
        try:
            conn.close()
        except Exception:
            pass


class ChatProjects:
    """Phone chat id / session id → project slug, persisted next to the device store."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._d: dict[str, dict[str, str]] = {"chats": {}, "sessions": {}}
        try:
            raw = json.loads(path.read_text())
            self._d["chats"].update(raw.get("chats") or {})
            self._d["sessions"].update(raw.get("sessions") or {})
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._d, indent=1))
        os.replace(tmp, self.path)

    def set_chat(self, chat_id: str, slug: str) -> None:
        with self._lock:
            self._d["chats"][chat_id] = slug
            self._save()

    def set_session(self, session_id: str, slug: str) -> None:
        with self._lock:
            if self._d["sessions"].get(session_id) != slug:
                self._d["sessions"][session_id] = slug
                self._save()

    def chat(self, chat_id: Optional[str]) -> Optional[str]:
        return self._d["chats"].get(chat_id) if chat_id else None

    def session(self, session_id: Optional[str]) -> Optional[str]:
        return self._d["sessions"].get(session_id) if session_id else None


def prompt_section(project: dict[str, Any]) -> str:
    folders = project.get("folders") or []
    extra = [f for f in folders if f != project.get("path")]
    lines = [
        f"## Active project: {project['name']}",
        f"This chat was started from the user's phone inside the Hermes project \"{project['name']}\" "
        f"(slug `{project['slug']}`).",
        f"Project folder: `{project.get('path')}`" + (f" (also: {', '.join(f'`{f}`' for f in extra)})" if extra else ""),
        "Treat that folder as the working directory for this conversation: `cd` into it before running "
        "terminal commands and use paths inside it for file tools. Read its AGENTS.md / README first when "
        "the task concerns the code.",
    ]
    if project.get("description"):
        lines.append(f"Project description: {project['description']}")
    return "\n".join(lines)
