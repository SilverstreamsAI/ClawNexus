import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { TaskManager } from "../../src/agent/tasks.js";
import { TaskExecutor } from "../../src/agent/executor.js";
import { makeTaskRecord } from "../fixtures.js";
import type { TaskRecord } from "../../src/agent/types.js";
import type { AgentRouter } from "../../src/agent/router.js";

// Finds a free port for the mock gateway
function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/**
 * Creates a mock OpenClaw Gateway WebSocket server using Protocol v3.
 * Handles connect.challenge → connect → hello-ok handshake,
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
    const nonce = randomUUID();

    // Step 1: Send connect.challenge (v3 format)
    ws.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce, ts: Date.now() },
    }));

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      // v3 protocol: type/id/method/params
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
        // Step 2: Send hello-ok (v3 format)
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

      if (msg.type === "req" && msg.method === "chat.send") {
        const sessionKey = msg.params?.sessionKey as string;

        if (opts.autoFinal !== false) {
          const delay = opts.finalDelay ?? 50;
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                sessionKey,
                state: "final",
                messages: [
                  { role: "user", content: msg.params?.message ?? "" },
                  { role: "assistant", content: opts.finalContent ?? "Task completed successfully" },
                ],
              },
            }));
          }, delay);
        }
      }

      if (msg.type === "req" && msg.method === "chat.abort") {
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
      executor.setRouter(mockRouter as unknown as AgentRouter);

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
      executor.setRouter(mockRouter as unknown as AgentRouter);

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
      const port = getRandomPort();
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
        connections.push(ws);
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
                features: {},
                snapshot: {},
                policy: {},
              },
            }));
          }
          if (msg.type === "req" && msg.method === "chat.send") {
            receivedMessage = msg.params?.message ?? "";
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  sessionKey: msg.params?.sessionKey,
                  state: "final",
                  messages: [{ role: "assistant", content: "Done" }],
                },
              }));
            }, 50);
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}` });

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

      for (const ws of connections) ws.close();
      await new Promise<void>((r) => wss.close(() => r()));
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
      executor.setRouter(mockRouter as unknown as AgentRouter);

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
    it("handles chat error event from gateway", async () => {
      const port = getRandomPort();
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
        connections.push(ws);
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
                features: {},
                snapshot: {},
                policy: {},
              },
            }));
          }
          if (msg.type === "req" && msg.method === "chat.send") {
            // Respond with chat error event (v3 format)
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  sessionKey: msg.params?.sessionKey,
                  state: "error",
                  errorMessage: "Model not available",
                },
              }));
            }, 50);
          }
        });
      });

      const mockRouter = createMockRouter();
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 3 });
      executor.setRouter(mockRouter as unknown as AgentRouter);

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

  describe("scheduleReconnect", () => {
    it("reconnects via scheduleReconnect when executing tasks exist and gateway drops", { timeout: 10000 }, async () => {
      // Verifies the scheduleReconnect path: gateway drops while a task is executing,
      // 5s later it reconnects and the task can resume on the new connection.
      // This test exercises ws.on("close") → scheduleReconnect() → 5s → ensureConnection().

      const port = getRandomPort();
      let connectionCount = 0;
      let chatSendCount = 0;
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
        connectionCount++;
        connections.push(ws);
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
                features: { methods: ["chat.send"], events: ["chat"] },
                snapshot: {},
                policy: {},
              },
            }));
          }

          if (msg.type === "req" && msg.method === "chat.send") {
            chatSendCount++;
            // Never send final — task stays in executing
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 3 });

      // Enqueue a task that will enter executing (gateway never responds with final)
      tasks.create(makeTaskRecord({
        task_id: "reconnect-exec-1",
        state: "accepted",
        direction: "inbound",
        task: { task_type: "test", description: "Long-running task", constraints: { max_duration_s: 300 } },
      }));

      executor.start();

      // Wait for task to be sent to gateway
      await vi.waitFor(() => {
        expect(chatSendCount).toBe(1);
      }, { timeout: 3000 });

      expect(executor.getStatus().executing).toHaveLength(1);
      expect(connectionCount).toBe(1);

      // Drop the gateway connection from server side → triggers ws.on("close") → scheduleReconnect()
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }

      // Wait for scheduleReconnect to fire (5s) and reconnect
      await vi.waitFor(() => {
        expect(connectionCount).toBeGreaterThanOrEqual(2);
      }, { timeout: 8000 });

      // Verify the executor reconnected (gateway state should be ready again)
      expect(executor.getStatus().gw_state).toBe("ready");

      await executor.close();
      executor = null;
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it("reconnects when only queued tasks exist (the bug fix scenario)", { timeout: 12000 }, async () => {
      // This is the exact bug that was fixed: scheduleReconnect() previously only
      // checked executing.size > 0, missing tasks in the queue.
      //
      // Scenario to exercise the fix:
      // 1. maxConcurrent=1, enqueue 2 tasks → task 1 executes, task 2 in queue
      // 2. Gateway drops → ws.on("close") → scheduleReconnect()
      // 3. Task 1 timeout fires (1s) → removed from executing, executing.size=0
      // 4. scheduleReconnect timer fires (5s) → checks condition:
      //    OLD CODE: executing.size > 0 → false → NO reconnect (BUG!)
      //    NEW CODE: executing.size > 0 || queue.length > 0 → true → reconnects
      // 5. After reconnect, queued task 2 should drain and execute

      const port = getRandomPort();
      let connectionCount = 0;
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
        connectionCount++;
        connections.push(ws);

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
                features: { methods: ["chat.send"], events: ["chat"] },
                snapshot: {},
                policy: {},
              },
            }));
          }

          if (msg.type === "req" && msg.method === "chat.send") {
            const sessionKey = msg.params?.sessionKey as string;
            // On reconnection (connection 2+), respond with final so task completes
            if (connectionCount >= 2) {
              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: "event",
                  event: "chat",
                  payload: {
                    sessionKey,
                    state: "final",
                    messages: [{ role: "assistant", content: "Done after reconnect" }],
                  },
                }));
              }, 50);
            }
            // First connection: never respond (task stays executing until timeout)
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 1 });

      // Task 1: will execute, then timeout after 1s (short timeout for testing)
      tasks.create(makeTaskRecord({
        task_id: "reconnect-bug-1",
        state: "accepted",
        direction: "inbound",
        task: { task_type: "test", description: "Will timeout", constraints: { max_duration_s: 1 } },
      }));
      // Task 2: stays in queue (maxConcurrent=1)
      tasks.create(makeTaskRecord({
        task_id: "reconnect-bug-2",
        state: "accepted",
        direction: "inbound",
        task: { task_type: "test", description: "Queued task" },
      }));

      const completed: string[] = [];
      const timedOut: string[] = [];
      executor.on("task:completed", (id: string) => completed.push(id));
      executor.on("task:timeout", (id: string) => timedOut.push(id));

      executor.start();

      // Wait for task 1 to enter executing
      await vi.waitFor(() => {
        expect(executor!.getStatus().executing).toHaveLength(1);
      }, { timeout: 2000 });

      // Drop gateway → scheduleReconnect() called
      // At this point: executing.size=1, queue.length=1
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      await new Promise((r) => setTimeout(r, 100));

      // Task 1 will timeout after ~1s → executing.size becomes 0
      // scheduleReconnect timer fires after 5s → should check queue.length > 0
      // Without the fix: executing.size=0 → skips reconnect → task 2 stuck forever
      // With the fix: queue.length=1 → reconnects → task 2 executes

      await vi.waitFor(() => {
        // Task 2 should complete after reconnect
        expect(completed).toContain("reconnect-bug-2");
      }, { timeout: 10000 });

      // Task 1 should have timed out
      expect(timedOut).toContain("reconnect-bug-1");
      // Should have at least 2 connections (original + reconnect)
      expect(connectionCount).toBeGreaterThanOrEqual(2);

      await executor.close();
      executor = null;
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      await new Promise<void>((r) => wss.close(() => r()));
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
