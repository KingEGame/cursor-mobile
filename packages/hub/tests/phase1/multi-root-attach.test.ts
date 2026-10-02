/**
 * Phase 3 — multi-root Hub binding + attach path validation under roots.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../../src/app.js";
import {
  createHubContext,
  loadConfig,
  PairingStore,
  parseCodeWorkspaceFolders,
  resolveWorkspace,
} from "../../src/config.js";
import {
  searchWorkspaceFiles,
  validateAttachmentPaths,
} from "../../src/workspace/files.js";

function setupMultiRoot(primary: string, extraRoots: string[]) {
  const config = loadConfig({
    HUB_HOST: "127.0.0.1",
    HUB_PORT: "8787",
    CDP_URL: "http://127.0.0.1:9222",
    PAIRING_REQUIRED: "true",
    CURSOR_WORKSPACE: primary,
    CURSOR_WORKSPACE_ROOTS: extraRoots.join(","),
    HUB_DATA_DIR: "none",
  });
  config.cursorWorkspace = primary;
  config.cursorWorkspaceRoots = extraRoots;
  const pairing = new PairingStore();
  const live = createMockLiveCursorAdapter({
    healthState: "extractor_stale",
    windowsDetected: 1,
  });
  const ctx = createHubContext(config, { pairing, live });
  return { app: createApp(ctx), ctx, live };
}

async function pair(app: ReturnType<typeof createApp>) {
  const start = await request(app).post("/pair/start").send({}).expect(201);
  const confirm = await request(app)
    .post("/pair/confirm")
    .send({
      code: start.body.code,
      pairId: start.body.pairId,
      deviceName: "Pixel-multiroot",
      platform: "android",
      appVersion: "0.1.0",
    })
    .expect(201);
  return confirm.body.deviceToken as string;
}

describe("multi-root resolveWorkspace", () => {
  it("merges CURSOR_WORKSPACE_ROOTS into GET /workspace roots", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-ws-"));
    const a = join(base, "proj_a");
    const b = join(base, "proj_b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "a.txt"), "a");
    writeFileSync(join(b, "b.txt"), "b");

    const snap = resolveWorkspace(a, { extraRoots: [b] });
    expect(snap.workspaceId).toMatch(/^ws_/);
    expect(snap.path).toBe(a);
    expect(snap.roots.length).toBe(2);
    expect(snap.roots.map((r) => r.path).sort()).toEqual([a, b].sort());
  });

  it("parses .code-workspace folders", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-cws-"));
    const r1 = join(base, "root1");
    const r2 = join(base, "root2");
    mkdirSync(r1);
    mkdirSync(r2);
    const wsFile = join(base, "multi.code-workspace");
    writeFileSync(
      wsFile,
      JSON.stringify({
        folders: [
          { path: "root1", name: "one" },
          { path: "root2", name: "two" },
        ],
      }),
    );
    const folders = parseCodeWorkspaceFolders(wsFile);
    expect(folders).toHaveLength(2);
    expect(folders[0]!.name).toBe("one");
    expect(folders[1]!.name).toBe("two");

    const snap = resolveWorkspace(wsFile);
    expect(snap.roots.length).toBe(2);
    expect(snap.roots[0]!.name).toBe("one");
  });
});

describe("multi-root file search + attach validation", () => {
  it("searchWorkspaceFiles lists across multiple roots with correct rootPath", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-scan-"));
    const a = join(base, "alpha");
    const b = join(base, "beta");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "only-a.md"), "a");
    writeFileSync(join(b, "only-b.md"), "b");

    const { items } = searchWorkspaceFiles({
      roots: [
        { name: "alpha", path: a },
        { name: "beta", path: b },
      ],
      q: "only-",
      limit: 50,
    });
    expect(items.some((i) => i.path === "only-a.md" && i.rootPath === a)).toBe(
      true,
    );
    expect(items.some((i) => i.path === "only-b.md" && i.rootPath === b)).toBe(
      true,
    );
  });

  it("searchWorkspaceFiles?root= name filter scopes to one root", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-filt-"));
    const a = join(base, "alpha");
    const b = join(base, "beta");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "shared.txt"), "a");
    writeFileSync(join(b, "shared.txt"), "b");

    const { items } = searchWorkspaceFiles({
      roots: [
        { name: "alpha", path: a },
        { name: "beta", path: b },
      ],
      rootFilter: "beta",
      q: "shared",
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.rootPath).toBe(b);
  });

  it("validateAttachmentPaths accepts under any bound root; rejects escapes", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-att-"));
    const a = join(base, "alpha");
    const b = join(base, "beta");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "in-a.ts"), "a");
    writeFileSync(join(b, "in-b.ts"), "b");

    const roots = [
      { name: "alpha", path: a },
      { name: "beta", path: b },
    ];
    const okPrimary = validateAttachmentPaths(roots, ["in-a.ts"]);
    expect(okPrimary.ok).toEqual(["in-a.ts"]);
    expect(okPrimary.invalid).toEqual([]);

    const okNamed = validateAttachmentPaths(roots, ["beta:in-b.ts"]);
    expect(okNamed.ok).toEqual(["beta:in-b.ts"]);
    expect(okNamed.invalid).toEqual([]);

    const bad = validateAttachmentPaths(roots, [
      "../etc/passwd",
      "/etc/passwd",
      "missing.ts",
    ]);
    expect(bad.ok).toEqual([]);
    expect(bad.invalid.length).toBe(3);
  });

  it("ambiguous relative path across roots is rejected until rootName: prefix", () => {
    const base = mkdtempSync(join(tmpdir(), "cm-amb-"));
    const a = join(base, "alpha");
    const b = join(base, "beta");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "dup.txt"), "a");
    writeFileSync(join(b, "dup.txt"), "b");

    const roots = [
      { name: "alpha", path: a },
      { name: "beta", path: b },
    ];
    const amb = validateAttachmentPaths(roots, ["dup.txt"]);
    expect(amb.ok).toEqual([]);
    expect(amb.invalid).toEqual(["dup.txt"]);

    const explicit = validateAttachmentPaths(roots, ["alpha:dup.txt"]);
    expect(explicit.ok).toEqual(["dup.txt"]); // primary root → no prefix
  });
});

describe("multi-root Hub HTTP", () => {
  it("GET /workspace exposes multiple roots; files scan; attach rejects outside", async () => {
    const base = mkdtempSync(join(tmpdir(), "cm-http-"));
    const a = join(base, "alpha");
    const b = join(base, "beta");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "from-a.md"), "hello");
    writeFileSync(join(b, "from-b.md"), "world");

    const { app } = setupMultiRoot(a, [b]);
    const token = await pair(app);

    const ws = await request(app)
      .get("/v1/workspace")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(ws.body.roots.length).toBe(2);

    const files = await request(app)
      .get("/v1/workspace/files")
      .query({ q: "from-", limit: 50 })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(files.body.roots.length).toBe(2);
    expect(
      files.body.items.some((i: { path: string }) => i.path === "from-a.md"),
    ).toBe(true);
    expect(
      files.body.items.some((i: { path: string }) => i.path === "from-b.md"),
    ).toBe(true);

    const byRoot = await request(app)
      .get("/workspace/files")
      .query({ root: "beta", q: "from-" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(byRoot.body.items).toHaveLength(1);
    expect(byRoot.body.items[0].path).toBe("from-b.md");

    // Create session then attach outside roots → 400
    const created = await request(app)
      .post("/v1/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "mr-create-1")
      .send({
        workspaceId: ws.body.workspaceId,
        model: "composer",
        attachments: ["from-a.md"],
      })
      .expect(201);
    expect(created.body.attachments).toContain("from-a.md");
    expect(created.body.domApplied).toBe(false);

    await request(app)
      .post(`/v1/sessions/${created.body.id}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "mr-attach-bad")
      .send({ mode: "add", attachments: ["../../etc/passwd"] })
      .expect(400)
      .expect((r) => {
        expect(r.body.error.code).toBe("ATTACHMENT_OUTSIDE_ROOTS");
      });

    // Valid secondary-root attach registers; domApplied false while CANDIDATE
    const attach = await request(app)
      .post(`/sessions/${created.body.id}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "mr-attach-ok")
      .send({ mode: "add", attachments: ["beta:from-b.md"] })
      .expect(200);
    expect(attach.body.domApplied).toBe(false);
    expect(attach.body.attachments).toContain("beta:from-b.md");
    expect(attach.body.note).toMatch(/VERIFIED|extractor_stale|register/i);
  });
});
