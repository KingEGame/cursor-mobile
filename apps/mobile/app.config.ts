import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Android versionCode from the app version: major * 10000 + minor * 100 + patch.
 * Every version bump in app.json therefore installs as an update over the last one.
 * Mirrored in scripts/publish-apk-to-hub.mjs (versionCodeFor).
 */
export function versionCodeFor(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`app version "${version}" must be x.y.z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`app version "${version}": minor/patch must be ≤ 99`);
  return major * 10000 + minor * 100 + patch;
}

/**
 * Expo config — Hub base URL from EXPO_PUBLIC_HUB_URL (Tailscale MagicDNS / IP).
 * PC-local companion only: no Cursor Cloud Agents / Remote Control.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const hubUrl =
    process.env.EXPO_PUBLIC_HUB_URL?.trim() ||
    (typeof config.extra?.hubUrl === 'string' &&
    !config.extra.hubUrl.includes('${')
      ? config.extra.hubUrl
      : '') ||
    '';

  const version = config.version ?? '0.1.0';

  return {
    ...config,
    name: config.name ?? 'Cursor Mobile',
    slug: config.slug ?? 'cursor-mobile',
    version,
    android: {
      ...config.android,
      versionCode: versionCodeFor(version),
      // Self-update hands the downloaded APK to Android's package installer.
      permissions: [...(config.android?.permissions ?? []), 'android.permission.REQUEST_INSTALL_PACKAGES'],
    },
    plugins: [
      ...(config.plugins ?? []),
      './plugins/with-release-signing',
      // Hub speaks HTTP on Tailscale (PC-local mesh); Expo ignores
      // android.usesCleartextTraffic, so the manifest flag comes from this plugin.
      './plugins/with-cleartext-hub',
    ],
    extra: {
      ...config.extra,
      hubUrl,
      apiVersion: '1',
    },
  };
};
