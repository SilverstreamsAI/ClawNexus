import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { SkillsRegistry, DEFAULT_SKILL } from "../../src/agent/services.js";

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/**
 * Mock OpenClaw Gateway (v3 protocol) that handles handshake and tools.catalog requests.
 */
function createMockGateway(port: number, opts: {
  tools?: Array<Record<string, unknown>>;
  rejectConnect?: boolean;
  catalogDelay?: number;
  noCatalogResponse?: boolean;
} = {}): { wss: WebSocketServer; close: () => Promise<void> } {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    const nonce = randomUUID();

    // Step 1: Send connect.challenge (v3 format)
    ws.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce, ts: Date.now() },
    }));

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      // v3 protocol uses type/id/method/params
      if (msg.type === "req" && msg.method === "connect") {
        if (opts.rejectConnect) {
          ws.send(JSON.stringify({
            type: "res",
            id: msg.id,
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Rejected" },
          }));
          ws.close();
          return;
        }
        ws.send(JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            server: { version: "mock", connId: randomUUID() },
            features: { methods: ["tools.catalog", "chat.send"], events: ["chat"] },
            snapshot: {},
            policy: {},
          },
        }));
      }

      if (msg.type === "req" && msg.method === "tools.catalog") {
        if (opts.noCatalogResponse) return; // Simulate timeout

        const rawTools = opts.tools ?? [
          { id: "web_search", label: "web_search", description: "Search the web" },
          { id: "read_file", label: "read_file", description: "Read a file from disk" },
        ];

        // v3 returns grouped tools
        const groups = [{
          id: "default",
          label: "Default",
          source: "core",
          tools: rawTools,
        }];

        const delay = opts.catalogDelay ?? 10;
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            payload: { agentId: "main", groups },
          }));
        }, delay);
      }
    });
  });

  return {
    wss,
    close: () => new Promise<void>((resolve) => {
      wss.close(() => resolve());
    }),
  };
}

describe("SkillsRegistry", () => {
  let gateway: ReturnType<typeof createMockGateway> | null = null;
  let registry: SkillsRegistry | null = null;

  afterEach(async () => {
    registry?.stop();
    registry = null;
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
  });

  it("fetches tools from Gateway and converts to AgentSkill[]", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      tools: [
        { id: "web_search", label: "web_search", description: "Search the web for info" },
        { id: "code_execute", label: "code_execute", description: "Run code snippets" },
      ],
    });

    registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
    const ok = await registry.refresh();

    expect(ok).toBe(true);
    const skills = registry.getSkills();
    expect(skills).toHaveLength(2);
    expect(skills[0].id).toBe("web_search");
    expect(skills[0].name).toBe("Web Search");
    expect(skills[0].tags).toContain("web");
    expect(skills[1].id).toBe("code_execute");
    expect(skills[1].name).toBe("Code Execute");
    expect(skills[1].tags).toContain("code");
  });

  it("returns DEFAULT_SKILL when no tools fetched", () => {
    registry = new SkillsRegistry({ gatewayUrl: "ws://127.0.0.1:1" });
    const skills = registry.getSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual(DEFAULT_SKILL);
  });

  it("returns DEFAULT_SKILL when Gateway is not available", async () => {
    registry = new SkillsRegistry({ gatewayUrl: "ws://127.0.0.1:1" });
    const ok = await registry.refresh();
    expect(ok).toBe(false);
    expect(registry.getSkills()).toEqual([DEFAULT_SKILL]);
  });

  it("keeps previous skills when refresh fails", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      tools: [{ id: "my_tool", label: "my_tool", description: "My tool" }],
    });

    registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
    await registry.refresh();
    expect(registry.getSkills()).toHaveLength(1);
    expect(registry.getSkills()[0].id).toBe("my_tool");

    // Close gateway, try refresh again
    await gateway.close();
    gateway = null;

    const ok = await registry.refresh();
    expect(ok).toBe(false);
    // Should keep the previous skills
    expect(registry.getSkills()).toHaveLength(1);
    expect(registry.getSkills()[0].id).toBe("my_tool");
  });

  it("getCapabilities converts skills to ServiceCapability[]", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      tools: [{ id: "web_search", label: "web_search", description: "Search the web" }],
    });

    registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
    await registry.refresh();

    const caps = registry.getCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].service_type).toBe("web_search");
    expect(caps[0].description).toBe("Search the web");
  });

  it("getStatus reports source correctly", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      tools: [{ id: "tool1", label: "tool1", description: "Tool" }],
    });

    registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });

    // Before refresh
    expect(registry.getStatus().source).toBe("default");
    expect(registry.getStatus().last_refreshed).toBeNull();

    await registry.refresh();
    expect(registry.getStatus().source).toBe("gateway");
    expect(registry.getStatus().last_refreshed).not.toBeNull();
    expect(registry.getStatus().skill_count).toBe(1);
  });

  it("handles empty tools array", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, { tools: [] });

    registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
    await registry.refresh();

    // Empty from gateway → falls back to DEFAULT_SKILL
    expect(registry.getSkills()).toEqual([DEFAULT_SKILL]);
  });

  it("infers tags from tool names", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      tools: [
        { id: "file_reader", label: "file_reader", description: "Read files" },
        { id: "image_gen", label: "image_gen", description: "Generate images" },
        { id: "http_request", label: "http_request", description: "HTTP requests" },
        { id: "my_custom_tool", label: "my_custom_tool", description: "Custom" },
      ],
    });

    registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
    await registry.refresh();

    const skills = registry.getSkills();
    expect(skills[0].tags).toContain("filesystem");
    expect(skills[1].tags).toContain("media");
    expect(skills[2].tags).toContain("network");
    expect(skills[3].tags).toContain("general");
  });
});
