import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { TaskManager } from "../../src/agent/tasks.js";
import { TaskExecutor } from "../../src/agent/executor.js";
import { makeTaskRecord } from "../fixtures.js";

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

function createMockGateway(port: number, opts: {
  autoFinal?: boolean;
  finalDelay?: number;
  onChatSend?: (params: Record<string, unknown>, ws: WebSocket) => void;
} = {}): { wss: WebSocketServer; connections: WebSocket[]; close: () => Promise<void> } {
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
            features: { methods: ["chat.send"], events: ["chat"] },
            snapshot: {},
            policy: {},
          },
        }));
      }

      if (msg.type === "req" && msg.method === "chat.send") {
        if (opts.onChatSend) {
          opts.onChatSend(msg.params, ws);
        } else if (opts.autoFinal !== false) {
          const sessionKey = msg.params?.sessionKey as string;
          const delay = opts.finalDelay ?? 50;
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                sessionKey,
                state: "final",
                messages: [
                  { role: "assistant", content: "Task completed" },
                ],
              },
            }));
          }, delay);
        }
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

function createMockRouter() {
  return {
    sendReport: vi.fn(),
    sendHeartbeat: vi.fn(),
  };
}

describe("TaskExecutor — edge cases", () => {
  let tmpDir: string;
  let tasks: TaskManager;
  let gwPort: number;
  let gateway: ReturnType<typeof createMockGateway> | null = null;
  let executor: TaskExecutor | null = null;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-exec-ext-test-"));
    tasks = new TaskManager(tmpDir);
    await tasks.init();
    gwPort = getRandomPort();
  });

  afterEach(async () => {
    if (executor) {
      await executor.close();
      executor = null;
    }
    await new Promise((r) => setTimeout(r, 600));
    await tasks.close();
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("chat.update event", () => {
    it("handles chat.update with final state same as chat event", async () => {
      const port = getRandomPort();
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
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
                features: {},
                snapshot: {},
                policy: {},
              },
            }));
          }
          if (msg.type === "req" && msg.method === "chat.send") {
            // Respond with chat.update instead of chat
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "event",
                event: "chat.update",
                payload: {
                  sessionKey: msg.params?.sessionKey,
                  state: "final",
                  messages: [
                    { role: "assistant", content: "Updated response" },
                  ],
                },
              }));
            }, 50);
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 3 });
      const mockRouter = createMockRouter();
      executor.setRouter(mockRouter as any);

      tasks.create(makeTaskRecord({
        task_id: "update-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
      }));

      const completedPromise = new Promise<string>((resolve) => {
        executor!.on("task:completed", (taskId: string) => resolve(taskId));
      });

      executor.start();
      const completedId = await completedPromise;
      expect(completedId).toBe("update-1");

      expect(mockRouter.sendReport).toHaveBeenCalledWith(
        "room-1", "peer.id.claw", "update-1", "completed",
        expect.stringContaining("Updated response"),
      );

      await executor.close();
      executor = null;
      for (const ws of connections) ws.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });
  });

  describe("content block extraction", () => {
    it("extracts text from content blocks array", async () => {
      const port = getRandomPort();
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
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
                features: {},
                snapshot: {},
                policy: {},
              },
            }));
          }
          if (msg.type === "req" && msg.method === "chat.send") {
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  sessionKey: msg.params?.sessionKey,
                  state: "final",
                  messages: [
                    {
                      role: "assistant",
                      content: [
                        { type: "text", text: "First part" },
                        { type: "tool_use", id: "tool-1" },
                        { type: "text", text: "Second part" },
                      ],
                    },
                  ],
                },
              }));
            }, 50);
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 3 });
      const mockRouter = createMockRouter();
      executor.setRouter(mockRouter as any);

      tasks.create(makeTaskRecord({
        task_id: "blocks-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
      }));

      const completedPromise = new Promise<string>((resolve) => {
        executor!.on("task:completed", (taskId: string) => resolve(taskId));
      });

      executor.start();
      await completedPromise;

      // Should extract and join text blocks
      expect(mockRouter.sendReport).toHaveBeenCalledWith(
        "room-1", "peer.id.claw", "blocks-1", "completed",
        expect.stringContaining("First part"),
      );
      const result = mockRouter.sendReport.mock.calls[0][4] as string;
      expect(result).toContain("Second part");

      await executor.close();
      executor = null;
      for (const ws of connections) ws.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it("falls back to content field when no messages", async () => {
      const port = getRandomPort();
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
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
                features: {},
                snapshot: {},
                policy: {},
              },
            }));
          }
          if (msg.type === "req" && msg.method === "chat.send") {
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  sessionKey: msg.params?.sessionKey,
                  state: "final",
                  content: "Fallback content string",
                  // No messages array
                },
              }));
            }, 50);
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 3 });
      const mockRouter = createMockRouter();
      executor.setRouter(mockRouter as any);

      tasks.create(makeTaskRecord({
        task_id: "fallback-1",
        state: "accepted",
        direction: "inbound",
        room_id: "room-1",
        peer_claw_id: "peer.id.claw",
      }));

      const completedPromise = new Promise<string>((resolve) => {
        executor!.on("task:completed", (taskId: string) => resolve(taskId));
      });

      executor.start();
      await completedPromise;

      expect(mockRouter.sendReport).toHaveBeenCalledWith(
        "room-1", "peer.id.claw", "fallback-1", "completed",
        "Fallback content string",
      );

      await executor.close();
      executor = null;
      for (const ws of connections) ws.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });
  });

  describe("gateway error response (type=res, ok=false)", () => {
    it("handles error response for a chat.send request", async () => {
      const port = getRandomPort();
      const connections: WebSocket[] = [];
      const wss = new WebSocketServer({ port });

      wss.on("connection", (ws) => {
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
                features: {},
                snapshot: {},
                policy: {},
              },
            }));
          }
          if (msg.type === "req" && msg.method === "chat.send") {
            // Send error response instead of success
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "res",
                id: msg.id,
                ok: false,
                error: { code: "SESSION_ERROR", message: "Session creation failed" },
              }));
            }, 50);
          }
        });
      });

      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${port}`, maxConcurrent: 3 });
      const mockRouter = createMockRouter();
      executor.setRouter(mockRouter as any);

      tasks.create(makeTaskRecord({
        task_id: "gw-err-1",
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
      expect(failedId).toBe("gw-err-1");

      expect(mockRouter.sendReport).toHaveBeenCalledWith(
        "room-1", "peer.id.claw", "gw-err-1", "failed", undefined,
        expect.stringContaining("Session creation failed"),
      );

      await executor.close();
      executor = null;
      for (const ws of connections) ws.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });
  });

  describe("close() cleanup", () => {
    it("cancels reconnect timer on close", async () => {
      gateway = createMockGateway(gwPort, { autoFinal: false });
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });

      tasks.create(makeTaskRecord({
        task_id: "close-reconnect-1",
        state: "accepted",
        direction: "inbound",
        task: { task_type: "test", description: "test", constraints: { max_duration_s: 300 } },
      }));

      executor.start();
      await new Promise((r) => setTimeout(r, 300));

      // Force disconnect to trigger scheduleReconnect
      for (const ws of gateway.connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      await new Promise((r) => setTimeout(r, 100));

      // Close immediately — should cancel reconnect timer
      await executor.close();
      executor = null;

      // If reconnect timer wasn't cancelled, it would try to reconnect after 5s
      // and cause errors. We just verify close() completes cleanly.
    });

    it("skips stale tasks in queue during drain", async () => {
      gateway = createMockGateway(gwPort);
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 3 });

      // Create a task, put it in queue, then change its state to something invalid
      tasks.create(makeTaskRecord({
        task_id: "stale-1",
        state: "accepted",
        direction: "inbound",
      }));

      executor.enqueue("stale-1");

      // Cancel the task before executor gets to drain it
      tasks.updateState("stale-1", "cancelled");

      await new Promise((r) => setTimeout(r, 500));

      // Task should have been skipped (not executed)
      const status = executor.getStatus();
      expect(status.executing).toHaveLength(0);
    });
  });

  describe("concurrent task draining after completion", () => {
    it("drains next queued task after current one completes", async () => {
      gateway = createMockGateway(gwPort, { finalDelay: 100 });
      executor = new TaskExecutor({ tasks, gatewayUrl: `ws://127.0.0.1:${gwPort}`, maxConcurrent: 1 });

      // Create 2 tasks with maxConcurrent=1
      tasks.create(makeTaskRecord({
        task_id: "drain-1",
        state: "accepted",
        direction: "inbound",
      }));
      tasks.create(makeTaskRecord({
        task_id: "drain-2",
        state: "accepted",
        direction: "inbound",
      }));

      const completed: string[] = [];
      executor.on("task:completed", (id: string) => completed.push(id));

      executor.start();

      await vi.waitFor(() => {
        expect(completed).toHaveLength(2);
      }, { timeout: 3000 });

      expect(completed).toContain("drain-1");
      expect(completed).toContain("drain-2");
    });
  });
});
