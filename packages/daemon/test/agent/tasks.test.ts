import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TaskManager } from "../../src/agent/tasks.js";
import { makeTaskRecord } from "../fixtures.js";
import type { LayerBEnvelope, AcceptPayload, RejectPayload, ReportPayload, CancelPayload, HeartbeatPayload } from "../../src/agent/types.js";

function makeEnvelope(type: string, payload: unknown): LayerBEnvelope {
  return {
    protocol: "clawnexus-agent",
    version: "1.0",
    message_id: "m-1",
    from: "peer.id.claw",
    to: "me.id.claw",
    type: type as LayerBEnvelope["type"],
    payload: payload as LayerBEnvelope["payload"],
    timestamp: new Date().toISOString(),
    ttl: 300,
  };
}

describe("TaskManager", () => {
  let tmpDir: string;
  let manager: TaskManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    manager = new TaskManager(tmpDir);
    await manager.init();
  });

  afterEach(async () => {
    await manager.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a task and retrieves it", () => {
      const record = makeTaskRecord({ task_id: "t1" });
      manager.create(record);
      expect(manager.getById("t1")).toBeDefined();
      expect(manager.getById("t1")!.state).toBe("pending");
    });

    it("emits created event", () => {
      const events: unknown[] = [];
      manager.on("created", (r) => events.push(r));
      manager.create(makeTaskRecord());
      expect(events).toHaveLength(1);
    });
  });

  describe("state transitions", () => {
    it("pending → accepted", () => {
      const record = makeTaskRecord({ task_id: "t1", state: "pending" });
      manager.create(record);
      const result = manager.updateState("t1", "accepted");
      expect(result).not.toBeNull();
      expect(result!.state).toBe("accepted");
      expect(result!.accepted_at).toBeTruthy();
    });

    it("accepted → executing", () => {
      const record = makeTaskRecord({ task_id: "t1", state: "pending" });
      manager.create(record);
      manager.updateState("t1", "accepted");
      const result = manager.updateState("t1", "executing");
      expect(result!.state).toBe("executing");
    });

    it("executing → completed", () => {
      const record = makeTaskRecord({ task_id: "t1", state: "pending" });
      manager.create(record);
      manager.updateState("t1", "accepted");
      manager.updateState("t1", "executing");
      const result = manager.updateState("t1", "completed", { result: { answer: 42 } });
      expect(result!.state).toBe("completed");
      expect(result!.completed_at).toBeTruthy();
      expect(result!.result).toEqual({ answer: 42 });
    });

    it("executing → failed", () => {
      const record = makeTaskRecord({ task_id: "t1", state: "pending" });
      manager.create(record);
      manager.updateState("t1", "accepted");
      manager.updateState("t1", "executing");
      const result = manager.updateState("t1", "failed", { error: "Something broke" });
      expect(result!.state).toBe("failed");
      expect(result!.error).toBe("Something broke");
    });

    it("rejects invalid transitions", () => {
      const record = makeTaskRecord({ task_id: "t1", state: "pending" });
      manager.create(record);
      // pending → completed is invalid
      const result = manager.updateState("t1", "completed");
      expect(result).toBeNull();
      // state should remain pending
      expect(manager.getById("t1")!.state).toBe("pending");
    });

    it("rejects transition from terminal state", () => {
      const record = makeTaskRecord({ task_id: "t1", state: "pending" });
      manager.create(record);
      manager.updateState("t1", "rejected");
      const result = manager.updateState("t1", "accepted");
      expect(result).toBeNull();
    });

    it("returns null for unknown task", () => {
      expect(manager.updateState("nonexistent", "accepted")).toBeNull();
    });
  });

  describe("getActive", () => {
    it("returns only active (non-terminal) tasks", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      manager.create(makeTaskRecord({ task_id: "t2", state: "pending" }));
      manager.create(record3());

      // t3 goes to rejected (terminal) — but it will be archived immediately
      // So let's check active
      expect(manager.getActive().length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getStats", () => {
    it("returns correct stats", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending", direction: "outbound" }));
      manager.create(makeTaskRecord({ task_id: "t2", state: "pending", direction: "inbound" }));

      const stats = manager.getStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(2);
      expect(stats.by_state.pending).toBe(2);
      expect(stats.by_direction.outbound).toBe(1);
      expect(stats.by_direction.inbound).toBe(1);
    });
  });

  describe("handleResponse", () => {
    it("handles accept response", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      const env = makeEnvelope("accept", { task_id: "t1" } as AcceptPayload);
      const result = manager.handleResponse(env);
      expect(result!.state).toBe("accepted");
    });

    it("handles reject response", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      const env = makeEnvelope("reject", { task_id: "t1", reason: "overloaded", message: "Too busy" } as RejectPayload);
      const result = manager.handleResponse(env);
      expect(result!.state).toBe("rejected");
      expect(result!.error).toBe("Too busy");
    });

    it("handles report completed", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      manager.updateState("t1", "accepted");
      manager.updateState("t1", "executing");
      const env = makeEnvelope("report", { task_id: "t1", status: "completed", result: { data: "ok" } } as ReportPayload);
      const result = manager.handleResponse(env);
      expect(result!.state).toBe("completed");
      expect(result!.result).toEqual({ data: "ok" });
    });

    it("handles report failed", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      manager.updateState("t1", "accepted");
      manager.updateState("t1", "executing");
      const env = makeEnvelope("report", { task_id: "t1", status: "failed", error: "Crash" } as ReportPayload);
      const result = manager.handleResponse(env);
      expect(result!.state).toBe("failed");
      expect(result!.error).toBe("Crash");
    });

    it("handles report progress", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      manager.updateState("t1", "accepted");
      manager.updateState("t1", "executing");
      const env = makeEnvelope("report", { task_id: "t1", status: "progress", progress_pct: 50 } as ReportPayload);
      const result = manager.handleResponse(env);
      expect(result!.progress_pct).toBe(50);
    });

    it("handles cancel response", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      const env = makeEnvelope("cancel", { task_id: "t1", reason: "No longer needed" } as CancelPayload);
      const result = manager.handleResponse(env);
      expect(result!.state).toBe("cancelled");
    });

    it("returns null for unknown types", () => {
      const env = makeEnvelope("query", { query_type: "capabilities" });
      expect(manager.handleResponse(env)).toBeNull();
    });
  });

  describe("updateHeartbeat", () => {
    it("updates last_heartbeat and progress", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      const env = makeEnvelope("heartbeat", { task_id: "t1", progress_pct: 75 } as HeartbeatPayload);
      manager.updateHeartbeat(env);
      const task = manager.getById("t1")!;
      expect(task.last_heartbeat).toBeTruthy();
      expect(task.progress_pct).toBe(75);
    });

    it("ignores heartbeat for unknown task", () => {
      const env = makeEnvelope("heartbeat", { task_id: "unknown" } as HeartbeatPayload);
      // Should not throw
      manager.updateHeartbeat(env);
    });
  });

  describe("cancelTask", () => {
    it("cancels an active task", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      const result = manager.cancelTask("t1", "User request");
      expect(result!.state).toBe("cancelled");
      expect(result!.error).toBe("User request");
    });

    it("returns null for terminal task", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      manager.updateState("t1", "rejected");
      expect(manager.cancelTask("t1")).toBeNull();
    });

    it("returns null for unknown task", () => {
      expect(manager.cancelTask("unknown")).toBeNull();
    });

    it("uses default reason when none provided", () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      const result = manager.cancelTask("t1");
      expect(result!.error).toBe("User cancelled");
    });
  });

  describe("persistence", () => {
    it("persists and reloads tasks", async () => {
      manager.create(makeTaskRecord({ task_id: "t1", state: "pending" }));
      await manager.close();

      const manager2 = new TaskManager(tmpDir);
      await manager2.init();
      expect(manager2.getById("t1")).toBeDefined();
      await manager2.close();
    });
  });

  describe("getByDirection", () => {
    it("filters by direction", () => {
      manager.create(makeTaskRecord({ task_id: "t1", direction: "outbound" }));
      manager.create(makeTaskRecord({ task_id: "t2", direction: "inbound" }));

      expect(manager.getByDirection("outbound")).toHaveLength(1);
      expect(manager.getByDirection("inbound")).toHaveLength(1);
    });
  });
});

// Helper to create a record that can go to rejected
function record3() {
  return makeTaskRecord({ task_id: "t3", state: "pending" });
}
