# Handoff — Phase 0 monorepo + Hub skeleton

**Date:** 2026-09-25  
**Phase focus:** 0  
**Locks check:** PC-local only · open-project remote · CDP `127.0.0.1` · Tailscale + pairing · Expo APK path · Phase 0 Hub routes implemented — Phase 1 live DOM / sessions **not** done

## Done

- Root npm workspaces: `packages/hub`, `packages/adapters/*`, `apps/*`
- Hub Express server with TOR-03-aligned Phase 0 routes:
  - `GET /health` and `GET /v1/health`
  - `POST /pair/start` and `/v1/pair/start`
  - `POST /pair/confirm` + `/pair/complete` (and `/v1/...` aliases)
  - `GET /workspace` (Bearer) — `CURSOR_WORKSPACE` stub or `NO_FOLDER_OPEN`
- Config: `HUB_HOST`, `HUB_PORT` (8787), `CDP_URL` default loopback, pairing TTLs
- `@cursor-mobile/live-cursor` — CDP `/json/version` probe + loopback URL guard
- `@cursor-mobile/history` — Phase 2 stub interface
- `npm run build` / `npm run start` / `npm run test:hub` (18 tests passing)
- Root README + CONFIGURATION + AGENT-CONTEXT status updated to Phase 0 in progress

## Files

| Path | Change |
|------|--------|
| `package.json` | Workspaces + build/start/test scripts |
| `tsconfig.base.json` | Shared TS config |
| `.env.example` / `.gitignore` | Hub env template |
| `packages/hub/**` | Express Hub, pairing store, routes, README, tests |
| `packages/adapters/live-cursor/**` | CDP probe stub |
| `packages/adapters/history/**` | History stub |
| `apps/mobile/**` | Expo shell (sibling) — package name `@cursor-mobile/mobile` |
| `README.md` | Status → Phase 0 in progress |
| `docs/CONFIGURATION.md` | Phase 0 knobs marked live |
| `docs/architecture/AGENT-CONTEXT.md` | Implementation status |
| `AGENTS.md` | Code layout + status |
| `docs/reports/handoff-phase0-scaffold.md` | This handoff |

## Open gaps

- Persistent device-token store (Phase 0 is in-memory)
- CDP-based workspace detect (env stub only via `CURSOR_WORKSPACE`)
- LiveCursorAdapter DOM / messages / approvals (R7, Phase 1)
- History Index implementation (R8, Phase 2)
- WS `/v1/ws`, sessions, models, files, tools routes (Phase 1+)
- APK pair UX + Tailscale operator UAT (R5 / R9)
- Pair `start` should ideally be loopback-only (TOR-03 `local` auth) — currently open like other public routes for Phase 0 simplicity

## Next agent

- **Role:** R7 Live Adapter Engineer (primary) and/or R5 Mobile UX for APK pairing screens
- **Next action:** Implement LiveCursorAdapter attach beyond probe; wire Hub health `cursor.windowsDetected` from real CDP targets; keep CDP on `127.0.0.1`
- **Also:** R9 verify Phase 0 DoD against TOR-08 AC catalog using `npm run test:phase0`

## Do not

- Expose CDP beyond loopback
- Add Cloud Agents / Remote Control / ngrok-as-default
- Claim sessions/WS/live chat “done”
- Invent fake workspace when unset

## Product locks still true?

Yes — PC-local · open-project remote · continue/create with PC tools · Tailscale+pair · CDP localhost · Expo APK · docs≠full product.
