// Layer B — Task Executor
// Connects to local OpenClaw Gateway via WebSocket, executes accepted inbound tasks,
// reports results back to the proposer via AgentRouter.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TaskManager } from "./tasks.js";
import type { AgentRouter } from "./router.js";
import type { TaskRecord } from "./types.js";

const CLAWNEXUS_DIR = path.join(os.homedir(), ".clawnexus");
const DEVICE_TOKEN_PATH = path.join(CLAWNEXUS_DIR, "oc-device-token");
const DEFAULT_GW_URL = "ws://127.0.0.1:18789";
const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 3;
const CONNECT_TIMEOUT_MS = 10_000;

type GwState = "disconnected" | "connecting" | "handshaking" | "ready" | "error";

interface ExecutingTask {
  taskId: string;
  sessionKey: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  aborted: boolean;
}

export interface TaskExecutorOptions {
  tasks: TaskManager;
  gatewayUrl?: string;
  maxConcurrent?: number;
}

export class TaskExecutor extends EventEmitter {
  private readonly tasks: TaskManager;
  private readonly gatewayUrl: string;
  private readonly maxConcurrent: number;

  private router: AgentRouter | null = null;
  private ws: WebSocket | null = null;
  private gwState: GwState = "disconnected";
  private deviceToken: string | null = null;

  // Queue of task IDs waiting to execute
  private queue: string[] = [];
  // Currently executing tasks
  private executing = new Map<string, ExecutingTask>();

  private stateChangeHandler: ((task: TaskRecord, newState: string) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private closed = false;

  constructor(opts: TaskExecutorOptions) {
    super();
    this.tasks = opts.tasks;
    this.gatewayUrl = opts.gatewayUrl ?? DEFAULT_GW_URL;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.loadDeviceToken();
  }

  setRouter(router: AgentRouter): void {
    this.router = router;
  }

  start(): void {
    // Listen for accepted inbound tasks
    this.stateChangeHandler = (task: TaskRecord, newState: string) => {
      if (newState === "accepted" && task.direction === "inbound") {
        this.enqueue(task.task_id);
      }
    };
    this.tasks.on("stateChange", this.stateChangeHandler);

    // Also pick up any already-accepted inbound tasks (e.g. after restart)
    for (const task of this.tasks.getActive()) {
      if (task.state === "accepted" && task.direction === "inbound") {
        this.enqueue(task.task_id);
      }
    }
  }

  enqueue(taskId: string): void {
    if (this.executing.has(taskId) || this.queue.includes(taskId)) return;
    this.queue.push(taskId);
    this.drainQueue();
  }

  getStatus(): {
    gw_state: GwState;
    queue_length: number;
    executing: Array<{ task_id: string; session_key: string }>;
    max_concurrent: number;
  } {
    return {
      gw_state: this.gwState,
      queue_length: this.queue.length,
      executing: Array.from(this.executing.values()).map((e) => ({
        task_id: e.taskId,
        session_key: e.sessionKey,
      })),
      max_concurrent: this.maxConcurrent,
    };
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.stateChangeHandler) {
      this.tasks.off("stateChange", this.stateChangeHandler);
      this.stateChangeHandler = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Abort all executing tasks
    for (const [taskId, exec] of this.executing) {
      this.clearTaskTimers(exec);
      this.tasks.updateState(taskId, "failed", { error: "Executor shutting down" });
    }
    this.executing.clear();
    this.queue = [];

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      // Remove all listeners except error to prevent uncaught exceptions
      ws.removeAllListeners("open");
      ws.removeAllListeners("message");
      ws.removeAllListeners("close");
      // Keep a no-op error handler to suppress uncaught ECONNREFUSED
      ws.removeAllListeners("error");
      ws.on("error", () => {});
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    this.gwState = "disconnected";
  }

  // --- Gateway Connection ---

  private async ensureConnection(): Promise<boolean> {
    if (this.gwState === "ready" && this.ws?.readyState === WebSocket.OPEN) {
      return true;
    }
    if (this.gwState === "connecting" || this.gwState === "handshaking") {
      // Already in progress — wait
      return new Promise((resolve) => {
        const onReady = () => { cleanup(); resolve(true); };
        const onError = () => { cleanup(); resolve(false); };
        const cleanup = () => {
          this.off("gw:ready", onReady);
          this.off("gw:error", onError);
        };
        this.once("gw:ready", onReady);
        this.once("gw:error", onError);
      });
    }
    return this.connectGateway();
  }

  private connectGateway(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.closed) { resolve(false); return; }

      this.gwState = "connecting";
      const connectTimeout = setTimeout(() => {
        this.gwState = "error";
        this.emit("gw:error", "Connection timeout");
        if (ws.readyState === WebSocket.CONNECTING) ws.close();
        resolve(false);
      }, CONNECT_TIMEOUT_MS);

      const ws = new WebSocket(this.gatewayUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.gwState = "handshaking";
      });

      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        this.handleGwMessage(msg, ws, connectTimeout, resolve);
      });

      ws.on("error", (err: Error) => {
        clearTimeout(connectTimeout);
        console.log(`[clawnexus] [Executor] Gateway connection error: ${err.message}`);
        this.gwState = "error";
        this.emit("gw:error", err.message);
        resolve(false);
      });

      ws.on("close", () => {
        clearTimeout(connectTimeout);
        const wasReady = this.gwState === "ready";
        this.gwState = "disconnected";
        this.ws = null;
        if (wasReady) {
          console.log("[clawnexus] [Executor] Gateway connection closed");
          this.scheduleReconnect();
        }
      });
    });
  }

  private handleGwMessage(
    msg: Record<string, unknown>,
    ws: WebSocket,
    connectTimeout: ReturnType<typeof setTimeout>,
    resolveConnect: ((ok: boolean) => void) | null,
  ): void {
    const action = msg.action as string | undefined;

    // Handshake: connect.challenge → connect → hello-ok
    if (action === "event" && msg.event === "connect.challenge") {
      const authToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? this.deviceToken ?? undefined;
      const connectMsg: Record<string, unknown> = {
        action: "req",
        method: "connect",
        role: "operator",
        scopes: ["read", "write"],
      };
      if (authToken) {
        connectMsg.token = authToken;
      }
      ws.send(JSON.stringify(connectMsg));
      return;
    }

    if (action === "res" && msg.response === "hello-ok") {
      clearTimeout(connectTimeout);
      this.gwState = "ready";

      // Persist deviceToken if returned
      if (msg.deviceToken && typeof msg.deviceToken === "string") {
        this.deviceToken = msg.deviceToken;
        this.saveDeviceToken(msg.deviceToken);
      }

      console.log("[clawnexus] [Executor] Gateway connection ready");
      this.emit("gw:ready");
      if (resolveConnect) resolveConnect(true);
      return;
    }

    // Runtime messages — route to task handlers
    if (action === "event") {
      this.handleGwEvent(msg);
    } else if (action === "res" && msg.response === "lifecycle:error") {
      const sessionKey = msg.sessionKey as string | undefined;
      if (sessionKey) {
        this.handleTaskError(sessionKey, (msg.message as string) ?? "Gateway lifecycle error");
      }
    }
  }

  private handleGwEvent(msg: Record<string, unknown>): void {
    const event = msg.event as string;
    const sessionKey = msg.sessionKey as string | undefined;

    if (!sessionKey) return;

    // Find the executing task for this sessionKey
    let execEntry: ExecutingTask | undefined;
    for (const exec of this.executing.values()) {
      if (exec.sessionKey === sessionKey) {
        execEntry = exec;
        break;
      }
    }
    if (!execEntry) return;

    if (event === "chat") {
      const state = (msg.data as Record<string, unknown>)?.state as string | undefined;
      if (state === "final") {
        this.handleTaskFinal(execEntry, msg);
      }
    }
  }

  private handleTaskFinal(exec: ExecutingTask, msg: Record<string, unknown>): void {
    this.clearTaskTimers(exec);

    // Extract the assistant's reply from the final message
    const data = msg.data as Record<string, unknown> | undefined;
    const messages = data?.messages as Array<Record<string, unknown>> | undefined;
    let result = "";

    if (messages && messages.length > 0) {
      // Last assistant message
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        const content = lastAssistant.content;
        if (typeof content === "string") {
          result = content;
        } else if (Array.isArray(content)) {
          // Content blocks — extract text
          result = (content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text")
            .map((b) => b.text as string)
            .join("\n");
        }
      }
    }

    // If no structured messages, try extracting from accumulated content
    if (!result) {
      result = (data?.content as string) ?? "Task completed (no output)";
    }

    const task = this.tasks.getById(exec.taskId);
    this.tasks.updateState(exec.taskId, "completed", { result });

    // Send report to proposer
    if (task?.room_id && task.peer_claw_id && this.router) {
      this.router.sendReport(task.room_id, task.peer_claw_id, exec.taskId, "completed", result);
    }

    this.executing.delete(exec.taskId);
    this.emit("task:completed", exec.taskId);
    this.drainQueue();
  }

  private handleTaskError(sessionKey: string, errorMsg: string): void {
    for (const [taskId, exec] of this.executing) {
      if (exec.sessionKey === sessionKey) {
        this.clearTaskTimers(exec);
        const task = this.tasks.getById(taskId);
        this.tasks.updateState(taskId, "failed", { error: errorMsg });

        if (task?.room_id && task.peer_claw_id && this.router) {
          this.router.sendReport(task.room_id, task.peer_claw_id, taskId, "failed", undefined, errorMsg);
        }

        this.executing.delete(taskId);
        this.emit("task:failed", taskId, errorMsg);
        this.drainQueue();
        return;
      }
    }
  }

  // --- Task Execution ---

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
    while (this.queue.length > 0 && this.executing.size < this.maxConcurrent && !this.closed) {
      const taskId = this.queue.shift()!;
      const task = this.tasks.getById(taskId);
      if (!task || task.state !== "accepted" || task.direction !== "inbound") {
        continue; // Skip stale entries
      }
      await this.executeTask(task);
    }
    } finally {
      this.draining = false;
    }
  }

  private async executeTask(task: TaskRecord): Promise<void> {
    const connected = await this.ensureConnection();
    if (!connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log(`[clawnexus] [Executor] Cannot execute task ${task.task_id}: gateway not available`);
      this.tasks.updateState(task.task_id, "failed", { error: "OpenClaw Gateway not available" });
      if (task.room_id && task.peer_claw_id && this.router) {
        this.router.sendReport(task.room_id, task.peer_claw_id, task.task_id, "failed", undefined, "OpenClaw Gateway not available");
      }
      this.emit("task:failed", task.task_id, "Gateway not available");
      return;
    }

    const sessionKey = `agent:main:main:dm:clawnexus-task-${task.task_id}`;
    const message = task.task.description + (task.task.input ? "\n\n" + JSON.stringify(task.task.input) : "");

    // Transition to executing
    this.tasks.updateState(task.task_id, "executing");

    const exec: ExecutingTask = {
      taskId: task.task_id,
      sessionKey,
      heartbeatTimer: null,
      timeoutTimer: null,
      aborted: false,
    };
    this.executing.set(task.task_id, exec);

    // Send chat message to OpenClaw
    const chatMsg = {
      action: "req",
      method: "chat.send",
      sessionKey,
      message,
    };
    this.ws.send(JSON.stringify(chatMsg));

    // Start heartbeat (sends Layer B heartbeat to proposer every 15s)
    if (task.room_id && task.peer_claw_id && this.router) {
      exec.heartbeatTimer = setInterval(() => {
        if (this.router && task.room_id) {
          this.router.sendHeartbeat(task.room_id, task.peer_claw_id, task.task_id);
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    // Set up timeout
    const maxDurationS = task.task.constraints?.max_duration_s ?? 600;
    exec.timeoutTimer = setTimeout(() => {
      if (exec.aborted) return;
      exec.aborted = true;

      // Abort the chat
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          action: "req",
          method: "chat.abort",
          sessionKey,
        }));
      }

      this.clearTaskTimers(exec);
      this.tasks.updateState(task.task_id, "timeout");

      if (task.room_id && task.peer_claw_id && this.router) {
        this.router.sendReport(task.room_id, task.peer_claw_id, task.task_id, "failed", undefined, "Task execution timed out");
      }

      this.executing.delete(task.task_id);
      this.emit("task:timeout", task.task_id);
      this.drainQueue();
    }, maxDurationS * 1000);

    this.emit("task:executing", task.task_id);
    console.log(`[clawnexus] [Executor] Executing task ${task.task_id} (session: ${sessionKey})`);
  }

  // --- Helpers ---

  private clearTaskTimers(exec: ExecutingTask): void {
    if (exec.heartbeatTimer) {
      clearInterval(exec.heartbeatTimer);
      exec.heartbeatTimer = null;
    }
    if (exec.timeoutTimer) {
      clearTimeout(exec.timeoutTimer);
      exec.timeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && this.executing.size > 0) {
        this.ensureConnection().catch(() => {});
      }
    }, 5000);
  }

  private loadDeviceToken(): void {
    try {
      if (fs.existsSync(DEVICE_TOKEN_PATH)) {
        this.deviceToken = fs.readFileSync(DEVICE_TOKEN_PATH, "utf-8").trim();
      }
    } catch {
      // Ignore
    }
  }

  private saveDeviceToken(token: string): void {
    try {
      fs.mkdirSync(CLAWNEXUS_DIR, { recursive: true });
      fs.writeFileSync(DEVICE_TOKEN_PATH, token, "utf-8");
    } catch {
      // Non-fatal
    }
  }
}
