import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClawNexusClient, ClawNexusApiError } from "../src/client.js";

describe("ClawNexusClient", () => {
  let client: ClawNexusClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ClawNexusClient({ apiUrl: "http://test:17890", timeout: 5000 });
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  function mockOk(data: unknown) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => data,
    });
  }

  function mockError(status: number, error: string) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      json: async () => ({ error }),
    });
  }

  function lastCall() {
    const [url, opts] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    return { url: url as string, method: opts?.method ?? "GET", body: opts?.body ? JSON.parse(opts.body) : undefined };
  }

  describe("health", () => {
    it("calls GET /health", async () => {
      mockOk({ status: "ok" });
      const result = await client.health();
      expect(result.status).toBe("ok");
      expect(lastCall().url).toBe("http://test:17890/health");
      expect(lastCall().method).toBe("GET");
    });
  });

  describe("listInstances", () => {
    it("calls GET /instances", async () => {
      mockOk({ count: 0, instances: [] });
      const result = await client.listInstances();
      expect(result.count).toBe(0);
      expect(lastCall().url).toBe("http://test:17890/instances");
    });
  });

  describe("getInstance", () => {
    it("calls GET /instances/:id with encoded id", async () => {
      mockOk({ agent_id: "a1" });
      await client.getInstance("my agent");
      expect(lastCall().url).toBe("http://test:17890/instances/my%20agent");
    });
  });

  describe("setAlias", () => {
    it("calls PUT /instances/:id/alias with body", async () => {
      mockOk({ status: "ok", agent_id: "a1", alias: "home" });
      await client.setAlias("a1", "home");
      expect(lastCall().method).toBe("PUT");
      expect(lastCall().body).toEqual({ alias: "home" });
    });
  });

  describe("removeInstance", () => {
    it("calls DELETE /instances/:id", async () => {
      mockOk({ status: "ok", removed: "a1" });
      await client.removeInstance("a1");
      expect(lastCall().method).toBe("DELETE");
      expect(lastCall().url).toBe("http://test:17890/instances/a1");
    });
  });

  describe("scan", () => {
    it("calls POST /scan", async () => {
      mockOk({ status: "ok", discovered: 0, instances: [] });
      await client.scan();
      expect(lastCall().method).toBe("POST");
      expect(lastCall().url).toBe("http://test:17890/scan");
    });
  });

  describe("relayConnect", () => {
    it("calls POST /relay/connect with body", async () => {
      mockOk({ status: "connecting", target: "x.claw" });
      await client.relayConnect("x.claw");
      expect(lastCall().method).toBe("POST");
      expect(lastCall().body).toEqual({ target_claw_id: "x.claw" });
    });
  });

  describe("relayStatus", () => {
    it("calls GET /relay/status", async () => {
      mockOk({ rooms: [] });
      await client.relayStatus();
      expect(lastCall().url).toBe("http://test:17890/relay/status");
    });
  });

  describe("relayDisconnect", () => {
    it("calls DELETE /relay/disconnect/:roomId", async () => {
      mockOk({ status: "disconnected", room_id: "r1" });
      await client.relayDisconnect("r1");
      expect(lastCall().method).toBe("DELETE");
      expect(lastCall().url).toBe("http://test:17890/relay/disconnect/r1");
    });
  });

  describe("getPolicy", () => {
    it("calls GET /agent/policy", async () => {
      mockOk({ mode: "queue" });
      const result = await client.getPolicy();
      expect(result.mode).toBe("queue");
    });
  });

  describe("updatePolicy", () => {
    it("calls PUT /agent/policy", async () => {
      mockOk({ status: "ok" });
      await client.updatePolicy({ mode: "auto" } as any);
      expect(lastCall().method).toBe("PUT");
      expect(lastCall().body.mode).toBe("auto");
    });
  });

  describe("patchPolicy", () => {
    it("calls PATCH /agent/policy", async () => {
      mockOk({ status: "ok", policy: { mode: "hybrid" } });
      await client.patchPolicy({ mode: "hybrid" });
      expect(lastCall().method).toBe("PATCH");
      expect(lastCall().body).toEqual({ mode: "hybrid" });
    });
  });

  describe("resetPolicy", () => {
    it("calls POST /agent/policy/reset", async () => {
      mockOk({ status: "ok", policy: { mode: "queue" } });
      await client.resetPolicy();
      expect(lastCall().method).toBe("POST");
      expect(lastCall().url).toBe("http://test:17890/agent/policy/reset");
    });
  });

  describe("listTasks", () => {
    it("calls GET /agent/tasks", async () => {
      mockOk({ count: 0, tasks: [] });
      await client.listTasks();
      expect(lastCall().url).toBe("http://test:17890/agent/tasks");
    });

    it("passes query params", async () => {
      mockOk({ count: 0, tasks: [] });
      await client.listTasks({ all: true, direction: "inbound", state: "pending" });
      expect(lastCall().url).toContain("all=true");
      expect(lastCall().url).toContain("direction=inbound");
      expect(lastCall().url).toContain("state=pending");
    });
  });

  describe("getTask", () => {
    it("calls GET /agent/tasks/:id", async () => {
      mockOk({ task_id: "t1" });
      await client.getTask("t1");
      expect(lastCall().url).toBe("http://test:17890/agent/tasks/t1");
    });
  });

  describe("cancelTask", () => {
    it("calls POST /agent/tasks/:id/cancel", async () => {
      mockOk({ status: "ok", task: { state: "cancelled" } });
      await client.cancelTask("t1", "No longer needed");
      expect(lastCall().method).toBe("POST");
      expect(lastCall().body).toEqual({ reason: "No longer needed" });
    });
  });

  describe("getTaskStats", () => {
    it("calls GET /agent/tasks/stats", async () => {
      mockOk({ total: 0, active: 0, by_state: {}, by_direction: {} });
      await client.getTaskStats();
      expect(lastCall().url).toBe("http://test:17890/agent/tasks/stats");
    });
  });

  describe("propose", () => {
    it("calls POST /agent/propose with correct body", async () => {
      mockOk({ status: "ok", task: {} });
      await client.propose("peer.claw", "room1", { task_type: "translate", description: "Translate text" });
      expect(lastCall().method).toBe("POST");
      expect(lastCall().body).toEqual({
        target_claw_id: "peer.claw",
        room_id: "room1",
        task: { task_type: "translate", description: "Translate text" },
      });
    });
  });

  describe("query", () => {
    it("calls POST /agent/query with correct body", async () => {
      mockOk({ status: "ok", message_id: "m1" });
      await client.query("peer.claw", "room1", "capabilities");
      expect(lastCall().body).toEqual({
        target_claw_id: "peer.claw",
        room_id: "room1",
        query_type: "capabilities",
      });
    });
  });

  describe("getInbox", () => {
    it("calls GET /agent/inbox", async () => {
      mockOk({ count: 0, items: [] });
      await client.getInbox();
      expect(lastCall().url).toBe("http://test:17890/agent/inbox");
    });
  });

  describe("approveInbox", () => {
    it("calls POST /agent/inbox/:id/approve", async () => {
      mockOk({ status: "ok", task: {} });
      await client.approveInbox("m1");
      expect(lastCall().method).toBe("POST");
      expect(lastCall().url).toBe("http://test:17890/agent/inbox/m1/approve");
    });
  });

  describe("denyInbox", () => {
    it("calls POST /agent/inbox/:id/deny with reason", async () => {
      mockOk({ status: "ok" });
      await client.denyInbox("m1", "Not interested");
      expect(lastCall().body).toEqual({ reason: "Not interested" });
    });
  });

  describe("error handling", () => {
    it("throws ClawNexusApiError on non-ok response", async () => {
      mockError(404, "Not found");
      await expect(client.getInstance("unknown")).rejects.toThrow(ClawNexusApiError);
      try {
        mockError(404, "Not found");
        await client.getInstance("unknown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClawNexusApiError);
        expect((err as ClawNexusApiError).statusCode).toBe(404);
        expect((err as ClawNexusApiError).message).toBe("Not found");
      }
    });

    it("uses default API URL", () => {
      const defaultClient = new ClawNexusClient();
      // Just verify construction works — actual URL is private
      expect(defaultClient).toBeDefined();
    });
  });
});
