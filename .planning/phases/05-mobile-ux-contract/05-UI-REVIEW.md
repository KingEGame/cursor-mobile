# Phase 5 — UI-SPEC Checker Review

**Contract:** `.planning/phases/05-mobile-ux-contract/05-UI-SPEC.md`  
**Reviewed:** 2026-10-01  
**Checker:** gsd-ui-checker (7 quality dimensions)  
**Product alignment:** `docs/features/phone-apk-screens.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `AGENTS.md` / `docs/architecture/AGENT-CONTEXT.md`

---

## Amendment — Home IA post-approval (2026-10-01)

**Status: FLAG** — prior APPROVED remains historically valid for token/copy dimensions, but **Screen 1 / Chats home IA changed** after checker sign-off. UI-SPEC frontmatter reset to `status: draft`. **Re-run gsd-ui-checker** before treating the contract as approved again.

| Change | Impact |
|--------|--------|
| Home = Cursor sidebar-inspired full-width layout | Dimension 2 Visuals / Screen inventory / nav map stale vs prior Gemini flat list + FAB |
| New Chat top row + Search + Projects + Repositories tree + profile footer | Copywriting + empty states + component inventory need re-score |
| `+ New Project` hidden/disabled (open-project remote lock) | Non-goals strengthened; product-lock table still aligned |
| Q1 light theme + Q5 system fonts **resolved** by reference | Open Questions section updated in UI-SPEC |
| Explicit non-goals: Getting Started, Connect Slack | Feature doc + UI-SPEC Non-Goals synced |
| Feature map | `docs/features/phone-apk-screens.md` §3–4 aligned |

**No app code changed** in this amendment.

---

## Amendment — Account Settings + opened-chat (2026-10-01)

**Status: FLAG** — additional post-approval IA changes. Re-run checker after all amendments settle.

| Change | Impact |
|--------|--------|
| Account → Cursor Settings card layout | Connection / Computer picker / **Refresh now** / Advanced |
| Choose one PC Hub + immediate session refresh | Nav + API cheat sheet; multi-PC saved peers planned |
| Opened chat Cursor chrome (`+` / mode / Model / queue) | Composer inventory + Live chat focal points |
| Feature map | `docs/features/phone-apk-screens.md` §8 Account / Settings |

**No app code changed** in this amendment.

---

## Amendment — Pair QR + camera (2026-10-01)

**Status: FLAG** — pairing UX now specifies PC QR display + phone camera scan as primary.

| Change | Impact |
|--------|--------|
| Pair primary = Scan QR | Copywriting CTA; Pair screen inventory; scenario 1 sequence |
| PC operator shows Hub `qrPayload` QR | Designed Hub loopback pair page; pair/start stays localhost-only |
| Camera permission / expired QR errors | States table + feature doc §1 |
| Manual code remains fallback | Existing PairScreen path kept |

**No app code changed** in this amendment.

---

## Amendment — Connectivity + session parity (2026-10-01)

**Status: FLAG** — sync/parity contract added; Home list sync metal started.

| Change | Impact |
|--------|--------|
| Session parity rules (PC Hub = source of truth) | UI-SPEC Amendment E; sync diagnosis updated |
| Home focus + WS re-pull + last-synced / stale hint | `ChatsHomeScreen.tsx` |
| Settings Refresh now | Still planned UI; same pull chain |

---

## UI-SPEC Review — Phase 5

| Dimension | Verdict |
|-----------|---------|
| Dimension 1 — Copywriting | PASS *(pre-amendment)* |
| Dimension 2 — Visuals | PASS *(pre-amendment)* → **FLAG pending re-check** |
| Dimension 3 — Color | PASS |
| Dimension 4 — Typography | PASS |
| Dimension 5 — Spacing | PASS |
| Dimension 6 — Registry Safety | PASS |
| Dimension 7 — Inventory Provenance | PASS |

**Status: FLAG (was APPROVED 2026-10-01)** — Home + Account Settings + opened-chat + Pair QR + sync/parity amendments require checker re-run.

Checker applied small BLOCK-level doc fixes during the original review (empty-state copy + CTA specificity + focal-point section). Re-score after those edits was all PASS. **Post-amendment:** do not ship plan-phase on the stale APPROVED stamp alone.

---

## Dimension evidence

### 1 Copywriting — PASS

- Empty states: unbound project, bound no chats, history no messages, editor no files — specific title/body/CTA (not “No data found”).
- Errors: Tailscale / Hub / Cursor / CDP queue — each includes a recovery path.
- CTAs: **Pair with Hub**, **New chat**, **Create chat**, **Continue to Chats**, **Send message**, **Open on PC**, **Approve tool**, **Deny tool** — verb + noun; no Submit/OK/Cancel/Save generics.
- Destructive: Clear pairing confirms; Deny tool declares no second dialog.

**Pre-fix (BLOCK, remediated):** History/Editor empties were shorthand only (“No messages copy” / “Empty roots / no files”); Pair/Create/Approve/Deny were single-word.

### 2 Visuals — PASS

- `## Visual hierarchy (focal points)` declares primary visual anchor per screen.
- Composer **+** requires `accessibilityLabel` fallback.
- Hierarchy also supported by typography roles + accent reservation.

**Pre-fix (FLAG, remediated):** No focal-point table; icon-only + without a11y note.

### 3 Color — PASS

- 60/30/10 declared (`#f4f5f7` / white-muted / `#1e6b4a`).
- Accent reserved for enumerable set (primary CTAs, selected tab, Online chip, Approve fill, focus links) — not “all interactive elements”.
- Destructive `#b3261e` + Warn `#9a6700` present for Deny/clear and degraded states.
- Light calm locked; OLED dark honestly deferred (Open Question 1).

### 4 Typography — PASS

- Exactly four sizes (13 / 16 / 20 / 28) and two weights (400 / 600).
- Body line-height 1.5 declared; scale is hierarchical (not 14–15–16 clustering).

### 5 Spacing — PASS

- Scale: 4, 8, 16, 24, 32, 48, 64 only.
- Exception: 44×44 min tap targets — accessibility-justified.
- Honest migrate note away from current `theme.spacing` 6/10.

### 6 Registry Safety — PASS

- No third-party registries (`none` / not applicable). Expo RN first-party — shadcn N/A.
- `workflow.ui_safety_gate` config absent → treated enabled; nothing to vet.

### 7 Inventory Provenance — PASS

- Provenance line present: `node` walk of `apps/mobile/src/{components,screens}` — **18 UI modules** — `@cursor-mobile/mobile@0.1.0` — 2026-10-01.
- Precedes screen/component lists. Tool: none (no shadcn closed allowlist risk beyond this enumerated RN inventory).
- Treat as known-good enumeration for plan context; executor may still use additional RN primitives not listed.

---

## Product-lock alignment (non-dimension)

| Lock | UI-SPEC | Verdict |
|------|---------|---------|
| PC-local Hub / no cloud / no ngrok / no public CDP | Non-Goals + Intent + product_locks frontmatter | Aligned |
| Expo RN Android (not SwiftUI) | Design System + Non-Goals | Aligned |
| Approvals in-chat; tools on PC | Screen inventory + scenarios + Non-Goals | Aligned |
| Open-project remote only | Empty unbound copy + New chat / attach flows | Aligned |
| Light calm recommended; open Qs honest | Visual direction + Open Questions 1–5 | Aligned |
| Feature map sync | Points at `phone-apk-screens.md`; IA matches Chats\|Account + sidebar home | Aligned (amended) |
| ROADMAP / STATE | Phase 5 plan-first; checker next gate | Re-check after home amend |

---

## Edits applied this review (doc-only)

1. Copywriting: History/Editor empty copy; **Pair with Hub** / **Create chat** / **Send message** / **Open on PC** / **Approve tool** / **Deny tool**.
2. States table: History/Editor empty cells point at Copywriting Contract.
3. New `## Visual hierarchy (focal points)` + composer **+** a11y label requirement.

No app code changed.

---

## Amendment — visual IA (2026-10-01, post-approval)

**Status:** UI-SPEC returned to **draft** pending checker re-run. Prior 7-dimension APPROVED remains historical evidence only.

### Amendment A — Home / Screen 1
- Cursor **sidebar-inspired** full-width Home (New Chat, Search, Projects, Repositories tree, profile footer).
- `+ New Project` / Getting Started / Connect Slack excluded or fail-closed.
- Conflicts with prior Gemini flat-list + FAB home chrome — superseded for Home only.

### Amendment B — Opened chat / Live composer
- Cursor **chat chrome**: leveled back-to-Home, gray user bubbles, agent identity/timing, path pills.
- Circular bordered **`+`** → Plan/Debug/Multitask/Ask + Files/Model/MCP sheet; mode chip; Working/Queued; Model panel from Hub.
- Explicit Implemented vs Designed (create `agentMode`, attach, models/`model_select` VERIFIED vs live Plan/Stop/MCP-run).
- Home Amendment A **preserved** — no wipe.

### Checker impact
- Dimensions 1–3 and 2 (visual hierarchy) need re-score for new copy, bubbles/agent blue/mode chips, and Live focal points.
- Product locks unchanged (PC-local, no phone MCP, open-project remote).

**Next:** `gsd-ui-checker` on amended `05-UI-SPEC.md`.

---

## Recommendations (non-blocking)

1. Re-run **gsd-ui-checker** on amended UI-SPEC (home IA) before plan-phase.
2. User confirm Open Questions still open: **Q2** Health gate, **Q3** pending approvals deep-link, **Q4** mic/camera, **Q6** New Project hide vs disable, **Q7** Repositories label. **Q1** (light) and **Q5** (system fonts) are resolved.
3. Sync Pair primary CTA in feature doc to **Pair with Hub** when next touching Pair § (minor).
4. Proceed to user plan approval → `/gsd-plan-phase 5` only after checker re-PASS; still **no UI implementation** until user asks to build.

---

## Ready for planning?

**Not yet — FLAG after home-IA amendment.**  
After checker re-PASS and **user plan approval**, `/gsd-plan-phase 5`. Not ready for app UI implementation until the user explicitly says build.

---

## Structured return

## UI-SPEC FLAGGED (post-amendment)

**Phase:** 5 - Mobile UX contract  
**Status:** FLAG — home IA amended after prior APPROVED

### Dimension Results
| Dimension | Verdict | Notes |
|-----------|---------|-------|
| 1 Copywriting | PASS → re-check | Home empty/search/New Chat copy added |
| 2 Visuals | FLAG | Screen 1 focal points / structure changed |
| 3 Color | PASS | Light grayscale + sparse accent still valid |
| 4 Typography | PASS | System fonts locked (Q5) |
| 5 Spacing | PASS | Compact home density exception documented |
| 6 Registry Safety | PASS | No third-party registries |
| 7 Inventory Provenance | PASS | 18 modules; planned home components listed |

### Recommendations
- Re-run gsd-ui-checker.
- Confirm Q2/Q3/Q4/Q6/Q7; Q1/Q5 resolved by reference.

### Ready for Planning
After checker re-PASS + user plan approval.
