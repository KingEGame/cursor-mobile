# Handoff — Phase 1 selector pack (VERIFIED vs CANDIDATE)

**Date:** 2026-09-25  
**Phase focus:** 1  
**Locks check:** PC-local only · open-project remote · CDP `127.0.0.1` only · Tailscale + pairing · Expo APK · **no fake DOM success**

## Done

- Versioned selector pack `cursor-ui@2026.09-candidate` (`2026.09.0-candidate`) with **per-action** `VERIFIED` | `CANDIDATE` flags for:
  - `send_message` · `approve` · `deny` · `model_select` · `file_attach`
- Candidate CSS/ARIA strategies borrowed from [CursorRemote `selectors.json`](https://github.com/len5ky/CursorRemote) patterns — **all still CANDIDATE** (not live-proven).
- Adapter mutations fail closed unless the specific action is `VERIFIED` (or `LIVE_SELECTOR_PACK_READY` ops override).
- Record/replay: synthetic fixtures + `recordFixture` / `replayPackFixtures` hooks (TOR-06).
- Optional loopback CDP probe test (`LIVE_CDP_PROBE` or auto when `:9222` up) — this env had **no CDP**; probe skipped honestly.
- Operator procedure documented in [`docs/CONFIGURATION.md`](../CONFIGURATION.md) § Marking a selector pack VERIFIED.

### Verification status (honest)

| Action | Flag | Notes |
|--------|------|-------|
| `send_message` | **CANDIDATE** | Not verified against live Cursor DOM |
| `approve` | **CANDIDATE** | Same |
| `deny` | **CANDIDATE** | Same |
| `model_select` | **CANDIDATE** | Same |
| `file_attach` | **CANDIDATE** | Same |
| Pack overall | **unverified** | → `extractor_stale`; mutations blocked |

**Nothing became VERIFIED this turn.** Synthetic fixture replay ≠ live UI verification.

## Files

| Path | Change |
|------|--------|
| `packages/adapters/live-cursor/src/selector-pack.ts` | Versioned pack + per-action flags |
| `packages/adapters/live-cursor/src/selector-match.ts` | Lightweight strategy matcher for fixtures |
| `packages/adapters/live-cursor/src/record-replay.ts` | Record/replay hooks |
| `packages/adapters/live-cursor/src/adapter.ts` | Per-action fail-closed gates |
| `packages/adapters/live-cursor/src/selector-pack.test.ts` | Unit + replay tests |
| `packages/adapters/live-cursor/src/cdp-probe.test.ts` | Optional live CDP probe |
| `packages/adapters/live-cursor/src/adapter.test.ts` | Fail-closed on CANDIDATE pack |
| `packages/adapters/live-cursor/src/index.ts` | Exports |
| `packages/adapters/live-cursor/fixtures/selector-pack/*` | Synthetic fixtures + manifest |
| `docs/CONFIGURATION.md` · `.env.example` | Operator verify steps + `LIVE_CDP_PROBE` |
| `docs/architecture/AGENT-CONTEXT.md` · `TOR-06` · hub README | Status honesty |
| `docs/reports/handoff-phase1-selector-pack.md` | This handoff |

## How to manually verify (operator)

1. Cursor with CDP on **`127.0.0.1` only** (never `0.0.0.0` / Tailscale-forward CDP).
2. Optional: `LIVE_CDP_PROBE=1 npm test -w @cursor-mobile/live-cursor` → expect `extractor_stale` while CANDIDATE.
3. For each action: confirm a strategy hits live DOM (DevTools) → exercise control on PC → in `selector-pack.ts` set `verification: "VERIFIED"`, `verifiedAt`, `verifiedAgainst`.
4. Replace synthetic fixtures with CDP-recorded snippets when strategies change.
5. Do **not** rely on `LIVE_SELECTOR_PACK_READY=true` in committed defaults — that override is ops smoke only and does not prove DOM match.
6. Pack `verified: true` / Hub `cdp_ok` only after **all five** actions are VERIFIED.

Full steps: [`docs/CONFIGURATION.md`](../CONFIGURATION.md) § Marking a selector pack VERIFIED.

## How to test

```bash
cd /data/projects/cursor_mobile
npm test -w @cursor-mobile/live-cursor
# Optional live attach (loopback Cursor only):
LIVE_CDP_PROBE=1 npm test -w @cursor-mobile/live-cursor
```

## Open gaps

- **No action VERIFIED on live Cursor** — still blocks send / approve / deny / model / @file DOM drive
- CDP WebSocket `Runtime.evaluate` matcher against live DOM (probe today is HTTP attach + health only)
- ~~Wire real click/type executor once flags flip~~ — see [`handoff-phase1-cdp-input.md`](./handoff-phase1-cdp-input.md) (executor gated; pack still CANDIDATE)
- Hub attachments / model list still DESIGNED stubs alongside pack
- TOR-08 UAT / APK mesh still pending (R8 / R4)

## Next agent

- **Role:** **R6 Live Adapter Engineer** (continue)
- **Next action:** With Cursor CDP on loopback, record real fixtures → mark actions VERIFIED one-by-one → smoke CDP Input executor on metal

## Do not

- Claim live E2E or flip VERIFIED without manual Cursor UI proof
- Expose CDP beyond `127.0.0.1`
- Treat `LIVE_SELECTOR_PACK_READY` or synthetic fixtures as verification

## Product locks still true?

Yes — PC-local · open-project remote · continue/create with PC tools · Tailscale+pair · CDP localhost · Expo APK · docs ≠ full live DOM.
