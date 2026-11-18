# AGENTS.md — Hermes Phone

**Product:** Android client for the Hermes Gateway `phone` platform. Cursor / Cursor Hub / CDP are gone;
`docs/` is historical (Cursor Hub era) — do not implement from it.

## Locks

| Lock | Meaning |
|------|---------|
| **state.db is the truth** | The bridge reads `~/.hermes/state.db` read-only and writes only through normal gateway inbound events. No second history, no copies on the phone beyond a cache. |
| **No gateway core changes** | Server lives in the plugin `~/.hermes/plugins/phone_bridge`. Gateway internals are touched only through `adapter.gateway_runner` (session routing like `/resume`) and fail soft if they change. |
| **PC-local + Tailscale** | Phone ↔ PC over TLS (self-signed cert, T16: bridge is HTTPS-only on all paths, cleartext blocked in the manifest). Pairing codes are created only on the PC (`/pair`, localhost-only). |
| **Evidence over claims** | `npm test`, `npm run e2e`, `smoke_test.py`, `bind_test.py` must be green before saying it works. |

## Map

- `apps/mobile/src/bridge/` — `types.ts` (wire), `client.ts` (REST), `socket.ts` (WS + `since` replay),
  `mirror.ts` (pure sync reducer — all merge/outbox logic, unit-tested), `BridgeProvider.tsx` (React state).
- `apps/mobile/src/screens/` — Pair, Sessions, Chat, Settings. Deep links: `hermes-phone://`.
- `apps/mobile/scripts/e2e-bridge.{sh,ts}` — live E2E using the app's own client code.
- `scripts/` — release gate, APK build/verify, version code.

## Protocol (v1)

REST `/v1/health` (lists `hub.addresses`), `/v1/pair/complete`, one-tap `/v1/pair/request` (+ `/{id}` poll; the PC owner
approves via localhost-only `/pair/requests/{id}/approve|deny`, Origin-checked), `/v1/device/revoke`, `/v1/projects`, `/v1/sessions?project=<slug>`, `POST /v1/chats {project?}` (project chats get the
`phone-bridge.project` system-prompt section; mapping in `~/.hermes/phone_bridge/projects.json`), `/v1/sessions[?before&limit&source&all]`, `/v1/sessions/{id}`,
`/v1/sessions/{id}/messages[?after&limit]` (GET history, POST continue any session), `/v1/chats` (new),
`/v1/chats/{chatId}/messages` (POST), `/v1/chats/{chatId}/session`. WS `/v1/ws?access_token=`:
client `client.hello{since?}`, `ping`; server `server.hello`, `status.snapshot`, `message.created`,
`session.updated`, `live.update{chatId,sessionId,liveId,text,final}` / `live.remove` (ephemeral gateway output:
stream previews, tool progress, command replies — dropped when the persisted message lands or the turn ends),
`pong`, `error`. Never send `since: 0` (would replay the oldest history).

- Test/e2e bridge servers must pass `extra={"notify": False}`: they share the desktop, and every pairing request
  otherwise pops a real "Hermes Phone" notification on the PC.
- Android package is `local.hermes.phone` since 0.4.0 (was `local.cursor.mobile`): the first 0.4.0 install is a
  fresh app — uninstall the old one and pair again.
- `apps/mobile/modules/hermes-background` is a local Expo module (Kotlin foreground service, type
  `remoteMessaging`); it notifies only for `session.updated` idle events whose `source` is `phone`.
- Messages accept multipart (`text`, `clientMessageId`, `file` parts; ≤10 files, 25 MB) → `cache_media_bytes`
  → `MessageEvent.media_urls`.
