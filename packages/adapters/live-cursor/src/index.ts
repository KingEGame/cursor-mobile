/**
 * LiveCursorAdapter — Phase 1: CDP attach, health triad, session list,
 * command interface with fail-closed mutations when extractor_stale.
 * CDP Input (click/type) runs only for VERIFIED selector-pack actions.
 * CDP must remain bound to 127.0.0.1 only.
 */

export {
  LiveCursorAdapterImpl,
  createLiveCursorAdapter,
  createMockLiveCursorAdapter,
} from "./adapter.js";
export type {
  LiveCursorAdapterOptions,
  SelectorPackStatusInject,
} from "./adapter.js";
export { assertLoopbackCdpUrl, normalizeCdpUrl } from "./loopback.js";
export {
  fetchCdpTargetList,
  fetchCdpVersion,
  selectWindowTargets,
} from "./cdp-http.js";
export {
  CdpWebSocketClient,
  assertLoopbackDebuggerUrl,
  createMockCdpClient,
  createMockCdpClientFactory,
  defaultCdpClientFactory,
} from "./cdp-client.js";
export type {
  CdpClient,
  CdpClientFactory,
  MockCdpCall,
  MockCdpClient,
} from "./cdp-client.js";
export {
  dispatchClick,
  executeClick,
  executeTypeAndSubmit,
  executeVerifiedAction,
  insertText,
  pressEnter,
  resolveElementCenter,
  resolveElementCenterByText,
  setFocusedEditableValue,
} from "./cdp-input.js";
export type {
  CdpInputFail,
  CdpInputOk,
  CdpInputResult,
  ElementBox,
} from "./cdp-input.js";
export {
  MODEL_PICKER_TRIGGER_STRATEGIES,
  scrapeComposerModels,
} from "./model-scrape.js";
export type { ModelScrapeResult, ScrapedModel } from "./model-scrape.js";
export {
  SELECTOR_ACTION_IDS,
  SELECTOR_PACK_ID,
  SELECTOR_PACK_VERSION,
  actionVerificationMap,
  createDefaultSelectorPack,
  isActionVerified,
  isPackFullyVerified,
  listCandidateActions,
  listVerifiedActions,
  markActionVerified,
  resolveSelectorPackStatus,
} from "./selector-pack.js";
export type {
  ActionSelector,
  SelectorActionId,
  SelectorPack,
  SelectorPackStatus,
  SelectorVerification,
} from "./selector-pack.js";
export {
  assertReplayAllOk,
  defaultFixturesDir,
  loadFixtureFile,
  loadFixturesFromDir,
  recordFixture,
  replayFixtureAgainstAction,
  replayPackFixtures,
} from "./record-replay.js";
export type {
  RecordCaptureInput,
  ReplayHitResult,
  SelectorFixture,
} from "./record-replay.js";
export {
  firstMatchingStrategy,
  strategyLikelyHits,
  textMatchHits,
} from "./selector-match.js";
export type {
  ApprovalResult,
  AttachFilesResult,
  CdpProbeResult,
  CdpProbeStatus,
  CdpTarget,
  CommandFailureCode,
  CommandResult,
  CreateLiveSessionInput,
  CreateLiveSessionResult,
  CursorDetectStatus,
  EnqueueApprovalInput,
  LiveAdapterHealth,
  LiveCursorAdapter,
  LiveHealthState,
  LiveSessionRow,
  LiveWindow,
  ModelScrapeCommandResult,
  PendingApprovalInfo,
  PendingApprovalTool,
  ReopenComposerContextInput,
  ReopenComposerContextResult,
  ReopenComposerStrategy,
  ScrapedModelOption,
  SendMessageResult,
} from "./types.js";

export {
  parseSidebarSnapshot,
  scrapeAgentsSidebar,
  sidebarLiveState,
  SIDEBAR_SCRAPE_EXPRESSION,
} from "./sidebar-scrape.js";
export type {
  SidebarChat,
  SidebarLiveState,
  SidebarScrapeResult,
  SidebarSection,
} from "./sidebar-scrape.js";

export {
  openAgentChat,
  readOpenChatId,
  sendToAgentChat,
  STOP_GENERATION_SELECTORS,
  stopAgentChat,
} from "./chat-send.js";
export type { ChatSendResult } from "./chat-send.js";
