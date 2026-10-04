/**
 * Sends are refused while Cursor shows a stuck-runtime banner (needs Reload Window).
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter, type CursorAlert } from "@cursor-mobile/live-cursor";
import { createApp } from "../src/app.js";
import { createHubContext, loadConfig, PairingStore } from "../src/config.js";

const ID = "466762d6-04ca-46e6-a047-4ad7932ae829";

function setup(cursorAlerts: CursorAlert[]) {
  const config = loadConfig({ HUB_HOST: "127.0.0.1", PAIRING_REQUIRED: "true", HUB_DATA_DIR: "none" });
  const live = createMockLiveCursorAdapter({
    healthState: "cdp_ok",
    sidebarSections: [
      {
        sectionId: "workspace:185f",
        name: "omnitouter",
        expanded: true,
        hasMore: false,
        chats: [{ composerId: ID, title: "t", ageLabel: "1m", active: true, live: "idle" }],
      },
    ],
    cursorAlerts,
  });
  return createApp(createHubContext(config, { pairing: new PairingStore(), live }));
}

async function token(app: ReturnType<typeof createApp>) {
  const start = await request(app).post("/v1/pair/start").send({}).expect(201);
  const done = await request(app)
    .post("/v1/pair/complete")
    .send({ code: start.body.code, pairId: start.body.pairId, deviceName: "t", platform: "android", appVersion: "1" })
    .expect(201);
  return `Bearer ${done.body.deviceToken as string}`;
}

const stuck: CursorAlert = {
  title: "Agent Execution Timed Out",
  message: "The agent execution provider did not respond in time.",
  actions: ["Copy ID", "Reload Window", "Dismiss error"],
  error: true,
  needsReload: true,
};

describe("Cursor reload guard", () => {
  it("refuses sends and new chats with CURSOR_NEEDS_RELOAD and shows the alert in GET /agents", async () => {
    const app = setup([stuck]);
    const auth = await token(app);
    const send = await request(app).post(`/v1/agents/chats/${ID}/messages`).set("authorization", auth).send({ text: "hi" });
    expect(send.status).toBe(409);
    expect(send.body.error.code).toBe("CURSOR_NEEDS_RELOAD");
    expect(send.body.error.message).toMatch(/Reload Window/);
    const created = await request(app)
      .post("/v1/agents/projects/new")
      .set("authorization", auth)
      .send({ projectId: "workspace:185f", text: "hi" });
    expect(created.body.error.code).toBe("CURSOR_NEEDS_RELOAD");
    const list = await request(app).get("/v1/agents").set("authorization", auth).expect(200);
    expect(list.body.alerts).toEqual([stuck]);
  });

  it("lets sends through when the only notice is benign", async () => {
    const app = setup([{ title: "1 message queued", message: "", actions: [], error: false, needsReload: false }]);
    const auth = await token(app);
    await request(app).post(`/v1/agents/chats/${ID}/messages`).set("authorization", auth).send({ text: "hi" }).expect(202);
  });
});
