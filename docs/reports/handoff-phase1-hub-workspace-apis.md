# Handoff — Phase 1 Hub workspace APIs (New Session)

**Date:** 2026-09-25  
**Phase focus:** 1  
**Locks check:** PC-local only · open-project remote · CDP `127.0.0.1` only · Tailscale + pairing · Expo APK path · no fake CDP mutation success

## Done

- Hub New Session routes (TOR-03) wired with honest DESIGNED stubs:
  - `GET /workspace/models` (+ `/v1/...`) — `CURSOR_MODELS` or built-in `composer` / `auto` defaults (`source: env` | `env_stub_default`)
  - `GET /workspace/files?q=` — filesystem scan of `CURSOR_WORKSPACE` (skips `node_modules` / `.git` / `dist`, limit ≤ 200)
  - `GET /workspace/tools` — informational summary from live-adapter health + optional `CURSOR_MCP_SERVERS` / `CURSOR_PLUGINS`
  - `POST /sessions/:id/attachments` — Idempotency-Key required; Hub registers paths under roots; **`domApplied: false`** (no fake Composer @-inject)
  - `POST /sessions` — requires Idempotency-Key; validates model against Hub catalog; validates attachment paths; registers live id via `LiveCursorAdapter.createSession` (`domApplied` false while `extractor_stale`)
- Hub-side `SessionAttachmentStore` seeds on create and merges on attach; `GET /sessions/:id` returns Hub attachment list
- Tests: `packages/hub/tests/phase1/workspace-apis.test.ts` (+ phase0 create Idempotency-Key fix)

## Files

| Path | Change |
|------|--------|
| `packages/hub/src/workspace/models.ts` | Env / default model catalog |
| `packages/hub/src/workspace/files.ts` | Workspace file search + path validation |
| `packages/hub/src/workspace/tools.ts` | Tools summary from health + env |
| `packages/hub/src/session-attachments.ts` | Hub attachment registry |
| `packages/hub/src/routes/api.ts` | Models / files / tools / attachments + stricter create |
| `packages/hub/src/config.ts` | `cursorModels`, MCP/plugins env, attachments store |
| `packages/hub/tests/phase1/workspace-apis.test.ts` | New Phase 1 coverage |
| `packages/hub/tests/phase0/workspace-empty.test.ts` | Idempotency-Key on create |
| `packages/hub/README.md` · `.env.example` · `docs/CONFIGURATION.md` | Document knobs + DESIGNED limits |
| `docs/reports/handoff-phase1-hub-workspace-apis.md` | This handoff |
| `docs/reports/handoff-phase1-live-adapter.md` · `handoff-phase1-mobile.md` | Gap cross-links |

## DESIGNED limits (honest)

| Surface | What it is | What it is not |
|---------|------------|----------------|
| Models | Env list / built-in defaults | Live CDP Composer model picker scrape |
| Files | Recursive FS under `CURSOR_WORKSPACE` | Cursor @-mention / ripgrep index via CDP |
| Tools | Health note + optional env MCP/plugin names | Live MCP inventory from Cursor UI |
| Attachments | Hub path registry + validation | Composer DOM @-file inject (`domApplied` always false until wired) |
| `POST /sessions` | Adapter registers `sess_live_*` id | Full Composer create when `extractor_stale` |

## How to test

```bash
cd /data/projects/cursor_mobile
npm install
npm run test:hub          # or: cd packages/hub && npm test
npm run test:phase1       # hub phase1 + live-cursor

# Manual smoke
CURSOR_WORKSPACE=/data/projects/cursor_mobile \
  CURSOR_MODELS='composer*:Composer:composer,auto:Auto:auto' \
  CURSOR_MCP_SERVERS='filesystem:12' \
  npm run start

# Pair, then:
# GET  /v1/workspace/models
# GET  /v1/workspace/files?q=hub&limit=20
# GET  /v1/workspace/tools
# POST /v1/sessions  (Idempotency-Key + workspaceId + model)
# POST /v1/sessions/:id/attachments  (Idempotency-Key, mode=add)
```

## Open gaps

- Verified selector pack → real Composer create / @-inject / message / approval clicks
- CDP scrape for models / MCP inventory (still env stubs)
- History Index / open-on-pc (Phase 2)
- Persistent pairing token store
- Device E2E: Pair → New session → Live chat on Tailscale

## Next agent

- **Role:** R5 Mobile UX — smoke New Session against these routes (models picker should enable Create)
- **Or** R7 — selector pack record/replay so `domApplied` can become true without lying
- **Next action:** On device, Pair → Home → New session → pick model → attach file → Create → confirm `sess_live_*` and `domApplied: false` banner while stale

## Do not

- Claim Composer DOM create/attach “works” while `extractor_stale`
- Expose CDP beyond loopback / invent cloud model catalogs
- Run tools/MCP on the phone

## Product locks still true?

Yes — PC-local · open-project remote · continue/create with PC tools · Tailscale+pair · CDP localhost · Expo APK · docs≠full live DOM.
