# @cursor-mobile/mcp — Claude ↔ Cursor through the local Hub

A stdio MCP server that lets Claude (Claude Code) work with Cursor Agents chats on **this PC**:
list projects and chats, read transcripts, send prompts or start chats (with mode, model,
`@` files/plugins and `/` skills/rules), wait for the agent's reply, stop it, and review
the files it changed.

It talks **only** to the Hub on loopback (`http://127.0.0.1:8787`). It never dials CDP
and never leaves the PC. Every action goes through the Hub's verified, fail-closed
Agents path, the same one the phone uses.

```mermaid
flowchart LR
  Claude["Claude Code"] -->|stdio MCP| MCP["cursor-mobile-mcp"]
  MCP -->|"HTTP 127.0.0.1:8787 + device token"| Hub["Hub"]
  Hub -->|"CDP 127.0.0.1:9222"| Cursor["Cursor Agents window"]
```

## Install

```bash
npm run mcp:install
```

This builds the package and runs `claude mcp add cursor -s user -- node <repo>/packages/mcp/dist/index.js`.
Restart Claude Code sessions to load it. Remove it with `claude mcp remove cursor -s user`.

## Pairing

On first use the server pairs itself over loopback (`POST /v1/pair/start` is loopback-only)
as a device named **Claude (MCP)**. The token is stored in
`~/.config/cursor-mobile/mcp-device.json` (mode 0600; override with `CURSOR_MOBILE_MCP_TOKEN_FILE`).
If the Hub revokes or forgets the token, the server re-pairs once automatically.

## Tools

| Tool | Acts on PC? | Hub route |
|------|-------------|-----------|
| `cursor_status` | no | `GET /v1/health` (summary) |
| `cursor_list_projects` | no | `GET /v1/agents` |
| `cursor_read_chat` | no | `GET /v1/sessions/hist_<id>/messages` |
| `cursor_send` | **yes** | `POST /v1/agents/chats/:id/messages` |
| `cursor_new_chat` | **yes** | `POST /v1/agents/projects/new` |
| `cursor_wait` | no | polls `GET /v1/agents`, then reads the transcript |
| `cursor_stop` | **yes** | `POST /v1/agents/chats/:id/stop` |
| `cursor_changes` / `cursor_diff` | no | `GET /v1/agents/chats/:id/changes[/:index]` |
| `cursor_find_mention` | briefly types `@`/`/` into the PC composer and clears it | `GET /v1/agents/chats/:id/mentions` |

Editing earlier messages is intentionally **not** exposed.

## Fail-closed guards

- **Cursor needs Reload Window.** The Hub reads Cursor's composer notice tray. When it
  shows a stuck agent runtime ("Agent Execution Timed Out" + Reload Window), sends and new
  chats are refused with `CURSOR_NEEDS_RELOAD`, and `cursor_status` reports
  `cursor: "needs_reload"`. Otherwise the prompt would be submitted, time out, and land
  back in the PC input box. The phone shows the same warning on Home and in the chat.
- **Unsent text in the PC chat box.** If Cursor's input already holds text or attachments
  (an operator draft, or a prompt Cursor put back), sends are refused with
  `COMPOSER_NOT_EMPTY` and nothing is typed, so drafts are never overwritten or merged.
- **Prompt not in the transcript.** `cursor_wait` checks that the prompt it sent reached
  the chat transcript. If not, it returns `promptLanded: false` with a warning (and any
  Cursor error banner) instead of an old reply.

## Safety

- Sending makes a Cursor agent act on the operator's PC, and Cursor may auto-run tools.
  Leave `cursor_send`, `cursor_new_chat` and `cursor_stop` on "ask" in Claude Code
  permissions. The read-only tools are safe to allow.
- `HUB_URL` must be loopback; anything else is refused at startup.

## Test

```bash
npm run test:mcp
```

The tests run a real Hub app with the mock Cursor adapter, driven through a real MCP client.
