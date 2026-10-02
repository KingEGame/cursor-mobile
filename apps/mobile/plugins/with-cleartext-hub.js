/**
 * Expo config plugin — allow plain HTTP to the PC Hub in release builds.
 *
 * The Hub speaks HTTP on the Tailscale mesh (WireGuard already encrypts it).
 * Expo does not map `android.usesCleartextTraffic` from app config to the
 * manifest, so without this plugin `expo prebuild` produces a release APK that
 * cannot reach the Hub ("CLEARTEXT communication … not permitted").
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const withCleartextHub = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });

module.exports = withCleartextHub;
