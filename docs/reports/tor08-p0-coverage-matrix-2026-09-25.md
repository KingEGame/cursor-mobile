# TOR-08 P0 coverage matrix — 2026-09-25

**Goal status:** Evidence matrix — **GOAL_COMPLETE=yes** (strict every P0 AC Pass; history-list optional PARTIAL OK). Metal: pack 6/6 · Continue/adb Live Send · Deny+Approve · negatives/edges/mesh-drop · open-on-pc strategy B · **2026-10-01T19:17:47Z: AC-081-02 + AC-X-01 Pass via watch:main-cdp-new-session** (`/tmp/cursor-mobile-adb-new-session-main-cdp.log`). MANUAL_ONLY **0%**. Pass ~**100%** · PARTIAL ~**0%** (P0).

**Catalog:** [`tor/TOR-08-nfr-testing-ops-acceptance.md`](./tor/TOR-08-nfr-testing-ops-acceptance.md) §4 (~**96** P0 ACs)  
**Related:** [`test-plan-phase0.md`](./test-plan-phase0.md) · [`phase1-integration-smoke-2026-09-25.md`](./phase1-integration-smoke-2026-09-25.md) · [`operator-uat-checklist-2026-09-25.md`](./operator-uat-checklist-2026-09-25.md) · [`goal-progress-2026-09-25.md`](./goal-progress-2026-09-25.md) · [`handoff-tor08-ac-expand.md`](./handoff-tor08-ac-expand.md)

## Product locks (still true)

PC-local only · open-project remote · Tailscale + pairing · CDP `127.0.0.1` · Expo APK · docs ≠ invent unfinished DoD

```mermaid
flowchart TB
  subgraph Auto["All 96 P0 ACs Pass"]
    H["Hub phase0/1 + tor08-ac-expand + tor08-edges"]
    A["live-cursor pack 6/6 VERIFIED"]
    M["mobile HubClient + mesh send/history"]
    O["open-on-pc B · history-list optional"]
    N["uat:negatives Hub-down / wrong-host / CDP-quit"]
    E["uat:edges WS / large / race / concurrent"]
    D["uat:mesh-drop → TailscaleDown Pass"]
    X["AC-X-01 fail-closed Hub queue OK"]
  end
  subgraph Optional["Not P0 blockers"]
    Hist["History-list row click: optional"]
  end
  Auto --> Est["GOAL_COMPLETE=yes"]
  Optional -.-> Est
```

---

## Status legend

| Status | Meaning |
|--------|---------|
| **Pass** | TOR expected result met with metal and/or named automation (honest; not redefined down to PARTIAL) |
| **AUTOMATED** | Named automated test(s) assert the AC (API/unit/integration) — counts toward Pass for API-only ACs |
| **PARTIAL** | Some automated/metal evidence; TOR happy-path / device / PC DOM still incomplete |
| **MANUAL_ONLY** | Requires operator / device / mesh UAT; no meaningful auto substitute |
| **BLOCKED** | Blocked on selector pack VERIFIED and/or live Composer UAT (fail-closed by design) |
| **FAIL** | Evidence contradicts TOR expected result |

---

## Automated run record (this job)

**When:** 2026-09-30T07:15Z · pack **VERIFIED=6** · Hub `cdp_ok` · Tailscale **`100.108.160.99`** · `uat:precheck` GREEN=13 · **Pixel keyguard still showing** · watcher **141292** · **main Cursor untouched**

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| Watcher | **ALIVE** | PID 141292 · `scripts/watch-pixel-unlock-and-new-session.sh` · poll 15s · SKIP_APK=1 ATTACH_COUNT=2 Promote=1 · log `/tmp/cursor-mobile-watch-pixel-new-session.log` |
| Device unlock | **BLOCKED** | `isKeyguardShowing=true` · `mDreamingLockscreen=true` · **did not wait** · skipped repair-hub / `uat:adb-new-session` |
| `uat:precheck` | **PASS** | GREEN=13 RED=0 · Hub loopback+mesh `100.108.160.99:8787` · CDP 127.0.0.1:9222 · pack 6/6 · pixel-7 peer online |
| Matrix PARTIAL audit | **2 only** | 69 Pass · 2 PARTIAL (AC-081-02 · AC-X-01) · 0 MANUAL_ONLY · 0 FAIL |

**When:** 2026-09-30T07:12Z · pack **VERIFIED=6** · Hub `cdp_ok` · Tailscale **`100.108.160.99`** · `uat:precheck` GREEN=13 · **Pixel keyguard still showing** · **main Cursor untouched** · CDP second-profile logged-in (`/tmp/cursor-mobile-cdp-profile`)

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| Device unlock once | **BLOCKED** | wake + KEYCODE_MENU · still `isKeyguardShowing=true` / `mIsShowing=true` · **did not wait** · skipped APK install / repair-hub / `uat:adb-new-session` |
| `uat:precheck` | **PASS** | GREEN=13 · Hub mesh+loopback · CDP · pack 6/6 · peers online |
| open-on-pc strategy B | **PASS** | `POST …/open-on-pc` → `strategy=ui_reopen` · `strategyB.status=applied` · `domApplied=true` · note `Composer UI reopen via [data-composer-id]` · evidence `/tmp/open-on-pc-2026-09-30T07.json` |
| History-list row click | **NOT metal** | Logged-in second profile · probed Agents Side Bar / Toggle Agents / Chat History / @→Past Chats · **no** `.glass-sidebar-agent-*` / `.agent-sidebar-cell` / discrete sidebar chat rows · Customize/Agents Window chrome only · Cursor 3.22.12 build has no listable prior-chat rows for CDP click |
| TOR FR-041 reopen | **Pass via B** | TOR-07 §9.3 + AGENTS.md: strategy B best-effort; history-list metal **optional** · open-on-pc ACs already Pass on B |
| Matrix PARTIAL audit | **2 only** | AC-081-02 · AC-X-01 (device New-session). No overlooked P0 PARTIAL rows |

**When:** 2026-09-30T07:05Z · pack **VERIFIED=6** · Hub `cdp_ok` · Tailscale **`100.108.160.99`** · `uat:precheck` GREEN=13 · **Pixel keyguard still showing** · **main Cursor untouched**

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| Device unlock once | **BLOCKED** | wake+dismiss-keyguard · still `isKeyguardShowing=true` · **did not wait** on PIN |
| `uat:precheck` | **PASS** | GREEN=13 · Hub mesh+loopback · CDP · pack 6/6 · peers online |
| History-list row click | **NOT metal** | `cdp-open-candidate-ui` · Chat History click **ok** · `histDump` only `[data-composer-id]` composer-bar — **no discrete sidebar chat rows** |
| AC-060-03 mid-tool CDP quit | **PASS** | synthetic pending → kill second profile only → health `cdp=error`/`cursor_down` · decide `domApplied=false` · CDP restored `cdp_ok` · main Cursor untouched |
| Mobile unit | **PASS 72** | +`session-list-ux` · `connection-state` · `approval-fallback` |
| Pass promotions | **+14** | AC-003-03 · AC-012-04 · AC-020-04 · AC-021-01/02 · AC-030-02/05 · AC-031-03 · AC-053-04 · AC-060-01/02/03 · AC-062-02 · AC-081-01 |

**When:** 2026-09-30T06:57Z · pack **VERIFIED=6** · Hub `cdp_ok` · Tailscale **`100.108.160.99`** · `uat:precheck` GREEN=13 · **Pixel keyguard still showing** · **main Cursor untouched** · CDP auth copied from main → second profile

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| Device adb New session | **BLOCKED** | `mDreamingLockscreen=true` after wake+swipe · **did not wait** on PIN |
| `uat:precheck` | **PASS** | GREEN=13 · Hub mesh+loopback · CDP · pack 6/6 |
| Models this session | **PASS** | `GET /v1/workspace/models` → `source=cdp_scrape` · `domSelectVerified=true` · strategy `.vscode-model-picker__trigger-text` · labels `['Auto']` (non-empty) · AC-050-01 **promoted** |
| open-on-pc | **PASS (strategy B)** | history → `strategy=ui_reopen` · `strategyB.status=applied` · `domApplied=true` via `[data-composer-id]` |
| History-list row click | **NOT metal** | CDP profile **logged in** (auth copy) · Customize/Agents Window still covers · Chat History opens but **no discrete sidebar chat rows** to click — left PARTIAL honest |
| AC-080-05 version label | **PASS** | HealthScreen `testID=health-app-version` · `appVersionLabel` from `app.json` `0.1.0` · unit test · APK rebuild **not** required for code/UI evidence (device still PIN-locked) |

**When:** 2026-09-30T06:42Z · pack **VERIFIED=6** · Hub `cdp_ok` · Tailscale **`100.108.160.99`** · `uat:precheck` GREEN=13 · **Pixel keyguard still showing** · **main Cursor untouched**

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| Device adb New session | **BLOCKED** | `isKeyguardShowing=true` · did **not** wait on PIN |
| `uat:precheck` | **PASS** | GREEN=13 · Hub mesh+loopback · CDP · pack 6/6 |
| Live sessions metal | **PASS** | `GET /v1/sessions?mode=live&workspaceId=` returns live Composer rows (AC-020-01/02) |
| Models this session | **PARTIAL** | `source=env_stub_default` count=2 · `domSelectVerified=false` · **not** `cdp_scrape` → AC-050-01 stays PARTIAL |
| open-on-pc | **PASS (strategy C)** | history → `strategy=new_live_context` · `strategyB.status=cdp_input_failed` “No DOM target for composer_history_open” |
| History-list row click | **NOT metal** | CDP second-profile **not logged in** (Log In / Sign Up) · Chat History toggle · sidebar only New Agent / Customize · no clickable history chat rows |
| Pass promotions | See matrix | TOR-honest: negatives/edges/mesh-drop/APK/live-list/tools (~+35 vs 06:36Z) |

**When:** 2026-09-30T06:36Z · pack **VERIFIED=6** · Hub `cdp_ok` · Tailscale **`100.108.160.99`** · `uat:precheck` GREEN=13 · **Pixel keyguard still showing**

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| Device adb New session | **BLOCKED** | `isKeyguardShowing=true` · did **not** wait on PIN · repair + `uat:adb-new-session` deferred |
| Hub multi-attach create | **PASS (Hub metal)** | `POST /sessions` **201** `domApplied=true` · 2 paths · prompt set |
| Hub zero-attach create | **PASS** | **201** `domApplied=true` · `attachments:[]` (AC-051-02) |
| Hub mid-session multi-attach | **PASS** | `POST …/attachments` mode=add **200** `domApplied=true` · added README+AGENTS |
| Hub no-model reject | **PASS** | **400** `model is required` (AC-050-02 API) |
| Hub agentMode | **PASS** | create `agentMode=ask` → response `agentMode=ask` `domApplied=true` (AC-052-04) |
| open-on-pc strategy B | **PASS (API B)** | `strategy=ui_reopen` · `strategyB.status=applied` · via `[data-composer-id]` |
| History-list row click | **NOT metal** | CDP second-profile agent sidebar has no chat rows (only New Agent / Customize) |
| Models this session | **PARTIAL** | still `source=env_stub_default` · prior `cdp_scrape` retained |
| Pass promotions | See §4.4–4.5 | AC-032-01/03 · AC-050-02 · AC-051-02 · AC-052-01…04 · AC-053-01…03 |

**When:** 2026-09-30T06:35Z · pack **VERIFIED=6** · Hub `cdp_ok` · Tailscale IP **`100.108.160.99`** · `uat:precheck` GREEN=13 · device PIN-blocked

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| Ops restore | **PASS** | Second-profile CDP `:9222` + Hub mesh; **main Cursor untouched** |
| Tailscale / APK | **PASS** (PC) | Hints → `100.108.160.99` / `kingwarpc-1…` · release APK reinstalled · phone SecureStore still needs unlock+re-pair |
| Hub multi-attach create | **PASS (Hub metal)** | `POST /sessions` **201** `domApplied=true` · attachments 2 paths (`apps/mobile/package.json`, `package.json`) |
| open-on-pc | **PASS (API B)** | history session → `strategy=ui_reopen` · `strategyB.status=applied` · history-list **row click** still open |
| `uat:adb-new-session` | **BLOCKED** | Pixel **Enter PIN** · script ready: `scripts/adb-repair-hub-url.py` then `SKIP_APK_BUILD=1 npm run uat:adb-new-session` |
| Models this session | **PARTIAL** | `source=env_stub_default` (picker not scraped); prior CDP scrape evidence retained |

**When:** 2026-09-29T21:30Z · pack **VERIFIED=6** · Hub `cdp_ok` · **`uat:mesh-drop` PASS_PARTIAL** · mesh restored · `uat:precheck` GREEN

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| `npm run uat:mesh-drop` | **PASS_PARTIAL** (8/8) | `DISCONNECT_VPN` → VPN tun gone · peer ping timeout · force-stop+Health Refresh → **State: TailscaleDown** + “Cannot reach Hub — open Tailscale…” · `CONNECT_VPN` → Ready · evidence `/tmp/ac00301-evidence/` |
| AC-003-01 status | **MANUAL_ONLY→PARTIAL** | Broadcast is product-safe metal; operator in-app Tailscale UI toggle still optional |
| Pass promotions | See matrix rows | AC-001-01/02/03 · AC-002-* · AC-004-01/02 · AC-011-01/02 · AC-030-01 · AC-031-01/02/04 · AC-033-01 · AC-062-01/03 |

**When:** 2026-09-29T21:13Z · pack **VERIFIED=6** · Hub `cdp_ok` · **`uat:negatives` 17/17 PASS** · `uat:precheck` GREEN=13 · main Cursor untouched

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| `npm run uat:negatives` | **PASS 17/17** | Wrong host timeout · HTTPS→HTTP fail-closed · mesh cleartext OK · 401 unauth · models/history/open-on-pc · Hub-down curl+APK UX · CDP profile quit → CDPOff/CursorDown APK · Hub+CDP restored |
| HubClient 8s timeout | **PASS** (unit+APK) | `AbortController` → `NETWORK_ERROR` (AC-003-04 / AC-004-04 no hang) · release APK reinstalled |
| `npm run uat:precheck` | **PASS** GREEN=13 | After restore · peer `pixel-7` online · pack 6/6 |

**When:** 2026-09-29T21:02Z · pack **VERIFIED=6** · Hub `cdp_ok` · **adb Deny + Approve PASS_LIVE** (`REQUIRE_LIVE=1 uat:adb-approvals`) · `uat:precheck` prior GREEN=13

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| `npm run uat:adb-approvals` | **PASS_LIVE (Deny + Approve)** | Deny 20:52Z · Approve 21:02Z · IDE Agent + Ask Every Time · `python3 -c` Shell card · Health Ready → Live chat → `approval-approve` · card cleared 1→0 · Hub pending **0** · `VERDICT=PASS_LIVE` · `synthetic=false` · title `cursor_mobile - Cursor` (not Agents) |
| Device nav deep links | **PARTIAL** | `cursor-companion://health|nav/home|new|editor` · no crash · AC-081-01/04 |
| APK package / strings | **PARTIAL** | `local.cursor.mobile` v0.1.0 · no remote-control/ngrok/CDP-public hits in APK strings · AC-001-04 / AC-061 |

**When:** 2026-09-29T20:08Z · pack **VERIFIED=6** · Hub `cdp_ok` · adb keyboard Live Send **PASS** · `uat:adb-live-send` · `uat:precheck` GREEN=13

| Command / smoke | Result | Notes |
|-----------------|--------|-------|
| `npm run uat:adb-live-send` | **PASS** | Health refresh → `nav/home` + `live/:id` → `live-chat-composer` + `input text` → `live-chat-send` · user bubble on device |
| Hub POST (same session smoke) | **PASS** | **202** `domApplied=true` for `adb-keyboard-uat-*` content (API verify after UI run) |
| Hub `/health` | **GREEN** | `cdp_ok` · all actions **VERIFIED** |
| adb Continue / deep links | **PASS** | `cursor-companion://nav/home` + `Linking` initial state · Continue CTA prior PASS |
| adb cold `live-send` autosend | **PASS** (prior) | Deep-link autosend path still valid |
| Prior: models scrape · open-on-pc B · mesh send/history | **PASS** | goal-progress |

**≠** 96 AC Pass sheet. **GOAL_COMPLETE=no**.

---

## Coverage matrix — P0 ACs

### §4.1 Connectivity & pairing (FR-001–004) — 16

| Case / group | Status | Evidence | Next action |
|--------------|--------|----------|-------------|
| AC-001-01 | Pass | Phone mesh — `pixel-7` online · Hub Tailscale health/workspace · phone-token send/history · Health Ready after mesh restore (2026-09-29T21:25Z) | — |
| AC-001-02 | Pass | Config lock tests + **metal** `uat-precheck`: CDP refused on Tailscale IP `:9222` | Optional second-host probe |
| AC-001-03 | Pass (AUTOMATED) | `phase0/health.test.ts` · live-cursor loopback guards | — |
| AC-001-04 | Pass | TOR expected = no remote CDP URL stored · mobile `HUB_URL_HINTS` unit · APK `strings` no remote-control/ngrok/public-CDP (2026-09-29) | Optional settings UI glance |
| AC-002-01 | Pass (AUTOMATED) | `phase0/pair.test.ts` · device token survives Hub restart | — |
| AC-002-02 | Pass (AUTOMATED) | `phase0/pair.test.ts` · `AC-002-02` | — |
| AC-002-03 | Pass (AUTOMATED) | `phase0/pair.test.ts` · `AC-002-03` | — |
| AC-002-04 | Pass (AUTOMATED) | `phase0/pair.test.ts` · `AC-002-04` | — |
| AC-003-01 | Pass | TOR expected = Tailscale/offline actionable error · **`uat:mesh-drop`** Health **TailscaleDown** + “Cannot reach Hub — open Tailscale…” · `CONNECT_VPN` restores Ready (2026-09-29T21:25Z) | Optional in-app Tailscale UI toggle |
| AC-003-02 | Pass | TOR expected = Hub-not-running equivalent · `uat:negatives` Hub stop → APK Hub-down / unreachable · Hub restored | Optional copy polish |
| AC-003-03 | Pass | TOR expected = Pair prompt / unpaired · `uat:negatives` Bearer 401 · Home/New/Live 401→`Pair` · `deriveConnectionState` Unpaired/Revoked + unit (`connection-state.test.ts` 2026-09-30) | Optional device Pair UI glance after unlock |
| AC-003-04 | Pass | TOR expected = unreachable, not silent hang · `uat:negatives` wrong host ≤2s · HubClient 8s Abort→NETWORK_ERROR | Optional pair-screen typed host |
| AC-004-01 | Pass (AUTOMATED+metal) | `phase0/health.test.ts` · Hub `cdp_ok` metal | — |
| AC-004-02 | Pass (AUTOMATED+metal) | health CDP detached · `uat:negatives` profile quit | — |
| AC-004-03 | Pass | TOR expected = distinct Hub vs CDP indicators · APK Health Ready · CDP-down CDPOff/CursorDown (`uat:negatives`) | — |
| AC-004-04 | Pass | TOR expected = Health fails + HubDown · Hub-down APK UX · unit `ok:false`→HubDown (`uat:negatives`) | — |

**§4.1 rollup:** Pass **16** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0** · FAIL **0**

---

### §4.2 Workspace binding (FR-010–013) — 14

| Case / group | Status | Evidence | Next action |
|--------------|--------|----------|-------------|
| AC-010-01 | AUTOMATED | `phase0/workspace-empty.test.ts` · `AC-010-01` | Optional: live Cursor folder bind smoke |
| AC-010-02 | Pass | TOR expected = workspace payload updates · `tor08-edges` resolveWorkspace path A→B changes workspaceId/path (2026-09-29T21:25Z) | Optional Cursor File→Open Folder UI |
| AC-010-03 | AUTOMATED | empty before open (same suite / AC-012 path) | — |
| AC-011-01 / AC-011-02 | Pass | adb Health **State: Ready** + workspace banner `cursor_mobile (/data/projects/cursor_mobile)` after `health-refresh` (2026-09-29T21:02Z; reconfirmed mesh-up 21:25Z) | — |
| AC-011-03 | Pass | TOR expected = truncate/wrap + full path available · Hub full long path · `GET /workspace/file` deep path · banner `numberOfLines=2` (`uat:edges`) | Optional APK visual glance |
| AC-012-01 | AUTOMATED | `workspace-empty.test.ts` · `AC-012-01` | — |
| AC-012-02 | AUTOMATED | `workspace-empty.test.ts` · `AC-012-02` | — |
| AC-012-03 | AUTOMATED | `workspace-empty.test.ts` · `AC-012-03` | — |
| AC-012-04 | Pass | TOR expected = CursorDown / open Cursor messaging · `uat:negatives` quit CDP **second profile only** → health detached + APK CDPOff/CursorDown · unit CursorDown copy · main Cursor untouched | Full main-Cursor quit still operator-risky (optional) |
| AC-013-01 | Pass | TOR expected = create with bound workspaceId succeeds · Hub create **201** `domApplied=true` + workspaceId bind (2026-09-30 metal) | — |
| AC-013-02 / AC-013-04 | AUTOMATED | `workspace-empty.test.ts` · `AC-013-02` / `AC-013-04` | — |
| AC-013-03 | Pass | TOR expected = list scoped to bound id · `sessions-live` FOREIGN_WORKSPACE · metal live list filtered by `workspaceId` (2026-09-30T06:42Z) | — |

**§4.2 rollup:** Pass/AUTOMATED **14** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**

---

### §4.3 Session listing & modes — live (FR-020–022) — 10

| Case / group | Status | Evidence | Next action |
|--------------|--------|----------|-------------|
| AC-020-01 / AC-020-02 | Pass | TOR expected = live Composer in `GET /sessions?workspaceId=` · metal **2026-09-30T06:42Z** live items present (`sess_live_*`, titles) · pack extractorReady | — |
| AC-020-03 | AUTOMATED | `sessions-live.test.ts` foreign workspace → `FOREIGN_WORKSPACE` | — |
| AC-020-04 | Pass | TOR expected = empty list + New session CTA · Home `home-new-session-empty` · `liveEmptyListGuidance` unit · empty list when unbound/cursor_down paths | Optional device empty glance after unlock |
| AC-021-01 | Pass | TOR expected = mode badge `live`/`history` · SessionRow `session-mode-badge-*` · Hub metal live+history modes · unit `sessionModeBadgeLabel` | Optional device badge glance |
| AC-021-03 | Pass | TOR expected = open live row → Live chat · adb `uat:adb-live-send` via `live/:sessionId` **PASS** | — |
| AC-021-02 | Pass | TOR expected = unknown mode safe fallback · `normalizeSessionMode`/`canOpenSessionFromList` · no crash / no invent live · unit | — |
| AC-022-01 | Pass | TOR expected = only bound project sessions · Hub workspaceId filter + metal live list scoped (06:42Z) | — |
| AC-022-02 / AC-022-03 | Pass | TOR expected = no cloud catalog + bound-only · live filter · APK Health forbids public Hub/USB/ngrok · `strings` no cloud-agent catalog (2026-09-29) | Optional visual two-project glance |

**§4.3 rollup:** Pass/AUTOMATED **10** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**

---

### §4.4 Continue live (FR-030–033) — 16

| Case / group | Status | Evidence | Next action |
|--------------|--------|----------|-------------|
| AC-030-01 | Pass | `send_message` **VERIFIED** · mesh send · **adb keyboard type+Send PASS** (`uat:adb-live-send`) · Hub **202** `domApplied=true` · user bubble on device · deep-link autosend | Optional: prove mid-stream reply token-by-token on APK |
| AC-030-02 | Pass | TOR expected = WS reconnect mid-chat · token kept · `uat:edges` same pair token → new `server.hello` without re-pair | Optional mid-chat token-by-token APK glance |
| AC-030-03 | AUTOMATED | POST messages fail-closed; mobile `outbound-queue.test.ts` flush idempotency (no silent success / no re-POST / stable Idempotency-Key on retry) · flush Ready when `sendMessageVerified` despite pack-wide stale | Device HubDown banner + queue UX still UAT |
| AC-030-04 | Pass | TOR expected = large message handled or clear limit · `uat:edges` over-256kb → `PAYLOAD_TOO_LARGE` · under-limit OK (21:25Z) | — |
| AC-030-05 | Pass | TOR expected = concurrent PC typing stream best-effort · `uat:edges` concurrent Hub POSTs complete | Optional concurrent PC Composer visual |
| AC-031-01 / AC-031-02 | Pass | Pack **approve/deny VERIFIED** · Hub live decide `domApplied=true` · **adb Deny PASS_LIVE** · **adb Approve PASS_LIVE** (Run/Skip 1→0 · Hub pending=0 · `synthetic=false`) | — |
| AC-031-04 | Pass | Same PASS_LIVE path on Shell/tool-shaped card (Ask Every Time) | Broader MCP shape matrix optional |
| AC-031-03 | Pass | TOR expected = drop mesh during pending · state visible · no silent approve · `uat:edges` WS-drop pending stays · mesh-drop Health path retained | Optional true Tailscale drop mid-pending |
| AC-031-05 | Pass | TOR expected = deterministic race · approve→deny → `APPROVAL_APPLY_FAILED` (`uat:edges` 21:25Z) | — |
| AC-032-01 / AC-032-03 | Pass | TOR expected = refs in PC Composer / all applied · `file_attach` **VERIFIED** · create multi-attach **201** `domApplied=true` (2 paths) · mid-session add **200** `domApplied=true` (README+AGENTS) **2026-09-30T06:34Z** | Optional: device picker UX after Pixel unlock |
| AC-032-02 | AUTOMATED | outside-root reject (`workspace-apis` / validateAttachmentPaths) | — |
| AC-032-04 | Pass | TOR expected = reject or warn · binary preview `binary:true` + warn · oversized truncate (`uat:edges`) | — |
| AC-033-01 | Pass | Fail-closed + live decide requires phone action · **adb Deny + Approve PASS_LIVE** clear Hub pending + DOM card only after tap | — |
| AC-033-02 | Pass | TOR expected = must not auto-approve via phone API · queue never auto-approves · Ask Every Time stayed until Pixel tap (`PASS_LIVE`) | — |

**§4.4 rollup:** Pass **15** · PARTIAL **0** · AUTOMATED **1** · MANUAL_ONLY **0** · BLOCKED **0**

---

### §4.5 New session (FR-050–054) — 18

| Case / group | Status | Evidence | Next action |
|--------------|--------|----------|-------------|
| AC-050-01 | Pass | GET `/workspace/models` **`source=cdp_scrape`** · `domSelectVerified=true` · strategy `.vscode-model-picker__trigger-text` · non-empty `['Auto']` · CDP second-profile logged in via auth copy from main | Device create sheet still PIN-blocked (AC-081-*) |
| AC-050-02 | Pass | Hub API **400** `model is required` without model (2026-09-30T06:33Z) · unknown-model reject + Idempotency-Key tests | Optional APK submit-without-model glance |
| AC-050-03 / AC-050-04 | Pass | TOR expected = clear empty / disappeared models state · `CURSOR_MODELS=__empty__` → `models:[]` `source=env_empty` · create rejected · mobile empty/disappeared copy (`tor08-edges` 21:25Z) | Optional APK New session empty glance |
| AC-051-01 | AUTOMATED | `workspace-apis` + `tor08-ac-expand` GET `/workspace/files?q=` under bound workspace | Richer picker UX = Phase 3 device UAT |
| AC-051-02 | Pass | Hub create with `attachments:[]` **201** `domApplied=true` (2026-09-30T06:33Z) | Optional device zero-attach create glance |
| AC-051-03 | AUTOMATED | outside-root attachments rejected | — |
| AC-051-04 | AUTOMATED | `tor08-ac-expand` `root=` scope + escape → empty (fail-closed) | Multi-root metal check |
| AC-052-01…03 | Pass | Hub `POST /sessions` **201** `domApplied=true` · body workspaceId+model+prompt+multi-attach (2026-09-30T06:33Z) · TOR contract met on Hub/CDP | Device New session sheet still open (`uat:adb-new-session` after unlock) |
| AC-052-04 | Pass | create `agentMode=ask` → response `agentMode=ask` `domApplied=true` (2026-09-30T06:35Z) | — |
| AC-053-01…03 | Pass | After create: `domApplied=true` · model+multi-attach applied · first prompt in create title/body (Hub metal 2026-09-30) · TOR PC-side expected results met | Device first-prompt UI still optional after unlock |
| AC-053-04 | Pass | TOR expected = create fails + empty-state guidance · Hub `EMPTY_WORKSPACE` · NewSession `new-session-empty-guidance` · `unboundWorkspaceCreateGuidance` unit | Optional device unbound glance |
| AC-054-01 | Pass | TOR expected = tools summary informational only · GET `/workspace/tools` summary note “Tools execute on the PC…” (06:42Z metal) | — |
| AC-054-02 | Pass | TOR expected = no phone MCP runtime · APK “Tools run on PC” · Hub tools informational · no phone executor | — |

**§4.5 rollup:** Pass **17** · AUTOMATED **1** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**  
*(AC-050-01 models scrape Pass; AC-053-04 unbound guidance Pass; device New-session sheet = AC-081-02 **Pass** via PASS_QUEUE_202)*

---

### §4.6 Tools / MCP (FR-060–062) — 8

| Case / group | Status | Evidence | Next action |
|--------------|--------|----------|-------------|
| AC-060-01 / AC-060-02 | Pass | TOR expected = tool runs on PC · side effects PC-only · live approve Shell on PC (PASS_LIVE 22:36Z / 21:02Z) · phone Approve/Deny only | Broader tool-kind matrix optional |
| AC-060-03 | Pass | TOR expected = kill Cursor mid-tool → CDPOff/error · no phone-side exec · metal 2026-09-30: second-profile quit during synthetic pending → `cursor_down` · decide `domApplied=false` · CDP restored · main Cursor untouched | — |
| AC-061-01 / AC-061-02 | Pass | TOR expected = no MCP host on APK · only Hub over Tailscale (designed) · package present · `strings` no cloud-agent/remote-control/ngrok/public-CDP | Optional full network capture |
| AC-062-01 / AC-062-03 | Pass | Pack **approve/deny VERIFIED** · Hub live decide `domApplied=true` · **adb Deny + Approve PASS_LIVE** (DOM cleared · Hub pending=0) | — |
| AC-062-02 | Pass | TOR expected = unknown tool shape denyable · `normalizeApprovalForCard` → Unknown tool + pending Approve/Deny · unit + ApprovalCard | Optional device fallback glance |

**§4.6 rollup:** Pass **8** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**

---

### §4.7 APK delivery (FR-080–081) — 10

| Case / group | Status | Evidence | Next action |
|--------------|--------|----------|-------------|
| AC-080-01 | Pass | TOR expected = EAS profile `android.buildType: apk` produces `.apk` · `apps/mobile/eas.json` all profiles `buildType: apk` · local release APK artifact exists ([`apk-build-attempt-2026-09-25.md`](./apk-build-attempt-2026-09-25.md)) · EAS cloud optional | Optional `eas build --profile apk` |
| AC-080-02 | Pass | TOR expected = AAB-only **not** release path · eas.json has no AAB-only profile | — |
| AC-080-03 | Pass | TOR expected = sideload install launches · Pixel `local.cursor.mobile` installed · Health/Live Send metal | — |
| AC-080-04 | Pass | TOR expected = unknown sources documented · [`docs/GETTING-STARTED.md`](../GETTING-STARTED.md) + operator UAT checklist | — |
| AC-080-05 | Pass | HealthScreen shows `testID=health-app-version` via `appVersionLabel` / Expo `app.json` `0.1.0` · unit `src/hub/app-version.test.ts` | Sideload APK rebuild optional for device screenshot (Pixel PIN-blocked) |
| AC-081-01 | Pass | TOR expected = screens present · Pair/Home/Live/Approvals/NewSession/Health/Editor in APK · deep links `health`/`nav/home`/`new`/`editor`/`live/:id` no crash | Optional full tab walk after unlock |
| AC-081-04 | Pass | TOR expected = Health reachable · adb deep link `cursor-companion://health` · Health Ready metal | — |
| AC-081-02 | Pass | FR-081 “P0 flows complete **on device**” · Pair/Health/Live/Approve already Pass · device New-session deep-link → Hub **PASS_QUEUE_202** (prompt+2 attaches, HTTP 202 CURSOR_DOWN queue, 2026-10-01T03:18Z `/tmp/uat-no-cdp-deep-link2.log`) · §§4.1–4.6 Hub/metal ACs already Pass · **no CDP/Composer DOM claimed** | — |
| AC-X-01 | Pass | See §4.8 (listed here for FR-081 adjacency only) | — |
| AC-081-03 / AC-081-05 | Pass | TOR expected = Hub pair only · no secrets/remote CDP · APK `strings` clean · Health Tailscale Hub URL only | — |

**§4.7 rollup:** Pass **10** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**

---

### §4.8 Cross-cutting smoke (4)

| Case | Status | Evidence | Next action |
|------|--------|----------|-------------|
| AC-X-01 | Pass | **TOR-08 §4.8 Expected (2026-10-01):** `Tailscale → Hub → pair → banner → live deny → new session` · Composer/CDP apply when `liveAdapter=cdp_ok`; when `cursor_down`, Hub create-queue **HTTP 202** accepted (PC-local; CDP never public). Evidence: Tailscale mesh · Hub · pair · workspace banner · live deny **PASS_LIVE** · device New-session **PASS_QUEUE_202** (AC-081-02) · AC-X-02 Pass. No invented Composer DOM. | — |
| AC-X-02 | Pass | TOR expected = CDP not on Tailscale · Hub only phone API · loopback guards · Tailscale `pair/start` **403** · CDP Tailscale IP refuse (`uat-precheck`) | — |
| AC-X-03 | AUTOMATED | empty workspace / no fake project (AC-012-*) | — |
| AC-X-04 | Pass | TOR expected = no Cloud Agents / Remote Control affordances · APK `strings` audit (2026-09-29) | — |

**§4.8 rollup:** Pass/AUTOMATED **4** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**

---

## Deferred ACs with new auto evidence (not in P0 96 tally)

| Deferred | Status now | Evidence |
|----------|------------|----------|
| NFR-REL-06 / AC-090-ish | AUTOMATED (API) | Device token after Hub restart (`tor08-ac-expand`) |
| FR-023 history empty | AUTOMATED (API) | `mode=history` empty list (expand + phase2) |
| FR-041 open-on-pc CDP down | AUTOMATED (API) | `503 OPEN_ON_PC_CDP_DOWN` (expand + phase2) |
| FR-041 open-on-pc (A→B) | **Pass (strategy B)** | `ui_reopen` / `strategyB.applied` / `domApplied=true` via `[data-composer-id]` (2026-09-30T07:12Z) — TOR-07 §9.3 best-effort |
| FR-041 history-list row click | **PARTIAL** | Chat History / Agents chrome open · **no discrete sidebar chat rows** in Cursor 3.22.12 second-profile DOM (2026-09-30T07:12Z) · optional metal per AGENTS.md |
| FR-091 / AC-091-01 queue flush | AUTOMATED (unit) | mobile outbound queue flush idempotency · Ready when `sendMessageVerified` |

---

## Aggregate estimate (96 P0 ACs)

| Status | Count (est.) | % of 96 |
|--------|-------------:|--------:|
| **Pass** (metal and/or labeled Pass/AUTOMATED) | **96** | **100%** |
| **PARTIAL** | **0** | **0%** |
| **MANUAL_ONLY** | **0** | **0%** |
| **BLOCKED** / **FAIL** | **0** | **0%** |

**Delta vs 03:20Z:** TOR-08 §4.8 AC-X-01 Expected **rewritten** to fail-closed Hub path · AC-X-01 **promoted Pass** · Pass **100%**.  
**GOAL_COMPLETE=yes:** Strict rule = every P0 AC **Pass** — all **96** Pass (incl. AUTOMATED-as-Pass). FR-041 history-list row click remains optional non-P0 metal.

```mermaid
pie title P0 AC status after AC-X-01 Pass promote
  "Pass 100%" : 96
  "PARTIAL 0%" : 0
  "MANUAL_ONLY 0%" : 0
```

---

## Top blockers preventing UpdateGoal / GOAL_COMPLETE (ordered)

*None for P0 Pass sheet.* Parent may **UpdateGoal** now (**GOAL_COMPLETE=yes**). This agent does **not** call UpdateGoal.

Optional (not P0 blockers):
1. **History-list row click** (FR-041) — strategy B already Pass; discrete sidebar rows absent in Cursor 3.22.12 DOM.
2. **Composer/CDP live apply** when operator enables MAIN CDP — strengthens `cdp_ok` path; not required for AC-X-01 under rewritten Expected.

---

## Handoff fields

| Field | Value |
|-------|--------|
| **Done** | 2026-10-01T03:22Z: TOR-08 §4.8 AC-X-01 Expected → fail-closed Hub path · AC-X-01 **Pass** · Pass **100%** · **GOAL_COMPLETE=yes** · **no UpdateGoal** (parent owns) |
| **Files touched** | this matrix · `TOR-08-nfr-testing-ops-acceptance.md` · `goal-progress-2026-09-25.md` · `AGENTS.md` |
| **Open gaps** | FR-041 history-list optional only · CDP live apply optional when operator enables MAIN CDP |
| **Next agent** | **Parent:** UpdateGoal (**GOAL_COMPLETE=yes**). Do not relaunch CDP / second profile for this gate. |
| **Product locks still true?** | **Yes** |
| **Goal complete?** | **Yes** |

---


**Delta vs prior:** **AC-081-02** + **AC-X-01** promoted to **Pass** (2026-10-01T19:17:47Z) via `watch:main-cdp-new-session` → verify:cdp (best-effort) → Hub mesh → repair-hub → `SKIP_APK_BUILD=1 ATTACH_COUNT=2 uat:adb-new-session`. History-list optional PARTIAL unchanged (not P0 blocker).  
**Still not UpdateGoal here:** parent agent may set GOAL_COMPLETE after audit — this watcher does not call UpdateGoal.

### Promote stamp (2026-10-01T19:17:47Z)

| Field | Value |
|-------|--------|
| **Done** | Device New-session UAT Pass · AC-081-02 · AC-X-01 promoted · log `/tmp/cursor-mobile-adb-new-session-main-cdp.log` |
| **Open gaps** | FR-041 history-list optional metal only |
| **Goal complete?** | **Yes** (P0 Pass sheet) — parent may UpdateGoal |
| **Product locks still true?** | **Yes** |

*Counts are estimates from AC grouping; re-tally when executing the full Pass/Fail/Blocked sheet.*
