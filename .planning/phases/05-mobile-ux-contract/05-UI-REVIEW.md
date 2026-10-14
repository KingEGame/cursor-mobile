# Phase 5 — UI Review

**Audited:** 2026-10-14  
**Baseline:** `05-UI-SPEC.md` (amendments A–G) + implemented Expo RN + Hub pair page  
**Phase status:** UI-SPEC **approved** (checker); G P0 metal remediated same day (see below)  
**Screenshots:** Hub `/pair` re-captured after Hub restart — hero “You are on the PC — keep this page open here”. Mobile APK not re-sideloaded this turn.  
**Prior review:** Fresh **gsd-ui-auditor** 6-pillar pass; scores below are **pre-remediation**.

**Product locks still true:** PC-local Hub · Tailscale+pair · CDP `127.0.0.1` · phone remote UI · light calm grayscale (not OLED).

### Remediation (2026-10-14, post-audit)

| Blocker | Fix |
|---------|-----|
| PairScreen no scroll | `ScrollView` + safe-area + steps card; drop center-only flex |
| PC `/pair` undiscoverable | Hub CLI `PAIR PHONE → http://127.0.0.1:8787/pair`; PC hero; phone steps; Account How it works |
| Zero motion / unpair | `CalmEnter` (Reduce Motion aware); Clear pairing `Alert` confirm; `+` sheet `ScrollView` |

Remaining non-P0 from audit: typography scale drift, bubble color vs SPEC, Filter a11y, broader motion table.

---

## Pillar Scores (pre-remediation audit)

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 2/4 | Pair URL / “how to open QR” buried; Clear pairing has no confirm; CTA labels drift from contract |
| 2. Visuals | 2/4 | Scan QR is a solid focal point, but 11px hint + centered clip kills hierarchy on small phones |
| 3. Color | 3/4 | Light calm tokens mostly match; user bubble is green-tinted `#e6f2ec` vs SPEC `#f0f1f3` |
| 4. Typography | 2/4 | 11 distinct sizes + weight 700/500; SPEC locks 4 sizes / 400+600 only |
| 5. Spacing | 1/4 | **BLOCKER:** PairScreen has no ScrollView (`flex:1` + `justifyContent:'center'`) — clips under keyboard |
| 6. Experience Design | 1/4 | **BLOCKER:** zero Animated/Reanimated; Hub CLI never prints `/pair` URL; destructive unpair is one tap |

**Overall (pre-fix): 11/24**

---

## Top 3 Priority Fixes (addressed)

1. **PairScreen missing ScrollView** — ~~clips~~ → ScrollView + steps card shipped.
2. **Pairing URL undiscoverable** — ~~buried~~ → Hub console + PC hero + phone steps + Account copy.
3. **Zero motion** — ~~none~~ → `CalmEnter` + Reduce Motion; fuller Motion Notes table still open.

---

## Severity-ranked defect tracks (user-reported)

### A. SCROLL / overflow — BLOCKER

| Surface | Evidence | Verdict |
|---------|----------|---------|
| **PairScreen** | `KeyboardAvoidingView` → `View style={styles.content}` with `flex:1`, `justifyContent:'center'`, **no** `ScrollView` (`PairScreen.tsx` ~266–270, styles ~419–424) | **BLOCKER** — confirmed clip risk with Tailscale guide + 4 inputs + keyboard |
| AccountScreen | `ScrollView` + RefreshControl | Pass |
| HealthScreen | `ScrollView` | Pass |
| ChatsHomeScreen | `FlatList` | Pass |
| LiveChat / History | `FlatList` / `ScrollView` | Pass |
| NewSession / Update / Editor / ChatChanges | Scroll/list present | Pass |
| HomeScreen | Shim → Main (`return null`) | N/A |
| **ChatComposer `+` sheet** | `Modal` content is a plain `Pressable`/`View` — **no** `ScrollView` (`ChatComposer.tsx` ~210–240); modes grid + 5 rows | **WARNING** — overflows short viewports |
| Model sheet | `ScrollView` `maxHeight:420` | Pass |
| FilePickerSheet | ScrollView/FlatList | Pass |
| QrScanner | Full-screen Modal (camera) | Pass (not a form) |

### B. PAIRING URL DISCOVERABILITY — BLOCKER (operator path)

| Surface | What exists | Gap |
|---------|-------------|-----|
| Hub `GET /pair` | Live at `http://127.0.0.1:8787/pair`; QR + code + Tailscale host; light calm chrome | Page assumes you already found it. Copy says “On the phone…” but never “You opened this on the PC that runs Hub.” Narrow viewport shows card scrollbars / meta clip. |
| Hub CLI (`cli.ts`) | Logs listen host, CDP, workspace, dataDir, API routes | **Never** prints `http://127.0.0.1:{port}/pair`. Routes line lists `POST /v1/pair/*` only — not the operator QR page. |
| PairScreen body | “Hub must be running on the PC…” | Does not say *open the pair page in a PC browser*. |
| PairScreen hint | `fontSize: 11` — “On the PC open http://127.0.0.1:8787/pair …” | Correct URL, **wrong hierarchy** (smallest type on screen). |
| Account “How it works” | Mentions `127.0.0.1:8787/pair` + Scan QR | Better than Pair body, but still secondary meta; CTA is **Pair a PC** not SPEC **Pair with Hub**. |
| UI-SPEC Account copy | “On the PC, show the Hub pairing QR…” | Implemented drift + no numbered PC→phone steps. |

### C. ANIMATION / OPTIMIZATION — WARNING → contract miss

| Check | Result |
|-------|--------|
| `Animated` / Reanimated imports in `apps/mobile` | **0 files** |
| package.json motion deps | **none** |
| `AccessibilityInfo.isReduceMotionEnabled` / Haptics | **none** |
| UI-SPEC Motion Notes (pair success, sheet, chip, approval, Working strip…) | Unimplemented — OS modal slide only |
| FlatList virtualization knobs (`getItemLayout`, `windowSize`, `initialNumToRender`, `removeClippedSubviews`) | Mostly absent (keyExtractor present) |
| ChatsHome 15s poll + WS + focus refresh | Correct for parity; jank risk if list grows without virtualization tuning / without memoized rows |

---

## Detailed Findings

### Pillar 1: Copywriting (2/4)

**WARNING — Pair primary/fallback CTAs drift from contract**

- SPEC: primary **Scan QR**, fallback **Pair with Hub**.
- Code: Scan QR ✓; submit button label **Pair** (`PairScreen.tsx` ~386); Account CTA **Pair a PC** (`AccountScreen.tsx` ~189).

**WARNING — Destructive Clear pairing skips confirm**

- SPEC: “Clear pairing: Remove this phone’s trust…?”
- Code: `unpair` → `clearDevice()` immediately (`AccountScreen.tsx` ~155–157, ~255). No `Alert.alert`.

**WARNING — Approve / Deny visible labels shortened**

- a11y: “Approve tool” / “Deny tool” ✓  
- Visible: **Approve** / **Deny** (`ApprovalCard.tsx` ~63, ~78) — fails Copywriting Contract table.

**WARNING — Empty Home body vs SPEC**

- SPEC: “Start a new chat to continue in the project open on your PC.”
- Code: “Open Cursor on the PC and start a chat in the Agents window.” (`ChatsHomeScreen.tsx` ~305) — honest but not contract-aligned; misses New Chat CTA in empty state.

**BLOCKER (discoverability copy) — PC path under-taught**

- Phone Pair hint at 11px is the only front-door URL instruction.
- Hub startup silence means operators who never open `/pair` never see a QR.

**Pass notes:** Tailwind/generic “Submit / Click Here / OK” not used as primary CTAs. Mesh/Hub/Cursor error paths generally recovery-oriented. Light/PC-local framing present (“No cloud login”).

---

### Pillar 2: Visuals (2/4)

**Pass:** Pair **Scan QR** is a clear primary anchor (accent pill, icon + label). Account uses Settings-style cards. Home has New Chat row + Search (Amendment A direction). Hub pair page QR is a strong focal point; light calm matches product lock.

**WARNING — Pair hierarchy collapse**

- Critical URL lives in `styles.hint` (11px muted) while title is 24/700 — eye misses the operator step.
- `justifyContent: 'center'` visually centers a tall form; when clipped, top title/Scan QR can leave viewport first or last depending on keyboard — no reliable scroll affordance.

**WARNING — Home IA vs Amendment A**

- New Chat + Search + project groups exist; SPEC labels **Projects** / **Repositories** + profile footer not fully matched (tree is project-centric Agents list). Acceptable progress, not contract-complete.

**WARNING — Composer `+` sheet density**

- Mode cards + five rows without internal scroll — secondary overflow risk.

**a11y:** Scan QR, Search chats, Refresh from computer, Choose computer, Composer model pill labeled. Composer **+** should keep `accessibilityLabel="Composer actions"` (verify on implement polish).

---

### Pillar 3: Color (3/4)

**Pass:** Dominant `#f4f5f7`, surfaces white/`#eef0f3`, accent `#1e6b4a`, danger/warn match SPEC. Hub pair page uses the same palette. Not OLED / not purple-glow.

**WARNING — User bubble tint**

- SPEC bubble user: `#f0f1f3`  
- `theme.bubbleUser`: `#e6f2ec` (green wash) — used by LiveChat  
- HistoryRead hardcodes `#f0f1f3` — **inconsistent** across chats

**WARNING — Hardcoded hex still in screens** (e.g. QrScanner `#000`, HistoryRead bubble) — SPEC build practice: tokens via `theme.ts`.

Accent reservation mostly respected (CTAs, chip, Approve). Score 3: contract substantially met for brand direction; bubble + token leakage keep it off 4.

---

### Pillar 4: Typography (2/4)

**SPEC:** 13 / 16 / 20 / 28 · weights **400** and **600** only.

**Implemented (91 UI modules scanned):**

| Size px | Occurrences (approx) |
|---------|----------------------|
| 11 | 13 |
| 12 | 46 |
| 13 | 32 |
| 14 | 16 |
| 15 | 14 |
| 16 | 24 |
| 17–18 | 8 |
| 20 | 1 |
| 22–24 | 9 |

Weights include **500** and **700** widely (Pair Scan CTA 700, titles 700). Display 28 exists via `type.title` on Account; Pair title uses 24/700 outside scale.

**WARNING:** Pair URL hint at **11px** is both type and hierarchy failure.

---

### Pillar 5: Spacing (1/4)

**BLOCKER — PairScreen layout model**

```419:424:apps/mobile/src/screens/PairScreen.tsx
  content: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.sm,
    justifyContent: 'center',
  },
```

No scroll container. Android `KeyboardAvoidingView` `behavior` is `undefined` — keyboard covers fields.

**WARNING — Theme scale still pre-migration**

- SPEC: 4 / 8 / 16 / 24 / 32 / 48 / 64  
- `theme.spacing`: xs=**6**, sm=**10**, md=16, lg=24, xl=32 — no 2xl/3xl

**WARNING — Plus sheet** without vertical scroll (see track A).

Account/Home/Health spacing is usable; Pair alone justifies score **1**.

---

### Pillar 6: Experience Design (1/4)

**BLOCKER — Motion stack empty**

- UI-SPEC Motion Notes + stack lock (`Animated` / Reanimated) unmet.  
- No reduce-motion path. F9 haptics absent.

**BLOCKER — Pairing operator loop incomplete without docs tribal knowledge**

- Page works if discovered; Hub does not advertise it at boot; phone under-emphasizes it → users fail before Scan QR.

**WARNING — Clear pairing one-shot**

- Accidental tap unpairs with no undo snackbar / confirm.

**WARNING — Jank / re-render risks**

- ChatsHome: focus + WS + **15s poll** (`POLL_MS`) — fine for metal, but list rows should stay memoized; missing FlatList window tuning as session count grows.  
- AccountScreen comment documents prior refresh/WS loop (fixed) — keep that discipline.

**Pass notes:** Loading spinners on Pair/Account/Home; offline/connection chip paths; Refresh now present; fail-closed empty models direction exists elsewhere; QrScanner modal implemented (SPEC “camera planned” is now partly shipped — update inventory later).

Registry audit: **skipped** — `components.json` absent; UI-SPEC Registry Safety = none.

---

## Actionable fix list (ordered)

| # | Severity | Fix |
|---|----------|-----|
| 1 | BLOCKER | PairScreen: `ScrollView` + top-aligned content; Android keyboard vertical offset; keep Scan QR above the fold without centering the whole form |
| 2 | BLOCKER | Hub `cli.ts`: on listen, log `Pair QR page (PC only): http://127.0.0.1:${port}/pair` |
| 3 | BLOCKER | Pair + Account copy: numbered **PC:** open `/pair` → **Phone:** Scan QR; promote off 11px hint |
| 4 | BLOCKER | Clear pairing: `Alert.alert` with SPEC destructive copy before `clearDevice` |
| 5 | WARNING | ChatComposer `+` Modal: wrap sheet body in `ScrollView` |
| 6 | WARNING | Align CTAs: **Pair with Hub**, **Approve tool** / **Deny tool** visible labels |
| 7 | WARNING | `theme.bubbleUser` → `#f0f1f3`; remove Live/History bubble mismatch |
| 8 | WARNING | Migrate `theme.spacing` to 4pt scale; Pair/Account consume tokens only |
| 9 | WARNING | Introduce minimal `Animated` for pair success + sheet open; honor reduce-motion |
| 10 | WARNING | FlatList: `initialNumToRender` / memoized `ChatListRow`; avoid full-tree re-render on 15s poll |

---

## Screenshots

| File | Notes |
|------|-------|
| `.planning/ui-reviews/05-20261014-034149/hub-pair-desktop.png` | PC pair page — QR + code + light calm (gitignored binaries) |
| `.planning/ui-reviews/05-20261014-034149/hub-pair-narrow.png` | Narrow viewport — card scrollbars / meta clipping |

Mobile screens: **code-only** (no Expo Metro / device bridge in this audit turn).

---

## Files Audited

- `.planning/phases/05-mobile-ux-contract/05-UI-SPEC.md`
- `.planning/phases/05-mobile-ux-contract/05-UI-REVIEW.md` (prior checker — superseded by this audit)
- `apps/mobile/src/screens/PairScreen.tsx`
- `apps/mobile/src/screens/AccountScreen.tsx`
- `apps/mobile/src/screens/ChatsHomeScreen.tsx`
- `apps/mobile/src/screens/HomeScreen.tsx` (shim)
- `apps/mobile/src/screens/HealthScreen.tsx` (scroll presence)
- `apps/mobile/src/screens/LiveChatScreen.tsx` / `HistoryReadScreen.tsx` (bubble + list)
- `apps/mobile/src/composer/ChatComposer.tsx` (sheets)
- `apps/mobile/src/components/ApprovalCard.tsx`, `FilePickerSheet.tsx`, `QrScanner.tsx`
- `apps/mobile/src/theme.ts`
- `packages/hub/src/pair-page.ts`
- `packages/hub/src/cli.ts`
- Scan: all `apps/mobile/src/screens/*.tsx` for ScrollView/FlatList; repo-wide Animated/Reanimated = none

---

## Note on prior checker review

The previous `05-UI-REVIEW.md` content was a **UI-SPEC checker** FLAG (docs/contract quality, amendments A–F). That historical verdict remains true for *plan* readiness; this document replaces it as the **implementation visual audit**. Re-run gsd-ui-checker separately if the contract text changes again.
