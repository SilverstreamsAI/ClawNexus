import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { SkillsRegistry, DEFAULT_SKILL } from "../../src/agent/services.js";

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

function createMockGateway(port: number, opts: {
  tools?: Array<Record<string, unknown>>;
  catalogDelay?: number;
  noCatalogResponse?: boolean;
} = {}): { wss: WebSocketServer; close: () => Promise<void> } {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    const nonce = randomUUID();
    ws.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce, ts: Date.now() },
    }));

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "req" && msg.method === "connect") {
        ws.send(JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            server: { version: "mock", connId: randomUUID() },
            features: { methods: ["tools.catalog"], events: [] },
            snapshot: {},
            policy: {},
          },
        }));
      }

      if (msg.type === "req" && msg.method === "tools.catalog") {
        if (opts.noCatalogResponse) return;

        const rawTools = opts.tools ?? [];
        const groups = [{ id: "default", label: "Default", source: "core", tools: rawTools }];
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
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

describe("SkillsRegistry — edge cases", () => {
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

  describe("refresh after stop", () => {
    it("refresh returns false after stop()", async () => {
      registry = new SkillsRegistry({ gatewayUrl: "ws://127.0.0.1:1" });
      registry.stop();
      const ok = await registry.refresh();
      expect(ok).toBe(false);
    });
  });

  describe("periodic refresh timer", () => {
    it("start() triggers initial refresh and sets up timer", async () => {
      const port = getRandomPort();
      let refreshCount = 0;
      gateway = createMockGateway(port, {
        tools: [{ id: "tool1", label: "tool1", description: "A tool" }],
      });

      registry = new SkillsRegistry({
        gatewayUrl: `ws://127.0.0.1:${port}`,
        refreshIntervalMs: 200, // Short interval for testing
      });

      registry.on("refreshed", () => { refreshCount++; });
      registry.start();

      // Wait for initial refresh + at least one periodic refresh
      await vi.waitFor(() => {
        expect(refreshCount).toBeGreaterThanOrEqual(2);
      }, { timeout: 3000 });

      registry.stop();
    });
  });

  describe("tool-to-skill conversion edge cases", () => {
    it("handles tools with only id (no label, no name)", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "bare_tool", description: "A bare tool" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      const skills = registry.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe("bare_tool");
      expect(skills[0].name).toBe("Bare Tool");
    });

    it("handles tools with name but no id", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ name: "my_special_tool", description: "Special" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      const skills = registry.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe("my_special_tool");
    });

    it("handles tools with no description", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "no_desc" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      const skills = registry.getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].description).toBe("");
    });

    it("label takes priority over name for display", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "tool1", name: "original_name", label: "better_label", description: "Test" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      const skills = registry.getSkills();
      expect(skills[0].name).toBe("Better Label");
    });
  });

  describe("tag inference edge cases", () => {
    it("tags 'general' for unrecognized tool names", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "quantum_entangler", label: "quantum_entangler", description: "Entangle qubits" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      expect(registry.getSkills()[0].tags).toEqual(["general"]);
    });

    it("assigns multiple tags when name matches multiple categories", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "web_file_reader", label: "web_file_reader", description: "Read web files" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      const tags = registry.getSkills()[0].tags;
      expect(tags).toContain("web");
      expect(tags).toContain("filesystem");
    });

    it("detects media-related tools", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [
          { id: "draw_image", label: "draw_image", description: "Draw" },
          { id: "vision_analyze", label: "vision_analyze", description: "Analyze" },
        ],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      expect(registry.getSkills()[0].tags).toContain("media");
      expect(registry.getSkills()[1].tags).toContain("media");
    });

    it("detects code-related tools", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "run_python", label: "run_python", description: "Execute Python" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      expect(registry.getSkills()[0].tags).toContain("code");
    });

    it("detects network-related tools", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [
          { id: "fetch_url", label: "fetch_url", description: "Fetch a URL" },
          { id: "api_call", label: "api_call", description: "Call an API" },
        ],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      expect(registry.getSkills()[0].tags).toContain("network");
      expect(registry.getSkills()[1].tags).toContain("network");
    });
  });

  describe("formatSkillName", () => {
    it("converts snake_case to Title Case", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "my_great_tool", label: "my_great_tool", description: "Test" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      expect(registry.getSkills()[0].name).toBe("My Great Tool");
    });

    it("converts kebab-case to Title Case", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "web-search-v2", label: "web-search-v2", description: "Test" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      expect(registry.getSkills()[0].name).toBe("Web Search V2");
    });
  });

  describe("error handling", () => {
    it("emits refresh_error when gateway connection fails", async () => {
      registry = new SkillsRegistry({ gatewayUrl: "ws://127.0.0.1:1" });

      const errors: Error[] = [];
      registry.on("refresh_error", (err: Error) => errors.push(err));

      await registry.refresh();
      expect(errors).toHaveLength(1);
    });

    it("emits refreshed event on success", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [{ id: "tool1", label: "tool1", description: "Tool" }],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });

      const refreshed: any[] = [];
      registry.on("refreshed", (skills: any[]) => refreshed.push(skills));

      await registry.refresh();
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]).toHaveLength(1);
    });
  });

  describe("getStatus", () => {
    it("skill_count reflects actual skills after refresh", async () => {
      const port = getRandomPort();
      gateway = createMockGateway(port, {
        tools: [
          { id: "a", label: "a", description: "A" },
          { id: "b", label: "b", description: "B" },
          { id: "c", label: "c", description: "C" },
        ],
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      const status = registry.getStatus();
      expect(status.skill_count).toBe(3);
      expect(status.source).toBe("gateway");
      expect(status.last_refreshed).toBeTruthy();
    });
  });

  describe("multiple tool groups", () => {
    it("flattens tools from multiple groups", async () => {
      const port = getRandomPort();
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
        ws.send(JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: randomUUID(), ts: Date.now() },
        }));
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "req" && msg.method === "connect") {
            ws.send(JSON.stringify({
              type: "res",
              id: msg.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                server: { version: "mock", connId: randomUUID() },
                features: {},
                snapshot: {},
                policy: {},
              },
            }));
          }
          if (msg.type === "req" && msg.method === "tools.catalog") {
            ws.send(JSON.stringify({
              type: "res",
              id: msg.id,
              ok: true,
              payload: {
                agentId: "main",
                groups: [
                  { id: "core", tools: [{ id: "web_search", label: "web_search", description: "Search" }] },
                  { id: "custom", tools: [{ id: "my_tool", label: "my_tool", description: "Custom" }] },
                  { id: "empty", tools: [] },
                ],
              },
            }));
          }
        });
      });

      registry = new SkillsRegistry({ gatewayUrl: `ws://127.0.0.1:${port}` });
      await registry.refresh();

      const skills = registry.getSkills();
      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.id)).toContain("web_search");
      expect(skills.map((s) => s.id)).toContain("my_tool");

      registry.stop();
      registry = null;
      await new Promise<void>((r) => wss.close(() => r()));
    });
  });
});
