import Constants from 'expo-constants';
import { parseInstalledVersionCode } from '../hub/app-update';
import { appVersionLabel } from '../hub/app-version';

/** versionCode of the running build (native first; embedded config as fallback). */
export function installedVersionCode(): number | null {
  return parseInstalledVersionCode(
    Constants.nativeBuildVersion,
    (Constants.expoConfig?.android as { versionCode?: number } | undefined)?.versionCode,
  );
}

export function installedVersionLabel(): string {
  return appVersionLabel({
    version: Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? null,
    build: installedVersionCode(),
  });
}
