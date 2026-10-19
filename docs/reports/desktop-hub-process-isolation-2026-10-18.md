# Desktop Hub process isolation — 2026-10-18

**Done**
- The Hub no longer runs in Electron's main process. `apps/desktop/main.mjs` forks `hub-child.mjs` (`child_process.fork`, `execPath = process.execPath`, `ELECTRON_RUN_AS_NODE=1`, IPC channel) which loads `vendor/hub-bundle.mjs` (dev fallback `@cursor-mobile/hub`).
- `apps/desktop/hub-supervisor.mjs` (no Electron imports): `backoffDelay` (1s, 2s, 4s … cap 30s), `reduceStatus`/`labelFor` (status mapping), `createSupervisor` (spawn, restart with backoff, 20s startup timeout, failure streak reset after 60s stable, stale-child event guard, `stop()`, `requestRefresh()`).
- Window/tray show `Starting…` / `Hub restarting (attempt N)…` / `Running` / `Stopped` from `status.stateLabel`; last-known endpoints stay visible while restarting. Tray tooltip follows the label. Hide-on-close + tray behaviour is unchanged.
- First status does not wait for CDP: child sends `ready` right after `listen()`, then a separate `live` message from a CDP probe capped at 4s (re-probed every 15s and on Refresh). A hung probe yields `liveState: unknown` + error, never a delayed first status.
- Child exits if the parent disconnects (no orphan Hub on the port); `shutdown` message with a 3s SIGKILL fallback.
- Tests: `apps/desktop/hub-supervisor.test.mjs` (17, fake clock/child), wired into `scripts/release-gate.sh` as `test:desktop-supervisor`.

**Verified here:** supervisor tests; `node --check` on main/child; `hub-child.mjs` forked under plain Node against the real `vendor/hub-bundle.mjs` (ready ~330 ms, `live` = `cursor_down` with unreachable CDP, clean exit on `shutdown`).

**NOT verified (no Electron binary here):** launching the GUI; `fork(process.execPath)` with `ELECTRON_RUN_AS_NODE` inside the packaged asar on Windows/macOS/AppImage (asar import of the bundle from the child, and that electron-builder leaves the RunAsNode fuse enabled — its default); tray tooltip updates; renderer `warn` styling. Smoke test on each OS before release.

**Open gaps:** a Hub that is alive but event-loop-blocked is not killed (no heartbeat) — blocked work is slow, not dead; add a heartbeat only if it proves needed. `stdio` is inherited, so child logs go to the parent's console only.

**Next agent:** release/desktop owner — run packaged build per OS. Versions not bumped, no tags pushed. Product locks still true: yes (Hub + CDP on the operator PC, CDP 127.0.0.1).

## Addendum — self-update, no-tray fallback, live Tailscale (2026-10-18)

**Done:** `apps/desktop/updater.mjs` (+ 6 tests, in `test:desktop-supervisor`): GitHub Releases latest → asset per OS/arch → `.part` download with size check → swap. Window shows Version / Update row with "Check for updates" → "Update to vX"; auto-check on start. Windows portable: detached PowerShell waits for exit, moves the exe over `PORTABLE_EXECUTABLE_FILE`, relaunches. Linux: rename over `$APPIMAGE`, relaunch. macOS/dev: file revealed (unsigned zip, manual). Window close without a tray minimizes instead of hiding; unresponsive/crashed renderer reloads; hardware acceleration off. Child re-detects Tailscale every 15 s so a late-starting Tailscale shows up. Windows-only "Allow phone access (firewall)" button adds an inbound TCP rule for the Hub port (UAC).
**NOT verified:** any Electron GUI run, the real swap on Windows/AppImage, the firewall button (no Electron/Windows here).
**Open gaps:** likely remaining cause of "phone can't reach the Windows Hub" is Windows Firewall, not detection — confirm by pressing the new button. Binaries are unsigned; update trust is GitHub TLS only (no checksum in releases).
**Next agent:** release/desktop owner — bump version, tag, smoke-test each OS. Locks still true: yes.

## Addendum 2 — reliability pass (0.1.5)

**Done:** file log (`<hub-data>/logs/hub.log`, 1 MB × 3 rotation, tray "Open log folder"); heartbeat (3 missed `/health` pings → restart); "Why can't my phone connect?" diagnostics (Hub, Tailscale address, reachability on the mesh address, CDP, Windows firewall hint); update checksum verification against the release `SHA256SUMS.txt` (refuses unlisted/mismatched files); swap scripts keep `.bak` and roll back if the new build does not write `updates/ok` within 45 s; start-with-system (Win/mac login item, Linux XDG autostart, launched `--hidden`); update notification; dark theme + RU strings; `--disable-gpu`; `scripts/bump-version.mjs`; `scripts/smoke-desktop.mjs` wired into the Linux CI job.
**Verified here:** 35 desktop tests; the real packaged 0.1.4-layout AppImage built on this PC launched, answered `/v1/health`, wrote its log and stayed up 6 s (GPU "Goodbye" lines appear only at teardown).
**NOT verified:** Windows (exe, swap/rollback script, firewall button, login item), macOS, the update flow end to end (needs a published newer release).
**Not done:** phone-side "Hub update available" notice; Phase 5 mobile screens (await approve→build).
