#!/usr/bin/env node
import { createHubContext, loadConfig } from "./config.js";
import { createHubServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.hubHost === "0.0.0.0") {
    console.warn(
      "[hub] WARNING: HUB_HOST=0.0.0.0 — only use behind Tailscale ACLs. CDP stays on 127.0.0.1.",
    );
  }

  const ctx = createHubContext(config);
  const hub = createHubServer(ctx);

  await hub.listen();
  console.log(
    `[hub] listening on http://${config.hubHost}:${config.hubPort}`,
  );
  // Amendment G: operators must open this on the PC browser — never type it on the phone.
  console.log(
    `[hub] PAIR PHONE → open in a browser ON THIS PC: http://127.0.0.1:${config.hubPort}/pair`,
  );
  console.log(
    "[hub]          (loopback only — shows QR for the phone camera; do not open that URL on the phone)",
  );
  console.log(`[hub] CDP_URL=${config.cdpUrl} (loopback only)`);
  console.log(
    `[hub] workspace=${config.cursorWorkspace ?? "(unset — empty-state until CURSOR_WORKSPACE or CDP detect)"}`,
  );
  console.log(
    `[hub] dataDir=${config.hubDataDir ?? "(none — pairing in-memory only)"}`,
  );
  console.log(
    "[hub] routes: GET /pair · GET /v1/health · POST /v1/pair/* · GET /v1/workspace · GET|POST /v1/sessions · POST …/messages · GET|POST …/approvals · WS /v1/ws",
  );
}

main().catch((err) => {
  console.error("[hub] failed to start", err);
  process.exit(1);
});
