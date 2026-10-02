import { describe, expect, it } from "vitest";
import {
  LiveCursorAdapterImpl,
} from "./adapter.js";
import {
  createMockCdpClient,
  createMockCdpClientFactory,
  assertLoopbackDebuggerUrl,
} from "./cdp-client.js";
import {
  executeClick,
  executeTypeAndSubmit,
  executeVerifiedAction,
} from "./cdp-input.js";
import { createDefaultSelectorPack, markActionVerified } from "./selector-pack.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

async function mockCdpServer(opts: {
  targets?: Array<Record<string, unknown>>;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/json/version")) {
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

function candidateActions() {
  return {
    send_message: "CANDIDATE" as const,
    approve: "CANDIDATE" as const,
    deny: "CANDIDATE" as const,
    model_select: "CANDIDATE" as const,
    file_attach: "CANDIDATE" as const,
    composer_history_open: "CANDIDATE" as const,
  };
}

describe("cdp-client loopback guard", () => {
  it("rejects non-loopback debugger URLs", () => {
    expect(() =>
      assertLoopbackDebuggerUrl("ws://100.64.1.2:9222/devtools/page/x"),
    ).toThrow(/loopback/i);
  });

  it("allows 127.0.0.1 debugger URLs", () => {
    expect(() =>
      assertLoopbackDebuggerUrl("ws://127.0.0.1:9222/devtools/page/x"),
    ).not.toThrow();
  });
});

describe("cdp-input executor (unit)", () => {
  it("executeTypeAndSubmit issues Input + Runtime CDP methods", async () => {
    const client = createMockCdpClient({
      "Runtime.evaluate": () => ({
        result: {
          type: "object",
          value: { x: 10, y: 20, width: 100, height: 40 },
        },
      }),
    });
    const pack = createDefaultSelectorPack();
    const result = await executeTypeAndSubmit(
      client,
      "send_message",
      pack.actions.send_message,
      "hello from phone",
    );
    expect(result.ok).toBe(true);
    const methods = client.calls.map((c) => c.method);
    expect(methods).toContain("Runtime.evaluate");
    expect(methods).toContain("Input.dispatchMouseEvent");
    expect(methods).toContain("Input.insertText");
    expect(methods).toContain("Input.dispatchKeyEvent");
    const insert = client.calls.find((c) => c.method === "Input.insertText");
    expect(insert?.params.text).toBe("hello from phone");
  });

  it("executeClick uses Input.dispatchMouseEvent after resolve", async () => {
    const client = createMockCdpClient({
      "Runtime.evaluate": () => ({
        result: {
          type: "object",
          value: { x: 5, y: 8, width: 40, height: 20 },
        },
      }),
    });
    const pack = createDefaultSelectorPack();
    const result = await executeClick(client, "approve", pack.actions.approve);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.methods.filter((m) => m === "Input.dispatchMouseEvent").length).toBe(
        2,
      );
    }
  });

  it("executeVerifiedAction fails closed when strategies miss", async () => {
    const client = createMockCdpClient({
      "Runtime.evaluate": () => ({ result: { type: "object", value: null } }),
    });
    const pack = createDefaultSelectorPack();
    const result = await executeVerifiedAction(
      client,
      "deny",
      pack.actions.deny,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/No DOM target/i);
    }
  });
});

describe("adapter CDP Input gates", () => {
  it("CANDIDATE send_message rejects with EXTRACTOR_STALE and never opens CDP", async () => {
    const mockCdp = createMockCdpClient();
    const factory = createMockCdpClientFactory(mockCdp);
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
        cdpClientFactory: factory,
        selectorPack: {
          id: "cursor-ui@2026.09-candidate",
          verified: false,
          reason: "all CANDIDATE",
          actions: candidateActions(),
          pack: createDefaultSelectorPack(),
        },
      });
      const created = await adapter.createSession({
        workspaceId: "ws_abc",
        model: "composer-1",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const result = await adapter.sendMessage(created.id, "hello");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("EXTRACTOR_STALE");
      }
      expect(mockCdp.calls).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it("mock VERIFIED send_message attempts CDP Input path", async () => {
    const mockCdp = createMockCdpClient({
      "Runtime.evaluate": (params) => {
        const expr = String(params.expression ?? "");
        // First resolve (querySelector box) vs later setFocusedEditableValue
        if (expr.includes("getBoundingClientRect")) {
          return {
            result: {
              type: "object",
              value: { x: 12, y: 34, width: 80, height: 24 },
            },
          };
        }
        return { result: { type: "boolean", value: true } };
      },
    });
    const factory = createMockCdpClientFactory(mockCdp);
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "Cursor",
          type: "page",
          url: "vscode-file://x",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/t1",
        },
      ],
    });
    try {
      // Inject VERIFIED for tests only — does not mutate default pack source.
      let pack = createDefaultSelectorPack();
      pack = markActionVerified(pack, "send_message", {
        verifiedAgainst: "unit-test-mock (not live Cursor)",
      });
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        cdpClientFactory: factory,
        selectorPack: {
          id: pack.id,
          verified: false, // overall pack still incomplete
          reason: "only send_message mock-VERIFIED for unit test",
          actions: {
            ...candidateActions(),
            send_message: "VERIFIED",
          },
          pack,
        },
      });
      const created = await adapter.createSession({
        workspaceId: "ws_abc",
        model: "composer-1",
        prompt: "new session with model_select still CANDIDATE",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      // model_select CANDIDATE ⇒ Hub registers session but does not claim Composer DOM drive
      expect(created.domApplied).toBe(false);
      expect(created.note).toMatch(/not driven|CANDIDATE|extractor_stale/i);

      const result = await adapter.sendMessage(created.id, "ship it");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.domApplied).toBe(true);
      }
      const methods = mockCdp.calls.map((c) => c.method);
      expect(methods).toContain("Input.dispatchMouseEvent");
      expect(methods).toContain("Input.insertText");
      expect(
        mockCdp.calls.some(
          (c) => c.method === "Input.insertText" && c.params.text === "ship it",
        ),
      ).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("mock VERIFIED approve attempts CDP click path", async () => {
    const mockCdp = createMockCdpClient({
      "Runtime.evaluate": () => ({
        result: {
          type: "object",
          value: { x: 1, y: 2, width: 10, height: 10 },
        },
      }),
    });
    const factory = createMockCdpClientFactory(mockCdp);
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "Cursor",
          type: "page",
          url: "vscode-file://x",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/t1",
        },
      ],
    });
    try {
      let pack = createDefaultSelectorPack();
      pack = markActionVerified(pack, "approve", {
        verifiedAgainst: "unit-test-mock",
      });
      const adapter = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        cdpClientFactory: factory,
        selectorPack: {
          id: pack.id,
          verified: false,
          reason: "approve mock-VERIFIED only",
          actions: {
            ...candidateActions(),
            approve: "VERIFIED",
          },
          pack,
        },
      });
      const created = await adapter.createSession({
        workspaceId: "ws_abc",
        model: "composer-1",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      adapter.registerPendingApproval(created.id, "apr_1");
      const result = await adapter.applyApproval(created.id, "apr_1", "approve");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.domApplied).toBe(true);
      }
      expect(mockCdp.calls.map((c) => c.method)).toContain(
        "Input.dispatchMouseEvent",
      );
    } finally {
      await mock.close();
    }
  });

  it("default shipped pack: all mutation actions VERIFIED after live CDP proof", () => {
    const pack = createDefaultSelectorPack();
    for (const id of [
      "send_message",
      "approve",
      "deny",
      "model_select",
      "file_attach",
      "composer_history_open",
    ] as const) {
      expect(pack.actions[id].verification).toBe("VERIFIED");
      expect(pack.actions[id].verifiedAt).toBeTruthy();
    }
  });
});
