// Layer B — Task Manager
// Persistent task tracking with state machine, timeout checks, history archival

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  TaskRecord,
  TaskState,
  TaskDirection,
  ActiveTasksFile,
  TaskStats,
  LayerBEnvelope,
  AcceptPayload,
  RejectPayload,
  ReportPayload,
  CancelPayload,
  HeartbeatPayload,
} from "./types.js";

const CLAWNEXUS_DIR = path.join(os.homedir(), ".clawnexus");
const TASKS_DIR = path.join(CLAWNEXUS_DIR, "tasks");
const ACTIVE_PATH = path.join(TASKS_DIR, "active.json");
const HISTORY_DIR = path.join(TASKS_DIR, "history");
const DEBOUNCE_MS = 500;
const TIMEOUT_CHECK_INTERVAL = 30_000;
const TASK_TIMEOUT_S = 600; // 10 minutes default

// Valid state transitions
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending:   ["accepted", "rejected", "cancelled", "timeout"],
  accepted:  ["executing", "cancelled", "timeout"],
  executing: ["completed", "failed", "cancelled", "timeout"],
  completed: [],
  failed:    [],
  rejected:  [],
  cancelled: [],
  timeout:   [],
};

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "completed", "failed", "rejected", "cancelled", "timeout",
]);

const ACTIVE_STATES: ReadonlySet<TaskState> = new Set([
  "pending", "accepted", "executing",
]);

export class TaskManager extends EventEmitter {
  private tasks = new Map<string, TaskRecord>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private readonly tasksDir: string;
  private readonly activePath: string;
  private readonly historyDir: string;

  constructor(configDir?: string) {
    super();
    const baseDir = configDir ?? CLAWNEXUS_DIR;
    this.tasksDir = path.join(baseDir, "tasks");
    this.activePath = path.join(this.tasksDir, "active.json");
    this.historyDir = path.join(this.tasksDir, "history");
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.historyDir, { recursive: true });

    if (fs.existsSync(this.activePath)) {
      try {
        const raw = await fs.promises.readFile(this.activePath, "utf-8");
        const data: ActiveTasksFile = JSON.parse(raw);
        if (data.schema_version === "1" && Array.isArray(data.tasks)) {
          for (const task of data.tasks) {
            this.tasks.set(task.task_id, task);
          }
        }
      } catch {
        // Corrupted — start fresh
      }
    }

    this.startTimeoutChecker();
  }

  create(record: TaskRecord): void {
    this.tasks.set(record.task_id, record);
    this.scheduleDirtyFlush();
    this.emit("created", record);
  }

  updateState(taskId: string, newState: TaskState, extra?: Partial<TaskRecord>): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const allowed = TRANSITIONS[task.state];
    if (!allowed.includes(newState)) {
      return null; // Invalid transition
    }

    task.state = newState;
    task.updated_at = new Date().toISOString();

    if (newState === "accepted") task.accepted_at = task.updated_at;
    if (TERMINAL_STATES.has(newState)) task.completed_at = task.updated_at;

    if (extra) {
      if (extra.result !== undefined) task.result = extra.result;
      if (extra.error !== undefined) task.error = extra.error;
      if (extra.progress_pct !== undefined) task.progress_pct = extra.progress_pct;
      if (extra.decision !== undefined) task.decision = extra.decision;
    }

    this.scheduleDirtyFlush();
    this.emit("stateChange", task, newState);

    if (TERMINAL_STATES.has(newState)) {
      this.archiveCompleted();
    }

    return task;
  }

  getActive(): TaskRecord[] {
    return Array.from(this.tasks.values()).filter((t) => ACTIVE_STATES.has(t.state));
  }

  getAll(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }

  getById(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  getByDirection(direction: TaskDirection): TaskRecord[] {
    return Array.from(this.tasks.values()).filter((t) => t.direction === direction);
  }

  getStats(): TaskStats {
    const stats: TaskStats = {
      total: this.tasks.size,
      by_state: {
        pending: 0, accepted: 0, executing: 0, completed: 0,
        failed: 0, rejected: 0, cancelled: 0, timeout: 0,
      },
      by_direction: { outbound: 0, inbound: 0 },
      active: 0,
    };

    for (const task of this.tasks.values()) {
      stats.by_state[task.state]++;
      stats.by_direction[task.direction]++;
      if (ACTIVE_STATES.has(task.state)) stats.active++;
    }

    return stats;
  }

  handleResponse(envelope: LayerBEnvelope): TaskRecord | null {
    switch (envelope.type) {
      case "accept": {
        const p = envelope.payload as AcceptPayload;
        return this.updateState(p.task_id, "accepted");
      }
      case "reject": {
        const p = envelope.payload as RejectPayload;
        return this.updateState(p.task_id, "rejected", {
          error: p.message ?? p.reason,
        });
      }
      case "report": {
        const p = envelope.payload as ReportPayload;
        if (p.status === "completed") {
          return this.updateState(p.task_id, "completed", { result: p.result });
        } else if (p.status === "failed") {
          return this.updateState(p.task_id, "failed", { error: p.error });
        } else if (p.status === "progress") {
          const task = this.tasks.get(p.task_id);
          if (task) {
            task.progress_pct = p.progress_pct;
            task.updated_at = new Date().toISOString();
            task.last_heartbeat = task.updated_at;
            this.scheduleDirtyFlush();
          }
          return task ?? null;
        }
        return null;
      }
      case "cancel": {
        const p = envelope.payload as CancelPayload;
        return this.updateState(p.task_id, "cancelled", { error: p.reason });
      }
      default:
        return null;
    }
  }

  updateHeartbeat(envelope: LayerBEnvelope): void {
    const p = envelope.payload as HeartbeatPayload;
    const task = this.tasks.get(p.task_id);
    if (!task) return;

    task.last_heartbeat = new Date().toISOString();
    if (p.progress_pct !== undefined) task.progress_pct = p.progress_pct;
    task.updated_at = task.last_heartbeat;
    this.scheduleDirtyFlush();
  }

  cancelTask(taskId: string, reason?: string): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return null;
    return this.updateState(taskId, "cancelled", { error: reason ?? "User cancelled" });
  }

  close(): Promise<void> {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      return this.flushNow().catch(() => {});
    }
    return Promise.resolve();
  }

  private startTimeoutChecker(): void {
    this.timeoutTimer = setInterval(() => {
      const now = Date.now();
      for (const task of this.tasks.values()) {
        if (!ACTIVE_STATES.has(task.state)) continue;
        const maxDuration = (task.task.constraints?.max_duration_s ?? TASK_TIMEOUT_S) * 1000;
        const elapsed = now - new Date(task.updated_at).getTime();
        if (elapsed > maxDuration) {
          this.updateState(task.task_id, "timeout");
          this.emit("timeout", task);
        }
      }
    }, TIMEOUT_CHECK_INTERVAL);
  }

  private archiveCompleted(): void {
    const toArchive: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATES.has(task.state)) {
        toArchive.push(task);
      }
    }

    if (toArchive.length === 0) return;

    // Write to history file (async, fire-and-forget)
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const historyPath = path.join(this.historyDir, `${date}.jsonl`);

    const lines = toArchive.map((t) => JSON.stringify(t)).join("\n") + "\n";
    fs.promises.appendFile(historyPath, lines, "utf-8").catch(() => {});

    // Remove from active
    for (const task of toArchive) {
      this.tasks.delete(task.task_id);
    }
    this.scheduleDirtyFlush();
  }

  private scheduleDirtyFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow().catch((err) => this.emit("error", err));
    }, DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    const data: ActiveTasksFile = {
      schema_version: "1",
      updated_at: new Date().toISOString(),
      tasks: Array.from(this.tasks.values()),
    };
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.activePath + ".tmp";
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, this.activePath);
    this.dirty = false;
  }
}
