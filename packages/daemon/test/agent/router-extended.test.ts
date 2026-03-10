import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { AgentRouter } from "../../src/agent/router.js";
import { PolicyEngine } from "../../src/agent/engine.js";
import { TaskManager } from "../../src/agent/tasks.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LayerBEnvelope, ProposePayload } from "../../src/agent/types.js";

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

function makeValidEnvelope(overrides: Partial<LayerBEnvelope> = {}): string {
  return JSON.stringify({
    protocol: "clawnexus-agent",
    version: "1.0",
    message_id: overrides.message_id ?? "msg-1",
    from: overrides.from ?? "peer.id.claw",
    to: overrides.to ?? "me.id.claw",
    type: overrides.type ?? "propose",
    payload: overrides.payload ?? {
      task: { task_type: "test-task", description: "Do something" },
      reply_timeout_s: 60,
    },
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    ttl: overrides.ttl ?? 300,
    in_reply_to: overrides.in_reply_to,
  });
}

describe("AgentRouter — extended tests", () => {
  let tmpDir: string;
  let engine: PolicyEngine;
  let tasks: TaskManager;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-router-ext-test-"));
    engine = new PolicyEngine(tmpDir);
    await engine.init();
    tasks = new TaskManager(tmpDir);
    await tasks.init();
  });

  afterEach(async () => {
    await tasks.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("propose()", () => {
    it("creates outbound task and sends propose envelope", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      const outboundEvents: LayerBEnvelope[] = [];
      router.on("outbound", (env: LayerBEnvelope) => outboundEvents.push(env));

      const record = router.propose("room-1", "target.id.claw", {
        task_type: "translate",
        description: "Translate this text",
      });

      expect(record.task_id).toBeTruthy();
      expect(record.direction).toBe("outbound");
      expect(record.peer_claw_id).toBe("target.id.claw");
      expect(record.state).toBe("pending");
      expect(record.room_id).toBe("room-1");

      // Task created in TaskManager
      const stored = tasks.getById(record.task_id);
      expect(stored).toBeDefined();
      expect(stored!.state).toBe("pending");

      // Envelope sent via connector
      expect(connector.sent).toHaveLength(1);
      const envelope = JSON.parse(connector.sent[0].data);
      expect(envelope.protocol).toBe("clawnexus-agent");
      expect(envelope.from).toBe("me.id.claw");
      expect(envelope.to).toBe("target.id.claw");
      expect(envelope.type).toBe("propose");
      expect(envelope.payload.task.task_type).toBe("translate");

      // Event emitted
      expect(outboundEvents).toHaveLength(1);
    });
  });

  describe("query()", () => {
    it("sends query envelope and emits outbound event", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      const outboundEvents: LayerBEnvelope[] = [];
      router.on("outbound", (env: LayerBEnvelope) => outboundEvents.push(env));

      const envelope = router.query("room-1", "target.id.claw", "capabilities");

      expect(envelope.type).toBe("query");
      expect(envelope.from).toBe("me.id.claw");
      expect(envelope.to).toBe("target.id.claw");
      expect((envelope.payload as any).query_type).toBe("capabilities");

      expect(connector.sent).toHaveLength(1);
      expect(connector.sent[0].roomId).toBe("room-1");
      expect(outboundEvents).toHaveLength(1);
    });

    it("supports different query types", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      router.query("room-1", "target.id.claw", "status");
      router.query("room-1", "target.id.claw", "availability");

      expect(connector.sent).toHaveLength(2);
      expect(JSON.parse(connector.sent[0].data).payload.query_type).toBe("status");
      expect(JSON.parse(connector.sent[1].data).payload.query_type).toBe("availability");
    });
  });

  describe("inbox management", () => {
    it("getInbox() returns queued proposals", async () => {
      await engine.patchConfig({ mode: "queue", trust_threshold: 0 }); // queue mode → proposals go to inbox
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      // Simulate inbound propose
      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "proposal-1",
        from: "peer.id.claw",
        to: "me.id.claw",
        type: "propose",
        payload: {
          task: { task_type: "test", description: "Do something" },
          reply_timeout_s: 60,
        } as ProposePayload,
      }));

      const inbox = router.getInbox();
      expect(inbox).toHaveLength(1);
      expect(inbox[0].message_id).toBe("proposal-1");
      expect(inbox[0].roomId).toBe("room-1");
      expect(inbox[0].envelope.from).toBe("peer.id.claw");

      router.stop();
    });

    it("approveInbox() creates task and sends accept reply", async () => {
      await engine.patchConfig({ mode: "queue", trust_threshold: 0 });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "proposal-2",
        from: "peer.id.claw",
        type: "propose",
        payload: {
          task: { task_type: "translate", description: "Translate" },
          reply_timeout_s: 60,
        } as ProposePayload,
      }));

      expect(router.getInbox()).toHaveLength(1);

      const record = router.approveInbox("proposal-2");
      expect(record).toBeTruthy();
      expect(record!.task_id).toBe("proposal-2");
      expect(record!.state).toBe("accepted");
      expect(record!.direction).toBe("inbound");

      // Inbox should be empty after approval
      expect(router.getInbox()).toHaveLength(0);

      // Accept reply sent
      const acceptMsg = connector.sent.find((s) => {
        const env = JSON.parse(s.data);
        return env.type === "accept";
      });
      expect(acceptMsg).toBeTruthy();
      const acceptEnv = JSON.parse(acceptMsg!.data);
      expect(acceptEnv.payload.task_id).toBe("proposal-2");
      expect(acceptEnv.in_reply_to).toBe("proposal-2");

      router.stop();
    });

    it("approveInbox() returns null for unknown messageId", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      const result = router.approveInbox("nonexistent");
      expect(result).toBeNull();
    });

    it("denyInbox() sends reject reply and removes from inbox", async () => {
      await engine.patchConfig({ mode: "queue", trust_threshold: 0 });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "proposal-3",
        from: "peer.id.claw",
        type: "propose",
        payload: {
          task: { task_type: "test", description: "Something" },
          reply_timeout_s: 60,
        } as ProposePayload,
      }));

      router.denyInbox("proposal-3", "Not interested");

      expect(router.getInbox()).toHaveLength(0);

      const rejectMsg = connector.sent.find((s) => {
        const env = JSON.parse(s.data);
        return env.type === "reject";
      });
      expect(rejectMsg).toBeTruthy();
      const rejectEnv = JSON.parse(rejectMsg!.data);
      expect(rejectEnv.payload.task_id).toBe("proposal-3");
      expect(rejectEnv.payload.reason).toBe("user_denied");
      expect(rejectEnv.payload.message).toBe("Not interested");

      router.stop();
    });

    it("denyInbox() does nothing for unknown messageId", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      router.denyInbox("nonexistent"); // Should not throw
      expect(connector.sent).toHaveLength(0);
    });
  });

  describe("setConnector() — hot-swap", () => {
    it("rebinds data handler to new connector", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector1 = createMockConnector();
      const connector2 = createMockConnector();
      const router = new AgentRouter({
        connector: connector1 as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      // Data from old connector should be handled
      const inboundEvents: LayerBEnvelope[] = [];
      router.on("inbound", (env: LayerBEnvelope) => inboundEvents.push(env));

      connector1.emit("data", "room-1", makeValidEnvelope({ message_id: "msg-old" }));
      expect(inboundEvents).toHaveLength(1);

      // Hot-swap connector
      router.setConnector(connector2 as any);

      // Old connector should no longer trigger handler
      connector1.emit("data", "room-1", makeValidEnvelope({ message_id: "msg-should-not-arrive" }));
      expect(inboundEvents).toHaveLength(1); // No increase

      // New connector should work
      connector2.emit("data", "room-2", makeValidEnvelope({ message_id: "msg-new" }));
      expect(inboundEvents).toHaveLength(2);

      router.stop();
    });

    it("hot-swap before start() does not break", () => {
      const connector1 = createMockConnector();
      const connector2 = createMockConnector();
      const router = new AgentRouter({
        connector: connector1 as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });

      // setConnector before start — dataHandler is null
      router.setConnector(connector2 as any);
      router.start();

      const inboundEvents: LayerBEnvelope[] = [];
      router.on("inbound", (env: LayerBEnvelope) => inboundEvents.push(env));

      // Only new connector should work
      connector2.emit("data", "room-1", makeValidEnvelope());
      expect(inboundEvents).toHaveLength(1);

      connector1.emit("data", "room-1", makeValidEnvelope({ message_id: "from-old" }));
      expect(inboundEvents).toHaveLength(1); // No increase

      router.stop();
    });
  });

  describe("handleData — message type routing", () => {
    it("handles accept response and updates task state", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      // Create an outbound task first
      const record = router.propose("room-1", "peer.id.claw", {
        task_type: "test",
        description: "Test task",
      });

      const responseEvents: LayerBEnvelope[] = [];
      router.on("response", (env: LayerBEnvelope) => responseEvents.push(env));

      // Simulate accept from peer
      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "accept-1",
        from: "peer.id.claw",
        to: "me.id.claw",
        type: "accept",
        payload: { task_id: record.task_id } as any,
        in_reply_to: record.task_id,
      }));

      const updated = tasks.getById(record.task_id);
      expect(updated?.state).toBe("accepted");
      expect(responseEvents).toHaveLength(1);

      router.stop();
    });

    it("handles reject response", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const record = router.propose("room-1", "peer.id.claw", {
        task_type: "test",
        description: "Test",
      });

      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "reject-1",
        from: "peer.id.claw",
        type: "reject",
        payload: { task_id: record.task_id, reason: "overloaded", message: "Too busy" } as any,
      }));

      // Task is rejected and archived (terminal state)
      const task = tasks.getById(record.task_id);
      expect(task).toBeUndefined(); // archived

      router.stop();
    });

    it("handles report (completed) response", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const record = router.propose("room-1", "peer.id.claw", {
        task_type: "test",
        description: "Test",
      });

      // Accept first
      connector.emit("data", "room-1", makeValidEnvelope({
        from: "peer.id.claw",
        type: "accept",
        payload: { task_id: record.task_id } as any,
      }));

      // Then report completed
      connector.emit("data", "room-1", makeValidEnvelope({
        from: "peer.id.claw",
        type: "report",
        payload: { task_id: record.task_id, status: "completed", result: "Done!" } as any,
      }));

      // Archived
      expect(tasks.getById(record.task_id)).toBeUndefined();

      router.stop();
    });

    it("handles cancel response", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const record = router.propose("room-1", "peer.id.claw", {
        task_type: "test",
        description: "Test",
      });

      connector.emit("data", "room-1", makeValidEnvelope({
        from: "peer.id.claw",
        type: "cancel",
        payload: { task_id: record.task_id, reason: "No longer needed" } as any,
      }));

      expect(tasks.getById(record.task_id)).toBeUndefined(); // archived

      router.stop();
    });

    it("handles heartbeat and updates task", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const record = router.propose("room-1", "peer.id.claw", {
        task_type: "test",
        description: "Test",
      });

      // Accept first
      connector.emit("data", "room-1", makeValidEnvelope({
        from: "peer.id.claw",
        type: "accept",
        payload: { task_id: record.task_id } as any,
      }));

      const taskBefore = tasks.getById(record.task_id);
      const lastHeartbeatBefore = taskBefore?.last_heartbeat;

      // Send heartbeat
      connector.emit("data", "room-1", makeValidEnvelope({
        from: "peer.id.claw",
        type: "heartbeat",
        payload: { task_id: record.task_id, progress_pct: 50 } as any,
      }));

      const taskAfter = tasks.getById(record.task_id);
      expect(taskAfter?.last_heartbeat).toBeTruthy();
      expect(taskAfter?.progress_pct).toBe(50);

      router.stop();
    });

    it("handles capability response by emitting event", async () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const capEvents: LayerBEnvelope[] = [];
      router.on("capability", (env: LayerBEnvelope) => capEvents.push(env));

      connector.emit("data", "room-1", makeValidEnvelope({
        from: "peer.id.claw",
        type: "capability",
        payload: { capabilities: [{ service_type: "web_search", description: "Search" }] } as any,
      }));

      expect(capEvents).toHaveLength(1);
      expect((capEvents[0].payload as any).capabilities).toHaveLength(1);

      router.stop();
    });

    it("handles delegate envelope same as propose", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const decisionEvents: Array<{ envelope: LayerBEnvelope; decision: any }> = [];
      router.on("decision", (env: LayerBEnvelope, decision: any) => {
        decisionEvents.push({ envelope: env, decision });
      });

      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "delegate-1",
        from: "peer.id.claw",
        type: "delegate",
        payload: {
          task_id: "original-task",
          original_from: "origin.id.claw",
          task: { task_type: "test", description: "Delegated task" },
        } as any,
      }));

      // Since delegation is disabled by default, it should be rejected
      expect(decisionEvents).toHaveLength(1);
      // The reject reply should be sent
      const rejectMsg = connector.sent.find((s) => JSON.parse(s.data).type === "reject");
      expect(rejectMsg).toBeTruthy();

      router.stop();
    });
  });

  describe("handleData — error paths", () => {
    it("ignores invalid JSON silently", async () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const errors: Error[] = [];
      router.on("protocol_error", (err: Error) => errors.push(err));

      connector.emit("data", "room-1", "not json at all {{{");
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Invalid JSON");

      router.stop();
    });

    it("ignores non-clawnexus-agent protocol messages", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const errors: Error[] = [];
      router.on("protocol_error", (err: Error) => errors.push(err));

      connector.emit("data", "room-1", JSON.stringify({
        protocol: "other-protocol",
        version: "1.0",
        message_id: "x",
        from: "a",
        to: "b",
        type: "propose",
        payload: {},
        timestamp: new Date().toISOString(),
      }));

      expect(errors).toHaveLength(1);

      router.stop();
    });

    it("ignores expired envelopes", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const expired: LayerBEnvelope[] = [];
      router.on("expired", (env: LayerBEnvelope) => expired.push(env));

      const oldTimestamp = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
      connector.emit("data", "room-1", makeValidEnvelope({
        timestamp: oldTimestamp,
        ttl: 60, // 1 min TTL — definitely expired
      }));

      expect(expired).toHaveLength(1);

      router.stop();
    });

    it("emits inbound event for all valid messages", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const inbound: LayerBEnvelope[] = [];
      router.on("inbound", (env: LayerBEnvelope) => inbound.push(env));

      connector.emit("data", "room-1", makeValidEnvelope({ type: "propose" }));
      expect(inbound).toHaveLength(1);

      router.stop();
    });
  });

  describe("handleProposal — policy decisions", () => {
    it("auto-accepts in auto mode", async () => {
      await engine.patchConfig({ mode: "auto" });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "auto-1",
        type: "propose",
      }));

      // Should send accept reply
      const acceptMsg = connector.sent.find((s) => JSON.parse(s.data).type === "accept");
      expect(acceptMsg).toBeTruthy();

      router.stop();
    });

    it("rejects when policy denies (blacklisted peer)", async () => {
      await engine.patchConfig({
        mode: "auto",
        access_control: { whitelist: [], blacklist: ["evil.id.claw"] },
      });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      connector.emit("data", "room-1", makeValidEnvelope({
        from: "evil.id.claw",
        type: "propose",
      }));

      const rejectMsg = connector.sent.find((s) => JSON.parse(s.data).type === "reject");
      expect(rejectMsg).toBeTruthy();
      const env = JSON.parse(rejectMsg!.data);
      expect(env.payload.reason).toBe("policy_denied");

      router.stop();
    });

    it("queues in queue mode and emits queued event", async () => {
      await engine.patchConfig({ mode: "queue", trust_threshold: 0 });
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const queued: LayerBEnvelope[] = [];
      router.on("queued", (env: LayerBEnvelope) => queued.push(env));

      connector.emit("data", "room-1", makeValidEnvelope({
        message_id: "queue-1",
        type: "propose",
      }));

      expect(queued).toHaveLength(1);
      expect(router.getInbox()).toHaveLength(1);
      // No accept or reject should be sent
      expect(connector.sent).toHaveLength(0);

      router.stop();
    });
  });

  describe("start() and stop()", () => {
    it("stop() unbinds data handler", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();

      const inbound: LayerBEnvelope[] = [];
      router.on("inbound", (env: LayerBEnvelope) => inbound.push(env));

      router.stop();

      connector.emit("data", "room-1", makeValidEnvelope());
      expect(inbound).toHaveLength(0); // Handler removed
    });

    it("double stop() is safe", () => {
      const connector = createMockConnector();
      const router = new AgentRouter({
        connector: connector as any,
        engine,
        tasks,
        localClawId: "me.id.claw",
      });
      router.start();
      router.stop();
      router.stop(); // Should not throw
    });
  });
});
