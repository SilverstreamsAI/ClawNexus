import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { AgentRouter } from "../../src/agent/router.js";
import { PolicyEngine } from "../../src/agent/engine.js";
import { TaskManager } from "../../src/agent/tasks.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Minimal mock RelayConnector
function createMockConnector() {
  const emitter = new EventEmitter();
  const sent: Array<{ roomId: string; data: string }> = [];
  return Object.assign(emitter, {
    sendData(roomId: string, data: string) {
      sent.push({ roomId, data });
      return true;
    },
    sent,
  });
}

describe("AgentRouter — sendReport & sendHeartbeat", () => {
  let tmpDir: string;
  let engine: PolicyEngine;
  let tasks: TaskManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-router-test-"));
    engine = new PolicyEngine(tmpDir);
    await engine.init();
    tasks = new TaskManager(tmpDir);
    await tasks.init();
  });

  afterEach(async () => {
    await tasks.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("sendReport", () => {
    it("sends a completed report envelope", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      router.sendReport("room-1", "peer.id.claw", "task-123", "completed", "Result data");

      expect(connector.sent).toHaveLength(1);
      const envelope = JSON.parse(connector.sent[0].data);
      expect(envelope.protocol).toBe("clawnexus-agent");
      expect(envelope.from).toBe("me.id.claw");
      expect(envelope.to).toBe("peer.id.claw");
      expect(envelope.type).toBe("report");
      expect(envelope.payload.task_id).toBe("task-123");
      expect(envelope.payload.status).toBe("completed");
      expect(envelope.payload.result).toBe("Result data");
      expect(envelope.in_reply_to).toBe("task-123");
    });

    it("sends a failed report with error", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      router.sendReport("room-1", "peer.id.claw", "task-456", "failed", undefined, "Something broke");

      const envelope = JSON.parse(connector.sent[0].data);
      expect(envelope.payload.status).toBe("failed");
      expect(envelope.payload.error).toBe("Something broke");
      expect(envelope.payload.result).toBeUndefined();
    });

    it("sends to correct room", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      router.sendReport("room-abc", "peer.id.claw", "t1", "completed", "ok");
      expect(connector.sent[0].roomId).toBe("room-abc");
    });
  });

  describe("sendHeartbeat", () => {
    it("sends a heartbeat envelope", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      router.sendHeartbeat("room-1", "peer.id.claw", "task-789", 50);

      expect(connector.sent).toHaveLength(1);
      const envelope = JSON.parse(connector.sent[0].data);
      expect(envelope.protocol).toBe("clawnexus-agent");
      expect(envelope.from).toBe("me.id.claw");
      expect(envelope.to).toBe("peer.id.claw");
      expect(envelope.type).toBe("heartbeat");
      expect(envelope.payload.task_id).toBe("task-789");
      expect(envelope.payload.progress_pct).toBe(50);
      expect(envelope.in_reply_to).toBe("task-789");
    });

    it("sends heartbeat without progress", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      router.sendHeartbeat("room-1", "peer.id.claw", "task-000");

      const envelope = JSON.parse(connector.sent[0].data);
      expect(envelope.payload.task_id).toBe("task-000");
      expect(envelope.payload.progress_pct).toBeUndefined();
    });
  });
});
