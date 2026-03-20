// A2A Task Handler — manages tasks/send and tasks/get
// Uses a persistent Gateway connection (lazy init, auto-reconnect) shared across
// concurrent tasks. Each task is identified by a unique sessionKey for multiplexing.

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { connectGateway, type GatewayConnection } from "../agent/gateway.js";
import type { A2ATask, A2AMessage, A2AError } from "./types.js";
import { JSON_RPC_INVALID_PARAMS, JSON_RPC_TASK_LIMIT_EXCEEDED } from "./types.js";
import type { A2ATaskStore } from "./store.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 5;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface A2AHandlerOptions {
  gatewayUrl?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  store?: A2ATaskStore;
}

interface PendingSession {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class A2AHandler {
  private readonly gatewayUrl: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly store: A2ATaskStore | null;

  // Persistent Gateway connection
  private conn: GatewayConnection | null = null;
  private connecting: Promise<GatewayConnection> | null = null;
  private reconnectAttempt = 0;

  // Session-based dispatch for multiplexed tasks
  private readonly sessions = new Map<string, PendingSession>();
  private activeTasks = 0;

  constructor(opts: A2AHandlerOptions = {}) {
    this.gatewayUrl = opts.gatewayUrl ?? "ws://127.0.0.1:18789";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.store = opts.store ?? null;
  }

  async handleTaskSend(params: unknown): Promise<A2ATask | A2AError> {
    const p = params as { message?: A2AMessage } | undefined;
    if (!p?.message?.parts?.length) {
      return { code: JSON_RPC_INVALID_PARAMS, message: "Missing message with parts" };
    }

    const textParts = p.message.parts.filter((part) => part.type === "text");
    if (textParts.length === 0) {
      return { code: JSON_RPC_INVALID_PARAMS, message: "No text parts in message" };
    }

    // Concurrency guard
    if (this.activeTasks >= this.maxConcurrent) {
      return {
        code: JSON_RPC_TASK_LIMIT_EXCEEDED,
        message: `Too many concurrent tasks (max: ${this.maxConcurrent})`,
      };
    }

    const userText = textParts.map((part) => part.text).join("\n");
    const taskId = randomUUID();
    const sessionKey = `agent:main:main:dm:a2a-task-${taskId}`;

    const task: A2ATask = {
      id: taskId,
      status: { state: "submitted" },
      history: [p.message],
    };
    this.persistTask(task);
    this.activeTasks++;

    // Acquire shared connection
    let conn: GatewayConnection;
    try {
      conn = await this.getConnection();
    } catch (err) {
      this.activeTasks--;
      task.status = {
        state: "failed",
        message: {
          role: "agent",
          parts: [{ type: "text", text: `Gateway connection failed: ${(err as Error).message}` }],
        },
      };
      this.persistTask(task);
      return task;
    }

    task.status.state = "working";
    this.persistTask(task);

    try {
      const result = await this.sendAndWait(conn.ws, sessionKey, userText);
      const agentMsg: A2AMessage = { role: "agent", parts: [{ type: "text", text: result }] };
      task.status = { state: "completed", message: agentMsg };
      task.artifacts = [{ parts: [{ type: "text", text: result }] }];
      if (task.history) task.history.push(agentMsg);
    } catch (err) {
      task.status = {
        state: "failed",
        message: { role: "agent", parts: [{ type: "text", text: (err as Error).message }] },
      };
    } finally {
      this.activeTasks--;
      this.persistTask(task);
    }

    return task;
  }

  getTask(taskId: string): A2ATask | undefined {
    return this.store?.get(taskId);
  }

  /** Clean up connection and pending sessions. */
  close(): void {
    for (const [, session] of this.sessions) {
      clearTimeout(session.timer);
      session.reject(new Error("Handler closed"));
    }
    this.sessions.clear();
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
    this.connecting = null;
  }

  // --- Connection management ---

  private async getConnection(): Promise<GatewayConnection> {
    if (this.conn && this.conn.ws.readyState === WebSocket.OPEN) {
      return this.conn;
    }
    // Avoid duplicate connect attempts
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<GatewayConnection> {
    const conn = await connectGateway({ gatewayUrl: this.gatewayUrl });
    this.conn = conn;
    this.reconnectAttempt = 0;

    // Shared event dispatch: route incoming events to the right session
    conn.ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== "event") return;

      const event = msg.event as string;
      if (event !== "chat" && event !== "chat.update") return;

      const payload = msg.payload as Record<string, unknown> | undefined;
      const sk = (payload?.sessionKey as string) ?? (msg.sessionKey as string);
      if (!sk) return;

      const session = this.sessions.get(sk);
      if (!session) return;

      const state = payload?.state as string | undefined;
      if (state === "final") {
        this.sessions.delete(sk);
        clearTimeout(session.timer);
        session.resolve(this.extractResponse(payload));
      } else if (state === "error") {
        this.sessions.delete(sk);
        clearTimeout(session.timer);
        session.reject(new Error((payload?.errorMessage as string) ?? "OpenClaw chat error"));
      }
    });

    conn.ws.on("close", () => {
      this.conn = null;
      // Reject all pending sessions — they'll fail their tasks gracefully
      for (const [sk, session] of this.sessions) {
        clearTimeout(session.timer);
        session.reject(new Error("Gateway connection closed during task execution"));
        this.sessions.delete(sk);
      }
      this.scheduleReconnect();
    });

    return conn;
  }

  private scheduleReconnect(): void {
    // Only reconnect if there could be future tasks (handler not closed)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    setTimeout(() => {
      // Lazy: don't eagerly reconnect, just clear state so next getConnection() will connect fresh
      this.connecting = null;
    }, delay);
  }

  // --- Task execution ---

  private sendAndWait(ws: WebSocket, sessionKey: string, message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();

      const timer = setTimeout(() => {
        this.sessions.delete(sessionKey);
        reject(new Error("Task execution timed out"));
      }, this.timeoutMs);

      this.sessions.set(sessionKey, { resolve, reject, timer });

      ws.send(
        JSON.stringify({
          type: "req",
          id: requestId,
          method: "chat.send",
          params: { sessionKey, message, idempotencyKey: requestId },
        }),
      );
    });
  }

  private extractResponse(payload: Record<string, unknown> | undefined): string {
    if (!payload) return "Task completed (no output)";

    const messages = payload.messages as Array<Record<string, unknown>> | undefined;
    if (messages && messages.length > 0) {
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        const content = lastAssistant.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return (content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text")
            .map((b) => b.text as string)
            .join("\n");
        }
      }
    }

    return (payload.content as string) ?? "Task completed (no output)";
  }

  // --- Persistence ---

  private persistTask(task: A2ATask): void {
    if (this.store) this.store.put(task);
  }
}
