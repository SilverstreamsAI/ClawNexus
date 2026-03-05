import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LocalProbe } from "../../src/local/probe.js";
import { RegistryStore } from "../../src/registry/store.js";

describe("LocalProbe", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let probe: LocalProbe;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    probe = new LocalProbe(store, 18789);
  });

  afterEach(async () => {
    probe.stop();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers local instance when OpenClaw responds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "my-agent",
        assistantName: "My Assistant",
        displayName: "My Display",
      }),
    }));

    const result = await probe.probe();

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("my-agent");
    expect(result!.discovery_source).toBe("local");
    expect(result!.is_self).toBe(true);
    expect(result!.connectivity?.preferred_channel).toBe("local");
    expect(result!.address).toBe("127.0.0.1");
    expect(result!.lan_host).toBe(os.hostname());

    expect(probe.agentId).toBe("my-agent");

    const stored = store.getByNetworkKey("127.0.0.1", 18789);
    expect(stored).toBeDefined();
    expect(stored!.is_self).toBe(true);
    expect(stored!.auto_name).toBeTruthy();
  });

  it("returns null when OpenClaw is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const events: string[] = [];
    probe.on("local:unavailable", () => events.push("unavailable"));

    const result = await probe.probe();

    expect(result).toBeNull();
    expect(probe.agentId).toBeNull();
    expect(events).toContain("unavailable");
  });

  it("returns null on non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));

    const events: Array<{ reason: string }> = [];
    probe.on("local:unreachable", (info: { reason: string }) => events.push(info));

    const result = await probe.probe();

    expect(result).toBeNull();
    expect(events[0]?.reason).toBe("HTTP 404");
  });

  it("returns null when response has no assistantAgentId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantName: "No ID" }),
    }));

    const events: Array<{ reason: string }> = [];
    probe.on("local:unreachable", (info: { reason: string }) => events.push(info));

    const result = await probe.probe();

    expect(result).toBeNull();
    expect(events[0]?.reason).toBe("missing assistantAgentId");
  });

  it("emits local:discovered event on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "test-agent",
        assistantName: "Test",
      }),
    }));

    const discovered: unknown[] = [];
    probe.on("local:discovered", (inst: unknown) => discovered.push(inst));

    await probe.probe();

    expect(discovered).toHaveLength(1);
  });

  it("clears agentId when probe fails after previous success", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // First: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        assistantAgentId: "test-agent",
        assistantName: "Test",
      }),
    });
    await probe.probe();
    expect(probe.agentId).toBe("test-agent");

    // Second: failure
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await probe.probe();
    expect(probe.agentId).toBeNull();
  });

  it("start and stop manage the timer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await probe.start();
    // Should not throw
    probe.stop();
    // Double stop is safe
    probe.stop();
  });

  it("uses custom port", async () => {
    const customProbe = new LocalProbe(store, 19999);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "custom-port",
        assistantName: "Custom",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await customProbe.probe();

    expect(mockFetch.mock.calls[0][0]).toContain(":19999");
    const stored = store.getByNetworkKey("127.0.0.1", 19999);
    expect(stored?.gateway_port).toBe(19999);
    customProbe.stop();
  });
});
