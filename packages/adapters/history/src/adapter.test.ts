import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryHistoryAdapter,
  StubHistoryAdapter,
  createHistoryAdapter,
  findWorkspaceStorageHashes,
  isListableComposerRow,
  listStoragePathCandidates,
  parseDesktopComposerChatId,
} from "./index.js";

const require = createRequire(import.meta.url);

type SqliteDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
  close: () => void;
};

type DatabaseSyncCtor = new (path: string) => SqliteDb;

function tryLoadDatabaseSync(): DatabaseSyncCtor | null {
  try {
    return (require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor })
      .DatabaseSync;
  } catch {
    return null;
  }
}

describe("StubHistoryAdapter", () => {
  it("returns empty list", async () => {
    const stub = new StubHistoryAdapter();
    const rows = await stub.listSessions({ workspaceId: "ws_abc" });
    expect(rows).toEqual([]);
  });
});

describe("parseDesktopComposerChatId", () => {
  it("maps hist_<composerId> and rejects agent-cli / malformed ids", () => {
    expect(parseDesktopComposerChatId("hist_abc-def")).toBe("abc-def");
    expect(parseDesktopComposerChatId("hist_cli_abc")).toBeNull();
    expect(parseDesktopComposerChatId("sess_live_1")).toBeNull();
    expect(parseDesktopComposerChatId("hist_")).toBeNull();
  });
});

describe("isListableComposerRow", () => {
  it("includes root composers and multitask generalPurpose chats", () => {
    expect(
      isListableComposerRow({
        isArchived: 0,
        isSubagent: 0,
        subagentTypeName: "",
        value: JSON.stringify({ name: "Parent", isDraft: false }),
      }),
    ).toBe(true);
    expect(
      isListableComposerRow({
        isArchived: 0,
        isSubagent: 1,
        subagentTypeName: "generalPurpose",
        value: JSON.stringify({ name: "Agent chat" }),
      }),
    ).toBe(true);
  });

  it("excludes nested Task subagents, drafts, archived, best-of-N", () => {
    expect(
      isListableComposerRow({
        isArchived: 0,
        isSubagent: 1,
        subagentTypeName: "explore",
        value: JSON.stringify({ name: "Explore" }),
      }),
    ).toBe(false);
    expect(
      isListableComposerRow({
        isArchived: 0,
        isSubagent: 1,
        subagentTypeName: "code-reviewer",
        value: "{}",
      }),
    ).toBe(false);
    expect(
      isListableComposerRow({
        isArchived: 1,
        isSubagent: 0,
        subagentTypeName: "",
        value: "{}",
      }),
    ).toBe(false);
    expect(
      isListableComposerRow({
        isArchived: 0,
        isSubagent: 0,
        subagentTypeName: "",
        value: JSON.stringify({ isDraft: true }),
      }),
    ).toBe(false);
    expect(
      isListableComposerRow({
        isArchived: 0,
        isSubagent: 0,
        subagentTypeName: "",
        value: JSON.stringify({ isBestOfNSubcomposer: true }),
      }),
    ).toBe(false);
  });
});

describe("MemoryHistoryAdapter filter", () => {
  it("filters by workspaceId and returns empty for unknown", async () => {
    const adapter = new MemoryHistoryAdapter([
      {
        sessionId: "hist_1",
        workspaceId: "ws_a",
        title: "A",
        preview: null,
        model: null,
        updatedAt: "2026-09-25T00:00:00.000Z",
        createdAt: "2026-09-25T00:00:00.000Z",
        mode: "history",
        nativeKeyFingerprint: "sha256:aaaa",
        backend: "desktop_globalStorage",
        correlationKey: "ck_aaaa",
        messages: [],
        truncated: false,
        capabilities: { canOpenOnPc: true, readOnly: true },
      },
      {
        sessionId: "hist_2",
        workspaceId: "ws_b",
        title: "B",
        preview: null,
        model: null,
        updatedAt: "2026-09-25T00:00:00.000Z",
        createdAt: "2026-09-25T00:00:00.000Z",
        mode: "history",
        nativeKeyFingerprint: "sha256:bbbb",
        backend: "desktop_globalStorage",
        correlationKey: "ck_bbbb",
        messages: [],
        truncated: false,
        capabilities: { canOpenOnPc: true, readOnly: true },
      },
    ]);

    const a = await adapter.listSessions({ workspaceId: "ws_a" });
    expect(a).toHaveLength(1);
    expect(a[0]?.sessionId).toBe("hist_1");

    const empty = await adapter.listSessions({ workspaceId: "ws_missing" });
    expect(empty).toEqual([]);
  });
});

describe("path strategies", () => {
  it("lists storage candidates without inventing secrets", () => {
    const candidates = listStoragePathCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.kind).toBeTruthy();
      expect(c.osHint).toBeTruthy();
      expect(typeof c.present).toBe("boolean");
    }
  });
});

describe("workspace hash map", () => {
  const root = join(tmpdir(), `cm-hist-ws-${process.pid}`);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("matches folder URI in workspace.json", () => {
    const hash = "abc123hash";
    mkdirSync(join(root, hash), { recursive: true });
    writeFileSync(
      join(root, hash, "workspace.json"),
      JSON.stringify({ folder: "file:///tmp/demo-project" }),
    );
    const matches = findWorkspaceStorageHashes("/tmp/demo-project", root);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.hash).toBe(hash);
  });

  it("returns empty when no match (no cross-project leak)", () => {
    const hash = "otherhash";
    mkdirSync(join(root, hash), { recursive: true });
    writeFileSync(
      join(root, hash, "workspace.json"),
      JSON.stringify({ folder: "file:///tmp/other-project" }),
    );
    const matches = findWorkspaceStorageHashes("/tmp/demo-project", root);
    expect(matches).toEqual([]);
  });
});

describe("LocalHistoryAdapter empty without paths", () => {
  it("returns empty when home has no Cursor storage", async () => {
    const emptyHome = join(tmpdir(), `cm-hist-empty-${process.pid}`);
    mkdirSync(emptyHome, { recursive: true });
    try {
      const adapter = createHistoryAdapter({ home: emptyHome });
      const rows = await adapter.listSessions({
        workspaceId: "ws_x",
        workspacePath: "/tmp/does-not-matter",
      });
      expect(rows).toEqual([]);
      const status = await adapter.getStatus("ws_x");
      expect(status.ok).toBe(false);
      expect(status.reason).toMatch(/No local Cursor storage/i);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("LocalHistoryAdapter fixture composerHeaders", () => {
  const DatabaseSync = tryLoadDatabaseSync();
  const home = join(tmpdir(), `cm-hist-fix-${process.pid}`);
  const projectPath = "/tmp/cm-hist-fixture-project";
  const hash = "fixturehash001";

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(!DatabaseSync)(
    "lists root + generalPurpose; skips explore subagent",
    async () => {
      const Ctor = DatabaseSync!;
      const userRoot = join(home, ".config", "Cursor", "User");
      const globalDir = join(userRoot, "globalStorage");
      const wsDir = join(userRoot, "workspaceStorage", hash);
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(
        join(wsDir, "workspace.json"),
        JSON.stringify({ folder: `file://${projectPath}` }),
      );

      const dbPath = join(globalDir, "state.vscdb");
      const db = new Ctor(dbPath);
      db.exec(`
        CREATE TABLE composerHeaders (
          composerId TEXT PRIMARY KEY,
          workspaceId TEXT,
          createdAt INTEGER,
          lastUpdatedAt INTEGER,
          isArchived INTEGER,
          isSubagent INTEGER,
          subagentTypeName TEXT,
          value TEXT
        );
      `);
      const insert = db.prepare(`
        INSERT INTO composerHeaders
          (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, subagentTypeName, value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const t0 = Date.parse("2026-09-25T10:00:00.000Z");
      insert.run(
        "root-1",
        hash,
        t0,
        t0 + 1000,
        0,
        0,
        "",
        JSON.stringify({
          name: "Root multitask",
          unifiedMode: "multitask",
          subtitle: "parent",
        }),
      );
      insert.run(
        "gp-1",
        hash,
        t0 + 2000,
        t0 + 3000,
        0,
        1,
        "generalPurpose",
        JSON.stringify({
          name: "Real agent chat",
          unifiedMode: "agent",
          subtitle: "did work",
        }),
      );
      insert.run(
        "explore-1",
        hash,
        t0 + 4000,
        t0 + 5000,
        0,
        1,
        "explore",
        JSON.stringify({
          name: "Nested explore",
          unifiedMode: "agent",
        }),
      );
      db.close();

      const adapter = createHistoryAdapter({ home });
      const rows = await adapter.listSessions({
        workspaceId: "ws_fixture",
        workspacePath: projectPath,
        limit: 20,
      });
      expect(rows.map((r) => r.sessionId).sort()).toEqual([
        "hist_gp-1",
        "hist_root-1",
      ]);
      expect(rows.find((r) => r.title === "Real agent chat")).toBeTruthy();
      expect(rows.find((r) => r.title === "Nested explore")).toBeUndefined();

      const status = await adapter.getStatus("ws_fixture");
      expect(status.ok).toBe(true);
      expect(status.sessionCountForBind).toBe(2);
      expect(status.reason).toBeUndefined();

      const page = await adapter.listSessions({
        workspaceId: "ws_fixture",
        workspacePath: projectPath,
        limit: 1,
      });
      expect(page).toHaveLength(1);
      const statusAfterPage = await adapter.getStatus("ws_fixture");
      expect(statusAfterPage.sessionCountForBind).toBe(2);
    },
  );

  it.skipIf(!DatabaseSync)(
    "reports honest empty reason when workspace hash missing",
    async () => {
      const Ctor = DatabaseSync!;
      const userRoot = join(home, ".config", "Cursor", "User");
      const globalDir = join(userRoot, "globalStorage");
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(join(userRoot, "workspaceStorage"), { recursive: true });
      const db = new Ctor(join(globalDir, "state.vscdb"));
      db.exec(
        `CREATE TABLE composerHeaders (
          composerId TEXT, workspaceId TEXT, createdAt INTEGER,
          lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
          subagentTypeName TEXT, value TEXT
        );`,
      );
      db.close();

      const adapter = createHistoryAdapter({ home });
      const rows = await adapter.listSessions({
        workspaceId: "ws_fixture",
        workspacePath: "/tmp/no-such-bound-project",
      });
      expect(rows).toEqual([]);
      const status = await adapter.getStatus("ws_fixture");
      expect(status.ok).toBe(true);
      expect(status.sessionCountForBind).toBe(0);
      expect(status.reason).toMatch(/No workspaceStorage hash matched/i);
    },
  );
});
