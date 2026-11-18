/**
 * Expo config plugin — release APK signing that survives `expo prebuild --clean`.
 *
 * With CM_KEYSTORE_FILE (+ CM_KEYSTORE_PASSWORD, CM_KEY_ALIAS, CM_KEY_PASSWORD)
 * set at Gradle time, release builds are signed with that keystore. Without it
 * they keep the template debug key, which is what the APK already on the Pixel
 * uses — Android only installs an update signed with the same key as the
 * installed app, so switching keys needs one uninstall + re-pair.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// hermes-phone: release signing';

function applyReleaseSigning(gradle) {
  if (gradle.includes(MARKER)) return gradle;

  const signingAnchor = /signingConfigs\s*\{\s*\n(\s*)debug\s*\{/;
  if (!signingAnchor.test(gradle)) {
    throw new Error('with-release-signing: signingConfigs { debug { … } } not found in app/build.gradle');
  }
  gradle = gradle.replace(
    signingAnchor,
    (match, indent) =>
      match.replace(
        /\n(\s*)debug\s*\{/,
        `\n${indent}${MARKER}\n` +
          `${indent}release {\n` +
          `${indent}    if (System.getenv('CM_KEYSTORE_FILE')) {\n` +
          `${indent}        storeFile file(System.getenv('CM_KEYSTORE_FILE'))\n` +
          `${indent}        storePassword System.getenv('CM_KEYSTORE_PASSWORD')\n` +
          `${indent}        keyAlias System.getenv('CM_KEY_ALIAS')\n` +
          `${indent}        keyPassword System.getenv('CM_KEY_PASSWORD')\n` +
          `${indent}    }\n` +
          `${indent}}\n` +
          `${indent}debug {`,
      ),
  );

  const releaseType = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!releaseType.test(gradle)) {
    throw new Error('with-release-signing: release buildType signingConfig not found in app/build.gradle');
  }
  return gradle.replace(
    releaseType,
    `$1signingConfig System.getenv('CM_KEYSTORE_FILE') ? signingConfigs.release : signingConfigs.debug`,
  );
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('with-release-signing: expected a Groovy app/build.gradle');
    }
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents);
    return cfg;
  });

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
