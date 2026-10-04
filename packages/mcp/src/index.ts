#!/usr/bin/env node
/**
 * cursor-mobile MCP server (stdio). Lets Claude drive Cursor Agents chats on this PC
 * through the local Hub — PC-local only; never talks to CDP or anything off this machine.
 *
 *   claude mcp add cursor -s user -- node <repo>/packages/mcp/dist/index.js
 *
 * Env: HUB_URL (default http://127.0.0.1:8787), CURSOR_MOBILE_MCP_TOKEN_FILE.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultTokenFile, fileTokenStore, HubClient } from "./hub-client.js";
import { createCursorMcpServer } from "./server.js";

async function main() {
  const hub = new HubClient({
    baseUrl: process.env.HUB_URL || "http://127.0.0.1:8787",
    tokens: fileTokenStore(defaultTokenFile()),
  });
  await createCursorMcpServer(hub).connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[cursor-mobile-mcp]", err instanceof Error ? err.message : err);
  process.exit(1);
});
