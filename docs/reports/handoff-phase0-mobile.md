# Handoff — Phase 0 Expo mobile APK shell

**Date:** 2026-09-25  
**Phase focus:** 0  
**Locks check:** PC-local only · open-project remote · CDP localhost · Tailscale + pairing · Expo `android.buildType: apk` · no cloud claimed as product path

## Done

- Scaffolded `apps/mobile` as Expo (TypeScript) Android companion shell.
- Screens: **Pair**, **Health**, **Home** with project banner + empty state when no PC workspace.
- Typed Hub client for TOR-03 `/v1/health`, `/v1/pair/complete`, `/v1/workspace` (aligned with live `packages/hub`).
- Config: `EXPO_PUBLIC_HUB_URL` via `app.config.ts` / expo-constants; runtime Hub URL + device token in SecureStore.
- `eas.json` profiles with `android.buildType: "apk"`.
- README run / EAS notes; `npm run typecheck` / `npm test` smoke (client unit tests).
- Root scripts: `start:mobile`, `typecheck:mobile`, `test:mobile`.

## Files

| Path | Action |
|------|--------|
| `apps/mobile/**` | Created — Expo app, screens, Hub client, eas.json, README |
| `apps/mobile/.env.example` | Created |
| `package.json` (root) | Updated — mobile workspace scripts |
| `docs/CONFIGURATION.md` | Updated — Expo / `EXPO_PUBLIC_HUB_URL` Phase 0 |
| `docs/architecture/AGENT-CONTEXT.md` | Updated — code status |
| `AGENTS.md` | Updated — Phase 0 Hub + Expo shell |
| `README.md` | Updated — mobile status + run notes |
| `docs/reports/handoff-phase0-mobile.md` | Created (this file) |

## How to run

```bash
# Terminal A — Hub (Tailscale-reachable bind)
HUB_HOST=<tailscale-ip> CURSOR_WORKSPACE=/data/projects/cursor_mobile npm run start

# Issue pair code on PC (operator)
curl -X POST http://127.0.0.1:8787/v1/pair/start -H 'Content-Type: application/json' -d '{}'

# Terminal B — Expo
export EXPO_PUBLIC_HUB_URL="http://<tailscale-host-or-ip>:8787"
npm run start:mobile
# Pair screen → enter Hub URL + code → Health → Home
```

Typecheck / smoke:

```bash
npm run test:mobile
```

EAS APK (after `eas` project id in `app.json`):

```bash
cd apps/mobile && npx eas build -p android --profile apk
```

## Open gaps

- EAS `projectId` is still `TODO-create-eas-project` — create EAS project before release builds.
- QR camera scan not wired (manual code + optional pairId only).
- Session list / New session / Live chat / Approvals = **Phase 1**.
- SecureStore on web/Expo Go limitations — target Android device/emulator for pairing persistence.
- End-to-end device test against Hub on real Tailscale not run in this turn.
- Hub `/pair/start` remains operator/PC-side; APK only calls `/pair/complete`.

## Next agent

- **Role:** R5 Mobile / or Phase 1 executor (live sessions + approvals).
- **Next action:** Either (a) create EAS project + first sideload APK build, or (b) start Phase 1 Live chat / `GET /sessions` UI against Hub once those routes land.

## Do not

- Add Cloud Agents / Remote Control / public CDP.
- Invent a phone-side project picker or fake workspace.
- Claim Phase 1 chat/approvals are done.

## Product locks still true?

Yes — PC-local only · open-project remote · Tailscale + pairing · CDP `127.0.0.1` · Expo APK · docs≠Phase 1.
