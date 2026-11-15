# Hermes Phone — Expo APK

See the root [AGENTS.md](../../AGENTS.md) and [README.md](../../README.md).

- Core: `src/bridge/` (keep merge/outbox logic in the pure `mirror.ts` and cover it in `bridge.test.ts`).
- Screens: Pair → Sessions → Chat, Settings. Deep links: `hermes-phone://pair?hubUrl=&code=&pairId=&name=`, `hermes-phone://session/<id>`.
- Native: `android/` is generated — never edit it; change `app.config.ts` / `plugins/` and run `npx expo prebuild --clean`.
- Tests: `npm test`; live E2E against a DB copy: `npm run e2e`.
