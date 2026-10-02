# Real-data + connectivity test — go / no-go input

**Date:** 2026-10-01 · **Setup:** main Cursor window (CDP `127.0.0.1:9222`, normal profile), Hub on PC (`0.0.0.0:8787`), Pixel 7 over Tailscale (`pixel-7` ↔ `kingwarpc-1`), release APK `local.cursor.mobile` 0.1.0  
**Rules kept:** no second Cursor profile, Cursor not restarted, no messages sent and no buttons clicked in Cursor (selector check was read-only).

> **Product locks still true:** yes. Everything ran on the PC + phone over Tailscale; CDP stayed loopback.

---

## Summary

| Layer | Result |
|-------|--------|
| Network (Tailscale, Hub, WebSocket) | ✅ **Works well**: fast and stable |
| Cursor connection (CDP) | ✅ Connected; 4/6 actions match live UI, 2 can't be checked without a pending tool |
| **Real data on the phone** | ❌ **Does not match.** PC Cursor shows 16 repositories / ~28 chats; phone shows 1 project and 1 fake row |
| Chat content | ❌ Empty, no transcript |
| Pairing | ⚠️ Works only with the IP; the default QR (MagicDNS name) fails on the phone |

**In one line:** the pipe is good, but what flows through it is wrong. The app was built for "one editor window = one project". You actually use Cursor's **Agents window** with many repositories.

---

## 1. Connectivity and delay

| Measurement | Result |
|-------------|--------|
| Tailscale path PC ↔ Pixel | **Direct** (no relay), tunnel ping **9 ms** |
| ICMP ping from Pixel → PC (20 pkts) | 0% loss · avg **28 ms** · min 11 · max 240 (radio wake-up spike) |
| HTTP `/health` from Pixel (10 runs, new TCP each) | **60–123 ms** |
| HTTP `/health` PC → own mesh IP (20 runs) | p50 4.3 ms · p95 5.1 ms |
| `/sessions` (mesh) | p50 8.7 ms |
| `/workspace/models` | 679 ms (CDP scrape of model picker; first call) |
| WebSocket connect / ping | open **26 ms** · ping RTT **1 ms** |
| Hub health on phone | **healthy**: Hub up, CDP connected, `cdp_ok`, Cursor running |

Verdict: speed is not a problem. Everything is far below what a person notices on a phone.

## 2. Cursor connection (CDP selectors, read-only dry run)

| Action | Live match |
|--------|-----------|
| send_message | ✅ HIGH (prompt input) |
| model_select | ✅ HIGH (model picker) |
| file_attach | ✅ HIGH ("Add agents, context, tools") |
| composer_history_open | ✅ HIGH |
| approve | ⚪ no match: only appears when a tool waits for approval (untested) |
| deny | ⚪ LOW: same reason |

Note: the Hub reports all six as "VERIFIED" from a stored label, not from a live check.

## 3. Real projects and chats: PC vs phone

**Cursor on the PC (Agents window sidebar, read via CDP):** 16 repositories including KTMAppartments, omnitouter, cursor_mobile, AcademicResearch, enhanceduserinteraction, MasterProject, kingegame.github.io, kingegame, store, Cursor, mindzq-tawkto, AiJibApplier-org, Simulation, Entuthiasm, classifier-service, with about 28 chats and times (14m, 53m, 23h, 7d, 1mo…).

**Hub → phone:**

| | PC Cursor | Phone |
|---|-----------|-------|
| Projects | 16 | **1** (`cursor_mobile`, from the `CURSOR_WORKSPACE` env default) |
| Chats | ~28 | **1** row titled **"Cursor Agents"**: that's the *window title*, not a chat |
| History chats for bound project | 2 visible under cursor_mobile | **0** (`sessionCountForBind: 0`) |
| Opened chat transcript | full conversation | **empty** |

Root causes:
1. The Hub binds to **one workspace from an env var**, not to what Cursor has open.
2. The live adapter treats the **window** as a session.
3. The history reader doesn't find Agents-window chats for this project (the three local stores are present but don't map).
4. There's no transcript read (known gap F1.1).

Encouraging: the Agents sidebar **is cleanly readable** over CDP (`.ui-sidebar-label-row-title` = repository, `.ui-text` = chat title + age), so a correct list is reachable with the existing approach.

## 4. Bugs found on the device

| # | Bug | Effect | Fix |
|---|-----|--------|-----|
| B1 | Pair QR/deep link uses MagicDNS name; **phone can't resolve `*.ts.net`** (`ping: unknown host`) | Pairing fails with NETWORK_ERROR on the default path | Put the Tailscale **IP** in the QR (keep name as a hint), or fix MagicDNS on the phone's Tailscale app |
| B2 | After pairing, Hub's `baseUrlHint` (MagicDNS) **overwrites** the URL the user paired with | Health stuck at "unknown" even though pairing worked | App should keep the URL that worked; hint only if reachable |
| B3 | Pairing didn't survive earlier (app opened on Pair screen) | Re-pair needed | Check token persistence across Hub restarts |
| B4 | **154 paired devices** stored on the Hub | Old test tokens never expire/cleaned: security hygiene | Expire + prune; "Paired devices" list with revoke |
| B5 | Opened chat: message area collapses to a thin strip and the composer floats mid-screen | Looks broken | Layout flex fix (covered by Amendment B rebuild) |
| B6 | Deep link second time only filled fields, didn't submit; stale error stayed visible | Confusing | Clear error on new link; consistent auto-submit |

### Fixed same day (APK rebuilt + installed on Pixel)

| Bug | Fix | Verified on device |
|-----|-----|--------------------|
| **Endless refresh / reconnect loop** (all screens) | Six screens (Chats, Account, Health, New chat, Editor, Live chat) listed the whole `session` context as a hook dependency; `setHealthAndWorkspace` re-created the loader → refresh → set → … and the WS was torn down/re-opened each time. Now depend only on stable setters (`setHealthAndWorkspace`, `clearDevice`, `refreshFromStorage`) | Chats: 1 steady socket for 20 s (was reconnecting). Live chat: steady sockets + 15 s approvals poll only |
| B2 URL overwrite | `resolvePairedHubBaseUrl` keeps the URL the phone paired through; hint only when that was loopback (tests updated) | Unit tests pass |
| B1 QR host | `start-hub-tailscale.sh` puts the Tailscale **IPv4** in the QR, MagicDNS only as fallback | Script change; QR now `host=100.108.160.99` |
| B5 chat layout | Loading state fills the screen so the composer stays at the bottom (the strip was the never-ending spinner) | Composer pinned; empty state shows |
| B6 second pairing link | New code clears the stale error and re-arms auto-pair | Typecheck + tests |
| Boot route | Paired app opens on **Chats** (UI-SPEC decision #2); Health checks automatically when opened | Cold start → Chats, Online |

Still open: wrong data (1 fake row instead of 16 repos / 28 chats), empty transcripts, B3 token persistence, B4 154 stale devices, "Synced just now" label doesn't tick while idle.

### Real-data wave — steps 1–2 done (same day)

| | Before | After (on Pixel) |
|---|--------|------------------|
| Projects | 1 (env default) | **17**: same order as the PC Agents sidebar |
| Chats | 1 fake row ("Cursor Agents") | **25**: same titles + ages; PC-selected chat marked "Open on PC" |
| Chat messages | empty | real transcript, tool runs merged ("Used … (13 steps)"), opens at latest |
| Transcript load | ~6 s (LIKE scan) | **6 ms** (ordered PK lookups) |
| List load | n/a | **~14 ms** (`GET /v1/agents`) |

How: `GET /v1/agents` = read-only CDP scrape of the Agents sidebar (`section[data-agent-drop-section-id]` → `li[data-sidebar-item-key="row:<composerId>"]`) for *which* chats and order, enriched from Cursor's local DB (`composerHeaders`, `composerData`) for status / unread / waiting-for-approval / lines changed. Falls back to recent local DB chats (labeled) when the sidebar can't be read. `bc-` rows (Cursor background/cloud agents) are excluded per product lock. Also fixed: `/data` ↔ `/mnt/data` symlink path matching.

Files: `packages/adapters/live-cursor/src/sidebar-scrape.ts` (+test), `packages/adapters/history/src/agents-index.ts` (+test), `desktop-scan.ts` (ordered fast transcript, tool collapse), `workspace-map.ts` (realpath), `packages/hub/src/agents.ts` (+`test/agents.test.ts`), route `GET /v1/agents`, mobile `hub/agents-list.ts` (+test), `ChatsHomeScreen.tsx` (projects → chats, search, status marks, waiting pill, silent 15 s refresh), `HistoryReadScreen.tsx`.

Tests: Hub 103/103 · history 17/17 · sidebar 5/5 · mobile 104/104. Pre-existing unrelated failure: `selector-pack.test.ts` bans commas in selectors but the real attach label is "Add agents, context, tools".

Still open: markdown shows raw (`**`, `###`, tables) · send / approve on a real chat (needs operator watching) · "Open on PC" not yet checked against the Agents window · B3/B4.

### Send from phone — verified end to end (2026-10-01, operator-approved)

Test: Pixel → chat **MasterProject / "Project current state"** (not the chat open on the PC) → typed `reply with just the word pong` → **Send**.

| Step | Result |
|------|--------|
| PC switched to the target chat | ✅ open chat changed from "Conference paper project status" to "Project current state" (verified via `[data-composer-id]` before typing) |
| Message landed in that chat | ✅ appears in Cursor's own transcript |
| Agent reply reached the phone | ✅ "pong" shown on the phone ~20 s after send, no manual refresh |

How: `POST /v1/agents/chats/:composerId/messages` → `live-cursor/src/chat-send.ts` clicks the sidebar row (expands a collapsed project first), confirms the switch, then types + submits with the VERIFIED `send_message` selector; fails closed (`CHAT_SWITCH_FAILED`, nothing typed) if Cursor does not open the chat. Phone chat screen polls the transcript every 4 s. "Open on PC" button removed.

Also fixed: Hub tests wrote into the operator's real `packages/hub/data/devices.json` (source of the 160 stray devices) — test config now sets `HUB_DATA_DIR=none`; Chats background refresh no longer wipes the phone's pairing on a 401.

Still open: Cursor subagent notices (`<system_notification>…<user_query>`) show as "You" messages — filter them; markdown raw; approve/deny from phone on a real tool card; prune stale devices (B4); root cause of the earlier 401; phone Search field did not visibly filter in one adb run (re-check by hand).

### Cleanup + readability + approvals probe (same day)

| Item | Result |
|------|--------|
| Stale paired devices (B4) | 160 → **2** via new PC-only `POST /v1/pair/prune` (backup taken); `lastSeenAt` now persisted (≤ every 5 min); revoked devices no longer written to disk; mesh call → 403 |
| App wiping its own pairing on a 401 | All screens now keep the token and send the operator to Pair; Account → Clear pairing still wipes |
| Cursor sub-task notices shown as "You" | Bubbles with `isSimulatedMsg` → one line "Sub-task finished: <title>" (0 fake "You" left in the MasterProject chat) |
| Markdown | Built-in renderer (`apps/mobile/src/hub/markdown.ts` + `components/Markdown.tsx`): headings, bold/italic, inline + fenced code, lists, side-scrolling tables — verified on Pixel |
| False "waiting for approval" | `hasBlockingPendingActions` is stale on finished chats (4/4 flagged chats were `completed`) → only trusted while the run is not completed |
| Approvals | **Not testable yet**: asked the agent to run `echo phone-approval-test`; Cursor ran it via a sub-task **without** an approval prompt → operator's Cursor auto-runs terminal commands. **Deferred by operator decision (2026-10-01): keep Cursor auto-run on** — no approval cards occur, so phone approvals are parked. Revisit only if auto-run is turned off; the waiting badge stays (and now ignores stale flags) |

---

## 5. Recommendation

**Continue, but change what's built next.** Don't build the redesigned UI (Amendments A–F) yet.

Why continue: the hard, risky parts are proven: private connection with no cloud, fast enough, Hub ↔ Cursor control over CDP, and most Cursor actions matching the live UI.

Why change course: the app currently shows the wrong data, and that's the core of the product. A nicer UI over 1 fake row is wasted work.

**Next wave: "real data" (about 1 week), then decide again:**
1. Read the Agents-window sidebar → real repositories + chats + ages (replaces env-bound single workspace).
2. Open a chat → read its transcript (F1.1).
3. Fix B1/B2 (pairing address) and B4 (token pruning).
4. Check send + approve on one real throwaway chat, with the operator watching.

**Stop rule:** if after that wave the phone still can't show the same chat list as the PC **and** read one chat's messages reliably, stop the project. That would mean Cursor's UI is too unstable to remote this way.

## Handoff

- **Done:** real-data + latency test on PC and Pixel; selector dry run; device screenshots (scratchpad, not committed).
- **Files touched:** this report. Hub left running on `:8787` with `TAILSCALE_HOSTNAME=100.108.160.99`; Pixel paired to `http://100.108.160.99:8787`; one extra test token `claude-test-probe`.
- **Open gaps:** B1–B6; real-data wave above; approve/deny untested live.
- **Next agent:** adapter/Hub role → Agents-window sidebar + transcript scrape; then UX role resumes Phase 5 build.
- **Product locks still true?** Yes.
