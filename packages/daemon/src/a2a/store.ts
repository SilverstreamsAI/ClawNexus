// A2A Task Store — persists task records to ~/.clawnexus/a2a-tasks.json
// FIFO eviction: keeps at most MAX_TASKS entries.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { A2ATask } from "./types.js";

const CLAWNEXUS_DIR = path.join(os.homedir(), ".clawnexus");
const DEFAULT_FILE = "a2a-tasks.json";
const MAX_TASKS = 100;
const DEBOUNCE_MS = 500;

interface StoreFile {
  version: 1;
  updated_at: string;
  tasks: A2ATask[];
}

export class A2ATaskStore {
  private readonly tasks = new Map<string, A2ATask>();
  private readonly filePath: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInProgress: Promise<void> | null = null;
  private dirty = false;

  constructor(configDir?: string) {
    const dir = configDir ?? CLAWNEXUS_DIR;
    this.filePath = path.join(dir, DEFAULT_FILE);
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = await fs.promises.readFile(this.filePath, "utf-8");
        const data: StoreFile = JSON.parse(raw);
        if (data.version === 1 && Array.isArray(data.tasks)) {
          for (const t of data.tasks) {
            this.tasks.set(t.id, t);
          }
        }
      } catch {
        // Corrupted file — start fresh
      }
    }
  }

  get(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId);
  }

  put(task: A2ATask): void {
    this.tasks.set(task.id, task);
    this.evict();
    this.scheduleDirtyFlush();
  }

  getAll(): A2ATask[] {
    return Array.from(this.tasks.values());
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Wait for any in-progress timer-based flush before deciding whether to flush again
    if (this.flushInProgress) {
      await this.flushInProgress;
    }
    if (this.dirty) {
      await this.flushNow();
    }
  }

  private evict(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    // Map iteration order = insertion order; delete oldest entries
    const excess = this.tasks.size - MAX_TASKS;
    let removed = 0;
    for (const key of this.tasks.keys()) {
      if (removed >= excess) break;
      this.tasks.delete(key);
      removed++;
    }
  }

  private scheduleDirtyFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushInProgress = this.flushNow().finally(() => {
        this.flushInProgress = null;
      });
    }, DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    const data: StoreFile = {
      version: 1,
      updated_at: new Date().toISOString(),
      tasks: Array.from(this.tasks.values()),
    };
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.filePath + ".tmp";
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, this.filePath);
    this.dirty = false;
  }
}
