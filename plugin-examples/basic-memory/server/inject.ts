import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readConfig, type PluginConfig } from "./config.ts";

const PREAPPROVED_TOOLS = [
  "search_notes",
  "read_note",
  "recent_activity",
  "build_context",
  "list_directory",
  "list_memory_projects",
  "write_note",
];

export interface Preapproval {
  kind: "mcp";
  server: string;
  tool: string;
}

// A toolPolicy on a provider that cannot honor exact MCP preapproval makes the
// daemon refuse agent creation, so callers gate on this: only providers in
// `preapproveProviders` get preapproval entries.
export function preapprovalsFor(provider: string, config: PluginConfig): Preapproval[] {
  if (!config.preapproveTools || !config.preapproveProviders.includes(provider)) {
    return [];
  }
  return PREAPPROVED_TOOLS.map((tool) => ({
    kind: "mcp" as const,
    server: config.serverName,
    tool,
  }));
}

// Injected configuration is saved with the agent, so resume and refresh keep
// the server without re-running this hook. An explicit server entry the
// requester already set wins over the injection.
export function registerInjection(server: PluginServerContext): void {
  server.before("agent.create", ({ request }) => {
    const config = readConfig();
    if (!config.injectMcp) {
      return undefined;
    }
    if (config.excludeProviders.includes(request.config.provider)) {
      return undefined;
    }
    if (request.config.mcpServers?.[config.serverName] !== undefined) {
      return undefined;
    }

    const mcpServers = {
      ...request.config.mcpServers,
      [config.serverName]: {
        type: "stdio" as const,
        command: config.binaryPath,
        args: ["mcp", "--project", config.project],
        env: { NO_COLOR: "1" },
      },
    };

    const preapproved = preapprovalsFor(request.config.provider, config);
    const toolPolicy =
      preapproved.length > 0
        ? { preapproved: [...(request.config.toolPolicy?.preapproved ?? []), ...preapproved] }
        : request.config.toolPolicy;

    return { ...request, config: { ...request.config, mcpServers, toolPolicy } };
  });
}
