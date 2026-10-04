import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_VERSION, type HubClient } from "./hub-client.js";
import { registerCursorTools } from "./tools.js";

export function createCursorMcpServer(hub: HubClient): McpServer {
  const server = new McpServer(
    { name: "cursor-mobile", version: MCP_VERSION },
    {
      instructions:
        "Drives Cursor Agents chats on this PC through the local cursor-mobile Hub. " +
        "Typical loop: cursor_list_projects → cursor_new_chat or cursor_send → cursor_wait → cursor_changes / cursor_diff. " +
        "Sending makes a Cursor agent act on the operator's PC (Cursor may auto-run tools), so send only what the user asked for.",
    },
  );
  registerCursorTools(server, hub);
  return server;
}
