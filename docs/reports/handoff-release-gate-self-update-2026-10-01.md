# Handoff — release gate + phone self-update (2026-10-01)

Spec: [docs/features/release-gate-and-self-update.md](../features/release-gate-and-self-update.md)

## Done

- **Release gate** `npm run gate` (pre-push hook via `core.hooksPath=.githooks`): build → Hub+adapters
  tests → mobile tsc+tests → release-script tests → `assert:no-second-cdp`. GREEN · 318 tests · ~7s.
  Verified: a deliberately failing test blocks the push (exit 1); delete-only pushes skip.
- Fixed pre-existing red test `live-cursor/src/selector-pack.test.ts` (comma inside a quoted
  `aria-label` is not a selector cascade).
- **CI** `.github/workflows/ci.yml`: gate → android-apk → release (tags `v*`).
  **Not run yet — repo has no GitHub remote.**
- **Hub** `GET /v1/app/latest`, `GET /v1/app/apk` (paired), `HUB_RELEASES_DIR`; 9 vitest cases.
  Live smoke on a throwaway Hub (127.0.0.1:8799): 401 without token, manifest OK, downloaded
  APK sha256 identical to the published one.
- **Mobile** Account `UpdateCard`, `Update` modal screen, `src/update/installer.ts`
  (expo-file-system download with Bearer, size+md5 verify, intent to package installer),
  `REQUEST_INSTALL_PACKAGES`, `versionCode = major*10000+minor*100+patch`, signing plugin.
- **Local release** `npm run release:apk` built `0.1.0 (100)`, 77.9 MB, signed with the same key
  as the installed Pixel APK (SHA-1 5E:8F:16…), published to `packages/hub/data/releases`.

## Files touched

`.githooks/pre-push` · `.github/workflows/ci.yml` · `.gitignore` · `package.json` ·
`scripts/{release-gate.sh,release-apk-local.sh,publish-apk-to-hub.mjs,release-scripts.test.mjs}` ·
`packages/hub/src/{app-release.ts,config.ts,routes/api.ts}` · `packages/hub/tests/phase4/app-release.test.ts` ·
`packages/adapters/live-cursor/src/selector-pack.test.ts` ·
`apps/mobile/{app.config.ts,package.json,App.tsx,plugins/with-release-signing.js}` ·
`apps/mobile/src/{hub/app-update.ts,hub/app-update.test.ts,hub/client.ts,hub/app-version.test.ts,components/UpdateCard.tsx,screens/UpdateScreen.tsx,screens/AccountScreen.tsx,update/*,navigation/types.ts}` ·
docs: this report, feature spec, `CONFIGURATION.md`, `features/phone-apk-screens.md`.

## Open gaps

1. **Bootstrap once:** the APK on the Pixel (versionCode 1) predates self-update → install build
   100 via `adb install -r` (same key, keeps pairing); later updates go through the app.
2. Restart the operator Hub so it serves `/v1/app/*`.
3. On-device run of Download → verify → installer not yet exercised (needs 1+2, then a 0.1.1 bump).
4. GitHub: create private repo + `origin`, branch protection (`gate`, `android-apk`), optional
   `CM_KEYSTORE_*` secrets. First CI run unverified.
5. Release key is the public RN debug key; moving to a private key = one uninstall + re-pair.
6. Pre-push gate tests the working tree, not the exact pushed commit (CI covers the commit).

## Next agent

R-role owning mobile UAT (see AGENT-ROSTER): steps 1–3 on the Pixel.

## Product locks still true?

Yes — phone downloads only from the Hub on the PC over Tailscale with its device token; CDP
untouched and loopback-only; GitHub is build/test only, never a sync plane.
