# Handoff — Phase 0 test harness

**Date:** 2026-09-25  
**Phase focus:** 0  
**Locks check:** PC-local only · open-project remote · CDP localhost · Tailscale + pair · Hub Phase 0 routes tested (not claimed as full product)

## Done

- Root monorepo workspaces (`packages/*`, `packages/adapters/*`, `apps/*`) + `npm run test:phase0`.
- Phase 0 vitest suite against **Hub Express API** (`createApp` / `createHubContext`): health, pair, workspace empty-state, workspaceId scope on `POST /sessions`.
- Documented automated vs manual TOR-08 §4.1–4.2 matrix.
- Reconciled with parallel Hub agent landing (removed conflicting stub modules; tests target real routes).
- **21/21 tests passing** (`tests/phase0/*` + `test/health-pair.test.ts`).

## Files

- `package.json` — workspaces + `test:phase0`
- `packages/hub/tests/phase0/health.test.ts` — AC-004-01/02, secrets redaction, AC-001-03
- `packages/hub/tests/phase0/pair.test.ts` — AC-002-01…04, AC-003-03 API
- `packages/hub/tests/phase0/workspace-empty.test.ts` — AC-010/012/013 + AC-X-03
- `packages/hub/vitest.config.ts`
- `packages/hub/src/routes/api.ts` — added Phase 0 `POST /sessions` scope gate
- `packages/hub/src/config.ts` — `revokeByToken` for AC-002-04
- `packages/adapters/{history,live-cursor}/package.json` — source exports for workspace installs
- `docs/reports/test-plan-phase0.md`
- `docs/reports/handoff-phase0-tests.md` (this file)
- `README.md` — status notes Phase 0 harness

## Open gaps

- Manual TOR-08 §5.1 UAT: Tailscale mesh, APK Health/banner, CDP probe from phone.
- Real CDP attach still stubbed in unit tests (mock `live.probe`); live Cursor detection TBD.
- AC-013-03 session **list** scoping deferred to Phase 1.
- APK (`apps/mobile`) not covered by `test:phase0`.
- `POST /sessions` returns Phase 0 stub session — Composer create is Phase 1.

## Next agent

- **Role:** R3 Hub / Phase 0 UAT owner (AGENT-ROSTER)
- **Next action:** Run TOR-08 §5.1 manual UAT on Tailscale + APK; wire real CDP probe into health when Cursor is available; keep `npm run test:phase0` green.

## Do not

- Do not add Cloud Agents / public CDP / phone-side MCP.
- Do not invent workspace ids when no folder is open.
- Do not drop Phase 0 tests when expanding Hub.

## How to run

```bash
cd /data/projects/cursor_mobile
npm install
npm run test:phase0
```

## Locks check

PC-local only · open-project remote · CDP localhost · Tailscale + pair · no false “shipped full Hub” claim.
