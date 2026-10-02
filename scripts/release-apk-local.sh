#!/usr/bin/env bash
# PC-local release: gate GREEN → release APK → Hub update feed.
# The paired phone then sees "Update ready" in Account.
#
#   npm run release:apk              # full gate first
#   SKIP_GATE=1 npm run release:apk  # only right after a green `npm run gate`
#
# Signing: CM_KEYSTORE_FILE/CM_KEYSTORE_PASSWORD/CM_KEY_ALIAS/CM_KEY_PASSWORD
# when set (apps/mobile/plugins/with-release-signing.js), else the template
# debug key that the installed APK already uses.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "${SKIP_GATE:-0}" != "1" ]; then
  bash scripts/release-gate.sh
elif [ ! -s .gate/tests-passed ]; then
  echo "release-apk: SKIP_GATE=1 but the last gate run was not green — run npm run gate" >&2
  exit 1
fi

# prebuild can drop android/local.properties; Gradle then needs ANDROID_HOME.
if [ -z "${ANDROID_HOME:-}" ]; then
  for d in "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    if [ -n "$d" ] && [ -d "$d/platforms" ]; then export ANDROID_HOME="$d"; break; fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "release-apk: set ANDROID_HOME to your Android SDK" >&2; exit 1; }

echo "release-apk: expo prebuild (android)…"
(cd apps/mobile && npx expo prebuild --platform android --no-install >/dev/null)

echo "release-apk: gradle assembleRelease…"
(cd apps/mobile/android && ./gradlew --quiet assembleRelease)

APK=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
CODE="$(node -e "import('./scripts/publish-apk-to-hub.mjs').then(m=>console.log(m.versionCodeFor(require('./apps/mobile/app.json').expo.version)))")"
node scripts/verify-apk.mjs "$APK" --version-code "$CODE"

TESTS="$(cat .gate/tests-passed 2>/dev/null || echo '')"
node scripts/publish-apk-to-hub.mjs ${TESTS:+--tests-passed "$TESTS"}
echo "release-apk: done — open Account on the phone (pull to refresh)."
