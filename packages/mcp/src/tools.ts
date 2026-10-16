/**
 * MCP tools for driving Cursor Agents chats on this PC through the local Hub.
 * Read tools are marked read-only; send / new chat / stop act on the PC.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AGENT_MODES,
  assertCursorCanRun,
  describeAlerts,
  chatChanges,
  chatFileDiff,
  composerId,
  decideApproval,
  listApprovals,
  findChat,
  findMentions,
  listAgents,
  newChat,
  readMessages,
  sendMessage,
  stopChat,
  waitForAgent,
  type ChatMessage,
  type ComposerOptions,
} from "./cursor-api.js";
import { HubError, type HubClient } from "./hub-client.js";

/** Long agent answers are trimmed so one tool result can't flood the context. */
const MAX_MESSAGE_CHARS = 6_000;

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const text =
    err instanceof HubError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { isError: true, content: [{ type: "text", text }] };
}

function guard<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

function compact(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    text: m.content.length > MAX_MESSAGE_CHARS ? `${m.content.slice(0, MAX_MESSAGE_CHARS)}… [trimmed]` : m.content,
  }));
}

const chatIdArg = z.string().describe("Cursor chat id (composerId UUID) from cursor_list_projects");

const composerArgs = {
  mode: z.enum(AGENT_MODES).optional().describe("Switch the chat's composer mode first; omit to keep the current mode"),
  model: z.string().max(80).optional().describe("Model name as shown in Cursor's picker (e.g. \"Auto\"); omit to keep"),
  mentions: z
    .array(
      z.object({
        trigger: z.enum(["@", "/"]),
        label: z.string().min(1).max(200),
        detail: z.string().max(300).optional(),
      }),
    )
    .max(10)
    .optional()
    .describe("Context chips to attach: '@' files/plugins, '/' skills/rules — find exact labels with cursor_find_mention"),
};

function composerOptions(a: { mode?: ComposerOptions["mode"]; model?: string; mentions?: ComposerOptions["mentions"] }) {
  const out: ComposerOptions = {};
  if (a.mode) out.mode = a.mode;
  if (a.model) out.model = a.model;
  if (a.mentions?.length) out.mentions = a.mentions;
  return out;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function registerCursorTools(server: McpServer, hub: HubClient): void {
  /** Last prompt this server sent per chat, so cursor_wait can prove it landed. */
  const lastSent = new Map<string, string>();

  server.registerTool(
    "cursor_status",
    {
      title: "Cursor status",
      description: "Is the local Hub up and can it drive Cursor on this PC (CDP state, bound workspace)?",
      annotations: READ,
    },
    guard(async () => {
      const h = (await hub.health()) as {
        version?: string;
        cdp?: { status?: string; error?: string | null };
        liveAdapter?: { state?: string; lastError?: string | null };
        workspace?: { name?: string | null; path?: string | null };
      };
      const state = h.liveAdapter?.state ?? "unknown";
      const alerts = state === "cdp_ok" ? ((await listAgents(hub).catch(() => null))?.alerts ?? []) : [];
      const shown = describeAlerts(alerts);
      const needsReload = alerts.some((a) => a.needsReload);
      return {
        hub: "up",
        hubVersion: h.version ?? null,
        cursor: needsReload ? "needs_reload" : state,
        canDriveCursor: state === "cdp_ok" && !needsReload,
        ...(shown.length ? { cursorAlerts: shown } : {}),
        ...(h.cdp?.error || h.liveAdapter?.lastError ? { error: h.cdp?.error ?? h.liveAdapter?.lastError } : {}),
        hubWorkspace: h.workspace?.path ?? null,
        ...(needsReload
          ? { hint: "Ask the user to click Reload Window in Cursor on the PC; sends will not run until then." }
          : state === "cdp_ok"
          ? {}
          : { hint: "Cursor must run with CDP on 127.0.0.1:9222 (npm run start:cursor:cdp); the user restarts Cursor, never automation." }),
      };
    }),
  );

  server.registerTool(
    "cursor_list_projects",
    {
      title: "List Cursor projects and chats",
      description:
        "Projects and chats from the Cursor Agents sidebar on this PC, with live status (working / waiting_approval / error / idle). Use the projectId to start a chat and the composerId to read, send, wait or stop.",
      inputSchema: {
        project: z.string().optional().describe("Only projects whose name contains this text (case-insensitive)"),
      },
      annotations: READ,
    },
    guard(async ({ project }: { project?: string }) => {
      const res = await listAgents(hub);
      const needle = project?.trim().toLowerCase();
      const shown = describeAlerts(res.alerts);
      return {
        source: res.source,
        ...(res.note ? { note: res.note } : {}),
        ...(shown.length ? { cursorAlerts: shown } : {}),
        projects: res.projects
          .filter((p) => !needle || p.name.toLowerCase().includes(needle))
          .map((p) => ({
            projectId: p.projectId,
            name: p.name,
            path: p.path,
            chats: p.chats.map((c) => ({
              composerId: c.composerId,
              title: c.title,
              status: c.status,
              ...(c.unread ? { unread: true } : {}),
              ...(c.ageLabel ? { age: c.ageLabel } : {}),
              ...(c.activeOnPc ? { openOnPc: true } : {}),
              ...(c.linesAdded || c.linesRemoved ? { lines: `+${c.linesAdded} -${c.linesRemoved}` } : {}),
            })),
            ...(p.hasMore ? { moreInSidebar: true } : {}),
          })),
      };
    }),
  );

  server.registerTool(
    "cursor_read_chat",
    {
      title: "Read a Cursor chat",
      description: "The latest messages of one Cursor chat on this PC (tool steps are collapsed into one-line notes).",
      inputSchema: {
        composerId: chatIdArg,
        last: z.number().int().min(1).max(200).optional().describe("How many recent messages (default 20)"),
      },
      annotations: READ,
    },
    guard(async ({ composerId: id, last }: { composerId: string; last?: number }) => {
      const cid = composerId(id);
      const [found, { messages, truncated }] = await Promise.all([findChat(hub, cid), readMessages(hub, cid)]);
      const n = last ?? 20;
      return {
        composerId: cid,
        title: found?.chat.title ?? null,
        project: found?.project.name ?? null,
        status: found?.chat.status ?? "not in sidebar",
        totalMessages: messages.length,
        ...(truncated ? { truncated: true } : {}),
        messages: compact(messages.slice(-n)),
      };
    }),
  );

  server.registerTool(
    "cursor_send",
    {
      title: "Send to a Cursor chat",
      description:
        "Type a follow-up into an existing Cursor chat on this PC and submit it (the Hub opens the chat, applies mode/model/mentions, and confirms the send). The Cursor agent then runs on the PC — call cursor_wait for its reply.",
      inputSchema: {
        composerId: chatIdArg,
        text: z.string().min(1).max(20_000),
        ...composerArgs,
      },
      annotations: ACT,
    },
    guard(async (a: { composerId: string; text: string } & Parameters<typeof composerOptions>[0]) => {
      const cid = composerId(a.composerId);
      await assertCursorCanRun(hub);
      await sendMessage(hub, cid, a.text, composerOptions(a));
      lastSent.set(cid, a.text);
      return { sent: true, composerId: cid, next: "cursor_wait to get the agent's reply" };
    }),
  );

  server.registerTool(
    "cursor_new_chat",
    {
      title: "Start a Cursor chat",
      description:
        "Start a new Agents chat in one project of the Cursor sidebar on this PC and send its first message. Returns the new composerId — call cursor_wait for the reply.",
      inputSchema: {
        projectId: z.string().min(1).describe("projectId from cursor_list_projects (e.g. \"workspace:…\")"),
        text: z.string().min(1).max(20_000),
        ...composerArgs,
      },
      annotations: ACT,
    },
    guard(async (a: { projectId: string; text: string } & Parameters<typeof composerOptions>[0]) => {
      await assertCursorCanRun(hub);
      const res = await newChat(hub, a.projectId.trim(), a.text, composerOptions(a));
      if (res.composerId) lastSent.set(res.composerId, a.text);
      return { started: true, composerId: res.composerId, next: "cursor_wait to get the agent's reply" };
    }),
  );

  server.registerTool(
    "cursor_wait",
    {
      title: "Wait for the Cursor agent",
      description:
        "Wait until the Cursor agent in this chat stops working (or needs approval), then return what it answered since the last prompt. If it times out the agent is still running — call again or cursor_stop.",
      inputSchema: {
        composerId: chatIdArg,
        timeoutSec: z.number().int().min(5).max(1_800).optional().describe("Give up after this long (default 300)"),
      },
      annotations: READ,
    },
    guard(async ({ composerId: id, timeoutSec }: { composerId: string; timeoutSec?: number }) => {
      const cid = composerId(id);
      const expectPrompt = lastSent.get(cid);
      const res = await waitForAgent(hub, cid, {
        timeoutMs: (timeoutSec ?? 300) * 1000,
        ...(expectPrompt !== undefined ? { expectPrompt } : {}),
      });
      if (res.finished || res.promptLanded === false) lastSent.delete(cid);
      return { ...res, reply: compact(res.reply) };
    }),
  );

  server.registerTool(
    "cursor_stop",
    {
      title: "Stop the Cursor agent",
      description: "Press Stop on a running Cursor agent in this chat on the PC.",
      inputSchema: { composerId: chatIdArg },
      annotations: ACT,
    },
    guard(async ({ composerId: id }: { composerId: string }) => {
      await stopChat(hub, id);
      lastSent.delete(composerId(id));
      return { stopped: true };
    }),
  );

  server.registerTool(
    "cursor_changes",
    {
      title: "Files a Cursor chat changed",
      description: "Files this Cursor chat changed on the PC (original vs current disk), with line counts. Use the index with cursor_diff.",
      inputSchema: { composerId: chatIdArg },
      annotations: READ,
    },
    guard(async ({ composerId: id }: { composerId: string }) => (await chatChanges(hub, id)).files),
  );

  server.registerTool(
    "cursor_diff",
    {
      title: "Diff of one changed file",
      description: "Unified diff of one file a Cursor chat changed (index from cursor_changes).",
      inputSchema: { composerId: chatIdArg, index: z.number().int().min(0) },
      annotations: READ,
    },
    guard(async ({ composerId: id, index }: { composerId: string; index: number }) => {
      const d = await chatFileDiff(hub, id, index);
      if (d.skipped) return `${d.path}: not diffed (${d.skipped})`;
      const body = d.hunks
        .map((h) => {
          const oldLines = h.lines.filter((l) => !l.startsWith("+")).length;
          const newLines = h.lines.filter((l) => !l.startsWith("-")).length;
          return [`@@ -${h.oldStart},${oldLines} +${h.newStart},${newLines} @@`, ...h.lines].join("\n");
        })
        .join("\n");
      return `--- ${d.path} (+${d.added} -${d.removed})\n${body}`;
    }),
  );

  server.registerTool(
    "cursor_find_mention",
    {
      title: "Find files, skills or rules to attach",
      description:
        "Ask Cursor on the PC what it offers after '@' (files in the chat's project, MCP plugins) or '/' (skills, commands, rules). Pass the exact label back in cursor_send / cursor_new_chat mentions. Briefly types into the PC composer and clears it, so it is not read-only.",
      inputSchema: {
        composerId: chatIdArg.describe("Any chat in the target project (files are project-scoped)"),
        trigger: z.enum(["@", "/"]),
        query: z.string().max(80).optional().describe("Filter text, e.g. part of a file name"),
      },
      annotations: ACT,
    },
    guard(async ({ composerId: id, trigger, query }: { composerId: string; trigger: "@" | "/"; query?: string }) => {
      const trig = trigger === "/" ? "/" : "@";
      return (await findMentions(hub, id, trig, query ?? "")).options.map((o) => ({
        trigger: trig,
        label: o.label,
        ...(o.detail ? { detail: o.detail } : {}),
        ...(o.hint ? { hint: o.hint } : {}),
      }));
    }),
  );

  server.registerTool(
    "cursor_list_approvals",
    {
      title: "Pending tool approvals",
      description: "Tool calls a live Hub session is waiting on you to approve or deny. Takes the Hub session id (not a history composerId).",
      inputSchema: { sessionId: z.string().min(1).describe("Hub live session id") },
      annotations: READ,
    },
    guard(async ({ sessionId: id }: { sessionId: string }) => (await listApprovals(hub, id)).items),
  );

  for (const decision of ["approve", "deny"] as const) {
    server.registerTool(
      `cursor_${decision}`,
      {
        title: decision === "approve" ? "Approve a pending tool call" : "Deny a pending tool call",
        description:
          `${decision === "approve" ? "Approve" : "Deny"} one pending tool call on the PC (clicks it in Cursor). ` +
          "Get approvalId from cursor_list_approvals and review the tool and args first; approving lets the agent run that tool on the PC.",
        inputSchema: { sessionId: z.string().min(1), approvalId: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: decision === "approve", openWorldHint: false },
      },
      guard(async (a: { sessionId: string; approvalId: string }) => decideApproval(hub, a.sessionId, a.approvalId.trim(), decision)),
    );
  }
}
