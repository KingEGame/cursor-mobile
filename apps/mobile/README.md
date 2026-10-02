# Mobile — Expo Android companion (Phase 0–1)

PC-local Cursor companion APK shell. Remotes the **project already open** in Cursor on the PC via Tailscale → Hub. No cloud agents.

## Screens

| Screen | Phase | Notes |
|--------|-------|-------|
| Pair, Health, Home banner | 0 | Done |
| Live session list, New session, Live chat, Approvals | 1 | Client + UI; needs Hub live routes / adapter for E2E |

## Run

```bash
# Terminal A — Hub (Tailscale-reachable bind)
HUB_HOST=<tailscale-ip> CURSOR_WORKSPACE=/data/projects/cursor_mobile npm run start

# Issue pair code on PC
curl -X POST http://127.0.0.1:8787/v1/pair/start -H 'Content-Type: application/json' -d '{}'

# Terminal B — Expo (optional build-time default; Pair screen overrides at runtime)
export EXPO_PUBLIC_HUB_URL="http://100.91.47.68:8787"
npm run start:mobile
```

Hub URL is **editable on the Pair screen** and stored in SecureStore — rebuild not required to change host. This PC: `http://100.91.47.68:8787` or MagicDNS `http://kingwarpc.tail246b3f.ts.net:8787`.

Typecheck / unit tests:

```bash
npm run test:mobile
# or
cd apps/mobile && npm test
```

## Local release APK

Sideload artifact (gitignored `android/` tree; debug-signed):

`android/app/build/outputs/apk/release/app-release.apk`

See [`docs/reports/apk-build-attempt-2026-09-25.md`](../../docs/reports/apk-build-attempt-2026-09-25.md). Rebuild: `npx expo prebuild --platform android` then `cd android && ./gradlew assembleRelease`.

## Product locks

- PC-local only · open-project remote · CDP `127.0.0.1` · Tailscale + pairing · Expo `android.buildType: apk`
- Phone never dials CDP; tools run on PC only
