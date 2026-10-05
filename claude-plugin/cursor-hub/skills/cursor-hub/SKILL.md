---
name: cursor-hub
description: Work with Cursor Agents chats on this PC through the local cursor-mobile Hub — hand Cursor a task, wait for its answer, review the files it changed, follow up or stop it. Use when the user asks to have Cursor do something, check on a Cursor chat, or review what a Cursor agent changed.
---

# Cursor via the local Hub

The `cursor_*` tools drive the Cursor Agents window on **this PC** through the cursor-mobile
Hub on `127.0.0.1:8787`. Nothing leaves the PC.

## Loop

1. `cursor_status`. If `canDriveCursor` is false, stop and tell the user why. `needs_reload`
   means they must click **Reload Window** in Cursor; never reload, kill or restart Cursor yourself.
2. `cursor_list_projects` (optionally filter by `project`) to get the `projectId` and the chat `composerId`.
3. To give context, use `cursor_read_chat`. To attach files, rules or skills, look up exact labels with
   `cursor_find_mention` (`@` for files and MCP plugins, `/` for skills and commands).
4. Act:
   - `cursor_send` to continue an existing chat;
   - `cursor_new_chat` to start one in a project.
   Pass `mode` or `model` only when the user asked: they stick to that chat in Cursor.
5. `cursor_wait` for the reply.
   - `promptLanded: false` means Cursor did not run it. Report the warning; do not resend blindly.
   - `timedOut: true` means it is still running. Wait again, or `cursor_stop` if the user wants.
6. Review with `cursor_changes` and then `cursor_diff` (by index) before telling the user it's done.

## Rules

- Cursor auto-runs tools on the user's PC. Send only what the user asked for, phrased as a clear task.
- One prompt at a time per chat. Do not send again while a chat is `working`.
- `COMPOSER_NOT_EMPTY` means the user has unsent text in Cursor's box. Never clear it; ask them.
- Editing earlier messages is not supported on purpose.
