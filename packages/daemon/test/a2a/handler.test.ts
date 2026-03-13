import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { A2AHandler } from "../../src/a2a/handler.js";
import { A2ATaskStore } from "../../src/a2a/store.js";
import type { A2AMessage, A2AError, A2ATask } from "../../src/a2a/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/**
 * Mock OpenClaw Gateway with Protocol v3 handshake.
 */
function createMockGateway(port: number, opts: {
  autoFinal?: boolean;
  finalDelay?: number;
  finalContent?: string;
  rejectConnect?: boolean;
  chatError?: string;
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

        if (opts.chatError) {
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: "event",
              event: "chat",
              payload: { sessionKey, state: "error", errorMessage: opts.chatError },
            }));
          }, 20);
          return;
        }

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
                  { role: "assistant", content: opts.finalContent ?? "Hello from the assistant" },
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

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a2a-test-"));
}

describe("A2AHandler", () => {
  let port: number;
  let gateway: ReturnType<typeof createMockGateway> | null = null;
  let handler: A2AHandler;
  let tmpDir: string;
  let store: A2ATaskStore;

  beforeEach(async () => {
    port = getRandomPort();
    tmpDir = makeTmpDir();
    store = new A2ATaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    handler?.close();
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    await store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMessage(text: string): A2AMessage {
    return { role: "user", parts: [{ type: "text", text }] };
  }

  describe("handleTaskSend", () => {
    it("sends a message and returns completed task", async () => {
      gateway = createMockGateway(port, { finalContent: "The answer is 42" });
      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });

      const result = await handler.handleTaskSend({ message: makeMessage("What is 6*7?") });

      expect("id" in result).toBe(true);
      const task = result as A2ATask;
      expect(task.status.state).toBe("completed");
      expect(task.status.message?.parts[0].text).toContain("42");
      expect(task.artifacts).toHaveLength(1);
      expect(task.artifacts![0].parts[0].text).toContain("42");
      expect(task.history).toHaveLength(2);
      expect(task.history![0].role).toBe("user");
      expect(task.history![1].role).toBe("agent");
    });

    it("stores the task for later retrieval via getTask", async () => {
      gateway = createMockGateway(port);
      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });

      const result = await handler.handleTaskSend({ message: makeMessage("hello") });
      const task = result as A2ATask;

      const retrieved = handler.getTask(task.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(task.id);
      expect(retrieved!.status.state).toBe("completed");
    });

    it("returns failed task when gateway is not available", async () => {
      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });

      const result = await handler.handleTaskSend({ message: makeMessage("hello") });
      const task = result as A2ATask;
      expect(task.status.state).toBe("failed");
      expect(task.status.message?.parts[0].text).toContain("Gateway connection failed");
    });

    it("returns failed task on chat error from gateway", async () => {
      gateway = createMockGateway(port, { chatError: "Model not available" });
      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });

      const result = await handler.handleTaskSend({ message: makeMessage("hello") });
      const task = result as A2ATask;
      expect(task.status.state).toBe("failed");
      expect(task.status.message?.parts[0].text).toBe("Model not available");
    });

    it("returns failed task on timeout", async () => {
      gateway = createMockGateway(port, { autoFinal: false });
      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, timeoutMs: 500, store });

      const result = await handler.handleTaskSend({ message: makeMessage("hello") });
      const task = result as A2ATask;
      expect(task.status.state).toBe("failed");
      expect(task.status.message?.parts[0].text).toContain("timed out");
    });

    it("returns error for missing message", async () => {
      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });

      const result = await handler.handleTaskSend({});
      expect("code" in result).toBe(true);
      const err = result as A2AError;
      expect(err.code).toBe(-32602);
      expect(err.message).toContain("Missing message");
    });

    it("returns error for empty parts", async () => {
      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });

      const result = await handler.handleTaskSend({ message: { role: "user", parts: [] } });
      const err = result as A2AError;
      expect(err.code).toBe(-32602);
    });

    it("concatenates multiple text parts", async () => {
      let receivedMessage = "";
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
            receivedMessage = msg.params?.message ?? "";
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  sessionKey: msg.params?.sessionKey,
                  state: "final",
                  messages: [{ role: "assistant", content: "ok" }],
                },
              }));
            }, 20);
          }
        });
      });

      gateway = { wss, connections, close: () => new Promise<void>((r) => {
        for (const ws of connections) if (ws.readyState === WebSocket.OPEN) ws.close();
        wss.close(() => r());
      })};

      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });
      const msg: A2AMessage = {
        role: "user",
        parts: [
          { type: "text", text: "Part one" },
          { type: "text", text: "Part two" },
        ],
      };

      await handler.handleTaskSend({ message: msg });
      expect(receivedMessage).toBe("Part one\nPart two");
    });

    it("reuses gateway connection across multiple tasks", async () => {
      let connectCount = 0;
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
            connectCount++;
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
                  messages: [{ role: "assistant", content: "ok" }],
                },
              }));
            }, 20);
          }
        });
      });

      gateway = { wss, connections, close: () => new Promise<void>((r) => {
        for (const ws of connections) if (ws.readyState === WebSocket.OPEN) ws.close();
        wss.close(() => r());
      })};

      handler = new A2AHandler({ gatewayUrl: `ws://127.0.0.1:${port}`, store });

      // Send 3 sequential tasks
      await handler.handleTaskSend({ message: makeMessage("task 1") });
      await handler.handleTaskSend({ message: makeMessage("task 2") });
      await handler.handleTaskSend({ message: makeMessage("task 3") });

      // Only one Gateway connection should have been made
      expect(connectCount).toBe(1);
    });

    it("rejects when concurrency limit is exceeded", async () => {
      gateway = createMockGateway(port, { autoFinal: false }); // Never responds — tasks stay active
      handler = new A2AHandler({
        gatewayUrl: `ws://127.0.0.1:${port}`,
        maxConcurrent: 2,
        timeoutMs: 5000,
        store,
      });

      // Fire 2 tasks (they won't complete since autoFinal is false)
      const p1 = handler.handleTaskSend({ message: makeMessage("task 1") });
      const p2 = handler.handleTaskSend({ message: makeMessage("task 2") });

      // Small delay to let tasks start
      await new Promise((r) => setTimeout(r, 200));

      // Third task should be rejected immediately
      const result3 = await handler.handleTaskSend({ message: makeMessage("task 3") });
      expect("code" in result3).toBe(true);
      const err = result3 as A2AError;
      expect(err.code).toBe(-32005);
      expect(err.message).toContain("Too many concurrent tasks");

      // Clean up: close handler to abort pending tasks
      handler.close();
      // Wait for p1/p2 to settle (they'll fail due to close)
      await Promise.allSettled([p1, p2]);
    });
  });

  describe("getTask", () => {
    it("returns undefined for unknown task id", () => {
      handler = new A2AHandler({ store });
      expect(handler.getTask("nonexistent")).toBeUndefined();
    });
  });
});
