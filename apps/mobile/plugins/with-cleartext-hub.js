/**
 * Expo config plugin — disable cleartext HTTP in release builds (TLS-only).
 *
 * T16: the bridge now serves HTTPS with a self-signed certificate on all paths
 * (Tailscale and LAN). Cleartext traffic is no longer permitted.
 * The manifest flag comes from this plugin.
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const withCleartextHub = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:usesCleartextTraffic'] = 'false';
    return cfg;
  });

module.exports = withCleartextHub;
