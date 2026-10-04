/**
 * Typed wrappers over the Hub's Agents routes plus the "wait for the agent" loop.
 * Everything that acts on the PC goes through the Hub's verified, fail-closed path.
 */

import type { HubClient } from "./hub-client.js";
import { HubError } from "./hub-client.js";

export type ChatStatus = "idle" | "working" | "waiting_approval" | "error";
/** Cursor composer modes the Hub can switch to (omit to keep the chat's current mode). */
export const AGENT_MODES = ["Plan", "Debug", "Multitask", "Ask"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export interface MentionRef {
  trigger: "@" | "/";
  label: string;
  detail?: string;
}

export interface ComposerOptions {
  mode?: AgentMode;
  model?: string;
  mentions?: MentionRef[];
}

export interface AgentsChat {
  composerId: string;
  title: string;
  ageLabel: string | null;
  updatedAt: string | null;
  status: ChatStatus;
  unread: boolean;
  linesAdded: number;
  linesRemoved: number;
  activeOnPc: boolean;
}

export interface AgentsProject {
  projectId: string;
  name: string;
  path: string | null;
  hasMore: boolean;
  chats: AgentsChat[];
}

export interface CursorAlert {
  title: string;
  message: string;
  actions: string[];
  error: boolean;
  needsReload: boolean;
}

export interface AgentsResponse {
  source: "sidebar" | "history";
  note: string | null;
  /** Older Hubs omit this. */
  alerts?: CursorAlert[];
  projects: AgentsProject[];
}

/** One line per error banner Cursor shows above its composer. */
export function describeAlerts(alerts: CursorAlert[] | undefined): string[] {
  return (alerts ?? [])
    .filter((a) => a.error)
    .map((a) => `${a.title}${a.message ? ` — ${a.message}` : ""}${a.needsReload ? " (fix: Reload Window in Cursor on the PC)" : ""}`);
}

/**
 * Refuse to type into Cursor while its agent runtime is stuck: the prompt would be
 * submitted, time out, and land back in the PC input box.
 */
export async function assertCursorCanRun(hub: HubClient): Promise<void> {
  const res = await listAgents(hub);
  const stuck = (res.alerts ?? []).find((a) => a.needsReload);
  if (stuck) {
    throw new HubError(
      409,
      "CURSOR_NEEDS_RELOAD",
      `Cursor on the PC shows "${stuck.title}"${stuck.message ? ` (${stuck.message})` : ""}. ` +
        "Its agent runtime is not responding, so nothing sent now would run. Ask the user to click Reload Window in Cursor, then try again.",
    );
  }
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

const COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function composerId(raw: string): string {
  const id = raw.trim().replace(/^hist_/, "").toLowerCase();
  if (!COMPOSER_ID.test(id)) throw new HubError(400, "VALIDATION_ERROR", `Not a local Cursor chat id: ${raw}`);
  return id;
}

export function listAgents(hub: HubClient): Promise<AgentsResponse> {
  return hub.call<AgentsResponse>("GET", "/v1/agents");
}

export async function findChat(hub: HubClient, id: string): Promise<{ project: AgentsProject; chat: AgentsChat } | null> {
  const res = await listAgents(hub);
  for (const project of res.projects) {
    const chat = project.chats.find((c) => c.composerId === id);
    if (chat) return { project, chat };
  }
  return null;
}

export async function readMessages(hub: HubClient, id: string): Promise<{ messages: ChatMessage[]; truncated: boolean }> {
  const res = await hub.call<{ messages: ChatMessage[]; truncated: boolean }>(
    "GET",
    `/v1/sessions/hist_${composerId(id)}/messages?limit=2000`,
  );
  return { messages: res.messages, truncated: res.truncated };
}

/** Messages after the operator's last prompt — "what the agent answered". */
export function replyAfterLastPrompt(messages: ChatMessage[]): ChatMessage[] {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") last = i;
  });
  return messages.slice(last + 1);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Index of the user message carrying `prompt` (latest first). Mention chips are stored
 * ahead of the typed text ("AGENTS.md  Reply with…"), so match on the end.
 */
export function findPrompt(messages: ChatMessage[], prompt: string): number {
  const want = squash(prompt);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && squash(m.content).endsWith(want)) return i;
  }
  return -1;
}

export function sendMessage(hub: HubClient, id: string, text: string, options: ComposerOptions) {
  return hub.call<{ ok: true }>("POST", `/v1/agents/chats/${composerId(id)}/messages`, { text, ...options });
}

export function newChat(hub: HubClient, projectId: string, text: string, options: ComposerOptions) {
  return hub.call<{ ok: true; composerId: string | null }>("POST", "/v1/agents/projects/new", {
    projectId,
    text,
    ...options,
  });
}

export function stopChat(hub: HubClient, id: string) {
  return hub.call<{ ok: true }>("POST", `/v1/agents/chats/${composerId(id)}/stop`);
}

export function chatChanges(hub: HubClient, id: string) {
  return hub.call<{
    files: Array<{ index: number; path: string; isNew: boolean; deleted: boolean; added: number; removed: number; skipped: string | null }>;
  }>(
    "GET",
    `/v1/agents/chats/${composerId(id)}/changes`,
  );
}

export function chatFileDiff(hub: HubClient, id: string, index: number) {
  return hub.call<{ path: string; added: number; removed: number; skipped: string | null; hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> }>("GET", `/v1/agents/chats/${composerId(id)}/changes/${index}`);
}

export function findMentions(hub: HubClient, id: string, trigger: "@" | "/", query: string) {
  const q = new URLSearchParams({ trigger, q: query });
  return hub.call<{ options: Array<{ label: string; detail?: string; hint?: string }> }>(
    "GET",
    `/v1/agents/chats/${composerId(id)}/mentions?${q.toString()}`,
  );
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
  /** A run may take a few seconds to show as working after a send. */
  startGraceMs?: number;
  /** Text we sent; the reply is taken after it, and its absence is reported. */
  expectPrompt?: string;
  /** Cursor's DB can trail the screen for a few seconds after a run ends. */
  transcriptSettleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitResult {
  status: ChatStatus | "missing";
  finished: boolean;
  timedOut: boolean;
  waitedSec: number;
  /** false when the sent prompt never reached the chat transcript. */
  promptLanded?: boolean;
  warning?: string;
  reply: ChatMessage[];
}

export const PROMPT_NOT_LANDED =
  "The prompt sent from here is not in the chat transcript, so Cursor did not run it. " +
  "Cursor may have failed the run (e.g. an \"Agent Execution Timed Out\" banner, which needs Reload Window on the PC) " +
  "and put the text back in its input box. Ask the user to check Cursor on the PC before sending again.";

/** Poll the PC sidebar until this chat stops working, then return the agent's reply. */
export async function waitForAgent(hub: HubClient, id: string, opts: WaitOptions): Promise<WaitResult> {
  const cid = composerId(id);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 3_000;
  const grace = opts.startGraceMs ?? 12_000;
  const started = now();
  let sawWorking = false;
  let status: ChatStatus | "missing" = "missing";

  for (;;) {
    const found = await findChat(hub, cid);
    status = found?.chat.status ?? "missing";
    if (status === "working") sawWorking = true;
    const elapsed = now() - started;
    const settled = status !== "working" && (sawWorking || elapsed >= grace || status === "waiting_approval");
    if (settled || status === "missing") break;
    if (elapsed >= opts.timeoutMs) {
      return { status, finished: false, timedOut: true, waitedSec: Math.round(elapsed / 1000), reply: [] };
    }
    await sleep(pollMs);
  }

  let { messages } = await readMessages(hub, cid);
  if (opts.expectPrompt === undefined) {
    return {
      status,
      finished: status !== "missing",
      timedOut: false,
      waitedSec: Math.round((now() - started) / 1000),
      reply: replyAfterLastPrompt(messages),
    };
  }

  const settleUntil = now() + (opts.transcriptSettleMs ?? 8_000);
  let at = findPrompt(messages, opts.expectPrompt);
  while (at < 0 && now() < settleUntil) {
    await sleep(Math.min(pollMs, 2_000));
    ({ messages } = await readMessages(hub, cid));
    at = findPrompt(messages, opts.expectPrompt);
  }
  const waitedSec = Math.round((now() - started) / 1000);
  if (at < 0) {
    const shown = describeAlerts((await listAgents(hub).catch(() => null))?.alerts);
    const warning = shown.length ? `${PROMPT_NOT_LANDED} Cursor shows: ${shown.join("; ")}` : PROMPT_NOT_LANDED;
    return { status, finished: false, timedOut: false, waitedSec, promptLanded: false, warning, reply: [] };
  }
  return { status, finished: status !== "missing", timedOut: false, waitedSec, promptLanded: true, reply: messages.slice(at + 1) };
}
