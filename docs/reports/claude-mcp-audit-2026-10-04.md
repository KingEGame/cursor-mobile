# Claude MCP server — build, live test and audit (2026-10-04)

**Product locks still true?** Yes. The MCP server runs on the operator PC, talks only to
the Hub on `127.0.0.1`, never dials CDP, and nothing leaves the PC. CDP stays loopback-only.

## Done

- New package `packages/mcp` (`@cursor-mobile/mcp`): a stdio MCP server, registered with
  Claude Code as `cursor` (user scope) via `npm run mcp:install`.
- Tools: `cursor_status`, `cursor_list_projects`, `cursor_read_chat`, `cursor_send`,
  `cursor_new_chat`, `cursor_wait`, `cursor_stop`, `cursor_changes`, `cursor_diff`,
  `cursor_find_mention`. Editing earlier messages is intentionally not exposed.
- The server self-pairs over loopback as the device "Claude (MCP)". Its token is kept in
  `~/.config/cursor-mobile/mcp-device.json` (0600). It re-pairs once on 401, and parallel
  first calls share one pairing.

## Live test (real Hub, real Cursor)

| Check | Result |
|-------|--------|
| status / list / read | Pass, 20–90 ms |
| changes / diff (CI/CD chat, 20+ files) | Pass; a bad index fails with `FILE_NOT_FOUND` |
| `@` lookup with a draft in the PC box | Pass after fix (draft preserved byte-for-byte) |
| `/` lookup with and without a query | Pass |
| send while Cursor is stuck | Refused with `CURSOR_NEEDS_RELOAD` and a clear fix |
| send with leftover text in the PC box (after Reload Window) | Refused with `COMPOSER_NOT_EMPTY`; nothing typed |
| send → wait round trip ("Ping response" test chat) | **Pass**: reply `pong` in 6 s, `promptLanded: true` |

The first round-trip attempt hit a Cursor-side failure ("Agent Execution Timed Out", extension
host unresponsive), and Cursor put the prompt back in its input box. After the operator
clicked Reload Window, the leftover test text was cleared (verified to be exactly the test
prompt first) and the round trip passed.

## Audit findings and fixes

1. **Hub said `cdp_ok` while Cursor could not run agents.** The sidebar scrape now also
   reads the composer notice tray (`.ui-prompt-input-header-tray__tray[data-visible=true]`)
   and reports it as `alerts` (`GET /v1/agents`). Sends and new chats return 409
   `CURSOR_NEEDS_RELOAD` while a stuck-runtime banner is shown. The phone shows the warning
   on Home and in the chat; MCP `cursor_status` reports `needs_reload`.
2. **Drafts in the PC chat box were overwritten (plain send) or merged (send with chips).**
   This is a pre-existing bug that also affected the phone. Sends now fail closed with
   `COMPOSER_NOT_EMPTY` (409) and type nothing.
3. **`cursor_wait` could return an old reply** when the prompt never landed. It now matches
   the sent prompt in the transcript (allowing for chips in front), waits up to 8 s for the
   DB to catch up, and otherwise returns `promptLanded: false` plus Cursor's banner text.
4. **The `@` lookup found nothing after draft text** (`else.@AGENTS`): a leading space is
   now typed when needed and removed afterwards.
5. **Diff hunk headers** now carry line counts (`@@ -a,n +b,m @@`).

Tests: gate green (390+), including new tests for every fix above (adapter, Hub route,
MCP end-to-end through a real MCP client, phone helper).

## Open gaps

- The rebuilt APK (warning banner) is published to the Hub but keeps version 0.1.1 (101).
  Install it with `adb install -r` over USB, or bump the version for an in-app update.
- Approvals stay parked (Cursor auto-run is on).

## Next agent

Mobile owner: install the rebuilt APK over USB (`adb install -r`) and check the Cursor
warning banner on Home and in a chat.
