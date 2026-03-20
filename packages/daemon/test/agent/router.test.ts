import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { AgentRouter } from "../../src/agent/router.js";
import { PolicyEngine } from "../../src/agent/engine.js";
import { TaskManager } from "../../src/agent/tasks.js";
import type { RelayConnector } from "../../src/relay/connector.js";
import type { SkillsRegistry } from "../../src/agent/services.js";
import type { ServiceCapability } from "../../src/agent/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Minimal mock RelayConnector — implements the subset used by AgentRouter
function createMockConnector() {
  const emitter = new EventEmitter();
  const sent: Array<{ roomId: string; data: string }> = [];
  return Object.assign(emitter, {
    sendData(roomId: string, data: string) {
      sent.push({ roomId, data });
      return true;
    },
    sent,
  }) as EventEmitter & { sendData(roomId: string, data: string): boolean; sent: typeof sent } &
    Pick<RelayConnector, "on" | "off" | "emit">;
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
        connector: connector as unknown as RelayConnector,
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
        connector: connector as unknown as RelayConnector,
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
        connector: connector as unknown as RelayConnector,
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
        connector: connector as unknown as RelayConnector,
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
        connector: connector as unknown as RelayConnector,
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

  describe("handleQuery with SkillsRegistry", () => {
    it("responds with capabilities from SkillsRegistry", () => {
      const connector = createMockConnector();
      const mockRegistry: Pick<SkillsRegistry, "getCapabilities"> = {
        getCapabilities: (): ServiceCapability[] => [
          { service_type: "web_search", description: "Search the web" },
          { service_type: "code_run", description: "Run code" },
        ],
      };

      const router = new AgentRouter({
        connector: connector as unknown as RelayConnector,
        engine,
        tasks,
        localClawId: "me.id.claw",
        skillsRegistry: mockRegistry as SkillsRegistry,
      });
      router.start();

      // Simulate an incoming query message via the connector
      const queryEnvelope = JSON.stringify({
        protocol: "clawnexus-agent",
        version: "1.0",
        message_id: "q-1",
        from: "peer.id.claw",
        to: "me.id.claw",
        type: "query",
        payload: { query_type: "capabilities" },
        timestamp: new Date().toISOString(),
        ttl: 300,
      });
      connector.emit("data", "room-1", queryEnvelope);

      expect(connector.sent).toHaveLength(1);
      const reply = JSON.parse(connector.sent[0].data);
      expect(reply.type).toBe("capability");
      expect(reply.payload.capabilities).toHaveLength(2);
      expect(reply.payload.capabilities[0].service_type).toBe("web_search");
      expect(reply.payload.capabilities[1].service_type).toBe("code_run");

      router.stop();
    });

    it("responds with empty capabilities when no SkillsRegistry", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as unknown as RelayConnector,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const queryEnvelope = JSON.stringify({
        protocol: "clawnexus-agent",
        version: "1.0",
        message_id: "q-2",
        from: "peer.id.claw",
        to: "me.id.claw",
        type: "query",
        payload: { query_type: "capabilities" },
        timestamp: new Date().toISOString(),
        ttl: 300,
      });
      connector.emit("data", "room-1", queryEnvelope);

      expect(connector.sent).toHaveLength(1);
      const reply = JSON.parse(connector.sent[0].data);
      expect(reply.type).toBe("capability");
      expect(reply.payload.capabilities).toEqual([]);

      router.stop();
    });
  });
});
