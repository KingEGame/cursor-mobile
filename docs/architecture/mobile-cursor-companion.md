<!-- generated-by: gsd-doc-writer -->
# Architecture — Improved Cursor Mobile System

**Status:** accepted design (2026-09-24) · **Scope lock:** PC-local only — **no cloud mode**  
**Goal:** Phone works **inside the project already open on the PC** — continue existing sessions or start new ones with **model choice, file attach, tools & plugins** — all executed by Cursor on that PC.  
**Agent briefing (load first):** [AGENT-CONTEXT.md](./AGENT-CONTEXT.md) · **Rules:** [`../../AGENTS.md`](../../AGENTS.md)

---

## How we work (day in the life)

End-to-end path from a normal PC morning to phone-side Composer work. Nothing in this loop leaves the machine or Tailscale mesh.

```mermaid
sequenceDiagram
  actor You
  participant PC as Cursor on PC
  participant Hub as Hub (this PC)
  participant TS as Tailscale
  participant Phone as Android APK

  You->>PC: Open project folder (as today)
  Note over Hub,PC: Hub binds to that workspace only
  Hub->>PC: Detect workspace / windows (CDP · VS Code API)
  You->>Phone: Open companion APK
  Phone->>TS: Reach Hub on private mesh
  TS->>Hub: Forward (no public CDP)
  Phone->>Hub: GET /workspace + GET /health
  Hub-->>Phone: Project name, path, roots, models, tools summary
  Note over Phone: Banner shows the PC-open project — not a cloud list

  alt Continue an existing session
    Phone->>Hub: GET /sessions?workspaceId=
    Hub-->>Phone: live ∪ history for this project
    You->>Phone: Pick live or history session
    Phone->>Hub: messages / open-on-pc / approvals
    Hub->>PC: LiveCursorAdapter drives Composer + tool cards
  else Start a new session
    You->>Phone: New session sheet (model · files · prompt)
    Phone->>Hub: POST /sessions { model, attachments, prompt }
    Hub->>PC: Focus Composer in open project · apply model · @file refs
    Phone->>Hub: chat + Approve/Deny tool calls
    Hub->>PC: Tools/MCP run on PC only
  end
```

### Step-by-step

1. **Open the project on the PC** — Same as today: open the folder in Cursor. The phone never clones or opens an unrelated tree in v1.
2. **Hub binds** — Local Hub attaches to that workspace (and Cursor windows). If no folder is open, the APK shows “Open a project in Cursor on the PC” and refuses a fake empty workspace.
3. **Phone sees the project** — Over Tailscale, `GET /workspace` paints the active project banner (name, path, roots). Session lists are filtered to that `workspaceId`.
4. **Continue or create**
   - **Continue:** pick a live Composer/agent session or a history row → chat, attach more files, approve tools; history uses **Open on PC** to become `live` in the same project.
   - **New session:** pick **model**, **attach files** from workspace roots, optional first prompt → Hub opens/focuses Composer in the already-open project and applies model + `@file` refs. **Tools / plugins / MCP** stay loaded in Cursor on the PC; the phone only streams cards and Approve / Deny.

The phone does **not** replace opening the project on the PC. It remotes the agent/Composer loop for the project that is already there.

---

## Product model (how the phone is used)

```mermaid
flowchart TB
  PC["PC: Cursor has project X open"]
  Hub["Hub binds to that workspace"]
  Phone["APK: remote Composer for project X"]

  PC --> Hub --> Phone
  Phone -->|"continue session"| PC
  Phone -->|"new session: model + files + tools"| PC
```

1. You open a **project in Cursor on the PC** (as you do today).
2. The Hub attaches to that workspace (and open windows).
3. On the phone you either:
   - **Continue** a session that already belongs to that project, or
   - **Create** a new session in that same project: pick **model**, **attach files** from the project, use **tools / plugins / MCP** that Cursor already has on the PC.

---

## Scope lock (non-negotiable)

| In scope | Out of scope |
|----------|--------------|
| Workspace / project **already open** on this PC | Cloud Agents / Remote Control / cloud workers |
| **All** local sessions for that project (and PC history) | Browsing unrelated machines’ projects |
| Continue live + history → open-on-PC | Phone as primary place to clone/open folders |
| New session: model + file attach + tools/plugins | Running tools on the phone itself |
| Approvals for tool runs on the PC | Exposing CDP publicly |
| Tailscale phone ↔ PC | |

---

## How we work — component responsibilities

| Component | Runs on | Responsibility |
|-----------|---------|----------------|
| **Android APK** (`apps/mobile`) | Phone | Sideloaded Expo app: project banner, session list, continue / new-session UI, chat, Approve/Deny cards. Never executes MCP/tools locally. |
| **Hub** (`packages/hub`) | PC | Local HTTP + WebSocket API bound to the PC-open workspace. Aggregates workspace context, sessions, file index, models, tools summary; orchestrates create / open-on-pc / messages / approvals. |
| **LiveCursorAdapter** (`adapters/` · live) | PC | CDP / DOM relay into Cursor Composer (CursorRemote-class): send prompts, set model when UI allows, inject file refs, stream tool-call cards, apply approvals. |
| **History Index** (`adapters/` · history) | PC | Indexes local Cursor session store for the open project (cursor-session-class). Powers history list and **Open on PC** → `live`. |
| **Tailscale** | Phone ↔ PC | Private mesh only. Phone reaches Hub; CDP stays off the public internet. |

```mermaid
flowchart LR
  APK["APK"] -->|Tailscale| Hub["Hub"]
  Hub --> Live["LiveCursorAdapter"]
  Hub --> Hist["History Index"]
  Hub --> Files["Workspace file index"]
  Live --> Cursor["Cursor IDE"]
  Hist --> Cursor
  Files --> Cursor
```

---

## How we work — data and control flows

### Continue session (live or history → live)

Control stays on the phone; data and tool execution stay on the PC.

```mermaid
sequenceDiagram
  participant Phone as APK
  participant Hub
  participant Live as LiveCursorAdapter
  participant Hist as History Index
  participant Cursor as Cursor on PC

  Phone->>Hub: GET /sessions?workspaceId=
  Hub->>Live: list live Composer/agent for workspace
  Hub->>Hist: list history for workspace
  Hub-->>Phone: unified session rows

  alt Already live
    Phone->>Hub: POST /sessions/:id/messages
    Hub->>Live: inject prompt into open Composer
    Live->>Cursor: DOM / CDP update
    Cursor-->>Live: stream tokens + tool-call cards
    Live-->>Hub: events
    Hub-->>Phone: WS chat + approval cards
    Phone->>Hub: POST /sessions/:id/approvals
    Hub->>Live: Approve / Deny
    Live->>Cursor: confirm tool UI on PC
    Note over Cursor: MCP / plugins / tools run on PC
  else History → resume
    Phone->>Hub: POST /sessions/:id/open-on-pc
    Hub->>Hist: resolve local session identity
    Hub->>Live: focus / reopen in same project
    Live->>Cursor: open Composer in PC-open workspace
    Note over Phone,Cursor: Then same live path as above
  end
```

### New session (model + files + tools)

Phone chooses **model**, **attachments**, and first **prompt**; Hub and LiveCursorAdapter apply them inside the already-open project. Tools are never reimplemented on the phone.

```mermaid
sequenceDiagram
  participant Phone as APK
  participant Hub
  participant Live as LiveCursorAdapter
  participant Cursor as Cursor on PC

  Phone->>Hub: GET /workspace/models
  Hub-->>Phone: models Cursor exposes locally
  Phone->>Hub: GET /workspace/files?q=
  Hub-->>Phone: paths under workspace roots
  Phone->>Hub: GET /workspace/tools
  Hub-->>Phone: MCP / tools / plugins summary (read-only)

  Phone->>Hub: POST /sessions { workspaceId, model, attachments[], prompt, agentMode }
  Note over Hub: Reject if workspaceId ≠ PC-open project
  Hub->>Live: open/focus Composer in bound workspace
  Live->>Cursor: set model (as UI allows)
  Live->>Cursor: inject @file refs from attachments
  Live->>Cursor: optional first prompt
  Cursor-->>Live: stream + tool-call cards
  Live-->>Hub: events
  Hub-->>Phone: live chat + Approve/Deny
  Phone->>Hub: approvals
  Hub->>Live: apply on PC
  Note over Cursor: Tools / plugins / MCP execute on PC only
```

---

## Needs → coverage

| Need | How we cover it |
|------|-----------------|
| Work on PC-open project | Hub reports `workspace` (path, name, roots); APK UI scoped to it |
| Continue existing sessions | Live CDP + History Index filtered/grouped by workspace |
| New session + **model** | Create flow → LiveCursorAdapter sets model in Composer (as Cursor UI allows) |
| **Attach files** | File picker from workspace roots (Hub lists paths); refs injected into Composer |
| **Tools & plugins** | Tools/MCP already loaded in Cursor on PC; phone sends prompts + **approves** tool calls |
| Create session | `POST /sessions` with `{ model, attachments[], mode }` |
| APK | Expo sideload APK |
| Reliability | Health, reconnect, no silent approvals |

---

## Target architecture

```mermaid
flowchart TB
  subgraph Phone["Android APK"]
    Home["Active project banner"]
    Sess["Sessions for this project"]
    New["New session sheet:<br/>model · files · tools info"]
    Live["Chat + approvals"]
  end

  subgraph PC["This PC"]
    Hub["Hub"]
    WS["Workspace context"]
    LiveA["LiveCursorAdapter"]
    Hist["History Index"]
    Files["Workspace file index"]
    Cursor["Cursor IDE<br/>project open · models · MCP/tools"]
  end

  Home --> Hub
  Sess --> Hub
  New --> Hub
  Live --> Hub
  Hub --> WS
  Hub --> LiveA
  Hub --> Hist
  Hub --> Files
  WS --> Cursor
  LiveA --> Cursor
  Hist --> Cursor
  Files --> Cursor
```

---

## Session modes (PC-only)

| Mode | Meaning | Phone can |
|------|---------|-----------|
| `live` | Open Composer/agent in Cursor for this workspace | Chat, model (if UI allows change), attach more files, approve tools |
| `history` | Past session for this project (or PC store) | Read; **Open on PC** in this project → `live` |
| `editor` | Optional later — browse project files | Pick attachments / view |

---

## New session contract (required)

```
POST /sessions
{
  "workspaceId": "...",          // must match PC-open project
  "model": "composer-..." | "...",
  "attachments": [ "src/a.ts", "docs/x.md" ],
  "prompt": "optional first message",
  "agentMode": "agent" | "ask" | "..."   // as Cursor exposes
}
```

Hub → opens/focuses Composer in the **already open** project → applies model + @file refs → optional first prompt.

**Tools / plugins:** not reimplemented on the phone. Cursor on the PC runs MCP/tools/plugins; the APK streams tool-call cards and **Approve / Deny** (CursorRemote-class).

---

## Workspace binding

```mermaid
sequenceDiagram
  participant User
  participant PC as Cursor on PC
  participant Hub
  participant App as APK

  User->>PC: Open project folder
  Hub->>PC: Detect workspace via CDP / VS Code API
  App->>Hub: GET /workspace
  Hub-->>App: name, path, roots, models, tools summary
  App->>Hub: GET /sessions?workspaceId=
  Hub-->>App: live ∪ history for that project
```

If Cursor has **no** folder open: APK shows “Open a project in Cursor on the PC” — no fake empty workspace.

Multi-window: user picks which Cursor window/workspace (same as CursorRemote window switch).

---

## What we borrow

| Source | Use for |
|--------|---------|
| [CursorRemote](https://github.com/len5ky/CursorRemote) | Live chat, approvals, prompts, multi-window |
| [cursor-session](https://github.com/iksnae/cursor-session) | All past local sessions for the project |
| [Paseo](https://github.com/getpaseo/paseo) | Daemon + Expo APK shape |

---

## Hub API (core)

```
GET    /workspace              → active project(s) on PC
GET    /workspace/files?q=     → attach picker (paths under roots)
GET    /workspace/models       → models Cursor exposes locally
GET    /workspace/tools        → MCP/tools/plugins summary (read-only)
GET    /sessions?workspaceId=
POST   /sessions               → new: model + attachments + prompt
POST   /sessions/:id/open-on-pc
POST   /sessions/:id/messages
POST   /sessions/:id/attachments
POST   /sessions/:id/approvals
WS     /ws
GET    /health
POST   /pair/...
```

---

## Phased delivery (PC-only, no cloud)

Every phase stays on **this PC + Tailscale**. No Cloud Agents, no cloud session lists, no remote workers.

| Phase | Delivers | Still true |
|-------|----------|------------|
| **0** | Pair, Tailscale, health, **active workspace** banner | Bound to PC-open project only |
| **1** | Live continue + approve tools + create (model + basic attach) + APK | Tools execute on PC; phone approves |
| **2** | Full project session history + open-on-PC | Local History Index only — no cloud history |
| **3** | Richer file picker / @-mentions; optional editor tab | Attachments from workspace roots on PC |
| **4** | Harden CDP selectors, offline queue | Still no public CDP; still no cloud mode |

```mermaid
flowchart LR
  P0["Phase 0<br/>pair · health · workspace banner"] --> P1["Phase 1<br/>live + create + APK"]
  P1 --> P2["Phase 2<br/>full local history"]
  P2 --> P3["Phase 3<br/>richer files / editor"]
  P3 --> P4["Phase 4<br/>harden · offline queue"]
```

---

## Repo layout

Intended monorepo shape (packages land as implementation proceeds):

```
cursor_mobile/
├── apps/
│   └── mobile/          # Expo Android APK — UI, pairing, chat, approvals
├── packages/
│   └── hub/             # Local Hub API (HTTP/WS), workspace binding, orchestration
├── adapters/
│   ├── live/            # LiveCursorAdapter — CDP/Composer control (CursorRemote-class)
│   └── history/         # History Index — local session index (cursor-session-class)
├── docs/
│   ├── architecture/    # This document
│   ├── features/
│   └── reports/
└── research/
```

| Path | Owns |
|------|------|
| `apps/mobile` | APK surfaces only — never hosts tools or Cursor |
| `packages/hub` | Single control plane for phone ↔ PC; enforces workspace bind |
| `adapters/live` | Live control path into Cursor |
| `adapters/history` | Local project session discovery and open-on-PC |

---

## Explicit non-goals

- Cloud mode / cloud agents.
- Opening arbitrary projects from the phone without Cursor having them open on the PC (v1).
- Running MCP servers on the phone.

---

## Decision summary

**Phone = remote Composer for the project already open on the PC.** Continue all existing sessions for that work, or start new ones with **model + files + tools/plugins (on PC)** + approvals. No cloud.
