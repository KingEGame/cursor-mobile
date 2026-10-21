import { Router, type Request, type Response, type NextFunction } from "express";
import type { HubContext } from "../config.js";
import {
  baseUrlHint,
  buildQrPayload,
  resolveWorkspaceFromConfig,
} from "../config.js";
import { ApiError } from "../errors.js";
import { requirePaired } from "../auth.js";
import {
  clientRemoteAddress,
  isLocalClient,
  requireLocal,
  requireLocalOrSyntheticFlag,
} from "../local-guard.js";
import { hashBody } from "../idempotency.js";
import type { CommandFailureCode } from "@cursor-mobile/live-cursor";
import { parseDesktopComposerChatId } from "@cursor-mobile/history";
import { findModel, parseModelsEnv } from "../workspace/models.js";
import {
  readWorkspaceFilePreview,
  searchWorkspaceFiles,
  validateAttachmentPaths,
} from "../workspace/files.js";
import { buildToolsSummary } from "../workspace/tools.js";
import { agentComposerId, buildAgentsResponse, composerOptionsFromBody } from "../agents.js";
import type { SessionCreateInput } from "../session-create-queue.js";
import { lookupLatestRelease } from "../app-release.js";

/** Drain pending New-session creates when liveAdapter is cdp_ok. */
export async function drainSessionCreateQueueForCtx(
  ctx: HubContext,
): Promise<{
  skipped: boolean;
  flushedIds: string[];
  failedIds: string[];
  pending: number;
  lastDrained: ReturnType<HubContext["sessionCreateQueue"]["snapshot"]>["lastDrained"];
}> {
  const health = await ctx.live.getHealth();
  const isCdpOk = health.state === "cdp_ok";
  const result = await ctx.sessionCreateQueue.drain({
    isCdpOk,
    createSession: async (input: SessionCreateInput) => {
      const created = await ctx.live.createSession(input);
      if (!created.ok) {
        return {
          ok: false as const,
          code: created.code,
          message: created.message,
          details: created.details,
        };
      }
      ctx.attachments.seed(created.id, created.attachments);
      ctx.lastSessionCreateAttempt = {
        at: new Date().toISOString(),
        promptLen: input.prompt?.length ?? 0,
        promptPrefix: (input.prompt ?? "").slice(0, 64),
        attachmentCount: input.attachments.length,
        model: input.model,
        ok: true,
        queued: false,
      };
      ctx.ws?.broadcast({
        type: "session.updated",
        sessionId: created.id,
        session: {
          id: created.id,
          workspaceId: created.workspaceId,
          mode: "live",
          title: created.title,
          pendingApprovals: 0,
        },
      });
      ctx.ws?.broadcast({
        type: "session_create_queue.drained",
        sessionId: created.id,
        queuePending: ctx.sessionCreateQueue.pendingCount(),
      });
      return { ok: true as const, id: created.id };
    },
  });
  return {
    skipped: result.skipped,
    flushedIds: result.flushedIds,
    failedIds: result.failedIds,
    pending: ctx.sessionCreateQueue.pendingCount(),
    lastDrained: result.lastDrained,
  };
}

async function healthHandler(ctx: HubContext, _req: Request, res: Response) {
  const health = await ctx.live.getHealth();
  const probe = health.probe;
  const workspace = resolveWorkspaceFromConfig(ctx.config);
  const bound = workspace.workspaceId !== null;

  // Best-effort drain while operator polls health (cdp_ok recovery).
  if (health.state === "cdp_ok" && ctx.sessionCreateQueue.pendingCount() > 0) {
    try {
      await drainSessionCreateQueueForCtx(ctx);
    } catch (err) {
      console.warn("[hub] session create queue drain on health failed", err);
    }
  }

  res.status(200).json({
    ok: true,
    version: ctx.config.hubVersion,
    apiVersion: ctx.config.apiVersion,
    time: new Date().toISOString(),
    hub: {
      status: "up",
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
      // Which PC answered — the phone keeps one Account → Computer entry per hubId.
      displayName: ctx.config.hubDisplayName,
      hubId: ctx.config.hubId,
    },
    cdp: {
      status: probe.status,
      urlConfigured: probe.urlConfigured,
      lastAttachAt: probe.lastAttachAt ?? health.attachedAt,
      error: probe.error,
    },
    cursor: {
      status: probe.cursor.status,
      windowsDetected: probe.cursor.windowsDetected,
    },
    liveAdapter: {
      state: health.state,
      cdpUrl: health.cdpUrl,
      selectorPack: health.selectorPack,
      windowId: health.windowId,
      workspaceId: workspace.workspaceId,
      extractorReady: health.extractorReady,
      lastError: health.lastError,
      actions: health.actions ?? null,
      sendMessageVerified: health.sendMessageVerified === true,
      lastSessionCreateAttempt: ctx.lastSessionCreateAttempt,
    },
    sessionCreateQueue: ctx.sessionCreateQueue.snapshot(),
    history: await ctx.history.getStatus(
      workspace.workspaceId ?? undefined,
    ),
    workspace: bound
      ? {
          bound: true,
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          path: workspace.path,
        }
      : {
          bound: false,
          workspaceId: null,
          name: null,
          path: null,
        },
    pairing: {
      required: ctx.config.pairingRequired,
      devicesPaired: ctx.pairing.pairedCount(),
    },
  });
}

function pairStartHandler(ctx: HubContext, req: Request, res: Response) {
  const ttlSec =
    typeof req.body?.ttlSec === "number" && req.body.ttlSec > 0
      ? req.body.ttlSec
      : ctx.config.pairingCodeTtlSec;
  const label =
    typeof req.body?.label === "string" && req.body.label.trim()
      ? req.body.label.trim()
      : ctx.config.hubDisplayName;

  const pending = ctx.pairing.start({ ttlSec, label });
  res.status(201).json({
    pairId: pending.pairId,
    code: pending.code,
    qrPayload: buildQrPayload(ctx.config, pending),
    expiresAt: pending.expiresAt.toISOString(),
  });
}

function pairConfirmHandler(ctx: HubContext, req: Request, res: Response) {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const pairId =
    typeof req.body?.pairId === "string" ? req.body.pairId.trim() : undefined;
  const deviceName =
    typeof req.body?.deviceName === "string" ? req.body.deviceName.trim() : "";
  const platform = req.body?.platform;
  const appVersion =
    typeof req.body?.appVersion === "string" ? req.body.appVersion.trim() : "";

  if (!code) {
    throw new ApiError(400, "PAIR_CODE_INVALID", "code is required");
  }
  if (!deviceName) {
    throw new ApiError(400, "VALIDATION_ERROR", "deviceName is required");
  }
  if (platform !== "android") {
    throw new ApiError(400, "VALIDATION_ERROR", 'platform must be "android"');
  }
  if (!appVersion) {
    throw new ApiError(400, "VALIDATION_ERROR", "appVersion is required");
  }

  // Wrong codes from one address are limited; the pair page on the PC is loopback-only, so a
  // mesh peer guessing codes is the only caller that trips this.
  const caller = clientRemoteAddress(req) ?? "unknown";
  const retryAfter = ctx.pairLimiter.retryAfterSec(caller);
  if (retryAfter > 0) {
    res.setHeader("Retry-After", String(retryAfter));
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `Too many wrong pair codes from this phone. Wait ${retryAfter}s, then get a new code on the PC pair page.`,
      { bucket: "pair", retryAfterSec: retryAfter },
    );
  }

  const found = ctx.pairing.lookupPending(code, pairId);
  if (!found.ok) {
    ctx.pairLimiter.recordFailure(caller);
    const pc = ctx.config.hubDisplayName;
    const message =
      found.reason === "unknown_pair"
        ? `This QR is not known to ${pc}. Either the Hub on ${pc} restarted after the QR was shown, or the QR belongs to another PC. On the PC, reload the pair page and scan again.`
        : found.reason === "code_mismatch"
          ? `The code does not match this QR. On the PC, reload the pair page and scan the new QR.`
          : `No pending code ${code} on ${pc}. Check the PC address you typed matches the pair page on that PC, then type the code shown there.`;
    throw new ApiError(400, "PAIR_CODE_INVALID", message, {
      reason: found.reason,
      hubId: ctx.config.hubId,
      hubDisplayName: pc,
    });
  }
  const pending = found.pending;

  try {
    const device = ctx.pairing.complete(pending, {
      deviceName,
      platform: "android",
      appVersion,
      tokenTtlSec: ctx.config.pairingTokenTtlSec,
    });
    res.status(201).json({
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      tokenType: "Bearer",
      expiresAt: device.expiresAt,
      hub: {
        displayName: pending.label || ctx.config.hubDisplayName,
        baseUrlHint: baseUrlHint(ctx.config),
        hubId: ctx.config.hubId,
      },
    });
    ctx.pairLimiter.clear(caller);
  } catch (err) {
    const codeName =
      err instanceof Error && "code" in err
        ? String((err as { code: string }).code)
        : "PAIR_FAILED";
    if (codeName === "PAIR_CODE_EXPIRED") {
      throw new ApiError(410, "PAIR_CODE_EXPIRED", "Pairing code expired");
    }
    if (codeName === "PAIR_CODE_USED") {
      throw new ApiError(409, "PAIR_CODE_USED", "Pairing code already used");
    }
    throw err;
  }
}

function workspaceHandler(ctx: HubContext, _req: Request, res: Response) {
  const snapshot = resolveWorkspaceFromConfig(ctx.config);
  res.status(200).json(snapshot);
}

function requireBoundWorkspace(ctx: HubContext) {
  const snapshot = resolveWorkspaceFromConfig(ctx.config);
  if (snapshot.workspaceId === null) {
    throw new ApiError(
      409,
      "EMPTY_WORKSPACE",
      "Open a project in Cursor on the PC",
    );
  }
  return snapshot;
}

async function workspaceModelsHandler(
  ctx: HubContext,
  _req: Request,
  res: Response,
) {
  const snapshot = requireBoundWorkspace(ctx);
  const envModels = parseModelsEnv(ctx.config.cursorModels);
  const envSource = ctx.config.cursorModels ? "env" : "env_stub_default";

  // Prefer live Composer picker scrape when CDP + model_select are ready.
  let scrapeNote: string | undefined;
  try {
    const health = await ctx.live.getHealth();
    if (
      health.state === "cdp_ok" &&
      health.actions?.model_select === "VERIFIED"
    ) {
      const scraped = await ctx.live.scrapeModels();
      if (scraped.ok && scraped.models.length > 0) {
        res.status(200).json({
          workspaceId: snapshot.workspaceId,
          models: scraped.models,
          source: "cdp_scrape",
          updatedAt: new Date().toISOString(),
          domSelectVerified: true,
          strategy: scraped.strategy,
          note: "Models scraped from Cursor Composer model picker via CDP (domSelectVerified=true).",
        });
        return;
      }
      scrapeNote = scraped.ok
        ? "CDP scrape returned empty model list"
        : `CDP scrape failed: ${scraped.message ?? scraped.code ?? "unknown"}`;
    } else {
      scrapeNote = `CDP scrape skipped (live=${health.state}, model_select=${health.actions?.model_select ?? "n/a"})`;
    }
  } catch (err) {
    // Fall through to env catalog — never fail the route on scrape errors.
    scrapeNote =
      err instanceof Error ? `CDP scrape threw: ${err.message}` : "CDP scrape threw";
  }

  const emptyForced =
    envModels.length === 0 &&
    (ctx.config.cursorModels === "__empty__" ||
      (ctx.config.cursorModels ?? "").trim().toLowerCase() === "__none__");

  res.status(200).json({
    workspaceId: snapshot.workspaceId,
    models: envModels,
    source: emptyForced ? "env_empty" : envSource,
    updatedAt: new Date().toISOString(),
    /** Env fallback — live CDP scrape did not succeed this request. */
    domSelectVerified: false,
    note: (emptyForced
      ? "EMPTY: CURSOR_MODELS=__empty__ — no models catalog (AC-050-03). Unset sentinel or restore CDP scrape."
      : envSource === "env"
        ? "FALLBACK: models from CURSOR_MODELS on the PC Hub — CDP scrape unavailable (domSelectVerified=false)."
        : "FALLBACK: built-in Hub defaults (composer, auto). Override with CURSOR_MODELS on the PC. CDP scrape unavailable (domSelectVerified=false).") +
      (scrapeNote ? ` [${scrapeNote}]` : ""),
  });
}

async function workspaceFilesHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const snapshot = requireBoundWorkspace(ctx);
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const root = typeof req.query.root === "string" ? req.query.root : undefined;
  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limitRaw =
    typeof req.query.limit === "string"
      ? Number.parseInt(req.query.limit, 10)
      : undefined;

  const { items, nextCursor } = searchWorkspaceFiles({
    roots: snapshot.roots,
    rootPath: snapshot.path,
    q,
    rootFilter: root,
    limit: limitRaw,
    cursor,
  });

  res.status(200).json({
    workspaceId: snapshot.workspaceId,
    items,
    nextCursor,
    roots: snapshot.roots,
    note: "DESIGNED: filesystem scan of bound workspace roots (CURSOR_WORKSPACE / CURSOR_WORKSPACE_ROOTS / .code-workspace); skips node_modules/.git/dist. Not a CDP @-mention index.",
  });
}

/**
 * Optional Phase 3 — text preview for Editor browse (FR-070).
 * GET /v1/workspace/file?path=relative/under/roots
 */
async function workspaceFilePreviewHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const snapshot = requireBoundWorkspace(ctx);
  const pathParam =
    typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (!pathParam) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "path query parameter is required (relative to workspace root)",
    );
  }

  try {
    const preview = readWorkspaceFilePreview({
      roots: snapshot.roots,
      rootPath: snapshot.path,
      relativePath: pathParam,
    });
    res.status(200).json({
      workspaceId: snapshot.workspaceId,
      ...preview,
      note:
        preview.note ??
        "Optional Phase 3 text preview — not a code-server / full IDE. Edit on the PC in Cursor.",
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "READ_FAILED";
    if (code === "PATH_OUTSIDE_ROOT") {
      throw new ApiError(
        400,
        "PATH_OUTSIDE_ROOT",
        "File path must stay under the PC-open workspace roots",
      );
    }
    if (code === "FILE_NOT_FOUND" || code === "NOT_A_FILE") {
      throw new ApiError(404, "FILE_NOT_FOUND", `No file at ${pathParam}`);
    }
    if (code === "EMPTY_PATH") {
      throw new ApiError(400, "VALIDATION_ERROR", "path must not be empty");
    }
    throw new ApiError(500, "READ_FAILED", `Cannot read ${pathParam}`);
  }
}

async function workspaceToolsHandler(
  ctx: HubContext,
  _req: Request,
  res: Response,
) {
  const snapshot = requireBoundWorkspace(ctx);
  const health = await ctx.live.getHealth();
  const summary = buildToolsSummary({
    health,
    mcpServersEnv: ctx.config.cursorMcpServers,
    pluginsEnv: ctx.config.cursorPlugins,
  });

  res.status(200).json({
    workspaceId: snapshot.workspaceId,
    summary,
    liveAdapter: {
      state: health.state,
      extractorReady: health.extractorReady,
    },
    /** Inventory is env/DESIGNED — not a live CDP MCP scrape. */
    source: ctx.config.cursorMcpServers || ctx.config.cursorPlugins
      ? "env"
      : "env_stub_default",
    updatedAt: new Date().toISOString(),
  });
}

function requireIdempotencyKey(req: Request): string {
  const key = req.header("idempotency-key")?.trim();
  if (!key) {
    throw new ApiError(
      400,
      "IDEMPOTENCY_KEY_MISSING",
      "Idempotency-Key header is required",
    );
  }
  return key;
}

async function sessionsListHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const snapshot = resolveWorkspaceFromConfig(ctx.config);
  if (snapshot.workspaceId === null) {
    throw new ApiError(
      409,
      "EMPTY_WORKSPACE",
      "Open a project in Cursor on the PC",
    );
  }

  const workspaceId =
    typeof req.query.workspaceId === "string"
      ? req.query.workspaceId.trim()
      : "";
  if (!workspaceId) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "workspaceId query parameter is required",
    );
  }
  if (workspaceId !== snapshot.workspaceId) {
    throw new ApiError(
      400,
      "FOREIGN_WORKSPACE",
      "workspaceId must match the PC-open project",
    );
  }

  const modeRaw =
    typeof req.query.mode === "string" ? req.query.mode.trim() : "all";
  const mode = modeRaw || "all";
  const limitRaw =
    typeof req.query.limit === "string"
      ? Number.parseInt(req.query.limit, 10)
      : 100;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;

  type ListItem = {
    id: string;
    workspaceId: string;
    mode: "live" | "history" | "editor";
    title: string;
    preview: string | null;
    model: string | null;
    updatedAt: string;
    createdAt: string;
    pendingApprovals: number;
    correlationKey?: string;
  };

  let items: ListItem[] = [];

  if (mode === "live" || mode === "all") {
    const live = await ctx.live.listLiveSessions(workspaceId);
    items = live.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId || workspaceId,
      mode: "live" as const,
      title: s.title,
      preview: s.preview,
      model: s.model,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      pendingApprovals: s.pendingApprovals,
    }));
  }

  if (mode === "history" || mode === "all") {
    const history = await ctx.history.listSessions({
      workspaceId,
      workspacePath: snapshot.path,
      limit,
    });
    const historyItems: ListItem[] = history.map((s) => ({
      id: s.sessionId,
      workspaceId: s.workspaceId || workspaceId,
      mode: "history" as const,
      title: s.title,
      preview: s.preview,
      model: s.model,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      pendingApprovals: 0,
      correlationKey: s.correlationKey,
    }));
    if (mode === "history") {
      items = historyItems;
    } else {
      // Prefer live when both exist for same correlationKey (TOR-07 §11).
      const liveKeys = new Set(
        items
          .map((i) => i.correlationKey)
          .filter((k): k is string => Boolean(k)),
      );
      for (const h of historyItems) {
        if (h.correlationKey && liveKeys.has(h.correlationKey)) continue;
        items.push(h);
      }
    }
  }

  if (mode === "editor") {
    items = [];
  }

  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (items.length > limit) items = items.slice(0, limit);

  const health = await ctx.live.getHealth();
  const historyStatus = await ctx.history.getStatus(workspaceId);
  res.status(200).json({
    workspaceId,
    items,
    nextCursor: null,
    liveAdapter: {
      state: health.state,
      extractorReady: health.extractorReady,
    },
    history: {
      ok: historyStatus.ok,
      extractorStale: historyStatus.extractorStale,
      sessionCountForBind: historyStatus.sessionCountForBind,
      lastScanAt: historyStatus.lastScanAt,
    },
  });
}

function pathParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

async function sessionsGetHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const id = pathParam(req.params.id);
  const snapshot = resolveWorkspaceFromConfig(ctx.config);
  const session = await ctx.live.getLiveSession(id);
  if (session) {
    const health = await ctx.live.getHealth();
    const canMutate = health.state === "cdp_ok";
    const attachments = ctx.attachments.get(id);
    res.status(200).json({
      id: session.id,
      workspaceId: session.workspaceId,
      mode: "live",
      title: session.title,
      model: session.model,
      agentMode: "agent",
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      attachments,
      transcript: {
        messages: [],
        truncated: false,
        nextCursor: null,
      },
      capabilities: {
        canMessage: canMutate,
        canApprove: canMutate,
        canAttach: canMutate,
        canOpenOnPc: false,
      },
      liveAdapter: {
        state: health.state,
        extractorReady: health.extractorReady,
      },
    });
    return;
  }

  const history = await ctx.history.getSession(id);
  if (!history) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `Unknown session ${id}`);
  }
  res.status(200).json({
    id: history.sessionId,
    workspaceId: history.workspaceId || snapshot.workspaceId,
    mode: "history",
    title: history.title,
    model: history.model,
    agentMode: history.model,
    createdAt: history.createdAt,
    updatedAt: history.updatedAt,
    attachments: [],
    transcript: {
      messages: history.messages.map((m) => ({
        id: m.messageId,
        role: m.role === "tool" ? "system" : m.role,
        content: m.content,
        createdAt: m.createdAt,
        status: "completed" as const,
      })),
      truncated: history.truncated,
      nextCursor: null,
    },
    capabilities: {
      canMessage: false,
      canApprove: false,
      canAttach: false,
      canOpenOnPc: history.capabilities.canOpenOnPc,
    },
    source: {
      backend: history.backend,
      nativeKeyFingerprint: history.nativeKeyFingerprint,
    },
  });
}

async function sessionsMessagesGetHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const id = pathParam(req.params.id);
  const limitRaw =
    typeof req.query.limit === "string"
      ? Number.parseInt(req.query.limit, 10)
      : 200;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200;

  const liveSession = await ctx.live.getLiveSession(id);
  if (liveSession) {
    res.status(200).json({
      sessionId: id,
      mode: "live",
      messages: [],
      truncated: false,
      nextCursor: null,
      note: "Live messages stream over /ws; REST snapshot not populated",
    });
    return;
  }

  const packed = await ctx.history.getMessages(id, { limit });
  if (!packed) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `Unknown session ${id}`);
  }
  res.status(200).json({
    sessionId: packed.sessionId,
    mode: "history",
    messages: packed.messages.map((m) => ({
      id: m.messageId,
      role: m.role === "tool" ? "system" : m.role,
      content: m.content,
      createdAt: m.createdAt,
      status: "completed" as const,
    })),
    truncated: packed.truncated,
    nextCursor: null,
  });
}

async function sessionsOpenOnPcHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const id = pathParam(req.params.id);
  const key = requireIdempotencyKey(req);

  const existing = ctx.idempotency.get(`POST /sessions/${id}/open-on-pc`, key);
  if (existing) {
    const bodyHash = hashBody(req.body ?? {});
    if (existing.bodyHash !== bodyHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSE",
        "Idempotency-Key reused with a different body",
      );
    }
    res.status(existing.status).json(existing.response);
    return;
  }

  const snapshot = resolveWorkspaceFromConfig(ctx.config);
  if (snapshot.workspaceId === null) {
    throw new ApiError(
      409,
      "EMPTY_WORKSPACE",
      "Open a project in Cursor on the PC",
    );
  }

  const liveExisting = await ctx.live.getLiveSession(id);
  if (liveExisting) {
    const response = {
      id: liveExisting.id,
      sessionId: liveExisting.id,
      workspaceId: liveExisting.workspaceId || snapshot.workspaceId,
      mode: "live" as const,
      previousMode: "live" as const,
      openedAt: new Date().toISOString(),
      note: "Session already live",
    };
    ctx.idempotency.put({
      key,
      route: `POST /sessions/${id}/open-on-pc`,
      bodyHash: hashBody(req.body ?? {}),
      status: 200,
      response,
      createdAt: Date.now(),
    });
    res.status(200).json(response);
    return;
  }

  const history = await ctx.history.getSession(id);
  if (!history) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `Unknown session ${id}`);
  }

  const health = await ctx.live.getHealth();
  if (health.state === "cursor_down") {
    throw new ApiError(
      503,
      "OPEN_ON_PC_CDP_DOWN",
      "Cannot open on PC — Cursor/CDP unavailable",
      { liveAdapterState: health.state, strategyAttempted: "ui_reopen" },
    );
  }

  const composerChatId = parseDesktopComposerChatId(history.sessionId);
  type StrategyBStatus =
    | "not_attempted"
    | "applied"
    | "selector_candidate"
    | "no_composer_chat_id"
    | "cdp_input_failed"
    | "unsupported";

  let strategyB: {
    attempted: boolean;
    status: StrategyBStatus;
    composerChatId: string | null;
    code?: string;
    message?: string;
    actionStatus?: string;
  } = {
    attempted: false,
    status: composerChatId ? "not_attempted" : "no_composer_chat_id",
    composerChatId,
  };

  // TOR-07 §9.3 — Prefer B (Composer UI reopen) when we have a desktop chat id.
  if (composerChatId && typeof ctx.live.reopenComposerContext === "function") {
    const reopen = await ctx.live.reopenComposerContext({
      workspaceId: snapshot.workspaceId,
      historySessionId: history.sessionId,
      composerChatId,
      title: history.title,
      correlationKey: history.correlationKey,
      model: history.model,
    });

    if (reopen.ok) {
      const response = {
        id: reopen.id,
        sessionId: reopen.id,
        workspaceId: reopen.workspaceId,
        mode: "live" as const,
        previousMode: "history" as const,
        historySessionId: history.sessionId,
        composerChatId: reopen.composerChatId,
        strategy: "ui_reopen" as const,
        openedAt: new Date().toISOString(),
        domApplied: reopen.domApplied,
        strategyB: {
          attempted: true,
          status: "applied" as const,
          composerChatId: reopen.composerChatId,
        },
        note:
          reopen.note ||
          "Opened existing Composer chat via UI reopen (strategy B)",
      };
      ctx.idempotency.put({
        key,
        route: `POST /sessions/${id}/open-on-pc`,
        bodyHash: hashBody(req.body ?? {}),
        status: 200,
        response,
        createdAt: Date.now(),
      });
      ctx.ws?.broadcast({
        type: "session.mode.changed",
        sessionId: reopen.id,
        mode: "live",
        previousMode: "history",
        historySessionId: history.sessionId,
        strategy: "ui_reopen",
      });
      res.status(200).json(response);
      return;
    }

    if (reopen.code === "CURSOR_DOWN") {
      throw new ApiError(
        503,
        "OPEN_ON_PC_CDP_DOWN",
        reopen.message || "Cannot open on PC — Cursor/CDP unavailable",
        {
          liveAdapterState: "cursor_down",
          strategyAttempted: "ui_reopen",
          composerChatId,
          details: reopen.details,
        },
      );
    }

    const details =
      reopen.details && typeof reopen.details === "object"
        ? (reopen.details as Record<string, unknown>)
        : {};
    if (
      reopen.code === "EXTRACTOR_STALE" ||
      details.code === "OPEN_ON_PC_SELECTOR_CANDIDATE"
    ) {
      strategyB = {
        attempted: true,
        status: "selector_candidate",
        composerChatId,
        code: "OPEN_ON_PC_SELECTOR_CANDIDATE",
        message: reopen.message,
        actionStatus:
          typeof details.actionStatus === "string"
            ? details.actionStatus
            : "CANDIDATE",
      };
    } else if (reopen.code === "VALIDATION_ERROR") {
      strategyB = {
        attempted: true,
        status: "no_composer_chat_id",
        composerChatId,
        code: reopen.code,
        message: reopen.message,
      };
    } else {
      strategyB = {
        attempted: true,
        status: "cdp_input_failed",
        composerChatId,
        code: reopen.code,
        message: reopen.message,
      };
    }
  }

  // Best-effort strategy C (TOR-07 §9.3): new live + history context.
  // Used when B is CANDIDATE / failed / unavailable — never claim UI reopen.
  const prompt = [
    `[Open on PC] Continue history session "${history.title}"`,
    history.preview ? `Context: ${history.preview}` : null,
    `(historyId=${history.sessionId}; correlation=${history.correlationKey}` +
      (composerChatId ? `; composerChatId=${composerChatId}` : "") +
      `)`,
  ]
    .filter(Boolean)
    .join("\n");

  const created = await ctx.live.createSession({
    workspaceId: snapshot.workspaceId,
    model: history.model || "default",
    prompt,
    agentMode: "agent",
  });

  if (!created.ok) {
    if (created.code === "CURSOR_DOWN") {
      throw new ApiError(503, "OPEN_ON_PC_CDP_DOWN", created.message, {
        strategyAttempted: "new_live_context",
        strategyB,
      });
    }
    throw new ApiError(
      501,
      "OPEN_ON_PC_UNSUPPORTED",
      created.message ||
        "Live adapter could not reopen this history session on PC",
      { ...((created.details as object) ?? {}), strategyB },
    );
  }

  const caveat =
    strategyB.status === "selector_candidate"
      ? "Composer UI reopen (strategy B) blocked — composer_history_open still CANDIDATE; continued as new live session with history context (strategy C)"
      : strategyB.status === "no_composer_chat_id"
        ? "No desktop Composer chat id for UI reopen; continued as new live session with history context (strategy C)"
        : strategyB.status === "cdp_input_failed"
          ? "Composer UI reopen (strategy B) failed on CDP input; continued as new live session with history context (strategy C)"
          : "Opened as new live session with history context (Composer UI reopen not applied)";

  const response = {
    id: created.id,
    sessionId: created.id,
    workspaceId: created.workspaceId,
    mode: "live" as const,
    previousMode: "history" as const,
    historySessionId: history.sessionId,
    composerChatId,
    strategy: "new_live_context" as const,
    openedAt: new Date().toISOString(),
    domApplied: created.domApplied,
    strategyB,
    note: created.note ? `${caveat}. ${created.note}` : caveat,
  };

  ctx.idempotency.put({
    key,
    route: `POST /sessions/${id}/open-on-pc`,
    bodyHash: hashBody(req.body ?? {}),
    status: 200,
    response,
    createdAt: Date.now(),
  });

  ctx.ws?.broadcast({
    type: "session.mode.changed",
    sessionId: created.id,
    mode: "live",
    previousMode: "history",
    historySessionId: history.sessionId,
    strategy: "new_live_context",
  });

  res.status(200).json(response);
}

async function sessionsCreateHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const snapshot = requireBoundWorkspace(ctx);
  const workspaceId =
    typeof req.body?.workspaceId === "string" ? req.body.workspaceId.trim() : "";
  if (!workspaceId || workspaceId !== snapshot.workspaceId) {
    throw new ApiError(
      400,
      "FOREIGN_WORKSPACE",
      "workspaceId must match the PC-open project",
    );
  }

  const model =
    typeof req.body?.model === "string" ? req.body.model.trim() : "";
  if (!model) {
    throw new ApiError(400, "VALIDATION_ERROR", "model is required");
  }

  const catalog = parseModelsEnv(ctx.config.cursorModels);
  if (!findModel(catalog, model)) {
    throw new ApiError(
      400,
      "MODEL_UNAVAILABLE",
      `Model "${model}" is not in the local Hub model list`,
      { available: catalog.map((m) => m.id) },
    );
  }

  const rawAttachments = Array.isArray(req.body?.attachments)
    ? (req.body.attachments as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  const validated = validateAttachmentPaths(snapshot.roots, rawAttachments);
  if (validated.invalid.length > 0) {
    throw new ApiError(
      400,
      "ATTACHMENT_OUTSIDE_ROOTS",
      "One or more attachment paths are outside workspace roots or missing",
      { paths: validated.invalid },
    );
  }
  const attachments = validated.ok;

  const prompt =
    typeof req.body?.prompt === "string" ? req.body.prompt : undefined;
  const agentMode =
    typeof req.body?.agentMode === "string" ? req.body.agentMode : undefined;

  const idemKey = requireIdempotencyKey(req);
  const existing = ctx.idempotency.get("POST /sessions", idemKey);
  if (existing) {
    const bodyHash = hashBody(req.body);
    if (existing.bodyHash !== bodyHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSE",
        "Idempotency-Key reused with a different body",
      );
    }
    res.status(existing.status).json(existing.response);
    return;
  }

  const result = await ctx.live.createSession({
    workspaceId,
    model,
    attachments,
    prompt,
    agentMode,
  });

  ctx.lastSessionCreateAttempt = {
    at: new Date().toISOString(),
    promptLen: prompt?.length ?? 0,
    promptPrefix: (prompt ?? "").slice(0, 64),
    attachmentCount: attachments.length,
    model,
    ok: result.ok,
    code: result.ok ? undefined : result.code,
  };

  if (!result.ok) {
    if (result.code === "CURSOR_DOWN") {
      const { item, deduped } = ctx.sessionCreateQueue.enqueue({
        workspaceId,
        model,
        attachments,
        prompt,
        agentMode,
        idempotencyKey: idemKey,
      });
      ctx.lastSessionCreateAttempt = {
        at: new Date().toISOString(),
        promptLen: prompt?.length ?? 0,
        promptPrefix: (prompt ?? "").slice(0, 64),
        attachmentCount: attachments.length,
        model,
        ok: false,
        code: "CURSOR_DOWN",
        queued: true,
        queueId: item.id,
      };
      const queuedBody = {
        queued: true as const,
        queueId: item.id,
        deduped,
        status: item.status,
        workspaceId,
        model,
        attachments,
        prompt: prompt ?? null,
        promptLen: prompt?.length ?? 0,
        agentMode: agentMode ?? null,
        note:
          "Queued on Hub until liveAdapter is cdp_ok — PC-local retry; no cloud",
      };
      // Cache 202 under idempotency so retries do not double-enqueue.
      ctx.idempotency.put({
        key: idemKey,
        route: "POST /sessions",
        bodyHash: hashBody(req.body),
        status: 202,
        response: queuedBody,
        createdAt: Date.now(),
      });
      res.status(202).json(queuedBody);
      return;
    }
    throw new ApiError(502, result.code, result.message, result.details);
  }

  ctx.attachments.seed(result.id, result.attachments);

  const response = {
    id: result.id,
    sessionId: result.id,
    workspaceId: result.workspaceId,
    mode: result.mode,
    title: result.title,
    model: result.model,
    agentMode: result.agentMode,
    attachments: result.attachments,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    domApplied: result.domApplied,
    note:
      result.note ??
      (result.domApplied
        ? undefined
        : "Session registered on Hub via LiveCursorAdapter; Composer DOM not driven while extractor_stale."),
  };

  ctx.idempotency.put({
    key: idemKey,
    route: "POST /sessions",
    bodyHash: hashBody(req.body),
    status: 201,
    response,
    createdAt: Date.now(),
  });

  ctx.ws?.broadcast({
    type: "session.updated",
    sessionId: result.id,
    session: {
      id: result.id,
      workspaceId: result.workspaceId,
      mode: "live",
      title: result.title,
      pendingApprovals: 0,
    },
  });

  res.status(201).json(response);
}

async function sessionsAttachmentsHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const sessionId = pathParam(req.params.id);
  const key = requireIdempotencyKey(req);
  const snapshot = requireBoundWorkspace(ctx);

  const mode = req.body?.mode;
  if (mode !== "add") {
    throw new ApiError(400, "VALIDATION_ERROR", 'mode must be "add"');
  }

  const rawAttachments = Array.isArray(req.body?.attachments)
    ? (req.body.attachments as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  if (rawAttachments.length === 0) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "attachments must be a non-empty string array",
    );
  }

  const existing = ctx.idempotency.get(
    `POST /sessions/${sessionId}/attachments`,
    key,
  );
  if (existing) {
    const bodyHash = hashBody(req.body);
    if (existing.bodyHash !== bodyHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSE",
        "Idempotency-Key reused with a different body",
      );
    }
    res.status(existing.status).json(existing.response);
    return;
  }

  const session = await ctx.live.getLiveSession(sessionId);
  if (!session) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `Unknown session ${sessionId}`);
  }

  const health = await ctx.live.getHealth();
  if (health.state === "cursor_down") {
    throw new ApiError(
      503,
      "CDP_UNAVAILABLE",
      "Cannot attach files — Cursor CDP is down",
      { health: health.state },
    );
  }

  const validated = validateAttachmentPaths(snapshot.roots, rawAttachments);
  if (validated.invalid.length > 0) {
    throw new ApiError(
      400,
      "ATTACHMENT_OUTSIDE_ROOTS",
      "One or more attachment paths are outside workspace roots or missing",
      { paths: validated.invalid },
    );
  }

  // Gate CDP inject first (fail closed on cursor_down). Hub still registers when
  // file_attach is CANDIDATE — domApplied stays false until VERIFIED + inject.
  const inject = await ctx.live.attachFiles(sessionId, validated.ok);
  if (!inject.ok && inject.code === "CURSOR_DOWN") {
    throw new ApiError(503, "CDP_UNAVAILABLE", inject.message, inject.details);
  }
  if (!inject.ok && inject.code === "SESSION_NOT_FOUND") {
    throw new ApiError(404, "SESSION_NOT_FOUND", inject.message);
  }

  if (!ctx.attachments.has(sessionId)) {
    ctx.attachments.seed(sessionId, []);
  }
  const merged = ctx.attachments.add(sessionId, validated.ok);

  const domApplied = inject.ok ? inject.domApplied : false;
  const note =
    inject.ok && inject.note
      ? inject.note
      : !inject.ok && inject.code === "EXTRACTOR_STALE"
        ? "Hub registered paths under workspace roots; Composer DOM @-inject blocked until file_attach selector is VERIFIED."
        : domApplied
          ? "Composer DOM @-inject applied for verified file_attach."
          : "Hub registered paths under workspace roots; Composer DOM @-inject not applied (extractor_stale).";

  const response = {
    sessionId,
    attachments: merged.attachments,
    added: merged.added,
    domApplied,
    note,
  };

  ctx.idempotency.put({
    key,
    route: `POST /sessions/${sessionId}/attachments`,
    bodyHash: hashBody(req.body),
    status: 200,
    response,
    createdAt: Date.now(),
  });

  ctx.ws?.broadcast({
    type: "session.updated",
    sessionId,
    session: {
      id: sessionId,
      workspaceId: session.workspaceId || snapshot.workspaceId,
      mode: "live",
      title: session.title,
      pendingApprovals: session.pendingApprovals,
    },
  });

  res.status(200).json(response);
}

async function sessionsMessagesHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const sessionId = pathParam(req.params.id);
  const key = requireIdempotencyKey(req);
  const content =
    typeof req.body?.content === "string" ? req.body.content : "";
  if (!content.trim()) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "content must be a non-empty string",
    );
  }

  const replay = (() => {
    const existing = ctx.idempotency.get(
      `POST /sessions/${sessionId}/messages`,
      key,
    );
    if (!existing) return null;
    const bodyHash = hashBody(req.body);
    if (existing.bodyHash !== bodyHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSE",
        "Idempotency-Key reused with a different body",
      );
    }
    return existing;
  })();
  if (replay) {
    res.status(replay.status).json(replay.response);
    return;
  }

  const historyHit = await ctx.history.getSession(sessionId);
  if (historyHit) {
    throw new ApiError(
      409,
      "SESSION_NOT_LIVE",
      "Cannot post messages to a history session — use Open on PC first",
    );
  }

  const result = await ctx.live.sendMessage(sessionId, content);
  if (!result.ok) {
    mapCommandError(result.code, result.message, result.details);
  }

  const response = {
    messageId: result.messageId,
    sessionId: result.sessionId,
    role: result.role,
    content: result.content,
    status: result.status,
    createdAt: result.createdAt,
    domApplied: result.domApplied,
  };

  ctx.idempotency.put({
    key,
    route: `POST /sessions/${sessionId}/messages`,
    bodyHash: hashBody(req.body),
    status: 202,
    response,
    createdAt: Date.now(),
  });

  res.status(202).json(response);
}

async function sessionsApprovalsHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const sessionId = pathParam(req.params.id);
  const key = requireIdempotencyKey(req);
  const approvalId =
    typeof req.body?.approvalId === "string" ? req.body.approvalId.trim() : "";
  const decision = req.body?.decision;

  if (!approvalId) {
    throw new ApiError(400, "VALIDATION_ERROR", "approvalId is required");
  }
  if (decision !== "approve" && decision !== "deny") {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      'decision must be "approve" or "deny"',
    );
  }

  const existing = ctx.idempotency.get(
    `POST /sessions/${sessionId}/approvals`,
    key,
  );
  if (existing) {
    const bodyHash = hashBody(req.body);
    if (existing.bodyHash !== bodyHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSE",
        "Idempotency-Key reused with a different body",
      );
    }
    res.status(existing.status).json(existing.response);
    return;
  }

  const result = await ctx.live.applyApproval(sessionId, approvalId, decision);
  if (!result.ok) {
    mapCommandError(result.code, result.message, result.details);
  }

  const response = {
    approvalId: result.approvalId,
    sessionId: result.sessionId,
    decision: result.decision,
    status: result.status,
    appliedAt: result.appliedAt,
    domApplied: result.domApplied,
    synthetic: result.synthetic ?? false,
    note: result.note,
  };

  ctx.idempotency.put({
    key,
    route: `POST /sessions/${sessionId}/approvals`,
    bodyHash: hashBody(req.body),
    status: 200,
    response,
    createdAt: Date.now(),
  });

  ctx.ws?.broadcast({
    type: "session.approval.resolved",
    approvalId: result.approvalId,
    sessionId: result.sessionId,
    decision: result.decision,
    status: result.status,
  });

  res.status(200).json(response);
}

async function sessionsApprovalsListHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const sessionId = pathParam(req.params.id);
  const session = await ctx.live.getLiveSession(sessionId);
  if (!session) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `Unknown session ${sessionId}`);
  }
  const items = await ctx.live.listPendingApprovals(sessionId);
  res.status(200).json({
    sessionId,
    items: items.map((a) => ({
      approvalId: a.approvalId,
      sessionId: a.sessionId,
      tool: a.tool,
      summary: a.summary,
      argsPreview: a.argsPreview,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt ?? null,
      status: a.status,
      synthetic: a.synthetic,
    })),
  });
}

/**
 * Dev/UAT: enqueue a pending approval for phone decide smoke.
 * Gate: localhost OR HUB_ALLOW_SYNTHETIC_APPROVALS=1.
 *
 * Default: synthetic=true (no Cursor DOM click on decide).
 * Loopback-only: body.live=true → synthetic=false so decide clicks VERIFIED
 * approve/deny selectors against a real pending tool card.
 */
async function sessionsSyntheticApprovalHandler(
  ctx: HubContext,
  req: Request,
  res: Response,
) {
  const sessionId = pathParam(req.params.id);
  const session = await ctx.live.getLiveSession(sessionId);
  if (!session) {
    throw new ApiError(404, "SESSION_NOT_FOUND", `Unknown session ${sessionId}`);
  }

  const wantLive = req.body?.live === true || req.body?.synthetic === false;
  if (wantLive && !isLocalClient(req)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "live (non-synthetic) approval enqueue is loopback-only",
    );
  }
  const synthetic = !wantLive;

  const toolBody = req.body?.tool;
  let tool:
    | { name: string; server?: string | null; kind?: string | null }
    | undefined;
  if (typeof toolBody === "string" && toolBody.trim()) {
    tool = { name: toolBody.trim(), kind: synthetic ? "synthetic" : "shell" };
  } else if (toolBody && typeof toolBody === "object" && typeof toolBody.name === "string") {
    tool = {
      name: toolBody.name.trim() || (synthetic ? "synthetic.uat" : "Shell"),
      server: typeof toolBody.server === "string" ? toolBody.server : null,
      kind:
        typeof toolBody.kind === "string"
          ? toolBody.kind
          : synthetic
            ? "synthetic"
            : "shell",
    };
  }

  const summary =
    typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
  const approvalId =
    typeof req.body?.approvalId === "string"
      ? req.body.approvalId.trim()
      : undefined;

  let info;
  try {
    info = await ctx.live.enqueuePendingApproval({
      sessionId,
      approvalId: approvalId || undefined,
      tool: tool ?? {
        name: synthetic ? "synthetic.uat" : "Shell",
        kind: synthetic ? "synthetic" : "shell",
      },
      summary:
        summary ||
        (synthetic
          ? "Synthetic UAT pending approval (no live Cursor tool card)"
          : "Live tool card pending approval"),
      argsPreview: req.body?.argsPreview,
      synthetic,
    });
  } catch (err) {
    throw new ApiError(
      404,
      "SESSION_NOT_FOUND",
      err instanceof Error ? err.message : `Unknown session ${sessionId}`,
    );
  }

  ctx.ws?.broadcast({
    type: "session.approval.requested",
    approvalId: info.approvalId,
    sessionId: info.sessionId,
    tool: info.tool,
    summary: info.summary,
    argsPreview:
      info.argsPreview == null
        ? undefined
        : typeof info.argsPreview === "string"
          ? info.argsPreview
          : JSON.stringify(info.argsPreview),
    createdAt: info.createdAt,
    expiresAt: info.expiresAt ?? null,
    synthetic,
  });

  res.status(201).json({
    approvalId: info.approvalId,
    sessionId: info.sessionId,
    tool: info.tool,
    summary: info.summary,
    argsPreview: info.argsPreview,
    createdAt: info.createdAt,
    expiresAt: info.expiresAt ?? null,
    status: info.status,
    synthetic,
    note: synthetic
      ? "Synthetic UAT only — does not prove live Cursor DOM approve/deny"
      : "Live enqueue — decide should click VERIFIED approve/deny selectors",
  });
}

function mapCommandError(
  code: CommandFailureCode,
  message: string,
  details?: unknown,
): never {
  switch (code) {
    case "CURSOR_DOWN":
      throw new ApiError(503, "CDP_UNAVAILABLE", message, details);
    case "EXTRACTOR_STALE":
      throw new ApiError(503, "EXTRACTOR_STALE", message, details);
    case "SESSION_NOT_FOUND":
      throw new ApiError(404, "SESSION_NOT_FOUND", message, details);
    case "APPROVAL_NOT_FOUND":
      throw new ApiError(404, "APPROVAL_NOT_FOUND", message, details);
    case "APPROVAL_APPLY_FAILED":
      throw new ApiError(502, "APPROVAL_APPLY_FAILED", message, details);
    case "CDP_INPUT_FAILED":
      throw new ApiError(502, "CDP_INPUT_FAILED", message, details);
    case "VALIDATION_ERROR":
      throw new ApiError(400, "VALIDATION_ERROR", message, details);
    default: {
      const _exhaustive: never = code;
      throw new ApiError(502, String(_exhaustive), message, details);
    }
  }
}

function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Before typing into Cursor: if its agent runtime is stuck ("Agent Execution Timed Out"
 * + Reload Window), the prompt would time out and land back in the PC input box.
 * Refuse with a clear fix instead. Unreadable sidebar → let the send path decide.
 */
async function assertCursorCanRun(ctx: HubContext): Promise<void> {
  const sidebar = await ctx.live.scrapeSidebar();
  if (!sidebar.ok) return;
  const stuck = (sidebar.alerts ?? []).find((a) => a.needsReload);
  if (stuck) {
    throw new ApiError(
      409,
      "CURSOR_NEEDS_RELOAD",
      `Cursor on the PC shows "${stuck.title}" — its agent runtime is not responding. Click Reload Window in Cursor on the PC, then send again.`,
    );
  }
}

export function createApiRouter(ctx: HubContext): Router {
  const router = Router();

  router.get(
    "/health",
    asyncRoute(async (req, res) => healthHandler(ctx, req, res)),
  );

  router.post(
    "/pair/start",
    requireLocal(),
    asyncRoute((req, res) => pairStartHandler(ctx, req, res)),
  );

  // PC-only: revoke paired devices not seen recently (default: not since this Hub started).
  router.post(
    "/pair/prune",
    requireLocal(),
    asyncRoute(async (req, res) => {
      const minutes = Number(req.body?.notSeenForMinutes);
      const cutoff =
        Number.isFinite(minutes) && minutes > 0
          ? new Date(Date.now() - minutes * 60_000)
          : new Date(ctx.startedAt);
      const keep = Array.isArray(req.body?.keepDeviceIds)
        ? (req.body.keepDeviceIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const revoked = ctx.pairing.pruneStale(cutoff, keep);
      res.status(200).json({
        cutoff: cutoff.toISOString(),
        revokedCount: revoked.length,
        remaining: ctx.pairing.listDevices().filter((d) => !d.revoked).map((d) => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          lastSeenAt: d.lastSeenAt,
        })),
      });
    }),
  );

  const confirm = asyncRoute((req, res) => pairConfirmHandler(ctx, req, res));
  router.post("/pair/confirm", confirm);
  router.post("/pair/complete", confirm);

  router.get(
    "/agents",
    requirePaired(ctx),
    asyncRoute(async (_req, res) => {
      const sidebar = await ctx.live.scrapeSidebar();
      res.status(200).json(buildAgentsResponse(sidebar, ctx.agentsIndex));
    }),
  );

  // Read-only: files this chat changed (original → current disk) and one file's diff.
  router.get(
    "/agents/chats/:composerId/changes",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const files = ctx.agentsIndex.changes(composerId);
      if (!files) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown chat");
      res.status(200).json({ composerId, files });
    }),
  );

  router.get(
    "/agents/chats/:composerId/changes/:index",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const index = Number.parseInt(pathParam(req.params.index), 10);
      const diff = Number.isInteger(index) && index >= 0 ? ctx.agentsIndex.fileDiff(composerId, index) : null;
      if (!diff) throw new ApiError(404, "FILE_NOT_FOUND", "No such changed file for this chat");
      res.status(200).json(diff);
    }),
  );

  // Start a new chat in one sidebar project and send its first message.
  router.post(
    "/agents/projects/new",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const sectionId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!/^(workspace|repo):[\w.\-/:@]{1,200}$/.test(sectionId)) {
        throw new ApiError(400, "VALIDATION_ERROR", "projectId must be an Agents sidebar project id");
      }
      if (!text || text.length > 20_000) {
        throw new ApiError(400, "VALIDATION_ERROR", "text is required (max 20000 chars)");
      }
      const options = composerOptionsFromBody(req.body);
      await assertCursorCanRun(ctx);
      const result = await ctx.live.newAgentChat(sectionId, text, options);
      if (!result.ok) {
        const status =
          result.code === "PROJECT_NOT_IN_SIDEBAR"
            ? 404
            : result.code === "NEW_CHAT_FAILED" ||
                result.code === "MODE_NOT_APPLIED" ||
                result.code === "MODEL_NOT_APPLIED" ||
                result.code === "SEND_NOT_CONFIRMED" ||
                result.code === "MENTION_NOT_APPLIED" ||
                result.code === "IMAGE_NOT_ATTACHED" ||
                result.code === "COMPOSER_NOT_EMPTY"
              ? 409
              : 503;
        throw new ApiError(status, result.code, result.error);
      }
      res.status(202).json({
        ok: true,
        composerId: result.composerId ?? null,
        sessionId: result.composerId ? `hist_${result.composerId}` : null,
      });
    }),
  );

  // What Cursor offers after "@" (files, plugins…) or "/" (skills) — read from the PC menu.
  router.get(
    "/agents/chats/:composerId/mentions",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const trigger = req.query.trigger === "/" ? "/" : req.query.trigger === "@" ? "@" : null;
      if (!trigger) throw new ApiError(400, "VALIDATION_ERROR", "trigger must be @ or /");
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 80) : "";
      const result = await ctx.live.listAgentMentions(composerId, trigger, q);
      if (!result.ok) throw new ApiError(503, result.code, result.error);
      res.status(200).json({ trigger, query: q, options: result.options ?? [] });
    }),
  );

  // Edit one of the operator's earlier messages and resubmit (Cursor re-runs from there).
  router.put(
    "/agents/chats/:composerId/messages/:messageId",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const bubbleId = pathParam(req.params.messageId).replace(/^m_/, "");
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text || text.length > 20_000) {
        throw new ApiError(400, "VALIDATION_ERROR", "text is required (max 20000 chars)");
      }
      const result = await ctx.live.editAgentMessage(composerId, bubbleId, text);
      if (!result.ok) {
        const status =
          result.code === "MESSAGE_NOT_FOUND" || result.code === "CHAT_NOT_IN_SIDEBAR"
            ? 404
            : result.code === "EDIT_FAILED" || result.code === "CHAT_SWITCH_FAILED" || result.code === "SEND_NOT_CONFIRMED"
              ? 409
              : 503;
        throw new ApiError(status, result.code, result.error);
      }
      res.status(202).json({ ok: true, composerId, messageId: `m_${bubbleId}` });
    }),
  );

  /** PC composer text of this chat (readable only while the chat is open on the PC). */
  router.get(
    "/agents/chats/:composerId/draft",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const state = await ctx.live.readAgentDraft(composerId);
      res.status(200).json({ composerId, open: state.open, text: state.text, hasAttachments: state.hasAttachments });
    }),
  );

  /** Mirror the phone's draft into the PC composer; refuses (ok:false) unless the chat is open there. */
  router.put(
    "/agents/chats/:composerId/draft",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const text = typeof req.body?.text === "string" ? req.body.text : null;
      if (text === null) throw new ApiError(400, "VALIDATION_ERROR", "text is required");
      if (text.length > 20_000) throw new ApiError(400, "VALIDATION_ERROR", "text is too long (max 20000 chars)");
      const result = await ctx.live.writeAgentDraft(composerId, text);
      res.status(200).json({
        composerId,
        ok: result.ok,
        open: result.state.open,
        text: result.state.text,
        hasAttachments: result.state.hasAttachments,
      });
    }),
  );

  router.post(
    "/agents/chats/:composerId/open",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const result = await ctx.live.showAgentChat(composerId);
      if (!result.ok) {
        const status =
          result.code === "CHAT_NOT_IN_SIDEBAR"
            ? 404
            : result.code === "CHAT_SWITCH_FAILED" || result.code === "CURSOR_WINDOW_HIDDEN"
              ? 409
              : 503;
        throw new ApiError(status, result.code, result.error);
      }
      res.status(202).json({ ok: true, composerId, switchedOnPc: result.switched });
    }),
  );

  router.post(
    "/agents/chats/:composerId/stop",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = agentComposerId(req.params.composerId);
      const result = await ctx.live.stopAgentChat(composerId);
      if (!result.ok) {
        const status =
          result.code === "CHAT_NOT_IN_SIDEBAR" ? 404 : result.code === "NOT_RUNNING" ? 409 : result.code === "CHAT_SWITCH_FAILED" ? 409 : 503;
        throw new ApiError(status, result.code, result.error);
      }
      res.status(202).json({ ok: true, composerId, switchedOnPc: result.switched });
    }),
  );

  router.post(
    "/agents/chats/:composerId/messages",
    requirePaired(ctx),
    asyncRoute(async (req, res) => {
      const composerId = pathParam(req.params.composerId);
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) {
        throw new ApiError(400, "VALIDATION_ERROR", "text is required");
      }
      if (text.length > 20_000) {
        throw new ApiError(400, "VALIDATION_ERROR", "text is too long (max 20000 chars)");
      }
      const options = composerOptionsFromBody(req.body);
      await assertCursorCanRun(ctx);
      const result = await ctx.live.sendToAgentChat(composerId, text, options);
      if (!result.ok) {
        const status =
          result.code === "CHAT_NOT_IN_SIDEBAR"
            ? 404
            : result.code === "CHAT_SWITCH_FAILED" ||
                result.code === "MODE_NOT_APPLIED" ||
                result.code === "MODEL_NOT_APPLIED" ||
                result.code === "SEND_NOT_CONFIRMED" ||
                result.code === "MENTION_NOT_APPLIED" ||
                result.code === "IMAGE_NOT_ATTACHED" ||
                result.code === "COMPOSER_NOT_EMPTY" ||
                result.code === "CURSOR_WINDOW_HIDDEN"
              ? 409
              : 503;
        throw new ApiError(status, result.code, result.error);
      }
      res.status(202).json({ ok: true, composerId, switchedOnPc: result.switched });
    }),
  );

  router.get(
    "/workspace",
    requirePaired(ctx),
    asyncRoute((req, res) => workspaceHandler(ctx, req, res)),
  );

  router.get(
    "/workspace/models",
    requirePaired(ctx),
    asyncRoute(async (req, res) => workspaceModelsHandler(ctx, req, res)),
  );

  router.get(
    "/workspace/files",
    requirePaired(ctx),
    asyncRoute(async (req, res) => workspaceFilesHandler(ctx, req, res)),
  );

  router.get(
    "/workspace/file",
    requirePaired(ctx),
    asyncRoute(async (req, res) => workspaceFilePreviewHandler(ctx, req, res)),
  );

  router.get(
    "/workspace/tools",
    requirePaired(ctx),
    asyncRoute(async (req, res) => workspaceToolsHandler(ctx, req, res)),
  );

  router.get(
    "/sessions",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsListHandler(ctx, req, res)),
  );

  router.get(
    "/sessions/:id",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsGetHandler(ctx, req, res)),
  );

  router.get(
    "/sessions/:id/messages",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsMessagesGetHandler(ctx, req, res)),
  );

  router.post(
    "/sessions",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsCreateHandler(ctx, req, res)),
  );

  /** Loopback-only: drain queued creates when MAIN CDP is up (watcher / operator). */
  router.post(
    "/sessions/create-queue/drain",
    requireLocal(),
    asyncRoute(async (_req, res) => {
      const outcome = await drainSessionCreateQueueForCtx(ctx);
      res.status(200).json({
        ...outcome,
        queue: ctx.sessionCreateQueue.snapshot(),
      });
    }),
  );

  router.post(
    "/sessions/:id/messages",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsMessagesHandler(ctx, req, res)),
  );

  router.post(
    "/sessions/:id/open-on-pc",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsOpenOnPcHandler(ctx, req, res)),
  );

  router.post(
    "/sessions/:id/attachments",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsAttachmentsHandler(ctx, req, res)),
  );

  router.get(
    "/sessions/:id/approvals",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsApprovalsListHandler(ctx, req, res)),
  );

  router.post(
    "/sessions/:id/approvals/synthetic",
    requireLocalOrSyntheticFlag(ctx.config.allowSyntheticApprovals),
    asyncRoute(async (req, res) =>
      sessionsSyntheticApprovalHandler(ctx, req, res),
    ),
  );

  router.post(
    "/sessions/:id/approvals",
    requirePaired(ctx),
    asyncRoute(async (req, res) => sessionsApprovalsHandler(ctx, req, res)),
  );

  /**
   * Phone self-update (PC-local). Always 200 so the app can tell "nothing
   * published" from "Hub unreachable"; only a valid, complete release is offered.
   */
  router.get(
    "/app/latest",
    requirePaired(ctx),
    asyncRoute((_req, res) => {
      const found = lookupLatestRelease(ctx.config.hubReleasesDir);
      if (!found.ok) {
        res.status(200).json({ available: false, reason: found.reason, message: found.message });
        return;
      }
      const { apkFile: _apkFile, ...manifest } = found.manifest;
      res.status(200).json({ available: true, ...manifest, downloadPath: "/v1/app/apk" });
    }),
  );

  router.get(
    "/app/apk",
    requirePaired(ctx),
    asyncRoute((_req, res) => {
      const found = lookupLatestRelease(ctx.config.hubReleasesDir);
      if (!found.ok) {
        throw new ApiError(404, found.reason, found.message);
      }
      const { manifest, apkPath } = found;
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.setHeader("Content-Length", String(manifest.sizeBytes));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="cursor-mobile-${manifest.versionName}.apk"`,
      );
      res.setHeader("X-App-Version-Code", String(manifest.versionCode));
      res.setHeader("X-App-Sha256", manifest.sha256);
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(apkPath);
    }),
  );

  return router;
}
