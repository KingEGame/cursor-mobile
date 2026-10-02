# Parallel Deep Research — Cursor mobile / remote IDE OSS

**Run ID:** `trun_6ff99558f49543c39d550c594ca493db`  
**Processor:** pro-fast  
**Raw metadata:** `research/cursor-mobile-remote-ide-oss.json`  
**Synthesized project report:** `docs/reports/oss-landscape-research-2026-09-24.md`

> **Project decision:** PC-local only — no cloud mode. APK must list/use all sessions already on this PC. Cloud Agents / Remote Control below are **landscape only**, not active scope. See `docs/architecture/AGENT-CONTEXT.md` · `docs/architecture/mobile-cursor-companion.md`.

## Executive summary (from Parallel)

- **Best Open-Source Companion**: [Paseo](https://github.com/getpaseo/paseo) — iOS/Android/web/desktop/CLI + local agent daemon (~18.4k★, Apache-2.0). Strong for *agent* sessions, not verified Cursor Composer import.
- **Best Terminal Handoff**: [Happy](https://github.com/slopus/happy) — start/steer/approve Claude Code or Codex from phone/web with E2E encrypted sessions (~23.8k★).
- **Cursor official route (out of scope for this product):** Cursor for iOS + Remote Control — cloud agent loop with desktop worker; competitive context only.
- **Hard gap**: Local Cursor IDE Composer chats. [CursorRemote](https://github.com/len5ky/cursorremote) (CDP/DOM relay) + [cursor-session](https://github.com/iksnae/cursor-session) (export) — no supported two-way sync API for arbitrary historical chats.
- **Remote editing ≠ sessions**: code-server / OpenVSCode / VS Code Tunnels for files/terminals; pair with an agent companion for prompts/approvals.
- **Keep host private**: Tailscale/SSH; WebSocket relay for events; Cursor self-hosted worker uses outbound HTTPS (no inbound port).
- **Ship a signed APK**: Expo EAS `android.buildType: "apk"`, Flutter `flutter build apk`, RN/Capacitor/Kotlin release signing — do not confuse AAB with sideload APK.

## Also notable

- [omg.dev](https://github.com/BennyKok/omg.dev) (MIT) — multi-agent harness; lists Cursor among agents — verify adapter depth.
- Claude Code Monitor — WebSocket status + token auth pattern.

## Synthesis (product implication)

Lowest-risk build: **private network + host-owned agent sessions + mobile companion APK + optional browser editor**, with explicit limits on imported Cursor chat history. The valuable gap is not VNC — it is clear session identity, transcript, and approvals on the phone.
