// A2A Task Handler — manages tasks/send and tasks/get
// Connects to local OpenClaw Gateway per request, forwards user message,
// waits for final response, returns A2A Task.

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { connectGateway } from "../agent/gateway.js";
import type { A2ATask, A2AMessage, A2AError } from "./types.js";
import { JSON_RPC_INTERNAL_ERROR, JSON_RPC_INVALID_PARAMS } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface A2AHandlerOptions {
  gatewayUrl?: string;
  timeoutMs?: number;
}

export class A2AHandler {
  private readonly tasks = new Map<string, A2ATask>();
  private readonly gatewayUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: A2AHandlerOptions = {}) {
    this.gatewayUrl = opts.gatewayUrl ?? "ws://127.0.0.1:18789";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async handleTaskSend(params: unknown): Promise<A2ATask | A2AError> {
    const p = params as { message?: A2AMessage } | undefined;
    if (!p?.message?.parts?.length) {
      return { code: JSON_RPC_INVALID_PARAMS, message: "Missing message with parts" };
    }

    // Extract text from parts
    const textParts = p.message.parts.filter((part) => part.type === "text");
    if (textParts.length === 0) {
      return { code: JSON_RPC_INVALID_PARAMS, message: "No text parts in message" };
    }
    const userText = textParts.map((part) => part.text).join("\n");

    const taskId = randomUUID();
    const sessionKey = `agent:main:main:dm:a2a-task-${taskId}`;

    // Create initial task
    const task: A2ATask = {
      id: taskId,
      status: { state: "submitted" },
      history: [p.message],
    };
    this.tasks.set(taskId, task);

    // Connect to Gateway
    let conn;
    try {
      conn = await connectGateway({ gatewayUrl: this.gatewayUrl });
    } catch (err) {
      task.status = {
        state: "failed",
        message: { role: "agent", parts: [{ type: "text", text: `Gateway connection failed: ${(err as Error).message}` }] },
      };
      return task;
    }

    // Update to working
    task.status.state = "working";

    try {
      const result = await this.sendAndWait(conn.ws, sessionKey, userText);
      task.status = {
        state: "completed",
        message: { role: "agent", parts: [{ type: "text", text: result }] },
      };
      task.artifacts = [{ parts: [{ type: "text", text: result }] }];
      if (task.history) {
        task.history.push({ role: "agent", parts: [{ type: "text", text: result }] });
      }
    } catch (err) {
      task.status = {
        state: "failed",
        message: { role: "agent", parts: [{ type: "text", text: (err as Error).message }] },
      };
    } finally {
      conn.close();
    }

    return task;
  }

  getTask(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId);
  }

  private sendAndWait(ws: WebSocket, sessionKey: string, message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Task execution timed out"));
      }, this.timeoutMs);

      const onMessage = (data: Buffer) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.type !== "event") return;

        const event = msg.event as string;
        const payload = msg.payload as Record<string, unknown> | undefined;
        const msgSessionKey = (payload?.sessionKey as string) ?? (msg.sessionKey as string);
        if (msgSessionKey !== sessionKey) return;

        if (event === "chat" || event === "chat.update") {
          const state = payload?.state as string | undefined;

          if (state === "final") {
            cleanup();
            resolve(this.extractResponse(payload));
          } else if (state === "error") {
            cleanup();
            reject(new Error((payload?.errorMessage as string) ?? "OpenClaw chat error"));
          }
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Gateway connection closed during task execution"));
      };

      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
      };

      ws.on("message", onMessage);
      ws.on("close", onClose);

      // Send chat.send request
      ws.send(JSON.stringify({
        type: "req",
        id: requestId,
        method: "chat.send",
        params: { sessionKey, message, idempotencyKey: requestId },
      }));
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
}
