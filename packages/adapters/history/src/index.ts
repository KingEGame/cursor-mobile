/**
 * History Index — Phase 2 local scan + open-on-PC bridge hooks.
 * PC-local only — no cloud session catalogs.
 */

export type {
  HistoryAdapter,
  HistoryAdapterStatus,
  HistoryBackendKind,
  HistoryListOptions,
  HistoryMessage,
  HistoryOpenOnPcFailure,
  HistoryOpenOnPcOutcome,
  HistoryOpenOnPcResult,
  HistorySessionDetail,
  HistorySessionMode,
  HistorySessionSummary,
} from "./types.js";

export {
  createHistoryAdapter,
  LocalHistoryAdapter,
  MemoryHistoryAdapter,
  StubHistoryAdapter,
} from "./adapter.js";
export type { LocalHistoryAdapterOptions } from "./adapter.js";

export {
  cursorUserDataRoots,
  listStoragePathCandidates,
  resolveAgentCliChatsRoots,
  resolveDesktopGlobalStorageDb,
  resolveWorkspaceStorageRoot,
} from "./paths.js";
export type { StorageBackendKind, StoragePathCandidate } from "./paths.js";

export {
  findWorkspaceStorageHashes,
  workspaceIdFromPath,
} from "./workspace-map.js";

export {
  collapseToolRuns,
  isListableComposerRow,
  LISTABLE_COMPOSER_SQL,
  parseDesktopComposerChatId,
} from "./desktop-scan.js";
export { parseCliSessionId } from "./agent-cli-scan.js";

export {
  deriveChatStatus,
  describeAgentChats,
  groupChatsByProject,
  listRecentLocalProjects,
  rowToChatDetails,
} from "./agents-index.js";
export type {
  AgentChatDetails,
  AgentChatStatus,
  AgentProjectGroup,
} from "./agents-index.js";
