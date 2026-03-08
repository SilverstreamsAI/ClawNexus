import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RegistryStore } from "../../src/registry/store.js";

// Mock os module before importing ActiveScanner
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, networkInterfaces: vi.fn(() => actual.networkInterfaces()) };
});

const { ActiveScanner } = await import("../../src/scanner/active.js");

describe("ActiveScanner adapter integration", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let scanner: InstanceType<typeof ActiveScanner>;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-adapter-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    scanner = new ActiveScanner(store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers NanoClaw instance via adapter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      // NanoClaw on port 3100
      if (url === "http://192.168.1.50:3100/health") {
        return {
          ok: true,
          json: async () => ({ framework: "nanoclaw", version: "0.1.0", name: "My NanoClaw" }),
        };
      }
      // No ClawLink identity
      if (url.includes("/.well-known/claw-identity.json")) {
        return { ok: false, status: 404 };
      }
      // No OpenClaw config
      if (url.includes("/__openclaw/control-ui-config.json")) {
        return { ok: false, status: 404 };
      }
      // Fingerprint /health should not match zeroclaw/picoclaw patterns
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ framework: "nanoclaw", version: "0.1.0", name: "My NanoClaw" }),
          text: async () => JSON.stringify({ framework: "nanoclaw", version: "0.1.0", name: "My NanoClaw" }),
        };
      }
      if (url.includes("/ready")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Connection refused");
    }));

    const discovered = await scanner.scan({ targets: ["192.168.1.50:3100"] });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].implementation).toBe("nanoclaw");
    expect(discovered[0].agent_id).toBe("nanoclaw@192.168.1.50");
    expect(discovered[0].display_name).toBe("My NanoClaw");
    expect(discovered[0].gateway_port).toBe(3100);
    expect(discovered[0].discovery_source).toBe("scan");
  });

  it("discovers NanoBot instance via adapter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url === "http://192.168.1.60:8000/health") {
        return {
          ok: true,
          json: async () => ({ app: "nanobot", version: "1.0.0", name: "Python Bot" }),
          text: async () => JSON.stringify({ app: "nanobot", version: "1.0.0", name: "Python Bot" }),
        };
      }
      if (url.includes("/.well-known/claw-identity.json")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/__openclaw/control-ui-config.json")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/ready")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Connection refused");
    }));

    const discovered = await scanner.scan({ targets: ["192.168.1.60:8000"] });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].implementation).toBe("nanobot");
    expect(discovered[0].agent_id).toBe("nanobot@192.168.1.60");
    expect(discovered[0].display_name).toBe("Python Bot");
    expect(discovered[0].gateway_port).toBe(8000);
  });

  it("ClawLink identity takes priority over adapter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      // ClawLink identity declares nanoclaw
      if (url.includes("/.well-known/claw-identity.json")) {
        return {
          ok: true,
          json: async () => ({ implementation: "nanoclaw", version: "0.2.0" }),
        };
      }
      // No OpenClaw config
      if (url.includes("/__openclaw/control-ui-config.json")) {
        return { ok: false, status: 404 };
      }
      // /health also returns nanoclaw info (but should not be needed)
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ framework: "nanoclaw" }),
          text: async () => JSON.stringify({ framework: "nanoclaw" }),
        };
      }
      if (url.includes("/ready")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Connection refused");
    }));

    const discovered = await scanner.scan({ targets: ["192.168.1.50:3100"] });
    expect(discovered).toHaveLength(1);
    // Should be identified by fingerprint (ClawLink), not adapter
    expect(discovered[0].implementation).toBe("nanoclaw");
    // Fingerprint path uses synthesized agent_id pattern
    expect(discovered[0].agent_id).toBe("nanoclaw@192.168.1.50");
  });

  it("existing OpenClaw discovery unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/__openclaw/control-ui-config.json")) {
        return {
          ok: true,
          json: async () => ({
            assistantAgentId: "main",
            assistantName: "My Assistant",
            displayName: "Test",
            controlUi: {},
            webSearchEnabled: true,
            tools: [],
            customInstructions: "",
            theme: "dark",
            language: "en",
          }),
        };
      }
      if (url.includes("/.well-known/claw-identity.json")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Not found");
    }));

    const discovered = await scanner.scan({ targets: ["192.168.1.10:18789"] });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].implementation).toBe("openclaw");
    expect(discovered[0].agent_id).toBe("main");
  });

  it("existing ZeroClaw discovery unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/.well-known/claw-identity.json")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/__openclaw/control-ui-config.json")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/health")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ status: "ok", paired: true, runtime: "tokio" }),
        };
      }
      throw new Error("Not found");
    }));

    const discovered = await scanner.scan({ targets: ["192.168.1.20:42617"] });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].implementation).toBe("zeroclaw");
    expect(discovered[0].agent_id).toBe("zeroclaw@192.168.1.20");
  });
});
