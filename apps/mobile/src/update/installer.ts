/**
 * Native half of self-update: download the APK (GitHub releases, or the PC Hub as fallback), verify it,
 * hand it to Android's package installer. Decisions live in hub/app-update.ts.
 *
 * Android always shows its own Install confirmation for sideloaded apps, and
 * only accepts an update signed with the same key as the installed app.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { downloadPercent, verifyDownload, type AppLatestAvailable } from '../hub/app-update';

const APK_MIME = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const APP_PACKAGE = 'local.cursor.mobile';

function apkPath(versionCode: number): string {
  if (!FileSystem.cacheDirectory) throw new Error('No cache directory on this device');
  return `${FileSystem.cacheDirectory}update-${versionCode}.apk`;
}

/** Drop earlier downloads (and a partial one for this version). */
async function clearDownloads(): Promise<void> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return;
  const names = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => /^update-\d+\.apk$/.test(n))
      .map((n) => FileSystem.deleteAsync(`${dir}${n}`, { idempotent: true })),
  );
}

export interface DownloadHandle {
  done: Promise<string>;
  cancel: () => Promise<void>;
}

export function startDownload(opts: {
  url: string;
  /** Only for Hub downloads; GitHub release files are public and get no Authorization header. */
  deviceToken?: string;
  release: AppLatestAvailable;
  onProgress: (percent: number) => void;
}): DownloadHandle {
  const dest = apkPath(opts.release.versionCode);
  let cancelled = false;
  const task = FileSystem.createDownloadResumable(
    opts.url,
    dest,
    { headers: opts.deviceToken ? { Authorization: `Bearer ${opts.deviceToken}` } : {}, cache: false },
    (p) => opts.onProgress(downloadPercent(p.totalBytesWritten, opts.release.sizeBytes)),
  );
  const done = (async () => {
    await clearDownloads();
    const res = await task.downloadAsync();
    if (cancelled) throw new Error('Cancelled');
    if (!res) throw new Error('Download stopped before it finished');
    if (res.status !== 200) {
      await FileSystem.deleteAsync(dest, { idempotent: true });
      throw new Error(
        res.status === 401 ? 'This phone is no longer paired with the PC.' : `Download server answered ${res.status}`,
      );
    }
    return res.uri;
  })();
  return {
    done,
    cancel: async () => {
      cancelled = true;
      await task.cancelAsync().catch(() => undefined);
      await FileSystem.deleteAsync(dest, { idempotent: true });
    },
  };
}

/** Size + md5 against the release manifest; deletes the file when it does not match. */
export async function verifyApk(uri: string, release: AppLatestAvailable): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri, { md5: true });
  const check = verifyDownload(
    { size: info.exists ? info.size : null, md5: info.exists ? info.md5 : null },
    release,
  );
  if (!check.ok) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    throw new Error(`${check.message} The file was deleted; nothing was installed.`);
  }
}

export async function openInstaller(uri: string): Promise<void> {
  const contentUri = await FileSystem.getContentUriAsync(uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: APK_MIME,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  });
}

/** Settings page where the user allows this app to install updates (first time only). */
export async function openInstallPermissionSettings(): Promise<void> {
  await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_UNKNOWN_APP_SOURCES, {
    data: `package:${APP_PACKAGE}`,
  });
}
