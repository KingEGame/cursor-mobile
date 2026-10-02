import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  LiveCursorAdapterImpl,
  createLiveCursorAdapter,
  createMockLiveCursorAdapter,
} from "./adapter.js";
import { assertLoopbackCdpUrl } from "./loopback.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mockCdpServer(opts: {
  versionOk?: boolean;
  targets?: Array<Record<string, unknown>>;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/json/version")) {
      if (opts.versionOk === false) {
        res.writeHead(500);
        res.end("fail");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: "Cursor/mock", "Protocol-Version": "1.3" }));
      return;
    }
    if (req.url?.startsWith("/json/list")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(opts.targets ?? []));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind mock CDP");
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("loopback CDP guard", () => {
  it("rejects non-loopback CDP URLs", () => {
    expect(() => assertLoopbackCdpUrl("http://100.64.1.2:9222")).toThrow(
      /loopback/i,
    );
    expect(() => createLiveCursorAdapter("http://0.0.0.0:9222")).toThrow(
      /loopback/i,
    );
  });

  it("allows 127.0.0.1 and localhost", () => {
    expect(() => createLiveCursorAdapter("http://127.0.0.1:9222")).not.toThrow();
    expect(() => createLiveCursorAdapter("http://localhost:9222")).not.toThrow();
  });
});

describe("health triad", () => {
  it("cursor_down when CDP unreachable", async () => {
    const adapter = new LiveCursorAdapterImpl({
      cdpUrl: "http://127.0.0.1:1",
      fetchTimeoutMs: 200,
      selectorPack: {
        id: "test",
        verified: false,
        reason: "unverified",
      },
    });
    const health = await adapter.getHealth();
    expect(health.state).toBe("cursor_down");
    expect(health.extractorReady).toBe(false);
    expect(health.probe.status).not.toBe("connected");
  });

  it("extractor_stale when CDP up but pack unverified", async () => {
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "cursor_mobile — Cursor",
          type: "page",
          url: "vscode-file://cursor",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/t1",
        },
      ],
    });
    try {
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        selectorPack: {
          id: "cursor-ui@stub-unverified",
          verified: false,
          reason: "unverified",
        },
      });
      const health = await adapter.attach();
      expect(health.state).toBe("extractor_stale");
      expect(health.probe.status).toBe("connected");
      expect(health.probe.cursor.windowsDetected).toBeGreaterThanOrEqual(1);
      expect(health.extractorReady).toBe(false);
      expect(health.sendMessageVerified).toBe(false);
      expect(health.actions?.send_message).toBe("CANDIDATE");
    } finally {
      await mock.close();
    }
  });

  it("sendMessageVerified true when only send_message VERIFIED (pack still stale)", async () => {
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "cursor_mobile — Cursor",
          type: "page",
          url: "vscode-file://cursor",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/t1",
        },
      ],
    });
    try {
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        selectorPack: {
          id: "cursor-ui@partial-send",
          verified: false,
          reason: "approve still CANDIDATE",
          actions: {
            send_message: "VERIFIED",
            approve: "CANDIDATE",
            deny: "CANDIDATE",
            model_select: "CANDIDATE",
            file_attach: "CANDIDATE",
            composer_history_open: "CANDIDATE",
          },
        },
      });
      const health = await adapter.attach();
      expect(health.state).toBe("extractor_stale");
      expect(health.sendMessageVerified).toBe(true);
      expect(health.actions?.send_message).toBe("VERIFIED");
      expect(health.actions?.approve).toBe("CANDIDATE");
    } finally {
      await mock.close();
    }
  });

  it("cdp_ok when CDP up and pack verified", async () => {
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "Cursor",
          type: "page",
          url: "vscode-file://x",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/t1",
        },
      ],
    });
    try {
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        selectorPack: {
          id: "cursor-ui@test",
          verified: true,
          reason: "verified",
        },
      });
      const health = await adapter.getHealth();
      expect(health.state).toBe("cdp_ok");
      expect(health.extractorReady).toBe(true);
    } finally {
      await mock.close();
    }
  });
});

describe("live sessions + commands", () => {
  it("listLiveSessions empty when cursor_down", async () => {
    const adapter = createMockLiveCursorAdapter({
      healthState: "cursor_down",
    });
    const sessions = await adapter.listLiveSessions("ws_abc");
    expect(sessions).toEqual([]);
  });

  it("lists CDP windows as live sessions when attached (extractor_stale)", async () => {
    const mock = await mockCdpServer({
      targets: [
        {
          id: "abc123",
          title: "Wire Hub health",
          type: "page",
          url: "vscode-file://workbench",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/abc123",
        },
      ],
    });
    try {
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        selectorPack: {
          id: "stub",
          verified: false,
          reason: "stale",
        },
      });
      const sessions = await adapter.listLiveSessions("ws_test");
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.workspaceId).toBe("ws_test");
      expect(sessions[0]?.mode).toBe("live");
      expect(sessions[0]?.title).toContain("Wire Hub");
    } finally {
      await mock.close();
    }
  });

  it("sendMessage fails closed with EXTRACTOR_STALE (no fake success)", async () => {
    const adapter = createMockLiveCursorAdapter({
      healthState: "extractor_stale",
      sessions: [
        {
          id: "sess_live_1",
          workspaceId: "ws_abc",
          mode: "live",
          title: "t",
          preview: null,
          model: "m",
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          pendingApprovals: 0,
          windowId: "win_1",
          targetId: "t1",
        },
      ],
    });
    const result = await adapter.sendMessage("sess_live_1", "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EXTRACTOR_STALE");
    }
  });

  it("applyApproval fails closed with EXTRACTOR_STALE", async () => {
    const adapter = createMockLiveCursorAdapter({
      healthState: "extractor_stale",
      sessions: [
        {
          id: "sess_live_1",
          workspaceId: "ws_abc",
          mode: "live",
          title: "t",
          preview: null,
          model: null,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          pendingApprovals: 0,
          windowId: "win_1",
          targetId: "t1",
        },
      ],
    });
    await adapter.enqueuePendingApproval({
      sessionId: "sess_live_1",
      approvalId: "apr_1",
      synthetic: false,
      tool: { name: "shell" },
      summary: "Run shell",
    });
    const result = await adapter.applyApproval(
      "sess_live_1",
      "apr_1",
      "deny",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EXTRACTOR_STALE");
    }
  });

  it("synthetic applyApproval records without DOM while extractor_stale", async () => {
    const adapter = createMockLiveCursorAdapter({
      healthState: "extractor_stale",
      sessions: [
        {
          id: "sess_live_1",
          workspaceId: "ws_abc",
          mode: "live",
          title: "t",
          preview: null,
          model: null,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          pendingApprovals: 0,
          windowId: "win_1",
          targetId: "t1",
        },
      ],
    });
    const pending = await adapter.enqueuePendingApproval({
      sessionId: "sess_live_1",
      synthetic: true,
      summary: "UAT synthetic",
    });
    const listed = await adapter.listPendingApprovals("sess_live_1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.synthetic).toBe(true);

    const result = await adapter.applyApproval(
      "sess_live_1",
      pending.approvalId,
      "approve",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.domApplied).toBe(false);
      expect(result.synthetic).toBe(true);
      expect(result.status).toBe("recorded");
      expect(result.note).toMatch(/DOM was NOT clicked/i);
    }
    expect(await adapter.listPendingApprovals("sess_live_1")).toHaveLength(0);
  });

  it("createSession registers with domApplied=false when extractor_stale", async () => {
    const adapter = createMockLiveCursorAdapter({
      healthState: "extractor_stale",
      windowsDetected: 1,
    });
    const result = await adapter.createSession({
      workspaceId: "ws_abc",
      model: "composer-1",
      prompt: "Ship it",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.domApplied).toBe(false);
      expect(result.mode).toBe("live");
    }
  });

  it("sendMessage fails closed on real adapter when pack CANDIDATE", async () => {
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "Cursor",
          type: "page",
          url: "vscode-file://x",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/t1",
        },
      ],
    });
    try {
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        selectorPack: {
          id: "cursor-ui@2026.09-candidate",
          verified: false,
          reason: "CANDIDATE",
        },
      });
      const created = await adapter.createSession({
        workspaceId: "ws_abc",
        model: "composer-1",
        prompt: "hi",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.domApplied).toBe(false);
      const result = await adapter.sendMessage(created.id, "hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("EXTRACTOR_STALE");
      }
    } finally {
      await mock.close();
    }
  });

  it("reopenComposerContext fails closed when composer_history_open is CANDIDATE", async () => {
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "Cursor",
          type: "page",
          url: "vscode-file://x",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/t1",
        },
      ],
    });
    try {
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        selectorPack: {
          id: "cursor-ui@2026.09-candidate",
          verified: false,
          reason: "CANDIDATE",
        },
      });
      const result = await adapter.reopenComposerContext({
        workspaceId: "ws_abc",
        historySessionId: "hist_abc123",
        composerChatId: "abc123",
        title: "Past chat",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("EXTRACTOR_STALE");
        expect(result.message).toMatch(/strategy B/i);
        const details = result.details as { code?: string; action?: string };
        expect(details.code).toBe("OPEN_ON_PC_SELECTOR_CANDIDATE");
        expect(details.action).toBe("composer_history_open");
      }
    } finally {
      await mock.close();
    }
  });

  it("reopenComposerContext requires composerChatId", async () => {
    const adapter = createMockLiveCursorAdapter({
      healthState: "extractor_stale",
      windowsDetected: 1,
    });
    const result = await adapter.reopenComposerContext({
      workspaceId: "ws_abc",
      historySessionId: "hist_cli_xyz",
      composerChatId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_ERROR");
    }
  });

  it("mock reopenComposerContext CURSOR_DOWN when CDP down", async () => {
    const adapter = createMockLiveCursorAdapter({
      healthState: "cursor_down",
      windowsDetected: 0,
    });
    const result = await adapter.reopenComposerContext({
      workspaceId: "ws_abc",
      historySessionId: "hist_abc",
      composerChatId: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CURSOR_DOWN");
    }
  });
});
