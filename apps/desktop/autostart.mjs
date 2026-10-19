/** Start the Hub at login. Windows/macOS use Electron login items; Linux needs an XDG autostart entry. */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HIDDEN_ARG = "--hidden";

export function desktopEntry(execPath) {
  return `[Desktop Entry]
Type=Application
Name=Cursor Mobile Hub
Exec="${execPath}" ${HIDDEN_ARG}
X-GNOME-Autostart-enabled=true
Terminal=false
`;
}

const linuxFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "cursor-mobile-hub.desktop");

export function getAutostart(app) {
  if (process.platform === "linux") return existsSync(linuxFile());
  return app.getLoginItemSettings().openAtLogin;
}

export function setAutostart(app, enabled) {
  if (process.platform === "linux") {
    const f = linuxFile();
    if (!enabled) return rmSync(f, { force: true });
    mkdirSync(join(f, ".."), { recursive: true });
    // Packaged AppImage: execPath is a temporary mount, the real file is $APPIMAGE.
    return writeFileSync(f, desktopEntry(process.env.APPIMAGE || process.execPath));
  }
  // Portable Windows exe runs from a temp dir; the real file is PORTABLE_EXECUTABLE_FILE.
  const path = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: enabled, path, args: [HIDDEN_ARG] });
}
