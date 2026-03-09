import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

const FAKE_HOME = "/home/testuser";

// Mock node:os before importing adapter
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => FAKE_HOME) };
});

// Mock node:fs before importing adapter
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: vi.fn(async () => { throw new Error("ENOENT"); }),
      readlink: vi.fn(async () => { throw new Error("ENOENT"); }),
      readFile: vi.fn(async () => { throw new Error("ENOENT"); }),
      stat: vi.fn(async () => { throw new Error("ENOENT"); }),
      access: vi.fn(async () => { throw new Error("ENOENT"); }),
    },
  };
});

const fs = await import("node:fs");
const { NanoClawAdapter } = await import("../../src/adapter/nanoclaw.js");

const FAKE_NANO_DIR = path.join(FAKE_HOME, "nanoclaw");

describe("NanoClawAdapter", () => {
  let adapter: InstanceType<typeof NanoClawAdapter>;

  beforeEach(() => {
    adapter = new NanoClawAdapter();
    vi.mocked(fs.promises.readdir).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.promises.readlink).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fs.promises.access).mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct name and empty default ports", () => {
    expect(adapter.name).toBe("nanoclaw");
    expect(adapter.defaultPorts).toEqual([]);
  });

  it("probe always returns null (no HTTP server)", async () => {
    const result = await adapter.probe("192.168.1.50", 3100);
    expect(result).toBeNull();
  });

  it("healthCheck always returns false (no HTTP server)", async () => {
    const result = await adapter.healthCheck("192.168.1.50", 3100);
    expect(result).toBe(false);
  });

  it("toClawInstance maps correctly with gateway_port 0", () => {
    const probe = { name: "nanoclaw", version: "0.1.0", display_name: "My Agent" };
    const partial = adapter.toClawInstance("192.168.1.50", 3100, probe);

    expect(partial.agent_id).toBe("nanoclaw@192.168.1.50");
    expect(partial.display_name).toBe("My Agent");
    expect(partial.assistant_name).toBe("My Agent");
    expect(partial.gateway_port).toBe(0);
    expect(partial.implementation).toBe("nanoclaw");
    expect(partial.address).toBe("192.168.1.50");
    expect(partial.discovery_source).toBe("local");
  });

  it("toClawInstance uses fallback display_name when not provided", () => {
    const probe = { name: "nanoclaw" };
    const partial = adapter.toClawInstance("10.0.0.1", 3101, probe);

    expect(partial.display_name).toBe("nanoclaw");
    expect(partial.assistant_name).toBe("");
    expect(partial.gateway_port).toBe(0);
  });

  it("toClawInstance includes project_dir in labels", () => {
    const probe = {
      name: "nanoclaw",
      metadata: { project_dir: "/home/user/nanoclaw" },
    };
    const partial = adapter.toClawInstance("127.0.0.1", 0, probe);
    expect(partial.labels).toEqual({ project_dir: "/home/user/nanoclaw" });
  });

  describe("probeLocal", () => {
    it("returns null when no nanoclaw directory found", async () => {
      const result = await adapter.probeLocal();
      expect(result).toBeNull();
    });

    it("discovers nanoclaw from candidate directory", async () => {
      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "package.json")) {
          return JSON.stringify({ name: "nanoclaw", version: "0.2.1" });
        }
        throw new Error("ENOENT");
      });

      const result = await adapter.probeLocal();
      expect(result).not.toBeNull();
      expect(result!.name).toBe("nanoclaw");
      expect(result!.version).toBe("0.2.1");
      expect(result!.metadata).toHaveProperty("project_dir", FAKE_NANO_DIR);
      expect(result!.metadata).toHaveProperty("is_running", false);
      expect(result!.metadata).toHaveProperty("active_tasks", 0);
    });

    it("reads ASSISTANT_NAME from .env", async () => {
      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "package.json")) {
          return JSON.stringify({ name: "nanoclaw", version: "0.1.0" });
        }
        if (p === path.join(FAKE_NANO_DIR, ".env")) {
          return 'PORT=3000\nASSISTANT_NAME="HomeBot"\nDEBUG=true';
        }
        throw new Error("ENOENT");
      });

      const result = await adapter.probeLocal();
      expect(result).not.toBeNull();
      expect(result!.display_name).toBe("HomeBot");
    });

    it("counts IPC task files", async () => {
      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "package.json")) {
          return JSON.stringify({ name: "nanoclaw", version: "0.1.0" });
        }
        throw new Error("ENOENT");
      });

      vi.mocked(fs.promises.readdir).mockImplementation(async (dirPath) => {
        const d = dirPath.toString();
        if (d === path.join(FAKE_NANO_DIR, "data", "ipc")) {
          return ["channel-1", "channel-2"] as unknown as fs.Dirent[];
        }
        if (d === path.join(FAKE_NANO_DIR, "data", "ipc", "channel-1", "messages")) {
          return ["msg1.json", "msg2.json"] as unknown as fs.Dirent[];
        }
        if (d === path.join(FAKE_NANO_DIR, "data", "ipc", "channel-2", "messages")) {
          return ["msg3.json", "readme.txt"] as unknown as fs.Dirent[];
        }
        throw new Error("ENOENT");
      });

      const result = await adapter.probeLocal();
      expect(result).not.toBeNull();
      expect(result!.metadata).toHaveProperty("active_tasks", 3);
    });

    it("detects messages.db existence", async () => {
      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "package.json")) {
          return JSON.stringify({ name: "nanoclaw", version: "0.1.0" });
        }
        throw new Error("ENOENT");
      });
      vi.mocked(fs.promises.access).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "store", "messages.db")) {
          return undefined;
        }
        throw new Error("ENOENT");
      });

      const result = await adapter.probeLocal();
      expect(result).not.toBeNull();
      expect(result!.metadata).toHaveProperty("has_message_db", true);
    });

    it("skips directories with wrong package name", async () => {
      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "package.json")) {
          return JSON.stringify({ name: "some-other-project", version: "1.0.0" });
        }
        throw new Error("ENOENT");
      });

      const result = await adapter.probeLocal();
      expect(result).toBeNull();
    });
  });

  describe("healthCheckLocal", () => {
    it("returns false when no project dir cached", async () => {
      const result = await adapter.healthCheckLocal();
      expect(result).toBe(false);
    });

    it("returns true when messages.db was recently modified", async () => {
      // First, run probeLocal to cache the project dir
      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "package.json")) {
          return JSON.stringify({ name: "nanoclaw", version: "0.1.0" });
        }
        throw new Error("ENOENT");
      });

      await adapter.probeLocal();

      // Now test healthCheckLocal with recent mtime
      vi.mocked(fs.promises.stat).mockResolvedValue({
        mtimeMs: Date.now() - 60_000, // 1 minute ago
      } as fs.Stats);

      const result = await adapter.healthCheckLocal();
      expect(result).toBe(true);
    });

    it("returns false when messages.db is stale", async () => {
      vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
        const p = filePath.toString();
        if (p === path.join(FAKE_NANO_DIR, "package.json")) {
          return JSON.stringify({ name: "nanoclaw", version: "0.1.0" });
        }
        throw new Error("ENOENT");
      });

      await adapter.probeLocal();

      vi.mocked(fs.promises.stat).mockResolvedValue({
        mtimeMs: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      } as fs.Stats);

      const result = await adapter.healthCheckLocal();
      expect(result).toBe(false);
    });
  });
});
