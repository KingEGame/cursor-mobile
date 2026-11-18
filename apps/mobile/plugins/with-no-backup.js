/**
 * Expo config plugin — disable Android backup for the app (T16 security).
 *
 * android:allowBackup=false + fullBackupContent/dataExtractionRules removed
 * prevents the token and paired PC addresses from being backed up to the cloud
 * or restored onto a different device.
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const withNoBackup = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:allowBackup'] = 'false';
    // Remove backup rules — no data should leave this device.
    delete app.$['android:fullBackupContent'];
    delete app.$['android:dataExtractionRules'];
    return cfg;
  });

module.exports = withNoBackup;