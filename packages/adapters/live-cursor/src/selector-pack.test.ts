import { describe, expect, it } from "vitest";
import {
  assertReplayAllOk,
  loadFixturesFromDir,
  recordFixture,
  replayPackFixtures,
} from "./record-replay.js";
import { splitSelectorParts, strategyLikelyHits } from "./selector-match.js";
import {
  SELECTOR_ACTION_IDS,
  SELECTOR_PACK_ID,
  SELECTOR_PACK_VERSION,
  createDefaultSelectorPack,
  isActionVerified,
  isPackFullyVerified,
  listCandidateActions,
  markActionVerified,
  resolveSelectorPackStatus,
  type SelectorPack,
} from "./selector-pack.js";

/** Clone default pack with every action forced back to CANDIDATE (unit fail-closed paths). */
function candidateClone(): SelectorPack {
  const pack = createDefaultSelectorPack();
  const actions = { ...pack.actions };
  for (const id of SELECTOR_ACTION_IDS) {
    actions[id] = {
      ...actions[id],
      verification: "CANDIDATE",
      verifiedAt: null,
      verifiedAgainst: null,
    };
  }
  return { ...pack, actions };
}

describe("selector pack versioning", () => {
  it("ships all mutation actions VERIFIED after live CDP proof", () => {
    const pack = createDefaultSelectorPack();
    expect(pack.id).toBe(SELECTOR_PACK_ID);
    expect(pack.version).toBe(SELECTOR_PACK_VERSION);
    expect(isPackFullyVerified(pack)).toBe(true);
    expect(listCandidateActions(pack)).toEqual([]);
    for (const id of SELECTOR_ACTION_IDS) {
      expect(pack.actions[id].verification).toBe("VERIFIED");
      expect(pack.actions[id].verifiedAt).toBeTruthy();
      expect(pack.actions[id].verifiedAgainst).toBeTruthy();
      expect(pack.actions[id].strategies.length).toBeGreaterThan(0);
    }
  });

  it("pack structure covers every action with non-empty unique strategies", () => {
    const pack = createDefaultSelectorPack();
    expect(Object.keys(pack.actions).sort()).toEqual(
      [...SELECTOR_ACTION_IDS].sort(),
    );
    expect(pack.candidateSource.toLowerCase()).toMatch(/cursorremote/);
    for (const id of SELECTOR_ACTION_IDS) {
      const action = pack.actions[id];
      expect(action.action).toBe(id);
      expect(action.strategies.length).toBeGreaterThanOrEqual(6);
      expect(new Set(action.strategies).size).toBe(action.strategies.length);
      for (const strategy of action.strategies) {
        expect(strategy.trim().length).toBeGreaterThan(2);
        // Comma-joined cascades break our fixture matcher — keep one selector per entry
        // (commas inside quoted attribute values, e.g. aria-label='Add agents, context, tools', are fine)
        expect(strategy.replace(/'[^']*'|"[^"]*"/g, "")).not.toMatch(/,/);
      }
    }
  });

  it("includes CursorRemote-inspired fallbacks for composer / approve / deny / model", () => {
    const pack = createDefaultSelectorPack();
    const {
      send_message,
      approve,
      deny,
      model_select,
      file_attach,
      composer_history_open,
    } = pack.actions;

    expect(send_message.strategies).toEqual(
      expect.arrayContaining([
        "div.composer-bar.editor [contenteditable='true']",
        "#workbench\\.parts\\.auxiliarybar [contenteditable='true']",
        ".composer-bar [contenteditable='true']",
        "textarea",
        "button[aria-label*='Send']",
        "[class*='composer-bar'] [contenteditable='true']",
      ]),
    );
    expect(approve.strategies).toEqual(
      expect.arrayContaining([
        "button.ui-shell-tool-call__run-btn",
        "button.ui-shell-tool-call__allowlist-button",
        ".composer-tool-call-status-row .anysphere-secondary-button.composer-run-button",
        ".composer-run-button",
        "button[aria-label*='Accept']",
        ".composer-questionnaire-toolbar-actions [data-click-ready]",
      ]),
    );
    expect(deny.strategies).toEqual(
      expect.arrayContaining([
        "button.ui-shell-tool-call__skip-btn",
        ".composer-skip-button",
        "button[aria-label*='Reject']",
        "button[aria-label*='Skip']",
        ".composer-questionnaire-toolbar-actions [data-click-ready]",
      ]),
    );
    expect(model_select.strategies).toEqual(
      expect.arrayContaining([
        ".vscode-model-picker__trigger-text",
        ".ui-model-picker__trigger",
        ".composer-unified-dropdown-model",
        "[data-testid='selected-auto-menu']",
        "[data-testid='model-picker-menu']",
      ]),
    );
    expect(file_attach.strategies).toEqual(
      expect.arrayContaining([
        ".typeahead-popover.mentions-menu",
        ".mentions-menu",
        ".mention-menu-item-with-codicon",
        "[aria-label*='Add Context']",
        "[aria-label*='Attach']",
        "[aria-label*='@']",
        "[data-command-id*='attach']",
        ".composer-bar-input-buttons [aria-label*='Add Context']",
        "[class*='mention-picker']",
      ]),
    );
    expect(composer_history_open.strategies).toEqual(
      expect.arrayContaining([
        "[data-composer-id]",
        ".agent-sidebar-cell",
        "div.glass-sidebar-agent-menu-btn",
        ".glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn",
        "span.auxiliary-bar-chat-title",
      ]),
    );
  });

  it("candidateClone keeps every action CANDIDATE with null verified fields (fail-closed)", () => {
    const pack = candidateClone();
    for (const id of SELECTOR_ACTION_IDS) {
      expect(pack.actions[id].verification).toBe("CANDIDATE");
      expect(pack.actions[id].verifiedAt).toBeNull();
      expect(pack.actions[id].verifiedAgainst).toBeNull();
      expect(pack.actions[id].strategies.length).toBeGreaterThanOrEqual(8);
    }
    expect(resolveSelectorPackStatus({}, pack).verified).toBe(false);
  });

  it("resolveSelectorPackStatus reports verified when default pack is fully VERIFIED", () => {
    const status = resolveSelectorPackStatus({ LIVE_SELECTOR_PACK_READY: "false" });
    expect(status.verified).toBe(true);
    expect(status.opsOverride).toBe(false);
    expect(status.reason).toMatch(/VERIFIED/);
    expect(isActionVerified(status, "send_message")).toBe(true);
    expect(isActionVerified(status, "approve")).toBe(true);
    expect(isActionVerified(status, "model_select")).toBe(true);
    expect(isActionVerified(status, "file_attach")).toBe(true);
    expect(isActionVerified(status, "composer_history_open")).toBe(true);
  });

  it("LIVE_SELECTOR_PACK_READY override marks actions VERIFIED (ops smoke only)", () => {
    const status = resolveSelectorPackStatus(
      { LIVE_SELECTOR_PACK_READY: "true" },
      candidateClone(),
    );
    expect(status.verified).toBe(true);
    expect(status.opsOverride).toBe(true);
    for (const id of SELECTOR_ACTION_IDS) {
      expect(isActionVerified(status, id)).toBe(true);
    }
  });

  it("pack becomes fully verified only after every action is marked", () => {
    let pack = candidateClone();
    for (const id of SELECTOR_ACTION_IDS) {
      expect(isPackFullyVerified(pack)).toBe(false);
      pack = markActionVerified(pack, id, {
        verifiedAgainst: "Cursor test-build",
      });
    }
    expect(isPackFullyVerified(pack)).toBe(true);
    const status = resolveSelectorPackStatus({}, pack);
    expect(status.verified).toBe(true);
    expect(status.opsOverride).toBe(false);
  });
});

describe("selector matcher quoting", () => {
  it("keeps spaced attribute values as one selector part", () => {
    expect(splitSelectorParts("[aria-label*='Add Context']")).toEqual([
      "[aria-label*='Add Context']",
    ]);
    expect(
      splitSelectorParts(".composer-bar [aria-label*='Add Context']"),
    ).toEqual([".composer-bar", "[aria-label*='Add Context']"]);
    expect(
      strategyLikelyHits(
        '<button aria-label="Add Context">x</button>',
        "[aria-label*='Add Context']",
      ),
    ).toBe(true);
  });

  it("matches multi-class and child-combinator strategies against fixtures", () => {
    const html =
      '<div class="composer-bar editor"><div contenteditable="true"></div></div>';
    expect(
      strategyLikelyHits(html, "div.composer-bar.editor [contenteditable='true']"),
    ).toBe(true);
    expect(
      splitSelectorParts(
        ".glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn",
      ),
    ).toEqual([
      ".glass-sidebar-agent-list-container",
      "li.ui-sidebar-menu-item",
      "div.glass-sidebar-agent-menu-btn",
    ]);
  });
});

describe("record/replay fixtures", () => {
  it("replays synthetic fixtures against candidate strategies", () => {
    const pack = createDefaultSelectorPack();
    const fixtures = loadFixturesFromDir();
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    const results = replayPackFixtures(pack, fixtures);
    assertReplayAllOk(results);
  });

  it("recordFixture builds a capture object (optional write)", () => {
    const fx = recordFixture({
      action: "send_message",
      domSnippet: "<div class=\"composer-bar\"><div contenteditable=\"true\"></div></div>",
      recordedAgainst: "unit-test",
    });
    expect(fx.action).toBe("send_message");
    expect(fx.domSnippet).toContain("composer-bar");
    expect(strategyLikelyHits(fx.domSnippet, ".composer-bar [contenteditable='true']")).toBe(
      true,
    );
  });

  it("replay fails closed when fixture no longer matches strategies", () => {
    const pack = createDefaultSelectorPack();
    const results = replayPackFixtures(pack, [
      {
        id: "broken",
        action: "approve",
        recordedAgainst: "unit",
        recordedAt: new Date().toISOString(),
        domSnippet: "<div>no buttons here</div>",
        expectedStrategyHits: ["button.ui-shell-tool-call__run-btn"],
      },
    ]);
    expect(results[0]?.ok).toBe(false);
  });
});
