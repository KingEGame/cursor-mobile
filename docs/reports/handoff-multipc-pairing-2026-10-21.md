# Handoff — multi-PC pairing, QR/OTP fixes, app optimization (2026-10-21)

**Product locks still true:** PC-local Hub · open-project remote · Tailscale + pairing · CDP `127.0.0.1` only · Expo APK is remote UI only · docs ≠ code.

## The problem

The Hub journal showed `POST /v1/pair/complete -> 400 PAIR_CODE_INVALID` from a second phone (Samsung, `100.99.189.101`) on 2026-10-18 with **no** `GET /pair` from this Hub process before it: the code had been issued by another Hub process (laptop Hub or the AppImage shell) and the phone sent it here. Two things made that easy:

1. The phone replaced a loopback QR host (`127.0.0.1`, i.e. the issuing PC found no Tailscale address) with the **previously paired PC's URL**, so a code from PC A was silently posted to PC B.
2. Every Hub called itself "Desk PC", so Account → Computer could not tell two PCs apart, and the error said only "Unknown or mismatched pair code".

## Done

### Hub (`packages/hub`)
- `hubDisplayName` defaults to the **short hostname**; new `hubId` (sha256 of hostname + data dir, 12 hex) in config.
- `GET /v1/health` → `hub.displayName`, `hub.hubId`; `pair/complete` → `hub.hubId`; QR payload gains `name=` and `hub=`.
- `PairingStore.lookupPending()` explains misses (`unknown_pair` / `code_mismatch` / `unknown_code`); `PAIR_CODE_INVALID` message names the PC and the likely cause; `details.reason` for clients. Expired codes are swept 10 min after expiry (`sweepExpired`).
- New `PairAttemptLimiter`: 8 wrong codes per caller address per 10 min → `429 RATE_LIMITED` (`bucket: pair`, `Retry-After`). Success clears the caller.
- PC pair page (`/pair`): shows the PC name, a "Type it on the phone instead" block with address + code, a warning when no Tailscale address was found, and detects "Hub restarted" (`status: unknown`) and "Hub not responding" instead of polling forever.
- Desktop shell (`apps/desktop/main.mjs`) defaults `HUB_DISPLAY_NAME` to the hostname.
- Tests: `tests/phase4/pair-multipc.test.ts` (12) — suite 138/138.

### Phone (`apps/mobile`)
- **Pair screen** rewritten: Back when opened from Account, 3-step card, Scan QR, **Saved computers** (switch without scanning after an authenticated probe), Tailscale steps and manual entry collapsed. A loopback QR host is a clear error, never swapped for the old PC. Manual entry asks for the PC address from that PC's pair page (saved PCs are one-tap chips) and never prefills the old PC. Errors go through `hub/pair-errors.ts`.
- **Account → Computer**: live reachability per saved PC (Online / Unreachable / Needs re-pair / Not a Hub), switch only when that PC answers, **×** Forget, **Add another PC**.
- `storage/known-hubs-core.ts`: entries matched by `hubId` when known (address changes keep one entry), serialized list kept under the 2048-byte secure-store limit (`fitKnownHubs`).
- `storage/hub-switch-core.ts` (+ app wrapper): probe / switch / failure text, unit-tested.
- Session carries `hubId`; deep links accept `name` / `hub`.
- **Chats home**: timer polls only while the app is in the foreground and only re-read the chat list; foregrounding does one full refresh (less Hub load, less battery).
- Release APK: R8 minify + resource shrinking via `expo-build-properties` (`enableProguardInReleaseBuilds` → `android.enableMinifyInReleaseBuilds`, `enableShrinkResourcesInReleaseBuilds`).
- Tests: 170/170 (`npm run test:mobile`, includes typecheck). Version bumped to **0.1.8** (app.json + desktop package.json).

### Docs
`docs/features/phone-apk-screens.md` (Pair, Account → Computer), `docs/reports/tor/TOR-03-hub-and-api-specification.md` (pair/complete response + errors), `docs/CONFIGURATION.md`, `packages/hub/README.md`, `AGENTS.md` learned facts.

## Verified on device (Pixel 7, app 0.1.6 against the rebuilt Hub)
- Stale QR (`pairId` from "another PC") → `400 PAIR_CODE_INVALID` with the new explanation (`journalctl`: `from 100.121.1.117`).
- Fresh code from `POST /v1/pair/start` → `201`, phone lands on Health, `healthy`, 8 devices paired.
- Local Hub restarted: `/v1/health` reports `displayName: KINGWARPC`, `hubId: 6ebbfca4e190`; `/pair` shows the manual address `100.108.160.99:8787`.

## Verified on device (Pixel 7, local 0.1.8 release build, R8-minified)
- App boots, Chats lists 40 chats from **KINGWARPC** (name from the Hub, no longer "Desk PC").
- Account → Computer: KINGWARPC · green dot · "Online · http://100.108.160.99:8787" · ✓ selected · **Add another PC**; app shows v0.1.8 (108).
- Account → Add another PC → Pair: Back, 3-step card, Scan QR, **Saved computers** (KINGWARPC · current), Tailscale and manual entry collapsed.
- Local universal release APK (4 ABIs) is ~104 MB; the signed CI artifact for `v0.1.8` is built on node1 (run 39549730373).

## Open gaps
- Cross-PC switch (Pixel ↔ Windows laptop Hub) not exercised in this turn: the laptop was offline on the tailnet. The Samsung phone has not been re-paired yet.
- Pair page codes still live in memory only; a Hub restart invalidates them by design (now explained to the operator).
- Dark mode remains deferred (UI-SPEC F9).

## Next agent
R6 (mobile) to run the signed 0.1.8 build on both phones (Pixel + Samsung) against both Hubs (this PC + Windows laptop) and confirm Account → Computer switching across PCs.
