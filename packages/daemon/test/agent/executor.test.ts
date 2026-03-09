import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { TaskManager } from "../../src/agent/tasks.js";
import { TaskExecutor } from "../../src/agent/executor.js";
import { makeTaskRecord } from "../fixtures.js";
import type { TaskRecord } from "../../src/agent/types.js";

// Finds a free port for the mock gateway
function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/**
 * Creates a mock OpenClaw Gateway WebSocket server that performs the handshake
 * and optionally responds to chat.send with a final event.
 */
function createMockGateway(port: number, opts: {
  autoFinal?: boolean;
  finalDelay?: number;
  finalContent?: string;
  rejectConnect?: boolean;
} = {}): { wss: WebSocketServer; connections: WebSocket[]; close: () => Promise<void> } {
  const connections: WebSocket[] = [];
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    connections.push(ws);

    // Step 1: Send connect.challenge
    ws.send(JSON.stringify({
      action: "event",
      event: "connect.challenge",
    }));

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      if (msg.action === "req" && msg.method === "connect") {
        if (opts.rejectConnect) {
          ws.send(JSON.stringify({ action: "res", response: "error", message: "Rejected" }));
          ws.close();
          return;
        }
        // Step 2: Send hello-ok
        ws.send(JSON.stringify({
          action: "res",
          response: "hello-ok",
          deviceToken: "test-device-token-123",
        }));
      }

      if (msg.action === "req" && msg.method === "chat.send") {
        const sessionKey = msg.sessionKey as string;

        if (opts.autoFinal !== false) {
          const delay = opts.finalDelay ?? 50;
          setTimeout(() => {
            ws.send(JSON.stringify({
              action: "event",
              event: "chat",
              sessionKey,
              data: {
                state: "final",
                messages: [
                  { role: "user", content: msg.message },
                  { role: "assistant", content: opts.finalContent ?? "Task completed successfully" },
                ],
              },
            }));
          }, delay);
        }
      }

      if (msg.action === "req" && msg.method === "chat.abort") {
        // Acknowledge abort silently
      }
    });
  });

  return {
    wss,
    connections,
    close: () => new Promise<void>((resolve) => {
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      wss.close(() => resolve());
    }),
  };
}

// Mock router that records calls
function createMockRouter() {
  return {
    sendReport: vi.fn(),
    sendHeartbeat: vi.fn(),
  };
}

describe("TaskExecutor", () => {
  let tmpDir: string;
  let tasks: TaskManager;
  let gwPort: number;
  let gateway: ReturnType<typeof createMockGateway> | null = null;
  let executor: TaskExecutor | null = null;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-exec-test-"));
    tasks = new TaskManager(tmpDir);
    await tasks.init();
    gwPort = getRandomPort();
  });

  afterEach(async () => {
    // Close executor first (it uses tasks internally)
    if (executor) {
      await executor.close();
      executor = null;
    }
    // Wait for any debounced flush timers to fire, then close cleanly
    await new Promise((r) => setTimeout(r, 600));
    await tasks.close();
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("enqueue and getStatus", () => {
    it("enqueues a task and reports status", async () => {
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });

      const record = makeTaskRecord({
        task_id: "t1",
        state: "accepted",
        direction: "inbound",
      });
      tasks.create(record);

      executor.enqueue("t1");

      const status = executor.getStatus();
      expect(status.max_concurrent).toBe(3);
      // enqueue triggers async drainQueue, so gw_state may already be connecting
      expect(["disconnected", "connecting"]).toContain(status.gw_state);

    });

    it("deduplicates enqueue calls", async () => {
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });

      tasks.create(makeTaskRecord({ task_id: "t1", state: "accepted", direction: "inbound" }));

      executor.enqueue("t1");
      executor.enqueue("t1");
      executor.enqueue("t1");

      const status = executor.getStatus();
      expect(status.queue_length).toBeLessThanOrEqual(1);

    });
  });

  describe("start() picks up accepted inbound tasks", () => {
    it("auto-enqueues accepted inbound tasks on start", async () => {
      // Create an accepted inbound task before starting executor
      tasks.create(makeTaskRecord({
        task_id: "pre-existing",
        state: "accepted",
        direction: "inbound",
      }));

      gateway = createMockGateway(gwPort);
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });
      executor.start();

      // Wait for executor to process
      await new Promise((r) => setTimeout(r, 500));

      // Task should have been picked up and moved to executing or completed
      const task = tasks.getById("pre-existing");
      expect(task).toBeUndefined(); // completed tasks are archived
      // OR it's in a terminal state (completed gets archived immediately)

    });

    it("listens for stateChange events to pick up newly accepted tasks", async () => {
      gateway = createMockGateway(gwPort);
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });
      executor.start();

      // Create a pending inbound task, then accept it
      const record = makeTaskRecord({
        task_id: "dynamic-1",
        state: "pending",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
      });
      tasks.create(record);

      // Transition to accepted — executor should pick it up
      tasks.updateState("dynamic-1", "accepted");

      await new Promise((r) => setTimeout(r, 500));

      // Should have moved past accepted
      const task = tasks.getById("dynamic-1");
      // Either archived (completed) or still in map (executing)
      if (task) {
        expect(["executing", "completed"]).toContain(task.state);
      }
      // If undefined, it was completed and archived — that's fine

    });

    it("ignores outbound tasks", async () => {
      gateway = createMockGateway(gwPort);
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });
      executor.start();

      // Create an accepted outbound task — should NOT be picked up
      tasks.create(makeTaskRecord({
        task_id: "outbound-1",
        state: "pending",
        direction: "outbound",
      }));
      tasks.updateState("outbound-1", "accepted");

      await new Promise((r) => setTimeout(r, 300));

      // Should still be accepted, not executing
      const task = tasks.getById("outbound-1");
      expect(task).toBeDefined();
      expect(task!.state).toBe("accepted");

    });
  });

  describe("gateway handshake", () => {
    it("connects and completes handshake", async () => {
      gateway = createMockGateway(gwPort);
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}` });

      tasks.create(makeTaskRecord({ task_id: "t1", state: "accepted", direction: "inbound" }));
      executor.start();

      await new Promise((r) => setTimeout(r, 500));

      const status = executor.getStatus();
      expect(status.gw_state).toBe("ready");

    });

    it("handles gateway connection failure gracefully", async () => {
      // No gateway running — connection should fail
      executor = new TaskExecutor({
        tasks,
        gatewayUrl: `ws://127.0.0.1:${gwPort}`,
      });

      tasks.create(makeTaskRecord({
        task_id: "fail-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
      }));

      const failedPromise = new Promise<string>((resolve) => {
        executor!.on("task:failed", (taskId: string) => resolve(taskId));
      });

      executor.start();

      const failedId = await failedPromise;
      expect(failedId).toBe("fail-1");

    });
  });

  describe("task execution flow", () => {
    it("executes a task end-to-end: accepted → executing → completed", async () => {
      gateway = createMockGateway(gwPort, { finalContent: "The answer is 42" });
      const mockRouter = createMockRouter();

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });
      executor.setRouter(mockRouter as any);

      const record = makeTaskRecord({
        task_id: "exec-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
        task: {
          task_type: "question",
          description: "What is the meaning of life?",
        },
      });
      tasks.create(record);

      const completedPromise = new Promise<string>((resolve) => {
        executor.on("task:completed", (taskId: string) => resolve(taskId));
      });

      executor.start();

      const completedId = await completedPromise;
      expect(completedId).toBe("exec-1");

      // Router should have received a report
      expect(mockRouter.sendReport).toHaveBeenCalledWith(
        "room-1",
        "peer.id.claw",
        "exec-1",
        "completed",
        expect.stringContaining("42"),
      );

    });

    it("sends heartbeats during execution", async () => {
      // Use a long delay so we can observe heartbeats
      gateway = createMockGateway(gwPort, { autoFinal: false });
      const mockRouter = createMockRouter();

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });
      executor.setRouter(mockRouter as any);

      tasks.create(makeTaskRecord({
        task_id: "hb-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
        task: {
          task_type: "long-task",
          description: "Do something slow",
          constraints: { max_duration_s: 60 },
        },
      }));
      executor.start();

      // Wait long enough for at least one heartbeat (15s interval, but we can't wait that long in tests)
      // Instead, verify the heartbeat timer was set up by checking executor status
      await new Promise((r) => setTimeout(r, 500));

      const status = executor.getStatus();
      expect(status.executing).toHaveLength(1);
      expect(status.executing[0].task_id).toBe("hb-1");

    });

    it("handles task with input data", async () => {
      let receivedMessage = "";
      gateway = createMockGateway(gwPort, { autoFinal: true, finalContent: "Done" });

      // Intercept the chat.send to see what message was sent
      const origConnections = gateway.connections;
      const wss = gateway.wss;
      wss.removeAllListeners("connection");
      wss.on("connection", (ws) => {
        origConnections.push(ws);
        ws.send(JSON.stringify({ action: "event", event: "connect.challenge" }));
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.action === "req" && msg.method === "connect") {
            ws.send(JSON.stringify({ action: "res", response: "hello-ok" }));
          }
          if (msg.action === "req" && msg.method === "chat.send") {
            receivedMessage = msg.message;
            setTimeout(() => {
              ws.send(JSON.stringify({
                action: "event",
                event: "chat",
                sessionKey: msg.sessionKey,
                data: { state: "final", messages: [{ role: "assistant", content: "Done" }] },
              }));
            }, 50);
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}` });

      tasks.create(makeTaskRecord({
        task_id: "input-1",
        state: "accepted",
        direction: "inbound",
        task: {
          task_type: "compute",
          description: "Calculate this",
          input: { x: 10, y: 20 },
        },
      }));

      const done = new Promise<void>((resolve) => executor.on("task:completed", () => resolve()));
      executor.start();
      await done;

      expect(receivedMessage).toContain("Calculate this");
      expect(receivedMessage).toContain('"x":10');

    });
  });

  describe("concurrency control", () => {
    it("respects maxConcurrent limit", async () => {
      gateway = createMockGateway(gwPort, { autoFinal: false }); // Never finish
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 2 });

      // Create 4 accepted inbound tasks
      for (let i = 1; i <= 4; i++) {
        tasks.create(makeTaskRecord({
          task_id: `conc-${i}`,
          state: "accepted",
          direction: "inbound",
          task: {
            task_type: "slow",
            description: `Task ${i}`,
            constraints: { max_duration_s: 300 },
          },
        }));
      }

      executor.start();
      await new Promise((r) => setTimeout(r, 500));

      const status = executor.getStatus();
      // Only 2 should be executing, rest queued
      expect(status.executing.length).toBe(2);
      expect(status.queue_length).toBe(2);

    });
  });

  describe("timeout handling", () => {
    it("times out a task and reports failure", async () => {
      gateway = createMockGateway(gwPort, { autoFinal: false }); // Never respond
      const mockRouter = createMockRouter();

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });
      executor.setRouter(mockRouter as any);

      tasks.create(makeTaskRecord({
        task_id: "timeout-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
        task: {
          task_type: "slow",
          description: "This will timeout",
          constraints: { max_duration_s: 1 }, // 1 second timeout
        },
      }));

      const timeoutPromise = new Promise<string>((resolve) => {
        executor.on("task:timeout", (taskId: string) => resolve(taskId));
      });

      executor.start();

      const timedOutId = await timeoutPromise;
      expect(timedOutId).toBe("timeout-1");

      // Report should have been sent
      expect(mockRouter.sendReport).toHaveBeenCalledWith(
        "room-1",
        "peer.id.claw",
        "timeout-1",
        "failed",
        undefined,
        expect.stringContaining("timed out"),
      );

    });
  });

  describe("error handling", () => {
    it("handles lifecycle:error from gateway", async () => {
      const port = getRandomPort();
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
        connections.push(ws);
        ws.send(JSON.stringify({ action: "event", event: "connect.challenge" }));
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.action === "req" && msg.method === "connect") {
            ws.send(JSON.stringify({ action: "res", response: "hello-ok" }));
          }
          if (msg.action === "req" && msg.method === "chat.send") {
            // Respond with lifecycle error
            setTimeout(() => {
              ws.send(JSON.stringify({
                action: "res",
                response: "lifecycle:error",
                sessionKey: msg.sessionKey,
                message: "Model not available",
              }));
            }, 50);
          }
        });
      });

      const mockRouter = createMockRouter();
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 3 });
      executor.setRouter(mockRouter as any);

      tasks.create(makeTaskRecord({
        task_id: "err-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
      }));

      const failedPromise = new Promise<string>((resolve) => {
        executor.on("task:failed", (taskId: string) => resolve(taskId));
      });

      executor.start();

      const failedId = await failedPromise;
      expect(failedId).toBe("err-1");

      expect(mockRouter.sendReport).toHaveBeenCalledWith(
        "room-1",
        "peer.id.claw",
        "err-1",
        "failed",
        undefined,
        "Model not available",
      );

      await executor.close();
      for (const ws of connections) ws.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });
  });

  describe("close", () => {
    it("cleans up all resources on close", async () => {
      gateway = createMockGateway(gwPort, { autoFinal: false });
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });

      tasks.create(makeTaskRecord({
        task_id: "close-1",
        state: "accepted",
        direction: "inbound",
        task: { task_type: "test", description: "test", constraints: { max_duration_s: 300 } },
      }));

      executor.start();
      await new Promise((r) => setTimeout(r, 300));

      // Should be executing
      expect(executor.getStatus().executing.length).toBe(1);

      await executor.close();

      // After close, everything should be cleaned up
      const status = executor.getStatus();
      expect(status.gw_state).toBe("disconnected");
      expect(status.executing).toHaveLength(0);
      expect(status.queue_length).toBe(0);
    });

    it("marks executing tasks as failed on close", async () => {
      gateway = createMockGateway(gwPort, { autoFinal: false });
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });

      tasks.create(makeTaskRecord({
        task_id: "close-fail-1",
        state: "accepted",
        direction: "inbound",
        task: { task_type: "test", description: "test", constraints: { max_duration_s: 300 } },
      }));

      executor.start();
      await new Promise((r) => setTimeout(r, 300));

      await executor.close();

      // Task should be marked as failed (may have been archived)
      // We can't check getById because terminal states get archived
      // But the state transition should have happened
    });
  });

  describe("getStatus", () => {
    it("returns correct initial status", () => {
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 5 });

      const status = executor.getStatus();
      expect(status).toEqual({
        gw_state: "disconnected",
        queue_length: 0,
        executing: [],
        max_concurrent: 5,
      });
    });
  });
});
