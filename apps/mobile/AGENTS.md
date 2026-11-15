# Hermes Phone — Expo APK

Phone client for the **Hermes Gateway `phone` platform** (plugin `~/.hermes/plugins/phone_bridge`, port 8097).
Cursor / Cursor Hub are no longer used.

- Source of truth: the PC's `~/.hermes/state.db`. Phone mirrors sessions/messages; phone chats are normal
  Hermes sessions (`source=phone`), resumable on the PC with `hermes --resume <id>`.
- Code: `src/bridge/` (types, REST client, reconnecting WS with `since` replay, pure `mirror.ts` reducer,
  `BridgeProvider`), screens `Pair → Sessions → Chat`, `Settings`.
- Pair: open `http://127.0.0.1:8097/pair` on the PC → enter address + 8-digit code (or scan QR).
- Tests: `npm test` (typecheck + unit). Live E2E against a DB copy:
  `python ~/.hermes/plugins/phone_bridge/e2e_server.py 18098` then
  `node --import tsx scripts/e2e-bridge.ts http://127.0.0.1:18098 <pairId> <code>`.
