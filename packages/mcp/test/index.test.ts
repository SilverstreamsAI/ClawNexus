import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, api, toolResult, main } from "../src/index.js";
import type { ApiResult } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;
let client: Client;
let closeTransports: () => Promise<void>;

function mockOk(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status,
    json: async () => data,
  });
}

function mockError(status: number, data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => data,
  });
}

function mockNetworkError(message = "ECONNREFUSED") {
  mockFetch.mockRejectedValueOnce(new Error(message));
}

function lastCall() {
  const calls = mockFetch.mock.calls;
  const [url, opts] = calls[calls.length - 1];
  return {
    url: url as string,
    method: (opts?.method ?? "GET") as string,
    body: opts?.body ? JSON.parse(opts.body as string) : undefined,
  };
}

function parseContent(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Setup / Teardown — create MCP server + client connected via InMemoryTransport
// ---------------------------------------------------------------------------

beforeEach(async () => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);

  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  closeTransports = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await closeTransports();
});

// ---------------------------------------------------------------------------
// Low-level helpers: api() and toolResult()
// ---------------------------------------------------------------------------

describe("api() helper", () => {
  it("sends GET request with correct URL", async () => {
    mockOk({ status: "ok" });
    const result = await api("GET", "/health");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ status: "ok" });
    expect(lastCall().url).toBe("http://localhost:17890/health");
    expect(lastCall().method).toBe("GET");
  });

  it("sends POST request with body", async () => {
    mockOk({ status: "ok" });
    const result = await api("POST", "/scan", { targets: ["192.168.1.0/24"] });
    expect(result.ok).toBe(true);
    expect(lastCall().method).toBe("POST");
    expect(lastCall().body).toEqual({ targets: ["192.168.1.0/24"] });
  });

  it("handles HTTP error response", async () => {
    mockError(404, { error: "Not found" });
    const result = await api("GET", "/instances/missing");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.data).toEqual({ error: "Not found" });
  });

  it("handles network failure", async () => {
    mockNetworkError("ECONNREFUSED");
    const result = await api("GET", "/health");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    const data = result.data as { error: string };
    expect(data.error).toContain("Failed to reach daemon");
    expect(data.error).toContain("ECONNREFUSED");
  });

  it("handles json parse failure gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error("bad json"); },
    });
    const result = await api("GET", "/health");
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it("does not send body for GET requests without body arg", async () => {
    mockOk({});
    await api("GET", "/instances");
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBeUndefined();
  });
});

describe("toolResult() helper", () => {
  it("formats successful result", () => {
    const r: ApiResult = { ok: true, status: 200, data: { count: 3 } };
    const result = toolResult(r);
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ count: 3 });
  });

  it("formats error result", () => {
    const r: ApiResult = { ok: false, status: 500, data: { error: "fail" } };
    const result = toolResult(r);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "fail" });
  });
});

// ---------------------------------------------------------------------------
// MCP protocol: tools/list
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("returns all 19 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(18);
    const names = tools.map((t) => t.name);
    expect(names).toContain("clawnexus_list_instances");
    expect(names).toContain("clawnexus_get_instance");
    expect(names).toContain("clawnexus_set_alias");
    expect(names).toContain("clawnexus_remove_instance");
    expect(names).toContain("clawnexus_scan");
    expect(names).toContain("clawnexus_resolve");
    expect(names).toContain("clawnexus_register");
    expect(names).toContain("clawnexus_whoami");
    expect(names).toContain("clawnexus_relay_connect");
    expect(names).toContain("clawnexus_relay_status");
    expect(names).toContain("clawnexus_relay_disconnect");
    expect(names).toContain("clawnexus_agent_policy");
    expect(names).toContain("clawnexus_agent_tasks");
    expect(names).toContain("clawnexus_agent_propose");
    expect(names).toContain("clawnexus_agent_inbox");
    expect(names).toContain("clawnexus_agent_approve");
    expect(names).toContain("clawnexus_health");
    expect(names).toContain("clawnexus_diagnostics");
  });
});

// ---------------------------------------------------------------------------
// MCP protocol: resources/list
// ---------------------------------------------------------------------------

describe("resources/list", () => {
  it("returns 2 resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBe(2);
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("clawnexus://instances");
    expect(uris).toContain("clawnexus://agent-card");
  });
});

// ---------------------------------------------------------------------------
// Discovery & Instances tools
// ---------------------------------------------------------------------------

describe("clawnexus_list_instances", () => {
  it("calls GET /instances and returns data", async () => {
    const payload = { count: 2, instances: [{ agent_id: "a1" }, { agent_id: "a2" }] };
    mockOk(payload);
    const result = await client.callTool({ name: "clawnexus_list_instances", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseContent(result as any).count).toBe(2);
    expect(lastCall().url).toBe("http://localhost:17890/instances");
  });

  it("passes scope query param", async () => {
    mockOk({ count: 0, instances: [] });
    await client.callTool({ name: "clawnexus_list_instances", arguments: { scope: "vpn" } });
    expect(lastCall().url).toBe("http://localhost:17890/instances?scope=vpn");
  });

  it("filters by status client-side", async () => {
    const payload = {
      count: 3,
      instances: [
        { agent_id: "a1", status: "online" },
        { agent_id: "a2", status: "offline" },
        { agent_id: "a3", status: "online" },
      ],
    };
    mockOk(payload);
    const result = await client.callTool({
      name: "clawnexus_list_instances",
      arguments: { status: "online" },
    });
    const data = parseContent(result as any);
    expect(data.count).toBe(2);
    expect(data.instances.every((i: any) => i.status === "online")).toBe(true);
  });

  it("returns isError on daemon failure", async () => {
    mockNetworkError();
    const result = await client.callTool({ name: "clawnexus_list_instances", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("clawnexus_get_instance", () => {
  it("calls GET /instances/:id", async () => {
    mockOk({ agent_id: "main", auto_name: "macbook" });
    const result = await client.callTool({
      name: "clawnexus_get_instance",
      arguments: { id: "macbook" },
    });
    expect(result.isError).toBeFalsy();
    expect(parseContent(result as any).auto_name).toBe("macbook");
    expect(lastCall().url).toBe("http://localhost:17890/instances/macbook");
  });

  it("encodes special characters in id", async () => {
    mockOk({});
    await client.callTool({ name: "clawnexus_get_instance", arguments: { id: "my agent" } });
    expect(lastCall().url).toBe("http://localhost:17890/instances/my%20agent");
  });

  it("returns isError on 404", async () => {
    mockError(404, { error: "Instance not found" });
    const result = await client.callTool({
      name: "clawnexus_get_instance",
      arguments: { id: "unknown" },
    });
    expect(result.isError).toBe(true);
    expect(parseContent(result as any).error).toBe("Instance not found");
  });
});

describe("clawnexus_set_alias", () => {
  it("calls PUT /instances/:id/alias with body", async () => {
    mockOk({ status: "ok", alias: "home" });
    const result = await client.callTool({
      name: "clawnexus_set_alias",
      arguments: { id: "macbook", alias: "home" },
    });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("PUT");
    expect(lastCall().url).toBe("http://localhost:17890/instances/macbook/alias");
    expect(lastCall().body).toEqual({ alias: "home" });
  });

  it("returns isError on 409 conflict", async () => {
    mockError(409, { error: "Alias already taken" });
    const result = await client.callTool({
      name: "clawnexus_set_alias",
      arguments: { id: "macbook", alias: "home" },
    });
    expect(result.isError).toBe(true);
    expect(parseContent(result as any).error).toBe("Alias already taken");
  });
});

describe("clawnexus_remove_instance", () => {
  it("calls DELETE /instances/:id", async () => {
    mockOk({ status: "ok", removed: "macbook" });
    const result = await client.callTool({
      name: "clawnexus_remove_instance",
      arguments: { id: "macbook" },
    });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toBe("http://localhost:17890/instances/macbook");
  });
});

describe("clawnexus_scan", () => {
  it("calls POST /scan with empty body by default", async () => {
    mockOk({ status: "ok", discovered: 0, instances: [] });
    const result = await client.callTool({ name: "clawnexus_scan", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe("http://localhost:17890/scan");
    expect(lastCall().body).toEqual({});
  });

  it("passes targets and ports in body", async () => {
    mockOk({ status: "ok", discovered: 1, instances: [{}] });
    await client.callTool({
      name: "clawnexus_scan",
      arguments: { targets: ["192.168.1.0/24"], ports: [18789, 18790] },
    });
    expect(lastCall().body).toEqual({ targets: ["192.168.1.0/24"], ports: [18789, 18790] });
  });
});

// ---------------------------------------------------------------------------
// Registry tools
// ---------------------------------------------------------------------------

describe("clawnexus_resolve", () => {
  it("calls GET /resolve/:name", async () => {
    mockOk({ agent_id: "main", claw_name: "main.abc.claw" });
    const result = await client.callTool({
      name: "clawnexus_resolve",
      arguments: { name: "main.abc.claw" },
    });
    expect(result.isError).toBeFalsy();
    expect(lastCall().url).toBe("http://localhost:17890/resolve/main.abc.claw");
  });

  it("returns isError on 404", async () => {
    mockError(404, { error: "Name not found" });
    const result = await client.callTool({
      name: "clawnexus_resolve",
      arguments: { name: "nope.claw" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("clawnexus_register", () => {
  it("calls POST /registry/register", async () => {
    mockOk({ status: "ok", claw_name: "main.abc.claw", pubkey: "ed25519:abc" });
    const result = await client.callTool({ name: "clawnexus_register", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe("http://localhost:17890/registry/register");
  });
});

describe("clawnexus_whoami", () => {
  it("calls GET /whoami", async () => {
    mockOk({ pubkey: "ed25519:abc", claw_name: "main.abc.claw" });
    const result = await client.callTool({ name: "clawnexus_whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseContent(result as any).pubkey).toBe("ed25519:abc");
    expect(lastCall().url).toBe("http://localhost:17890/whoami");
  });
});

// ---------------------------------------------------------------------------
// Relay tools
// ---------------------------------------------------------------------------

describe("clawnexus_relay_connect", () => {
  it("calls POST /relay/connect with target_claw_id", async () => {
    mockOk({ status: "connecting", target: "peer.claw" });
    const result = await client.callTool({
      name: "clawnexus_relay_connect",
      arguments: { target_claw_id: "peer.claw" },
    });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe("http://localhost:17890/relay/connect");
    expect(lastCall().body).toEqual({ target_claw_id: "peer.claw" });
  });
});

describe("clawnexus_relay_status", () => {
  it("calls GET /relay/status", async () => {
    mockOk({ state: "connected", rooms: [] });
    const result = await client.callTool({ name: "clawnexus_relay_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(lastCall().url).toBe("http://localhost:17890/relay/status");
  });

  it("returns isError when relay not initialized", async () => {
    mockError(503, { error: "Relay connector not initialized" });
    const result = await client.callTool({ name: "clawnexus_relay_status", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("clawnexus_relay_disconnect", () => {
  it("calls DELETE /relay/disconnect/:room_id", async () => {
    mockOk({ status: "disconnected", room_id: "room-1" });
    const result = await client.callTool({
      name: "clawnexus_relay_disconnect",
      arguments: { room_id: "room-1" },
    });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toBe("http://localhost:17890/relay/disconnect/room-1");
  });

  it("encodes special characters in room_id", async () => {
    mockOk({});
    await client.callTool({
      name: "clawnexus_relay_disconnect",
      arguments: { room_id: "room/special" },
    });
    expect(lastCall().url).toBe("http://localhost:17890/relay/disconnect/room%2Fspecial");
  });
});

// ---------------------------------------------------------------------------
// Agent (Layer B) tools
// ---------------------------------------------------------------------------

describe("clawnexus_agent_policy", () => {
  it("calls GET /agent/policy", async () => {
    mockOk({ mode: "queue", max_concurrent_tasks: 3 });
    const result = await client.callTool({ name: "clawnexus_agent_policy", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseContent(result as any).mode).toBe("queue");
    expect(lastCall().url).toBe("http://localhost:17890/agent/policy");
  });
});

describe("clawnexus_agent_tasks", () => {
  it("calls GET /agent/tasks without params", async () => {
    mockOk({ count: 0, tasks: [] });
    const result = await client.callTool({ name: "clawnexus_agent_tasks", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(lastCall().url).toBe("http://localhost:17890/agent/tasks");
  });

  it("passes direction query param", async () => {
    mockOk({ count: 0, tasks: [] });
    await client.callTool({
      name: "clawnexus_agent_tasks",
      arguments: { direction: "inbound" },
    });
    expect(lastCall().url).toContain("direction=inbound");
  });

  it("passes state query param", async () => {
    mockOk({ count: 0, tasks: [] });
    await client.callTool({
      name: "clawnexus_agent_tasks",
      arguments: { state: "executing" },
    });
    expect(lastCall().url).toContain("state=executing");
  });

  it("passes all=true query param", async () => {
    mockOk({ count: 0, tasks: [] });
    await client.callTool({
      name: "clawnexus_agent_tasks",
      arguments: { all: true },
    });
    expect(lastCall().url).toContain("all=true");
  });

  it("passes multiple query params", async () => {
    mockOk({ count: 0, tasks: [] });
    await client.callTool({
      name: "clawnexus_agent_tasks",
      arguments: { direction: "outbound", state: "completed", all: true },
    });
    const url = lastCall().url;
    expect(url).toContain("direction=outbound");
    expect(url).toContain("state=completed");
    expect(url).toContain("all=true");
  });
});

describe("clawnexus_agent_propose", () => {
  it("calls POST /agent/propose with structured body", async () => {
    mockOk({ status: "ok", task: { task_id: "t1" } });
    const result = await client.callTool({
      name: "clawnexus_agent_propose",
      arguments: {
        target_claw_id: "peer.claw",
        room_id: "room-1",
        task_type: "summarize",
        description: "Summarize a document",
        input: { url: "https://example.com" },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe("http://localhost:17890/agent/propose");
    expect(lastCall().body).toEqual({
      target_claw_id: "peer.claw",
      room_id: "room-1",
      task: {
        task_type: "summarize",
        description: "Summarize a document",
        input: { url: "https://example.com" },
      },
    });
  });

  it("omits input when not provided", async () => {
    mockOk({ status: "ok", task: {} });
    await client.callTool({
      name: "clawnexus_agent_propose",
      arguments: {
        target_claw_id: "peer.claw",
        room_id: "room-1",
        task_type: "ping",
        description: "Check availability",
      },
    });
    expect(lastCall().body.task.input).toBeUndefined();
  });
});

describe("clawnexus_agent_inbox", () => {
  it("calls GET /agent/inbox", async () => {
    mockOk({ count: 1, items: [{ message_id: "m1" }] });
    const result = await client.callTool({ name: "clawnexus_agent_inbox", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseContent(result as any).count).toBe(1);
    expect(lastCall().url).toBe("http://localhost:17890/agent/inbox");
  });

  it("returns isError when router not initialized", async () => {
    mockError(503, { error: "Agent router not initialized" });
    const result = await client.callTool({ name: "clawnexus_agent_inbox", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe("clawnexus_agent_approve", () => {
  it("calls POST /agent/inbox/:id/approve", async () => {
    mockOk({ status: "ok", task: { state: "accepted" } });
    const result = await client.callTool({
      name: "clawnexus_agent_approve",
      arguments: { id: "msg-123" },
    });
    expect(result.isError).toBeFalsy();
    expect(lastCall().method).toBe("POST");
    expect(lastCall().url).toBe("http://localhost:17890/agent/inbox/msg-123/approve");
  });

  it("encodes special characters in id", async () => {
    mockOk({});
    await client.callTool({
      name: "clawnexus_agent_approve",
      arguments: { id: "msg/special" },
    });
    expect(lastCall().url).toBe("http://localhost:17890/agent/inbox/msg%2Fspecial/approve");
  });

  it("returns isError on 404", async () => {
    mockError(404, { error: "Inbox item not found" });
    const result = await client.callTool({
      name: "clawnexus_agent_approve",
      arguments: { id: "missing" },
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics tools
// ---------------------------------------------------------------------------

describe("clawnexus_health", () => {
  it("calls GET /health", async () => {
    const payload = { status: "ok", service: "clawnexus-daemon", version: "0.4.0" };
    mockOk(payload);
    const result = await client.callTool({ name: "clawnexus_health", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseContent(result as any).status).toBe("ok");
    expect(lastCall().url).toBe("http://localhost:17890/health");
  });

  it("returns isError when daemon is down", async () => {
    mockNetworkError("ECONNREFUSED");
    const result = await client.callTool({ name: "clawnexus_health", arguments: {} });
    expect(result.isError).toBe(true);
    expect(parseContent(result as any).error).toContain("ECONNREFUSED");
  });
});

describe("clawnexus_diagnostics", () => {
  it("calls GET /diagnostics", async () => {
    const payload = {
      local_instance: { status: "detected" },
      summary: { total_instances: 2 },
    };
    mockOk(payload);
    const result = await client.callTool({ name: "clawnexus_diagnostics", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseContent(result as any).summary.total_instances).toBe(2);
    expect(lastCall().url).toBe("http://localhost:17890/diagnostics");
  });
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

describe("clawnexus://instances resource", () => {
  it("returns instance registry as JSON", async () => {
    const payload = { count: 1, instances: [{ agent_id: "main" }] };
    mockOk(payload);
    const result = await client.readResource({ uri: "clawnexus://instances" });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe("clawnexus://instances");
    expect(result.contents[0].mimeType).toBe("application/json");
    const data = JSON.parse(result.contents[0].text as string);
    expect(data.count).toBe(1);
  });

  it("returns data even when daemon is down", async () => {
    mockNetworkError();
    const result = await client.readResource({ uri: "clawnexus://instances" });
    expect(result.contents).toHaveLength(1);
    const data = JSON.parse(result.contents[0].text as string);
    expect(data.error).toContain("Failed to reach daemon");
  });
});

describe("clawnexus://agent-card resource", () => {
  it("returns agent card as JSON", async () => {
    const card = { name: "test-agent", url: "http://localhost:17890" };
    mockOk(card);
    const result = await client.readResource({ uri: "clawnexus://agent-card" });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe("clawnexus://agent-card");
    expect(result.contents[0].mimeType).toBe("application/json");
    const data = JSON.parse(result.contents[0].text as string);
    expect(data.name).toBe("test-agent");
    expect(lastCall().url).toBe("http://localhost:17890/.well-known/agent-card.json");
  });

  it("returns error data when no local instance", async () => {
    mockError(404, { error: "No local instance discovered" });
    const result = await client.readResource({ uri: "clawnexus://agent-card" });
    const data = JSON.parse(result.contents[0].text as string);
    expect(data.error).toBe("No local instance discovered");
  });
});

// ---------------------------------------------------------------------------
// main() entry point
// ---------------------------------------------------------------------------

describe("main()", () => {
  it("creates server and connects via StdioServerTransport", async () => {
    // main() reads from stdin and writes to stdout — we need to mock StdioServerTransport
    // Since main() will hang waiting for stdio, we mock the module
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
    const originalStart = StdioServerTransport.prototype.start;
    // Patch start to be a no-op so main() doesn't actually read stdin
    StdioServerTransport.prototype.start = async function () {};

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // main() should complete without error
    await main();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[clawnexus-mcp] Server started"),
    );

    // Restore
    StdioServerTransport.prototype.start = originalStart;
    stderrSpy.mockRestore();
  });
});
