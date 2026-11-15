import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Android versionCode from the app version: major * 10000 + minor * 100 + patch.
 * Every version bump in app.json therefore installs as an update over the last one.
 * Mirrored in scripts/version-code.mjs.
 */
export function versionCodeFor(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`app version "${version}" must be x.y.z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`app version "${version}": minor/patch must be ≤ 99`);
  return major * 10000 + minor * 100 + patch;
}

/**
 * Hermes Phone — client of the Hermes Gateway phone bridge (port 8097) over Tailscale.
 * Default PC address from EXPO_PUBLIC_HUB_URL or app.json extra.hubUrl (only prefills Pair).
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const hubUrl =
    process.env.EXPO_PUBLIC_HUB_URL?.trim() ||
    (typeof config.extra?.hubUrl === 'string' && !config.extra.hubUrl.includes('${') ? config.extra.hubUrl : '') ||
    '';

  const version = config.version ?? '0.2.0';

  return {
    ...config,
    name: config.name ?? 'Hermes Phone',
    slug: config.slug ?? 'hermes-phone',
    version,
    android: {
      ...config.android,
      versionCode: versionCodeFor(version),
      // No self-updater and no gallery any more: keep the manifest to what the app uses.
      blockedPermissions: [
        'android.permission.REQUEST_INSTALL_PACKAGES',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.RECORD_AUDIO',
      ],
    },
    plugins: [
      ...(config.plugins ?? []),
      // Release APK: R8 code shrinking + resource shrinking (smaller download, faster cold start).
      [
        'expo-build-properties',
        {
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
        },
      ],
      './plugins/with-release-signing',
      // The bridge speaks HTTP on Tailscale (WireGuard encrypts it); Expo ignores
      // android.usesCleartextTraffic, so the manifest flag comes from this plugin.
      './plugins/with-cleartext-hub',
      // Camera only to scan the pairing QR shown on the PC.
      ['expo-camera', { cameraPermission: 'Scan the pairing QR code shown on your PC.', recordAudioAndroid: false }],
    ],
    extra: {
      ...config.extra,
      hubUrl,
      apiVersion: '1',
    },
  };
};
