#!/usr/bin/env node

// ClawNexus MCP Server — exposes daemon HTTP API as MCP tools
// Transport: stdio | Daemon: http://localhost:17890 (or CLAWNEXUS_API_URL)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.CLAWNEXUS_API_URL ?? "http://localhost:17890";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<ApiResult> {
  const url = `${API_BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => null)) as unknown;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: { error: `Failed to reach daemon at ${url}: ${(err as Error).message}` },
    };
  }
}

export function toolResult(result: ApiResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    isError: !result.ok,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {

const server = new McpServer({
  name: "clawnexus",
  version: "0.4.0",
});

// ---------------------------------------------------------------------------
// Discovery & Instances
// ---------------------------------------------------------------------------

server.tool(
  "clawnexus_list_instances",
  "List all known OpenClaw instances. Optionally filter by status (online/offline/unknown) or network scope (local/vpn/public).",
  {
    status: z.enum(["online", "offline", "unknown"]).optional().describe("Filter by status"),
    scope: z.enum(["local", "vpn", "public"]).optional().describe("Filter by network_scope"),
  },
  async ({ status, scope }) => {
    const params = new URLSearchParams();
    if (scope) params.set("scope", scope);
    const qs = params.toString();
    const result = await api("GET", `/instances${qs ? `?${qs}` : ""}`);
    // Client-side status filter (API only supports scope)
    if (result.ok && status) {
      const d = result.data as { instances: { status: string }[]; count: number };
      d.instances = d.instances.filter((i) => i.status === status);
      d.count = d.instances.length;
    }
    return toolResult(result);
  },
);

server.tool(
  "clawnexus_get_instance",
  "Get details of a specific OpenClaw instance by name, alias, or address.",
  {
    id: z.string().describe("Instance identifier (alias, auto_name, agent_id, or address)"),
  },
  async ({ id }) => toolResult(await api("GET", `/instances/${encodeURIComponent(id)}`)),
);

server.tool(
  "clawnexus_set_alias",
  "Set a human-readable alias for an OpenClaw instance.",
  {
    id: z.string().describe("Instance identifier to alias"),
    alias: z.string().describe("New alias (unique, max 32 chars, lowercase alphanumeric + hyphens)"),
  },
  async ({ id, alias }) =>
    toolResult(await api("PUT", `/instances/${encodeURIComponent(id)}/alias`, { alias })),
);

server.tool(
  "clawnexus_remove_instance",
  "Remove an OpenClaw instance from the local registry.",
  {
    id: z.string().describe("Instance identifier to remove"),
  },
  async ({ id }) => toolResult(await api("DELETE", `/instances/${encodeURIComponent(id)}`)),
);

server.tool(
  "clawnexus_scan",
  "Trigger an active network scan to discover OpenClaw instances on the LAN.",
  {
    targets: z
      .array(z.string())
      .optional()
      .describe("Specific IPs or CIDR ranges to scan (default: auto-detect LAN)"),
    ports: z
      .array(z.number())
      .optional()
      .describe("Ports to probe (default: [18789])"),
  },
  async ({ targets, ports }) => {
    const body: Record<string, unknown> = {};
    if (targets) body.targets = targets;
    if (ports) body.ports = ports;
    return toolResult(await api("POST", "/scan", body));
  },
);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

server.tool(
  "clawnexus_resolve",
  "Resolve a .claw name to instance details via the public Registry.",
  {
    name: z.string().describe("The .claw name to resolve (e.g. 'main.abc123.claw')"),
  },
  async ({ name }) => toolResult(await api("GET", `/resolve/${encodeURIComponent(name)}`)),
);

server.tool(
  "clawnexus_register",
  "Register the local instance to the public ClawNexus Registry.",
  {},
  async () => toolResult(await api("POST", "/registry/register")),
);

server.tool(
  "clawnexus_whoami",
  "Show the local daemon identity (public key and .claw name if registered).",
  {},
  async () => toolResult(await api("GET", "/whoami")),
);

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

server.tool(
  "clawnexus_relay_connect",
  "Connect to a remote instance via the ClawNexus relay service.",
  {
    target_claw_id: z.string().describe("Target .claw identifier to connect to"),
  },
  async ({ target_claw_id }) =>
    toolResult(await api("POST", "/relay/connect", { target_claw_id })),
);

server.tool(
  "clawnexus_relay_status",
  "Show current relay connection status and active rooms.",
  {},
  async () => toolResult(await api("GET", "/relay/status")),
);

server.tool(
  "clawnexus_relay_disconnect",
  "Disconnect from a relay room.",
  {
    room_id: z.string().describe("Room ID to disconnect from"),
  },
  async ({ room_id }) =>
    toolResult(await api("DELETE", `/relay/disconnect/${encodeURIComponent(room_id)}`)),
);

// ---------------------------------------------------------------------------
// Agent (Layer B)
// ---------------------------------------------------------------------------

server.tool(
  "clawnexus_agent_policy",
  "Get the current Layer B agent policy configuration (auto-accept rules, limits, etc).",
  {},
  async () => toolResult(await api("GET", "/agent/policy")),
);

server.tool(
  "clawnexus_agent_tasks",
  "List agent tasks. Optionally filter by direction (inbound/outbound) or state.",
  {
    direction: z.enum(["inbound", "outbound"]).optional().describe("Filter by task direction"),
    state: z
      .enum(["proposed", "accepted", "rejected", "executing", "completed", "failed", "cancelled"])
      .optional()
      .describe("Filter by task state"),
    all: z.boolean().optional().describe("Include completed/terminal tasks (default: active only)"),
  },
  async ({ direction, state, all }) => {
    const params = new URLSearchParams();
    if (direction) params.set("direction", direction);
    if (state) params.set("state", state);
    if (all) params.set("all", "true");
    const qs = params.toString();
    return toolResult(await api("GET", `/agent/tasks${qs ? `?${qs}` : ""}`));
  },
);

server.tool(
  "clawnexus_agent_propose",
  "Send a task proposal to a remote peer via the relay.",
  {
    target_claw_id: z.string().describe("Target peer's .claw identifier"),
    room_id: z.string().describe("Relay room ID for the connection"),
    task_type: z.string().describe("Type of task (e.g. 'summarize', 'translate')"),
    description: z.string().describe("Human-readable description of the task"),
    input: z.record(z.unknown()).optional().describe("Task input parameters"),
  },
  async ({ target_claw_id, room_id, task_type, description, input }) =>
    toolResult(
      await api("POST", "/agent/propose", {
        target_claw_id,
        room_id,
        task: { task_type, description, input },
      }),
    ),
);

server.tool(
  "clawnexus_agent_inbox",
  "View pending inbound task proposals from remote peers.",
  {},
  async () => toolResult(await api("GET", "/agent/inbox")),
);

server.tool(
  "clawnexus_agent_approve",
  "Approve a pending inbound task proposal.",
  {
    id: z.string().describe("Message ID of the inbox item to approve"),
  },
  async ({ id }) =>
    toolResult(await api("POST", `/agent/inbox/${encodeURIComponent(id)}/approve`)),
);

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

server.tool(
  "clawnexus_health",
  "Check daemon health status, component states, and version info.",
  {},
  async () => toolResult(await api("GET", "/health")),
);

server.tool(
  "clawnexus_diagnostics",
  "Get full diagnostic information: local instance, LAN discovery, registry, relay, and summary stats.",
  {},
  async () => toolResult(await api("GET", "/diagnostics")),
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

server.resource(
  "instances",
  "clawnexus://instances",
  { description: "Live snapshot of the ClawNexus instance registry" },
  async () => {
    const result = await api("GET", "/instances");
    return {
      contents: [
        {
          uri: "clawnexus://instances",
          mimeType: "application/json",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  },
);

server.resource(
  "agent-card",
  "clawnexus://agent-card",
  { description: "A2A Agent Card for the local OpenClaw instance" },
  async () => {
    const result = await api("GET", "/.well-known/agent-card.json");
    return {
      contents: [
        {
          uri: "clawnexus://agent-card",
          mimeType: "application/json",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  },
);

return server;

} // end createServer

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[clawnexus-mcp] Server started (daemon: ${API_BASE})`);
}

/* v8 ignore next 3 */
const isMainScript = process.argv[1]?.endsWith("/mcp/dist/index.js") ||
  process.argv[1]?.endsWith("/mcp/src/index.ts");
if (isMainScript) main().catch((err) => { console.error("[clawnexus-mcp] Fatal:", err); process.exit(1); });
