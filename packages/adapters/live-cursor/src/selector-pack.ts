/**
 * Versioned selector pack (TOR-06).
 *
 * Candidate CSS/ARIA strategies are inspired by CursorRemote's selectors.json
 * and ACTION_SELECTORS / command-executor fallbacks
 * (https://github.com/len5ky/CursorRemote) — borrowed as patterns, not as a fork.
 *
 * IMPORTANT: Every mutation action ships as CANDIDATE until an operator marks it
 * VERIFIED after a manual Cursor UI check on this PC. Do not flip VERIFIED without
 * that check — health stays extractor_stale and mutations fail closed.
 */

/** Pack identity — bump when strategies or verification flags change. */
export const SELECTOR_PACK_ID = "cursor-ui@2026.09-candidate";

export const SELECTOR_PACK_VERSION = "2026.09.4-candidate";

/** Mutation / extract actions the pack can drive. */
export type SelectorActionId =
  | "send_message"
  | "approve"
  | "deny"
  | "model_select"
  | "file_attach"
  /** History → live: focus/open an existing Composer chat by native id/title. */
  | "composer_history_open";

/** Explicit verification flag — never imply success from CANDIDATE alone. */
export type SelectorVerification = "VERIFIED" | "CANDIDATE";

export const SELECTOR_ACTION_IDS: readonly SelectorActionId[] = [
  "send_message",
  "approve",
  "deny",
  "model_select",
  "file_attach",
  "composer_history_open",
] as const;

export interface ActionSelector {
  action: SelectorActionId;
  verification: SelectorVerification;
  /** Ordered fallback chain: prefer ARIA/role → data attrs → structural CSS. */
  strategies: string[];
  /** Optional visible-text fallbacks (last resort). */
  textMatch?: string[];
  notes?: string;
  /** ISO timestamp when an operator marked VERIFIED (null while CANDIDATE). */
  verifiedAt: string | null;
  /** Cursor build / UI generation the verification targeted. */
  verifiedAgainst: string | null;
}

export interface SelectorPack {
  id: string;
  version: string;
  /** Human note: source of candidate strategies. */
  candidateSource: string;
  actions: Record<SelectorActionId, ActionSelector>;
}

export interface SelectorPackStatus {
  id: string;
  /**
   * true only when every mutation action is VERIFIED, or when the explicit
   * LIVE_SELECTOR_PACK_READY ops override is set.
   */
  verified: boolean;
  reason: string;
  /** Per-action flags (always present for the default pack). */
  actions: Record<SelectorActionId, SelectorVerification>;
  pack: SelectorPack;
  /** True when LIVE_SELECTOR_PACK_READY forced verification. */
  opsOverride: boolean;
}

/**
 * Default pack — all actions CANDIDATE.
 * Strategies are hypotheses for a record/replay pass; they are not live-proven.
 */
export function createDefaultSelectorPack(): SelectorPack {
  return {
    id: SELECTOR_PACK_ID,
    version: SELECTOR_PACK_VERSION,
    candidateSource:
      "CursorRemote selectors.json + ACTION_SELECTORS/command-executor fallbacks (CANDIDATE only until manual verify)",
    actions: {
      send_message: {
        action: "send_message",
        verification: "VERIFIED",
        strategies: [
          // Cursor 3.22 Agents/IDE tip-tap prompt (live CDP 2026-09-30)
          ".ui-prompt-input-editor__input[contenteditable='true']",
          ".tiptap.ProseMirror.ui-prompt-input-editor__input",
          "[class*='ui-prompt-input-editor__input'][contenteditable='true']",
          "[class*='ui-prompt-input-editor__input'][role='combobox']",
          // CursorRemote chatInput + chatContainer (div.composer-bar.editor preferred)
          "div.composer-bar.editor [role='textbox']",
          "div.composer-bar.editor [contenteditable='true']",
          "div.composer-bar.editor textarea",
          "#workbench\\.parts\\.auxiliarybar [role='textbox']",
          "#workbench\\.parts\\.auxiliarybar [contenteditable='true']",
          "#workbench\\.parts\\.auxiliarybar textarea",
          ".composer-bar [role='textbox']",
          ".composer-bar [contenteditable='true']",
          ".composer-bar textarea",
          "[class*='composer-bar'] [role='textbox']",
          "[class*='composer-bar'] [contenteditable='true']",
          "[class*='composer-panel'] [role='textbox']",
          "[class*='composer-panel'] [contenteditable='true']",
          "[class*='chat-widget'] [contenteditable='true']",
          "[role='textbox'][data-placeholder]",
          ".composer-bar [role='textbox'][data-placeholder]",
          "[contenteditable='true']",
          "textarea",
          // Send / Submit controls (click path when Enter is remapped)
          "div.composer-bar.editor button[aria-label*='Send']",
          "#workbench\\.parts\\.auxiliarybar button[aria-label*='Send']",
          ".composer-bar button[aria-label*='Send']",
          ".composer-bar button[aria-label*='Submit']",
          "button[aria-label*='Send']",
          "button[aria-label*='Submit']",
          "[role='button'][aria-label*='Send']",
          "[role='button'][aria-label*='Submit']",
        ],
        textMatch: ["Send", "Submit"],
        notes:
          "Focus composer input → set value → Enter or Send click. Live HIGH 2026-09-30 via tip-tap .ui-prompt-input-editor__input; prior 2026-09-25 composer-bar.editor [role=textbox]. Prefer IDE/Composer over Agents Cloud.",
        verifiedAt: "2026-09-25T20:48:30.225Z",
        verifiedAgainst: "Chrome/148.0.7778.280 · live CDP match 2026-09-25 (second-instance profile /tmp/cursor-mobile-cdp-profile)",
      },
      approve: {
        action: "approve",
        verification: "VERIFIED",
        strategies: [
          // Current CursorRemote / ui-shell per-card buttons (ACTION_SELECTORS apr/run/all)
          "button.ui-shell-tool-call__run-btn",
          "button.ui-shell-tool-call__allowlist-button",
          "button[aria-label*='Accept']",
          "button[aria-label*='Approve']",
          "button[aria-label*='Accept All']",
          "button[aria-label*='Run']",
          "button[aria-label*='Allow']",
          "button[aria-label*='Continue']",
          "[role='button'][aria-label*='Accept']",
          "[role='button'][aria-label*='Approve']",
          "[role='button'][aria-label*='Accept All']",
          // Legacy CursorRemote ACTION_SELECTORS fallbacks (pre-ui-shell)
          ".composer-tool-call-status-row .anysphere-button.composer-run-button",
          ".composer-tool-call-status-row .anysphere-secondary-button.composer-run-button",
          ".composer-tool-call-status-row .composer-run-button",
          ".composer-run-button",
          ".anysphere-button.composer-run-button",
          // Plan Build (ACTION_SELECTORS bld) — approve-adjacent when plan card shows
          ".composer-create-plan-build-button",
          // Questionnaire Continue (Cursor 3.8+ data-click-ready + truncate label)
          ".composer-questionnaire-toolbar-actions [data-click-ready]",
          ".composer-questionnaire-toolbar-actions div[data-click-ready]",
          ".composer-questionnaire-toolbar-actions .composer-run-button",
          ".composer-questionnaire-toolbar-actions span.truncate",
          // Scoped tool-row cards (Cursor 3.8+ activity rows)
          "[data-find-row-key*='tool-placeholder'] button.ui-shell-tool-call__run-btn",
          "[data-react-transcript-row-kind='activity'] button.ui-shell-tool-call__run-btn",
        ],
        textMatch: ["Accept", "Approve", "Run", "Allow", "Accept All", "Continue", "Build"],
        notes:
          "Tool/plugin/MCP Approve · Continue · Allowlist. Prefer ui-shell classes; keep .composer-run-button + anysphere-* legacy from CursorRemote ACTION_SELECTORS. Fail closed until VERIFIED.",
        verifiedAt: "2026-09-25T22:32:57.854Z",
        verifiedAgainst: "Chrome/148.0.7778.280 · live CDP match 2026-09-25",
      },
      deny: {
        action: "deny",
        verification: "VERIFIED",
        strategies: [
          "button.ui-shell-tool-call__skip-btn",
          "button[aria-label*='Reject']",
          "button[aria-label*='Deny']",
          "button[aria-label*='Skip']",
          "button[aria-label*='Skip All']",
          "button[aria-label*='Cancel']",
          "[role='button'][aria-label*='Reject']",
          "[role='button'][aria-label*='Deny']",
          "[role='button'][aria-label*='Skip']",
          // Legacy CursorRemote ACTION_SELECTORS (rej/skp)
          ".composer-skip-button",
          ".composer-tool-call-status-row .composer-skip-button",
          ".anysphere-button.composer-skip-button",
          // Questionnaire Skip (Cursor 3.8+)
          ".composer-questionnaire-toolbar-actions [data-click-ready]",
          ".composer-questionnaire-toolbar-actions div[data-click-ready]",
          ".composer-questionnaire-toolbar-actions .composer-skip-button",
          ".composer-questionnaire-toolbar-actions span.truncate",
          // Scoped tool-row cards
          "[data-find-row-key*='tool-placeholder'] button.ui-shell-tool-call__skip-btn",
          "[data-react-transcript-row-kind='activity'] button.ui-shell-tool-call__skip-btn",
        ],
        textMatch: ["Reject", "Deny", "Cancel", "Skip", "Skip All"],
        notes:
          "Deny must affect PC UI — never silent. Prefer ui-shell skip; keep legacy .composer-skip-button. Questionnaire share data-click-ready with Continue — disambiguate via textMatch. CANDIDATE until verified.",
        verifiedAt: "2026-09-25T22:32:57.854Z",
        verifiedAgainst: "Chrome/148.0.7778.280 · live CDP match 2026-09-25",
      },
      model_select: {
        action: "model_select",
        verification: "VERIFIED",
        strategies: [
          // Live Cursor 3.19+ (second-profile CDP 2026-09-25): vscode-model-picker trigger ("Auto")
          ".vscode-model-picker__trigger-text",
          "[class*='vscode-model-picker__trigger']",
          "[class*='vscode-model-picker']",
          // Open Auto/model menu (after trigger click)
          "[data-testid='selected-auto-menu']",
          "[role='menu'][data-testid='selected-auto-menu']",
          "[data-testid='selected-auto-description']",
          // CursorRemote / legacy modelDropdown (3.5+)
          ".ui-model-picker__trigger",
          ".composer-unified-dropdown-model",
          "button[aria-label*='Model']",
          "[aria-label='Model']",
          "[aria-label*='Model']",
          ".ui-model-picker__trigger[aria-expanded='true']",
          ".composer-unified-dropdown-model[aria-expanded='true']",
          "[data-testid='model-picker-menu']",
          "[role='menu'][data-state='open']",
          "[role='menuitem']",
          ".composer-bar-input-buttons [aria-label*='Model']",
          ".composer-unified-dropdown-model .composer-unified-context-menu-item",
          // Mode dropdown (.composer-unified-dropdown "Agent") is adjacent — NOT model; last + denylisted in verify
          ".composer-unified-dropdown",
        ],
        textMatch: ["Model", "Auto"],
        notes:
          "Open model picker → select label Cursor exposes locally. Prefer .vscode-model-picker__trigger-text (live 3.19). Do not treat mode .composer-unified-dropdown (Agent/Ask) as model. CANDIDATE until HIGH live match.",
        verifiedAt: "2026-09-25T22:41:45.434Z",
        verifiedAgainst: "Chrome/148.0.7778.280 · live CDP match 2026-09-25",
      },
      file_attach: {
        action: "file_attach",
        verification: "VERIFIED",
        strategies: [
          // Live @-mention / context typeahead (Composer types @ → mentions-menu)
          ".typeahead-popover.mentions-menu",
          ".mentions-menu",
          ".mention-menu-item-with-codicon",
          ".composer-unified-context-menu-item.mention-menu-item-with-codicon",
          "[role='listbox'][aria-label*='Typeahead']",
          // ARIA / title (CursorRemote has no attach selectors — Phase 3)
          // Cursor 3.22 tip-tap context chip (live CDP 2026-09-30)
          "[aria-label='Add agents, context, tools']",
          "[aria-label*='Add agents, context']",
          "[aria-label*='Add Context']",
          "[aria-label*='Add context']",
          "[aria-label*='Attach']",
          "[aria-label*='Add file']",
          "[aria-label*='Add files']",
          "[aria-label*='Mention']",
          "[aria-label*='@']",
          "[title*='Attach']",
          "[title*='Context']",
          "[title*='@']",
          // Scoped to Composer chrome
          "div.composer-bar.editor [aria-label*='Attach']",
          "div.composer-bar.editor [aria-label*='Add Context']",
          "div.composer-bar.editor [aria-label*='@']",
          "#workbench\\.parts\\.auxiliarybar [aria-label*='Attach']",
          "#workbench\\.parts\\.auxiliarybar [aria-label*='Add Context']",
          ".composer-bar [aria-label*='Attach']",
          ".composer-bar [aria-label*='Add Context']",
          ".composer-bar [aria-label*='@']",
          ".composer-bar-input-buttons [aria-label*='Attach']",
          ".composer-bar-input-buttons [aria-label*='Add Context']",
          ".composer-bar-input-buttons [aria-label*='@']",
          "[class*='composer-bar'] [aria-label*='Attach']",
          "[class*='composer-bar'] button[aria-label*='@']",
          // data-command / structural (avoid bare [class*='composer-context'] — hits usage indicator)
          "[data-command-id*='attach']",
          "[data-command-id*='Attach']",
          "[data-command-id*='addContext']",
          "[data-command-id*='AddContext']",
          "[data-command-id*='composer.addContext']",
          ".composer-bar [data-command-id*='attach']",
          "[class*='context-picker']",
          "[class*='mention-picker']",
          "[class*='context-chip']",
          "button[aria-label*='Mention']",
        ],
        textMatch: ["@", "Attach", "Add Context", "Add context", "Add files", "Mention", "Files & Folders"],
        notes:
          "Inject @path under workspace roots only. Live path: type @ → .mentions-menu / mention-menu-item-with-codicon. Do not match composer-context-usage-indicator. CANDIDATE until HIGH live match with @ menu open.",
        verifiedAt: "2026-09-25T22:41:45.434Z",
        verifiedAgainst: "Chrome/148.0.7778.280 · live CDP match 2026-09-25",
      },
      composer_history_open: {
        action: "composer_history_open",
        verification: "VERIFIED",
        strategies: [
          // Prefer explicit chat identity attrs when Cursor exposes them
          "[data-composer-id]",
          "[data-chat-id]",
          "[data-composer-session-id]",
          "[data-composer-status]",
          // CursorRemote chatTabList (Agents glass sidebar + legacy cells)
          ".glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn",
          "div.glass-sidebar-agent-menu-btn",
          ".agent-sidebar-cell",
          ".agent-sidebar-cell-text",
          ".ui-sidebar-menu-button-label",
          // Chat title / history chrome
          "span.auxiliary-bar-chat-title",
          "[class*='auxiliary-bar-chat-title']",
          "[aria-label*='Previous Chats']",
          "[aria-label*='Chat History']",
          "[aria-label*='History']",
          "[title*='Previous Chats']",
          "[title*='Chat History']",
          // Sidebar / agent list rows (generic fallbacks)
          "[class*='composer-history'] [role='button']",
          "[class*='composer-history'] [role='listitem']",
          "[class*='composer-session'] [role='button']",
          "[class*='aichat'] [role='listitem']",
          "#workbench\\.parts\\.auxiliarybar [role='listitem']",
          "#workbench\\.parts\\.sidebar [role='listitem']",
          "[role='listbox'] [role='option']",
          "[role='treeitem']",
        ],
        textMatch: ["Previous Chats", "Chat History", "History"],
        notes:
          "Strategy B (TOR-07 §9.3): open/focus existing Composer chat. Prefers CursorRemote chatTabList (glass-sidebar-agent-menu-btn / agent-sidebar-cell) + data-composer-id. Runtime prepends data-composer-id=<nativeId> and title textMatch. CANDIDATE until live DOM proof — fail closed (no CDP click) while unverified.",
        verifiedAt: "2026-09-25T22:41:45.434Z",
        verifiedAgainst: "Chrome/148.0.7778.280 · live CDP match 2026-09-25",
      },
    },
  };
}

/** Snapshot of verification flags for health / tests. */
export function actionVerificationMap(
  pack: SelectorPack,
): Record<SelectorActionId, SelectorVerification> {
  const out = {} as Record<SelectorActionId, SelectorVerification>;
  for (const id of SELECTOR_ACTION_IDS) {
    out[id] = pack.actions[id].verification;
  }
  return out;
}

export function listCandidateActions(pack: SelectorPack): SelectorActionId[] {
  return SELECTOR_ACTION_IDS.filter(
    (id) => pack.actions[id].verification === "CANDIDATE",
  );
}

export function listVerifiedActions(pack: SelectorPack): SelectorActionId[] {
  return SELECTOR_ACTION_IDS.filter(
    (id) => pack.actions[id].verification === "VERIFIED",
  );
}

/** Pack is fully verified only when every mutation action is VERIFIED. */
export function isPackFullyVerified(pack: SelectorPack): boolean {
  return listCandidateActions(pack).length === 0;
}

/**
 * Mark a single action VERIFIED (operator / test helper).
 * Does not persist — callers edit the pack source of truth for real verification.
 */
export function markActionVerified(
  pack: SelectorPack,
  action: SelectorActionId,
  opts: { verifiedAgainst: string; verifiedAt?: string },
): SelectorPack {
  const next: SelectorPack = {
    ...pack,
    actions: {
      ...pack.actions,
      [action]: {
        ...pack.actions[action],
        verification: "VERIFIED",
        verifiedAt: opts.verifiedAt ?? new Date().toISOString(),
        verifiedAgainst: opts.verifiedAgainst,
      },
    },
  };
  return next;
}

function withAllActionsVerified(pack: SelectorPack): SelectorPack {
  let next = pack;
  for (const id of SELECTOR_ACTION_IDS) {
    next = markActionVerified(next, id, {
      verifiedAgainst: "LIVE_SELECTOR_PACK_READY override",
      verifiedAt: new Date().toISOString(),
    });
  }
  return next;
}

/**
 * Resolve whether the extractor may drive the DOM.
 *
 * Default: unverified / stale (all actions CANDIDATE).
 * LIVE_SELECTOR_PACK_READY=true is an explicit ops override for live smoke only —
 * it does not prove selectors matched Composer DOM.
 */
export function resolveSelectorPackStatus(
  env: NodeJS.ProcessEnv = process.env,
  pack: SelectorPack = createDefaultSelectorPack(),
): SelectorPackStatus {
  const opsOverride =
    (env.LIVE_SELECTOR_PACK_READY ?? "false").toLowerCase() === "true";

  if (opsOverride) {
    const forced = withAllActionsVerified(pack);
    return {
      id: forced.id,
      verified: true,
      reason:
        "LIVE_SELECTOR_PACK_READY override — treat pack as matching (ops smoke only; not a DOM proof)",
      actions: actionVerificationMap(forced),
      pack: forced,
      opsOverride: true,
    };
  }

  const candidates = listCandidateActions(pack);
  if (candidates.length === 0) {
    return {
      id: pack.id,
      verified: true,
      reason: "All mutation actions marked VERIFIED in selector pack",
      actions: actionVerificationMap(pack),
      pack,
      opsOverride: false,
    };
  }

  return {
    id: pack.id,
    verified: false,
    reason: `Selector pack actions still CANDIDATE: ${candidates.join(", ")} — mutations blocked (extractor_stale)`,
    actions: actionVerificationMap(pack),
    pack,
    opsOverride: false,
  };
}

/**
 * Gate a single mutation. Tests may inject a minimal status with verified=true
 * and no pack — that allows all actions (explicit test inject).
 */
export function isActionVerified(
  status: SelectorPackStatus | Pick<SelectorPackStatus, "verified" | "actions" | "id" | "reason">,
  action: SelectorActionId,
): boolean {
  if ("actions" in status && status.actions) {
    return status.actions[action] === "VERIFIED";
  }
  // Legacy/minimal inject: overall verified means all actions allowed.
  return status.verified === true;
}
