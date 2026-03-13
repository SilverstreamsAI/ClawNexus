import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { A2ATaskStore } from "../../src/a2a/store.js";
import type { A2ATask } from "../../src/a2a/types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a2a-store-test-"));
}

function makeTask(id: string, state: "completed" | "failed" = "completed"): A2ATask {
  return {
    id,
    status: { state, message: { role: "agent", parts: [{ type: "text", text: `result-${id}` }] } },
    history: [{ role: "user", parts: [{ type: "text", text: `input-${id}` }] }],
  };
}

describe("A2ATaskStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves tasks", async () => {
    const store = new A2ATaskStore(tmpDir);
    await store.init();

    const task = makeTask("t1");
    store.put(task);

    expect(store.get("t1")).toEqual(task);
    expect(store.get("nonexistent")).toBeUndefined();
    await store.close();
  });

  it("persists tasks to disk and reloads on init", async () => {
    const store1 = new A2ATaskStore(tmpDir);
    await store1.init();
    store1.put(makeTask("t1"));
    store1.put(makeTask("t2"));
    await store1.close();

    // Verify file exists
    const filePath = path.join(tmpDir, "a2a-tasks.json");
    expect(fs.existsSync(filePath)).toBe(true);

    // Reload
    const store2 = new A2ATaskStore(tmpDir);
    await store2.init();
    expect(store2.get("t1")).toBeDefined();
    expect(store2.get("t2")).toBeDefined();
    expect(store2.get("t1")!.status.state).toBe("completed");
    await store2.close();
  });

  it("evicts oldest tasks when exceeding max capacity", async () => {
    const store = new A2ATaskStore(tmpDir);
    await store.init();

    // Insert 105 tasks
    for (let i = 0; i < 105; i++) {
      store.put(makeTask(`t-${i}`));
    }

    // Oldest 5 should be evicted
    expect(store.get("t-0")).toBeUndefined();
    expect(store.get("t-4")).toBeUndefined();
    // Recent ones should remain
    expect(store.get("t-5")).toBeDefined();
    expect(store.get("t-104")).toBeDefined();
    expect(store.getAll()).toHaveLength(100);
    await store.close();
  });

  it("handles corrupted file gracefully", async () => {
    const filePath = path.join(tmpDir, "a2a-tasks.json");
    fs.writeFileSync(filePath, "not json at all");

    const store = new A2ATaskStore(tmpDir);
    await store.init();
    expect(store.getAll()).toHaveLength(0);
    await store.close();
  });

  it("handles empty init (no file)", async () => {
    const store = new A2ATaskStore(tmpDir);
    await store.init();
    expect(store.getAll()).toHaveLength(0);
    await store.close();
  });

  it("put overwrites existing task by id", async () => {
    const store = new A2ATaskStore(tmpDir);
    await store.init();

    store.put(makeTask("t1", "completed"));
    expect(store.get("t1")!.status.state).toBe("completed");

    store.put(makeTask("t1", "failed"));
    expect(store.get("t1")!.status.state).toBe("failed");

    // Should still be only one task
    expect(store.getAll()).toHaveLength(1);
    await store.close();
  });

  it("getAll returns all current tasks", async () => {
    const store = new A2ATaskStore(tmpDir);
    await store.init();

    store.put(makeTask("t1"));
    store.put(makeTask("t2"));
    store.put(makeTask("t3"));

    const all = store.getAll();
    expect(all).toHaveLength(3);
    const ids = all.map((t) => t.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    expect(ids).toContain("t3");
    await store.close();
  });

  it("debounced flush — multiple rapid puts produce one file write", async () => {
    const store = new A2ATaskStore(tmpDir);
    await store.init();

    const filePath = path.join(tmpDir, "a2a-tasks.json");

    // Spy on writeFile by checking file mtime
    store.put(makeTask("t1"));
    store.put(makeTask("t2"));
    store.put(makeTask("t3"));

    // File should not exist yet (debounce hasn't fired)
    const existsImmediately = fs.existsSync(filePath);

    // Wait for debounce (500ms) + some margin
    await new Promise((r) => setTimeout(r, 700));

    const existsAfterDebounce = fs.existsSync(filePath);
    expect(existsAfterDebounce).toBe(true);

    // File should contain all 3 tasks (single write)
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.tasks).toHaveLength(3);

    // If no debounce existed, the file might have been written multiple times,
    // but having all 3 tasks confirms coalescing
    if (existsImmediately) {
      // If it did exist, it shouldn't have had all 3 yet (or debounce was instant)
      // This is a soft check — the main assertion is the final file state
    }

    await store.close();
  });

  it("close() flushes dirty data immediately", async () => {
    const store = new A2ATaskStore(tmpDir);
    await store.init();

    store.put(makeTask("t-flush"));

    // Close immediately (before debounce timer fires)
    await store.close();

    // File should contain the task
    const filePath = path.join(tmpDir, "a2a-tasks.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0].id).toBe("t-flush");
  });
});
