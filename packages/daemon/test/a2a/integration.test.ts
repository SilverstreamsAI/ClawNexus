// A2A Integration Test — requires a running OpenClaw Gateway + ClawNexus daemon
// Skipped in CI by default. Run locally with:
//   A2A_INTEGRATION=1 npx vitest run test/a2a/integration.test.ts

import { describe, it, expect } from "vitest";

const DAEMON_URL = process.env.A2A_DAEMON_URL || "http://localhost:17890";
const RUN = !!process.env.A2A_INTEGRATION;

async function rpc(method: string, params: Record<string, unknown>, id: string | number = "1") {
  const res = await fetch(`${DAEMON_URL}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, id, params }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

describe.skipIf(!RUN)("A2A Integration", () => {
  describe("tasks/send", () => {
    it("sends a message and receives a completed task", async () => {
      const result = await rpc("tasks/send", {
        message: { role: "user", parts: [{ type: "text", text: "Say hello in one word." }] },
      });

      expect(result.jsonrpc).toBe("2.0");
      expect(result.error).toBeUndefined();

      const task = result.result as Record<string, unknown>;
      expect(task.id).toBeTruthy();
      expect((task.status as Record<string, unknown>).state).toBe("completed");
      expect(task.artifacts).toBeDefined();
      expect(task.history).toBeDefined();
    }, 90_000);

    it("retrieves a task via tasks/get after send", async () => {
      const sendResult = await rpc("tasks/send", {
        message: { role: "user", parts: [{ type: "text", text: "Reply with OK" }] },
      }, "send-1");

      const task = sendResult.result as Record<string, unknown>;
      const taskId = task.id as string;

      const getResult = await rpc("tasks/get", { id: taskId }, "get-1");
      expect(getResult.error).toBeUndefined();

      const fetched = getResult.result as Record<string, unknown>;
      expect(fetched.id).toBe(taskId);
      expect((fetched.status as Record<string, unknown>).state).toBe("completed");
    }, 90_000);
  });

  describe("concurrency limit", () => {
    it("rejects the 6th concurrent task with -32005", async () => {
      // Fire 6 tasks simultaneously
      const promises = Array.from({ length: 6 }, (_, i) =>
        rpc("tasks/send", {
          message: { role: "user", parts: [{ type: "text", text: `Concurrent test ${i}` }] },
        }, `concurrent-${i}`)
      );

      const results = await Promise.all(promises);
      const errors = results.filter((r) => r.error);
      const successes = results.filter((r) => r.result);

      // At least one should be rejected (the 6th)
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect((errors[0].error as Record<string, unknown>).code).toBe(-32005);
      expect(successes.length).toBeLessThanOrEqual(5);
    }, 120_000);
  });

  describe("JSON-RPC error handling", () => {
    it("returns -32601 for unknown method", async () => {
      const result = await rpc("tasks/unknown", {});
      expect((result.error as Record<string, unknown>).code).toBe(-32601);
    });

    it("returns -32602 for missing message", async () => {
      const result = await rpc("tasks/send", {});
      expect((result.error as Record<string, unknown>).code).toBe(-32602);
    });

    it("returns -32001 for non-existent task", async () => {
      const result = await rpc("tasks/get", { id: "non-existent-id" });
      expect((result.error as Record<string, unknown>).code).toBe(-32001);
    });
  });

  describe("Agent Card", () => {
    it("serves agent card at /.well-known/agent-card.json", async () => {
      const res = await fetch(`${DAEMON_URL}/.well-known/agent-card.json`);
      // 200 if local instance discovered, 404 otherwise — both are valid
      if (res.status === 200) {
        const card = await res.json() as Record<string, unknown>;
        expect(card.name).toBeTruthy();
        expect(card.url).toBeTruthy();
        expect(card.capabilities).toBeDefined();
        expect(card.skills).toBeDefined();
        expect(card.provider).toBeDefined();
      } else {
        expect(res.status).toBe(404);
      }
    });

    it("lists all cards at /a2a/cards", async () => {
      const res = await fetch(`${DAEMON_URL}/a2a/cards`);
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(typeof body.count).toBe("number");
      expect(Array.isArray(body.cards)).toBe(true);
    });
  });
});
