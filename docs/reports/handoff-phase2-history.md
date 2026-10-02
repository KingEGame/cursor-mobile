# Handoff — Phase 2 History Index + Open on PC

**Date:** 2026-09-25  
**Phase focus:** 2  
**Locks check:** PC-local only · open-project remote · CDP `127.0.0.1` · Tailscale + pairing · Expo APK · docs≠full product (Composer UI reopen still best-effort)

## Done

- **History adapter** (`@cursor-mobile/history`): best-effort local scan
  - Desktop: `composerHeaders` + `bubbleId:*` in `state.vscdb` (read-only via `node:sqlite` when available)
  - Listable filter: root composers **or** multitask `generalPurpose` (exclude nested Task types / drafts / best-of-N)
  - Workspace filter: `CURSOR_WORKSPACE` / bind path → `workspaceStorage/<hash>/workspace.json` folder URI match (prefer false negatives)
  - Agent CLI: `~/.cursor/chats/**/meta.json` filtered by `cwd`
  - OS path strategies documented in `packages/adapters/history/src/paths.ts`
  - Never invents sessions/secrets; empty when paths missing (honest `reason` on status after empty bind)
- **Hub routes**
  - `GET /sessions?mode=history|all` merges history (workspace-filtered)
  - `GET /sessions/:id` serves history detail + transcript
  - `GET /sessions/:id/messages` history REST transcript
  - `POST /sessions/:id/open-on-pc` — best-effort via `live.createSession` (strategy C) or `503 OPEN_ON_PC_CDP_DOWN` / `501 OPEN_ON_PC_UNSUPPORTED`
  - `/health.history` status block
- **Mobile:** Home Live/History tabs; `HistoryReadScreen` + Open on PC
- **Tests:** adapter empty/filter; Hub phase2 empty/filter/messages/open-on-pc
- Scripts: `npm run test:phase2`, `npm run test:history`

## Files

| Path | Change |
|------|--------|
| `packages/adapters/history/src/**` | LocalHistoryAdapter, path strategies, desktop/CLI scan, tests |
| `packages/hub/src/routes/api.ts` | History list/detail/messages/open-on-pc |
| `packages/hub/tests/phase2/sessions-history.test.ts` | Hub Phase 2 tests |
| `apps/mobile/src/screens/HomeScreen.tsx` | History tab enabled |
| `apps/mobile/src/screens/HistoryReadScreen.tsx` | Read-only + Open on PC |
| `apps/mobile/src/hub/client.ts` | `getSessionMessages`, `openOnPc` |
| `apps/mobile/App.tsx` · `navigation/types.ts` | HistoryRead route |
| `docs/CONFIGURATION.md` | CURSOR_WORKSPACE ↔ history match note |
| `docs/architecture/AGENT-CONTEXT.md` | History status |
| `docs/reports/tor/TOR-07-history-sessions-data.md` | Status → partially implemented |
| `docs/reports/handoff-phase2-history.md` | This handoff |
| Root / hub `package.json` | `test:phase2` / `test:history` |

## Open gaps

- **Composer UI reopen (strategy B)** — selector-pack verified navigation into existing chat not implemented; open-on-pc uses new live + context prompt (strategy C) while `composer_history_open` CANDIDATE
- **Dedup live∪history by correlationKey** — list merges prefer live when keys match; live rows do not yet emit history correlationKeys
- **Large `state.vscdb` performance** — cold scan acceptable for personal PC; no incremental mtime cache yet
- **Windows path UAT** — path strategies include APPDATA class; not exercised in CI
- **Bubble type mapping** — best-effort (`type` 1/2 → user/assistant); proprietary layout churn → extractor stale / empty
- **Agent CLI store.db** — list/meta only; full blob transcript not normalized
- Phase 3 file picker / Phase 4 selector harden still open

**Resolved 2026-09-25:** multitask agent chats were hidden by `isSubagent=0` filter — Cursor marks user-facing agent composers `isSubagent=1` / `subagentTypeName=generalPurpose`. Adapter now lists those and excludes nested Task types (`explore`, `gsd-doc-writer`, …). Live evidence: 45 listable of 63 headers for `/data/projects/cursor_mobile`.

## Next agent

- **Role:** R7 Live Adapter Engineer (primary) — wire strategy B open-on-pc when selector pack verified; optionally attach correlationKey on live rows
- **Also:** R9 — run `npm run test:phase2` + operator UAT: pair → History tab → Open on PC with CURSOR_WORKSPACE bound
- **Next action:** Verify selector pack for Composer history reopen; keep fail-closed 501/503 when unsupported

## Do not

- Expose CDP beyond loopback / ship cloud history catalogs
- Invent fake history when storage missing
- Claim full E2E Composer reopen “done”
- Put Cursor API keys or raw DB dumps in the APK

## Product locks still true?

Yes — PC-local · open-project remote · continue/create with PC tools · Tailscale+pair · CDP localhost · Expo APK · docs≠full product for UI reopen.
