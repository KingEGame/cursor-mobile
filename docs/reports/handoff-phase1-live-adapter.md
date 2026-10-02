# Handoff — Phase 1 LiveCursorAdapter + Hub sessions/WS

**Date:** 2026-09-25  
**Phase focus:** 1  
**Locks check:** PC-local only · open-project remote · CDP `127.0.0.1` only · Tailscale + pairing · Expo APK path · no History Index · no fake DOM success

## Done

- **LiveCursorAdapter** (`@cursor-mobile/live-cursor`) beyond Phase 0 probe:
  - Attach lifecycle: `/json/version` + `/json/list`, window discovery, detach
  - Health triad: `cdp_ok` | `extractor_stale` | `cursor_down`
  - Best-effort live session list from CDP targets; empty when `cursor_down`
  - Command interface: `createSession` / `sendMessage` / `applyApproval`
  - Default selector pack is **unverified** → `extractor_stale`; mutations **fail closed** (no fake success)
  - Loopback-only CDP URL guard unchanged
- **Hub Phase 1 routes** (TOR-03):
  - `GET /sessions?workspaceId=&mode=live` (+ `/v1/...`)
  - `GET /sessions/:id`
  - `POST /sessions` (registers Hub session; `domApplied: false` while stale)
  - `POST /sessions/:id/messages` + `POST /sessions/:id/approvals` (Idempotency-Key; `EXTRACTOR_STALE` / `CDP_UNAVAILABLE`)
  - `WS /ws` and `/v1/ws` (paired Bearer or `?access_token=`; `client.hello` / ping / health.changed)
  - `/health` includes `liveAdapter` triad slice
- **Tests:** adapter health + Hub empty/degraded session paths (39 tests total across hub + live-cursor)
- Product locks: CDP never exposed beyond loopback; phone never dials CDP

## Files

| Path | Change |
|------|--------|
| `packages/adapters/live-cursor/src/*` | Adapter impl, CDP HTTP, selector pack stub, tests |
| `packages/hub/src/routes/api.ts` | Sessions / messages / approvals |
| `packages/hub/src/ws.ts` · `server.ts` · `cli.ts` | WebSocket upgrade + listen |
| `packages/hub/src/idempotency.ts` · `config.ts` | Idempotency store + HubContext.ws |
| `packages/hub/tests/phase1/sessions-live.test.ts` | Phase 1 Hub tests |
| `packages/hub/tests/phase0/*` · `test/health-pair.test.ts` | Updated mocks for full adapter interface |
| `docs/CONFIGURATION.md` · `.env.example` · `packages/hub/README.md` | Phase 1 knobs / routes |
| `docs/architecture/AGENT-CONTEXT.md` | Implementation status |
| `docs/reports/handoff-phase1-live-adapter.md` | This handoff |

## How to test

```bash
cd /data/projects/cursor_mobile
npm install
npm run build
npm run test          # hub (29) + live-cursor (10)
npm run test:phase1   # hub phase1 + live-cursor

# Manual smoke (optional — Cursor with CDP on loopback)
CURSOR_WORKSPACE=/data/projects/cursor_mobile npm run start
curl -s http://127.0.0.1:8787/health | jq '.liveAdapter,.cdp,.cursor'
# Pair, then:
# GET /v1/sessions?workspaceId=ws_…&mode=live
# POST /v1/sessions/:id/messages with Idempotency-Key → expect EXTRACTOR_STALE until real selectors
```

Override only for future live DOM smoke (not default): `LIVE_SELECTOR_PACK_READY=true`.

## Open gaps

- **Verified selector pack** — real Composer DOM extract + click targets (still stub; health stays `extractor_stale`)
- **New Session full apply** — model picker + `@file` injection on PC DOM (Hub accepts create; `domApplied` false until pack ready). **Hub workspace APIs landed** — see [`handoff-phase1-hub-workspace-apis.md`](./handoff-phase1-hub-workspace-apis.md)
- **WS streaming transcript** — hello/health/events scaffolded; no live `session.message.delta` from DOM yet
- **History Index / open-on-pc** — Phase 2 (R8)
- **APK** — pair + sessions/chat UI against these routes (sibling R5); EAS APK polish
- Persistent device-token store (still in-memory)
- CDP-based workspace detect (still `CURSOR_WORKSPACE` env stub)

## Next agent

- **Role:** R7 (continue) for selector pack record/replay against real Cursor UI **or** R5 Mobile UX to wire APK to `/sessions`, `/messages`, `/approvals`, `/ws`
- **Next action:** Record Composer DOM fixtures → ship first verified pack so mutations can leave `extractor_stale`; APK should show health triad + fail-closed errors

## Do not

- Claim live chat/approvals “work end-to-end” on PC DOM until selector pack is verified
- Expose CDP beyond `127.0.0.1` / Tailscale-forward CDP
- Implement History Index as part of this path (Phase 2)
- Fake `status: applied` when extractor is stale

## Product locks still true?

Yes — PC-local · open-project remote · continue/create with PC tools · Tailscale+pair · CDP localhost · Expo APK · docs≠full live DOM.
