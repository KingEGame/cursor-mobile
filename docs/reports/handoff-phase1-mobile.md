# Handoff — Phase 1 mobile UI (sessions / chat / approvals / new session)

**Date:** 2026-09-25  
**Phase focus:** 1  
**Locks check:** PC-local only · open-project remote · CDP localhost · Tailscale + pairing · Expo `android.buildType: apk` · no cloud claimed as product path

## Done

- Extended typed Hub client for TOR-03 Phase 1 routes: `GET /sessions`, `GET /sessions/:id`, `POST /sessions`, messages, attachments, approvals, `GET /workspace/models|files|tools`.
- Missing Hub routes → `HubApiError` `ROUTE_NOT_AVAILABLE` (404); `listSessions({ tolerateMissing: true })` returns empty live list so Home stays usable while adapter lands.
- `createSession` normalizes Phase 0 Hub stub `{ sessionId }` → TOR `{ id }`.
- WebSocket helper `HubWebSocket` for `GET /v1/ws` (hello, subscribe, ping); UI degrades when WS unavailable.
- Screens / nav:
  - **Home** — live session list (History tab placeholder disabled for Phase 2), New session CTA, pull-to-refresh, degraded CDP banner.
  - **LiveChat** — transcript, composer send, inline **Approve/Deny** cards, WS event handling.
  - **NewSession** (modal) — model picker, file attach (Hub files or stub path), tools info, first prompt → `POST /sessions` → LiveChat.
- Unit tests + typecheck green (`npm run test:mobile`).
- Docs synced: root README, AGENT-CONTEXT, TOR-04 status, mobile README.

## Files

| Path | Action |
|------|--------|
| `apps/mobile/src/hub/client.ts` | Updated — Phase 1 REST + degrade helpers |
| `apps/mobile/src/hub/types.ts` | Updated — session/message/approval/workspace types |
| `apps/mobile/src/hub/ws.ts` | Created — WS client |
| `apps/mobile/src/hub/idempotency.ts` | Created |
| `apps/mobile/src/hub/format.ts` | Created |
| `apps/mobile/src/hub/client.test.ts` | Updated — Phase 1 client/helper tests |
| `apps/mobile/src/screens/HomeScreen.tsx` | Updated — live session list |
| `apps/mobile/src/screens/LiveChatScreen.tsx` | Created |
| `apps/mobile/src/screens/NewSessionScreen.tsx` | Created |
| `apps/mobile/src/components/ApprovalCard.tsx` | Created |
| `apps/mobile/src/components/SessionRow.tsx` | Created |
| `apps/mobile/App.tsx` | Updated — LiveChat + NewSession routes |
| `apps/mobile/src/navigation/types.ts` | Updated |
| `apps/mobile/README.md` | Updated |
| `docs/architecture/AGENT-CONTEXT.md` | Updated — code status |
| `docs/reports/tor/TOR-04-mobile-apk-and-ux.md` | Updated — status line |
| `AGENTS.md` / `README.md` | Updated — Phase 1 mobile note |
| `docs/reports/handoff-phase1-mobile.md` | Created (this file) |

## How to run

```bash
# Terminal A — Hub
HUB_HOST=<tailscale-ip> CURSOR_WORKSPACE=/data/projects/cursor_mobile npm run start

# Pair code (PC)
curl -X POST http://127.0.0.1:8787/v1/pair/start -H 'Content-Type: application/json' -d '{}'

# Terminal B — Expo
export EXPO_PUBLIC_HUB_URL="http://<tailscale-host-or-ip>:8787"
npm run start:mobile
# Pair → Health → Home → New session / Live chat
```

```bash
npm run test:mobile
```

## Open gaps (waiting on Hub / live adapter)

| Gap | Impact on mobile |
|-----|------------------|
| Verified selector pack / DOM mutations | Send / Approve / Create stay fail-closed or `domApplied: false` until pack verified |
| History list / Open on PC | Intentionally Phase 2 (tab disabled) |
| EAS `projectId` still TODO | Sideload release build blocked |
| Device E2E on Tailscale | Not run this turn |

**Hub workspace APIs (models / files / tools / attachments / create):** landed — see [`handoff-phase1-hub-workspace-apis.md`](./handoff-phase1-hub-workspace-apis.md). Mobile New Session Create should enable once Hub is running with `CURSOR_WORKSPACE` set.

## Next agent

- **Role:** R5 Mobile UX — smoke New Session against Hub workspace APIs; then R7 for selector pack.
- **Next action:** Ship verified selector pack **or** device smoke Pair → New session → stream → approval against live Hub routes ([`handoff-phase1-hub-workspace-apis.md`](./handoff-phase1-hub-workspace-apis.md)).
- After Hub live: smoke Pair → New session → stream → approval card on a real Tailscale device.

## Do not

- Add Cloud Agents / Remote Control / public CDP.
- Enable History as if Phase 2 were done.
- Claim live E2E chat/approvals work until Hub + adapter prove them.
- Run tools/MCP on the phone.

## Product locks still true?

Yes — PC-local only · open-project remote · Tailscale + pairing · CDP `127.0.0.1` · Expo APK · docs≠full live path until Hub WS + adapter land.
