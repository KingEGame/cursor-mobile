# Phase 5 — UI Review

**Audited:** 2026-10-16
**Baseline:** `05-UI-SPEC.md` (amendments A–G) + uncommitted 2026-10-16/17 chat-UX work in `apps/mobile/src`
**Screenshots:** not captured (Expo RN app; no dev server or device; nothing tested on a device). Code-only audit.
**Prior audit:** 2026-10-14, 11/24 (`05-UI-REVIEW.2026-10-14.md`).

Product locks still true: PC-local Hub, Tailscale+pair, CDP 127.0.0.1, phone is remote UI only, light calm grayscale.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 3/4 | Failure-reason catalog (`send-errors.ts`) is excellent and recovery-oriented; Approve/Deny visible labels and Home empty-state CTA still drift from the contract |
| 2. Visuals | 3/4 | Clear hierarchy in chat (delivery state, jump-to-latest, working bar, day dividers); focal-point and icon a11y mostly good; mode cards in the `+` sheet lack explicit a11y roles |
| 3. Color | 2/4 | 29 hardcoded hex values outside `theme.ts`; `theme.bubbleUser` is still `#e6f2ec` while HistoryRead hardcodes `#f0f1f3`; stale dark-green fills `#1a2e24` in a light theme; no dark mode |
| 4. Typography | 2/4 | 10 distinct font sizes (11–24) and weights 500/600/700 against a contract of 13/16/20/28 and 400/600 only |
| 5. Spacing | 2/4 | 48dp touch targets are now consistent; `theme.spacing` xs=6 / sm=10 still off the 4pt scale and 2xl/3xl are missing; raw `gap: 2/6` literals |
| 6. Experience Design | 3/4 | Strong state coverage (sending/sent/failed+Retry, stop confirm, live regions, keyboard fix, reduced-motion hook); gaps are polling-only freshness, Deny undo missing, motion barely used |

**Overall: 15/24** (was 11/24 on 2026-10-14)

---

## Top 3 Priority Fixes

1. **Typography and color tokens are bypassed** (WARNING) — operators see inconsistent sizes and a different user-bubble tint between Live chat and History chat. Add `type` and `colors` tokens (13/16/20/28, 400/600; `bubbleUser` `#f0f1f3`, `errorBg`, `warnBg`, `onAccent`) to `theme.ts` and replace the 29 literal hex values and 10 ad hoc sizes. Fix `#1a2e24` selected fills in `EditorScreen.tsx:294` and `FilePickerSheet.tsx:386,412` (dark-green rows with presumably light text in a light theme — verify contrast).
2. **Approval card diverges from the contract** (WARNING) — `ApprovalCard.tsx` shows **Approve** / **Deny** instead of **Approve tool** / **Deny tool**; Deny has no **Tool denied · Undo** snackbar (SPEC F4), and a single tap on an irreversible approval is the highest-stakes control in the app. Align labels, add the 3 s undo, keep 48dp targets.
3. **Freshness is poll-only and motion is minimal** (WARNING) — `HistoryReadScreen` re-reads every 4 s and the elapsed counter re-renders the whole screen every second (`setTick`, line 141), so replies and working state lag and the long transcript `ScrollView` re-renders. Subscribe to the Hub WS (as Home does), memoize message rows, and move the transcript to `FlatList` (as LiveChat already does). Use `useReducedMotion` for one or two meaningful transitions (new message, working bar) instead of only gating `scrollToEnd`.

Also fix: Home empty state needs a **New Chat** CTA; add dark-mode tokens (known gap, Deferred in SPEC F9).

---

## Remediation log (2026-10-17, after this audit; code-only, not device-tested)

| Finding | Status |
|---------|--------|
| Color: 29 hardcoded hex, bubbleUser mismatch, `#1a2e24` fills | Fixed: tokens in `theme.ts`, no hex literals left in `src/**/*.tsx`; warn darkened to `#8f6000` (5.0:1 on warnSoft) |
| Typography: 10 sizes, weights 500/700 | Fixed: 13/16/20/28 via `type`, weights `weight.regular/semibold`, `lineHeight` tokens |
| Spacing: xs=6/sm=10, no 2xl/3xl, raw literals | Fixed: 4/8/12/16/24/32/48/64 scale, small literals migrated |
| Approve/Deny labels, Deny undo | Fixed: "Approve tool"/"Deny tool", 3 s "Tool denied · Undo" (flushes if you leave) |
| Stop confirm vs SPEC | Removed: one tap |
| Poll-only + full re-render | Partly: memoized FlatList rows, own-clock working bar, stable message identity, slower idle poll, paused in background. Hub WS not used: the Hub has no event for Agents-chat transcripts |
| Empty-state CTAs | Fixed: Home "New Chat", chat "Open on PC" (new Hub route `POST /v1/agents/chats/:id/open`) |
| Waiting-approval dead end | Fixed: "Open on PC" button when approvals can't be listed |
| Stacked strips | Fixed: at most two status strips above the composer by priority |
| Competing tinted strips | Fixed: working bar neutral surface |
| Motion | Partly: CalmEnter on working bar, waiting box, outgoing bubbles, jump pill (reduced-motion aware) |
| Jargon in failure copy | Fixed: no commands or "CDP" in phone-facing catalog text |
| `+` sheet mode cards a11y | Fixed |
| **Dark mode** | **Open** (needs theme-wide `useColorScheme` pass) |
| Agent-identity blue, path pills (SPEC B) | Fixed: bold `#2563eb` "Cursor agent · time" heads each agent turn (4.7:1 on canvas); file/folder code spans render as monospace path pills, middle-truncated |
| Approve one tap, no unlock | Fixed per SPEC F6: "Require unlock to approve tools" (Account → Security), on by default, prompts only when the phone has fingerprint/PIN; Deny never asks; sending still needs no unlock |

---

## Detailed Findings

### Pillar 1: Copywriting (3/4)

Strengths
- `hub/send-errors.ts` maps about 30 Hub and client codes to one-line, recovery-oriented messages, each flagged `queueable` / `definitelyNotSent`. The "may arrive twice" case is surfaced (`HistoryReadScreen.tsx:458-460`, "Send again" vs "Retry"). This exceeds the contract.
- Pair/Account copy now carries the numbered PC to phone path (`AccountScreen.tsx:203` "Pair with Hub → Scan QR. Do not type that loopback URL"); Clear pairing uses `Alert.alert` (`AccountScreen.tsx:157`). Both 2026-10-14 blockers are fixed.
- Loading, empty and error strings are specific ("Loading this chat from your PC…", "Nothing here yet", "No agents running", "No matching chats").

Gaps
- WARNING: `ApprovalCard.tsx:63,78` visible labels are "Deny" / "Approve" (a11y labels are right). SPEC: "Approve tool" / "Deny tool".
- WARNING: History empty state ("Nothing here yet") and Home empty state lack the contract CTAs (**Open on PC** / **New Chat**); contract titles ("No messages in this chat", "No chats yet") only partly match (`ChatsHomeScreen.tsx:324`).
- WARNING: Stop uses a confirmation `Alert` ("Stop the agent?", `HistoryReadScreen.tsx:257`). SPEC F states "none — Stop is one tap" and "Stopped from phone" in the transcript. Defensible, but it contradicts the locked copy; either update the SPEC or remove the dialog.
- WARNING: Failure strings carry PC jargon ("CDP", "npm run start:cursor:cdp", `send-errors.ts` CDP_UNAVAILABLE). Fine for this operator, but a command line in a phone toast is rough.
- WARNING: Several error `Alert`/banner phrasings mix "Not sent —" and "Could not…" styles.

### Pillar 2: Visuals (3/4)

- Chat focal flow is clear: day dividers (`HistoryReadScreen.tsx:369`), flush assistant text vs gray user bubble, tool lines muted, delivery label under pending bubble, `failedBubble` danger border + filled Retry pill, jump-to-latest pill with unseen count ("3 new ↓"), working bar with elapsed and last tool step.
- Icon-only controls are labeled: composer `+` "Composer actions", model pill "Select model", Stop "Stop the agent", Home search/New Chat/Account, working chip announces count and filter action.
- WARNING: the error bar, waiting box and cursor alert all stack above the composer (`HistoryReadScreen.tsx:497-568`); with error + waiting + working + changes simultaneously, the stream loses vertical space on small phones. No cap or collapse.
- WARNING: `+` sheet mode cards (`ChatComposer.tsx:228`) have no `accessibilityRole`/label beyond child text; selection state is visual only.
- WARNING: waiting box uses `#fff4e0` and working bar `accentSoft` green wash; two different tinted full-width strips compete with the accent for attention.
- Agent identity blue (`#2563eb`), path pills and mode-chip tint colors from SPEC B were not found in this pass; Live chat remains a simplified take on the Cursor chrome.

### Pillar 3: Color (2/4)

- 29 hardcoded hex values in screens/components outside `theme.ts`: `#fdecea` (HistoryRead:598,616; UpdateScreen:361), `#fff4e0` (HistoryRead:646; ChatsHome:522), `#fff7e0`, `#5c3e00`, `#f7f8fa`/`#c5c9d0`/`#c4c8ce` (composer/update), `#e6f4ea`/`#0d5d2c`/`#fce8e6`/`#8c1d18` (diff lines), `#cfe6da` (UpdateCard), `#fff`/`#000` (QrScanner, jump/retry text).
- WARNING: `colors.bubbleUser` is `#e6f2ec` (green wash); `HistoryReadScreen.tsx:614` hardcodes `#f0f1f3` (matches SPEC). Live and History chat show different user bubbles. Not fixed since 2026-10-14.
- WARNING: `#1a2e24` (very dark green) as selected-row/chip fill in `EditorScreen.tsx:294` and `FilePickerSheet.tsx:386,412` is a leftover from a dark palette; it clashes with the `#f4f5f7` canvas and needs a contrast check against `text`.
- Accent use is mostly disciplined (Send, chip online, Approve, link/View changes). Working-bar fill and `statusDotLive` use accent as intended.
- Known gap: no dark mode (`app.json` `userInterfaceStyle: "light"`, static palette, no `useColorScheme`). SPEC defers it, but this is a phone used at night and a recorded gap.
- `warn` `#9a6700` on `#fff4e0` is about 4.6:1, passes AA for body text only barely.

### Pillar 4: Typography (2/4)

Contract: 13 / 16 / 20 / 28, weights 400 and 600.

| Size | Uses | | Weight | Uses |
|------|------|-|--------|------|
| 11 | 10 | | 400 | 2 |
| 12 | 42 | | 500 | 6 |
| 13 | 35 | | 600 | 48 |
| 14 | 22 | | 700 | 40 |
| 15 | 14 | | | |
| 16 | 24 | | | |
| 17 / 18 | 9 | | | |
| 22 / 24 | 8 | | | |

- 10 distinct sizes; 12 and 14 are the most common after 13/16, so the scale is effectively 11–24 with no discipline. 700 is used 40 times (Retry, jump pill, titles) against a 600-only contract.
- 11px text still exists (10 uses). Minimum should be 13 for operator-critical labels.
- The recent chat work consistently uses 14/700 for action text (`retryText`, `jumpText`) rather than tokens (`type.meta`/`type.body`).
- `type` in `theme.ts` lacks weight and line-height tokens, so screens cannot comply without literals.

### Pillar 5: Spacing (2/4)

- Good: touch targets are explicitly 48dp (`action`, `jump`, `changesBar`, `workingBar`, composer `touch48`, `modelPill`, sheet rows 52); Home rows 44-48. Exceeds the 44 minimum.
- Good: `HistoryReadScreen` and `LiveChatScreen` use `KeyboardAvoidingView behavior="padding"` with `keyboardVerticalOffset={headerHeight}` and bottom safe-area inset passed to the composer; the Android edge-to-edge keyboard fix is present in code (unverified on device).
- WARNING: `theme.spacing` is xs=6, sm=10, md=16, lg=24, xl=32; SPEC is 4/8/16/24/32/48/64. Not migrated. Most chat layout uses `xs`/`sm`, so the entire chat inherits the off-scale values.
- WARNING: raw literals `gap: 2` (8 uses), `gap: 6`, `marginTop: 2`, `paddingVertical: 10` bypass tokens.
- Stacked bars above the composer (see Visuals) use inconsistent padding (`spacing.md` vs `spacing.xs` vertical).

### Pillar 6: Experience Design (3/4)

State coverage (good)
- Delivery state machine with Retry/Discard and "definitely not sent" handling (`chat/outgoing.ts`, `HistoryReadScreen.tsx:438-473`); text is never lost on failed send; unlock-cancel keeps text.
- Stop confirmation, `stopping` state, "Stopping…" label, errors for stop/approve/deny/edit with reasons.
- Live regions (`polite` for working/loading/waiting, `assertive` for errors and failed delivery); haptics through `buzz`; `useReducedMotion` gates animated scroll.
- Loading, empty, error, offline banner (`cursorAlert`), unseen-new-messages counter, changes bar, Edit and resend.

Gaps
- WARNING: History chat refreshes via 4 s polling plus reconcile (`HistoryReadScreen.tsx:47,128`), not WS. A 1 s `setTick` re-renders the entire screen (including every `Markdown` message) while running.
- WARNING: whole transcript in a `ScrollView` with `.map` (no virtualization, no memoized row) — long chats will jank; LiveChat uses `FlatList`, so the two chat screens diverge.
- WARNING: Deny is irreversible with no Undo (SPEC F4); Approve is one tap with no unlock because `lockSend` is off by default.
- WARNING: motion is effectively absent: `useReducedMotion` is used only for `scrollToEnd`; `ActivityIndicator` is the only animation; no entrance or state transition for new messages or the working bar. Calm motion contract (G3) unmet beyond `CalmEnter` (`motion/calmEnter.tsx`) on other screens.
- WARNING: `waiting_approval` without loadable approvals tells the operator to "approve or deny it in Cursor on your PC" — honest, but a dead end on the phone.
- Not tested on a device: keyboard avoidance, edge-to-edge, 48dp targets, TalkBack announcement order, reduce-motion behavior are all code-verified only.
- Registry audit: skipped (`components.json` absent).

---

## Fixed since 2026-10-14

- PairScreen scroll and PC `/pair` discoverability (Hub console line, PC hero, phone steps card, Account How it works) — shipped earlier, still present.
- Clear pairing now confirms via `Alert`; CTA renamed **Pair with Hub**.
- `+` sheet wrapped in `ScrollView`.
- Delivery states, Retry, jump-to-latest, timestamps, working bar, changes bar, stop confirm, 48dp targets, live regions: new since the last audit.
- Typography, `theme.spacing` scale, and `bubbleUser` token: still open.

---

## Files Audited

- `.planning/phases/05-mobile-ux-contract/05-UI-SPEC.md`, `05-UI-REVIEW.2026-10-14.md`
- `apps/mobile/src/screens/HistoryReadScreen.tsx` (full), `LiveChatScreen.tsx`, `ChatsHomeScreen.tsx`, `AccountScreen.tsx` (targeted)
- `apps/mobile/src/composer/ChatComposer.tsx`
- `apps/mobile/src/components/ApprovalCard.tsx`, `QrScanner.tsx`, `FilePickerSheet.tsx`
- `apps/mobile/src/chat/{outgoing,feedback,format,useReducedMotion}.ts`
- `apps/mobile/src/hub/send-errors.ts`
- `apps/mobile/src/theme.ts`, `apps/mobile/App.tsx`, `apps/mobile/app.json`
- Repo-wide greps for font sizes/weights, hex literals, spacing literals, motion usage
