/**
 * Workspace tools summary — DESIGNED Phase 1 stub.
 * Honest summary from adapter health + optional env inventory; not CDP MCP scrape.
 */

import type { LiveAdapterHealth } from "@cursor-mobile/live-cursor";

export interface ToolsSummary {
  mcpServers: Array<{ name: string; enabled: boolean; toolCount?: number }>;
  plugins: Array<{ name: string; enabled: boolean }>;
  note: string;
}

/**
 * Parse optional `CURSOR_MCP_SERVERS` as `name[:toolCount][,…]`.
 * Example: `filesystem:12,github:8`
 */
export function parseMcpServersEnv(
  raw: string | null | undefined,
): ToolsSummary["mcpServers"] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, countRaw] = part.split(":").map((x) => x.trim());
      const toolCount = countRaw ? Number.parseInt(countRaw, 10) : undefined;
      return {
        name: name || "unnamed",
        enabled: true,
        ...(Number.isFinite(toolCount) ? { toolCount } : {}),
      };
    });
}

export function buildToolsSummary(opts: {
  health: LiveAdapterHealth;
  mcpServersEnv?: string | null;
  pluginsEnv?: string | null;
}): ToolsSummary {
  const mcpServers = parseMcpServersEnv(opts.mcpServersEnv);
  const plugins = (opts.pluginsEnv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, enabled: true }));

  const healthNote =
    opts.health.state === "cdp_ok"
      ? "Live adapter healthy (cdp_ok)."
      : opts.health.state === "extractor_stale"
        ? "Live adapter attached but extractor_stale — tools still run on PC; phone approvals cannot click UI until selector pack is verified."
        : "Live adapter cursor_down — Cursor CDP unreachable; tools inventory is env/DESIGNED only.";

  return {
    mcpServers,
    plugins,
    note: [
      "Tools execute on the PC inside Cursor; phone approves only.",
      healthNote,
      "DESIGNED limit: Hub does not yet scrape Cursor MCP/plugin UI via CDP; optional CURSOR_MCP_SERVERS / CURSOR_PLUGINS env stubs.",
    ].join(" "),
  };
}
