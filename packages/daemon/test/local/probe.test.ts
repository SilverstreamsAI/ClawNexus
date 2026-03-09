import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Mock adapter module — control which adapters are available
// ---------------------------------------------------------------------------
const mockAdapters: import("../../src/adapter/types.js").FrameworkAdapter[] = [];

vi.mock("../../src/adapter/index.js", () => ({
  get ADAPTERS() { return mockAdapters; },
}));

import { LocalProbe } from "../../src/local/probe.js";
import { RegistryStore } from "../../src/registry/store.js";
import type { FrameworkAdapter, ProbeResult } from "../../src/adapter/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeFakeAdapter(overrides: Partial<FrameworkAdapter> & { name: string }): FrameworkAdapter {
  return {
    defaultPorts: [],
    probe: vi.fn().mockResolvedValue(null),
    toClawInstance: vi.fn().mockReturnValue({}),
    healthCheck: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe("LocalProbe", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let probe: LocalProbe;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    probe = new LocalProbe(store, 18789);
    // Reset adapters to empty (OpenClaw is handled by probeOpenClaw directly)
    mockAdapters.length = 0;
  });

  afterEach(async () => {
    probe.stop();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------
  // probeOpenClaw success path
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // probeOpenClaw failure paths
  // -------------------------------------------------------------------
  it("returns null when OpenClaw is not running (ECONNREFUSED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const events: string[] = [];
    probe.on("local:unavailable", () => events.push("unavailable"));

    const result = await probe.probe();

    expect(result).toBeNull();
    expect(probe.agentId).toBeNull();
    expect(events).toContain("unavailable");
  });

  it("returns null on non-ok HTTP response without emitting unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));

    const events: Array<{ reason: string }> = [];
    probe.on("local:unreachable", (info: { reason: string }) => events.push(info));

    const result = await probe.probe();

    expect(result).toBeNull();
    // Bug 2 fix: no unreachable event — another adapter may occupy the port
    expect(events).toHaveLength(0);
  });

  it("returns null when response has no assistantAgentId without emitting unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantName: "No ID" }),
    }));

    const events: Array<{ reason: string }> = [];
    probe.on("local:unreachable", (info: { reason: string }) => events.push(info));

    const result = await probe.probe();

    expect(result).toBeNull();
    // Bug 2 fix: no unreachable event — another adapter may match this endpoint
    expect(events).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Adapter probeLocal success path
  // -------------------------------------------------------------------
  it("discovers adapter via probeLocal when OpenClaw is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const probeResult: ProbeResult = { name: "nanoclaw", version: "1.0" };
    const adapter = makeFakeAdapter({
      name: "nanoclaw",
      probeLocal: vi.fn().mockResolvedValue(probeResult),
      toClawInstance: vi.fn().mockReturnValue({
        agent_id: "nanoclaw@local",
        display_name: "NanoClaw Local",
        gateway_port: 0,
        implementation: "nanoclaw",
      }),
    });
    mockAdapters.push(
      makeFakeAdapter({ name: "openclaw" }), // skipped (already tried)
      adapter,
    );

    const discovered: unknown[] = [];
    probe.on("local:discovered", (inst: unknown) => discovered.push(inst));

    const result = await probe.probe();

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("nanoclaw@local");
    expect(result!.implementation).toBe("nanoclaw");
    expect(result!.is_self).toBe(true);
    expect(result!.connectivity?.lan_reachable).toBe(false); // probeLocal path
    expect(discovered).toHaveLength(1);
  });

  it("uses adapter.name as fallback display_name in probeLocal path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const adapter = makeFakeAdapter({
      name: "nanoclaw",
      probeLocal: vi.fn().mockResolvedValue({ name: "nanoclaw" }),
      toClawInstance: vi.fn().mockReturnValue({
        // No display_name, no agent_id — test fallback defaults
        implementation: "nanoclaw",
      }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    const result = await probe.probe();

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("nanoclaw@localhost"); // fallback
    expect(result!.display_name).toBe("nanoclaw"); // fallback to adapter.name
  });

  // -------------------------------------------------------------------
  // Adapter HTTP probe success path
  // -------------------------------------------------------------------
  it("discovers adapter via HTTP probe on default port when OpenClaw and probeLocal fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const probeResult: ProbeResult = { name: "nanobot", version: "2.0" };
    const adapter = makeFakeAdapter({
      name: "nanobot",
      defaultPorts: [18790],
      probe: vi.fn().mockResolvedValue(probeResult),
      toClawInstance: vi.fn().mockReturnValue({
        agent_id: "nanobot@local",
        display_name: "NanoBot Instance",
        implementation: "nanobot",
      }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    const discovered: unknown[] = [];
    probe.on("local:discovered", (inst: unknown) => discovered.push(inst));

    const result = await probe.probe();

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("nanobot@local");
    expect(result!.gateway_port).toBe(18790);
    expect(result!.implementation).toBe("nanobot");
    expect(result!.is_self).toBe(true);
    expect(result!.connectivity?.lan_reachable).toBe(true); // HTTP probe path
    expect(discovered).toHaveLength(1);
    expect(adapter.probe).toHaveBeenCalledWith("127.0.0.1", 18790);
  });

  it("uses fallbacks for agent_id and display_name in adapter HTTP probe path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const adapter = makeFakeAdapter({
      name: "openfang",
      defaultPorts: [4200],
      probe: vi.fn().mockResolvedValue({ name: "openfang" }),
      toClawInstance: vi.fn().mockReturnValue({
        // No agent_id, no display_name — test defaults
        implementation: "openfang",
      }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    const result = await probe.probe();

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("openfang@localhost");
    expect(result!.display_name).toBe("openfang");
    expect(result!.gateway_port).toBe(4200);
  });

  it("skips adapter HTTP probe when probeLocal already succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const httpProbe = vi.fn().mockResolvedValue({ name: "nanoclaw" });
    const adapter = makeFakeAdapter({
      name: "nanoclaw",
      defaultPorts: [9999],
      probeLocal: vi.fn().mockResolvedValue({ name: "nanoclaw" }),
      probe: httpProbe,
      toClawInstance: vi.fn().mockReturnValue({
        implementation: "nanoclaw",
        gateway_port: 0,
      }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    await probe.probe();

    // HTTP probe should not have been called since probeLocal succeeded
    expect(httpProbe).not.toHaveBeenCalled();
  });

  it("stops iterating adapters after first successful match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const firstAdapter = makeFakeAdapter({
      name: "nanobot",
      defaultPorts: [18790],
      probe: vi.fn().mockResolvedValue({ name: "nanobot" }),
      toClawInstance: vi.fn().mockReturnValue({ implementation: "nanobot" }),
    });
    const secondAdapter = makeFakeAdapter({
      name: "openfang",
      defaultPorts: [4200],
      probe: vi.fn().mockResolvedValue({ name: "openfang" }),
      toClawInstance: vi.fn().mockReturnValue({ implementation: "openfang" }),
    });
    mockAdapters.push(
      makeFakeAdapter({ name: "openclaw" }),
      firstAdapter,
      secondAdapter,
    );

    await probe.probe();

    expect(firstAdapter.probe).toHaveBeenCalled();
    expect(secondAdapter.probe).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Bug 1: stale self instances marked offline
  // -------------------------------------------------------------------
  it("marks previously-discovered adapter self instance offline when it stops responding", async () => {
    // Simulate a NanoBot adapter instance previously discovered on port 18790
    store.upsert({
      agent_id: "nanobot@localhost",
      auto_name: "",
      assistant_name: "",
      display_name: "NanoBot",
      lan_host: os.hostname(),
      address: "127.0.0.1",
      gateway_port: 18790,
      tls: false,
      discovery_source: "local",
      network_scope: "local",
      status: "online",
      last_seen: new Date().toISOString(),
      discovered_at: new Date().toISOString(),
      is_self: true,
      connectivity: {
        lan_reachable: true,
        relay_available: false,
        preferred_channel: "local",
        last_lan_check: new Date().toISOString(),
      },
    });

    // Everything is offline now
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await probe.probe();

    const nanobot = store.getByNetworkKey("127.0.0.1", 18790);
    expect(nanobot).toBeDefined();
    expect(nanobot!.status).toBe("offline");
  });

  it("marks stale adapter self instance offline even when OpenClaw is found", async () => {
    // Pre-register a NanoBot self instance on port 18790
    store.upsert({
      agent_id: "nanobot@localhost",
      auto_name: "",
      assistant_name: "",
      display_name: "NanoBot",
      lan_host: os.hostname(),
      address: "127.0.0.1",
      gateway_port: 18790,
      tls: false,
      discovery_source: "local",
      network_scope: "local",
      status: "online",
      last_seen: new Date().toISOString(),
      discovered_at: new Date().toISOString(),
      is_self: true,
      connectivity: {
        lan_reachable: true,
        relay_available: false,
        preferred_channel: "local",
        last_lan_check: new Date().toISOString(),
      },
    });

    // OpenClaw responds on primary port — probe returns early
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "openclaw-agent",
        assistantName: "OpenClaw",
      }),
    }));

    await probe.probe();

    // NanoBot on 18790 should be marked offline (not rediscovered this cycle)
    const nanobot = store.getByNetworkKey("127.0.0.1", 18790);
    expect(nanobot).toBeDefined();
    expect(nanobot!.status).toBe("offline");
  });

  it("marks stale self instance offline when adapter finds a different instance", async () => {
    // Pre-register an old self instance on port 18790
    store.upsert({
      agent_id: "old@localhost",
      auto_name: "",
      assistant_name: "",
      display_name: "Old Instance",
      lan_host: os.hostname(),
      address: "127.0.0.1",
      gateway_port: 18790,
      tls: false,
      discovery_source: "local",
      network_scope: "local",
      status: "online",
      last_seen: new Date().toISOString(),
      discovered_at: new Date().toISOString(),
      is_self: true,
      connectivity: {
        lan_reachable: true,
        relay_available: false,
        preferred_channel: "local",
        last_lan_check: new Date().toISOString(),
      },
    });

    // OpenClaw down
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    // Adapter discovers something on port 4200
    const adapter = makeFakeAdapter({
      name: "openfang",
      defaultPorts: [4200],
      probe: vi.fn().mockResolvedValue({ name: "openfang" }),
      toClawInstance: vi.fn().mockReturnValue({ implementation: "openfang" }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    await probe.probe();

    // New instance discovered
    const openfang = store.getByNetworkKey("127.0.0.1", 4200);
    expect(openfang).toBeDefined();
    expect(openfang!.status).toBe("online");

    // Old instance marked offline
    const old = store.getByNetworkKey("127.0.0.1", 18790);
    expect(old).toBeDefined();
    expect(old!.status).toBe("offline");
  });

  it("does not mark already-offline self instances again", async () => {
    // Pre-register an already-offline self instance
    store.upsert({
      agent_id: "dead@localhost",
      auto_name: "",
      assistant_name: "",
      display_name: "Dead",
      lan_host: os.hostname(),
      address: "127.0.0.1",
      gateway_port: 9999,
      tls: false,
      discovery_source: "local",
      network_scope: "local",
      status: "offline",
      last_seen: new Date().toISOString(),
      discovered_at: new Date().toISOString(),
      is_self: true,
      connectivity: {
        lan_reachable: false,
        relay_available: false,
        preferred_channel: "local",
        last_lan_check: new Date().toISOString(),
      },
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const upsertSpy = vi.spyOn(store, "upsert");

    await probe.probe();

    // _markOffline should not upsert for already-offline instance
    const upsertCalls = upsertSpy.mock.calls.filter(
      (call) => call[0].gateway_port === 9999,
    );
    expect(upsertCalls).toHaveLength(0);
  });

  it("_markOfflineStaleSelf is a no-op when no stale keys", async () => {
    // Nothing pre-registered, OpenClaw responds
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "test-agent",
        assistantName: "Test",
      }),
    }));

    const upsertSpy = vi.spyOn(store, "upsert");
    await probe.probe();

    // Only the discovered instance should be upserted, no offline marks
    expect(upsertSpy).toHaveBeenCalledOnce();
    expect(upsertSpy.mock.calls[0]![0].status).toBe("online");
  });

  // -------------------------------------------------------------------
  // Bug 2: HTTP error does not emit unreachable before adapter loop
  // -------------------------------------------------------------------
  it("HTTP error on probeOpenClaw does not emit unreachable before adapter loop", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // probeOpenClaw returns HTTP 500
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    // All adapter probes fail
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const unreachableEvents: unknown[] = [];
    const discoveredEvents: unknown[] = [];
    probe.on("local:unreachable", (info: unknown) => unreachableEvents.push(info));
    probe.on("local:discovered", (inst: unknown) => discoveredEvents.push(inst));

    await probe.probe();

    expect(unreachableEvents).toHaveLength(0);
    expect(discoveredEvents).toHaveLength(0);
  });

  it("adapter succeeds after probeOpenClaw HTTP error — no contradictory events", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // probeOpenClaw gets 404 (something on port but not OpenClaw)
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    // Adapter will be tried
    const adapter = makeFakeAdapter({
      name: "nanobot",
      defaultPorts: [18789], // same port as OpenClaw!
      probe: vi.fn().mockResolvedValue({ name: "nanobot" }),
      toClawInstance: vi.fn().mockReturnValue({
        agent_id: "nanobot-on-18789",
        implementation: "nanobot",
      }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    const unreachableEvents: unknown[] = [];
    const discoveredEvents: unknown[] = [];
    probe.on("local:unreachable", (info: unknown) => unreachableEvents.push(info));
    probe.on("local:discovered", (inst: unknown) => discoveredEvents.push(inst));

    const result = await probe.probe();

    // Should discover via adapter, no unreachable emitted
    expect(unreachableEvents).toHaveLength(0);
    expect(discoveredEvents).toHaveLength(1);
    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("nanobot-on-18789");
  });

  // -------------------------------------------------------------------
  // Adapter probeLocal fails, falls through to HTTP probe
  // -------------------------------------------------------------------
  it("falls through to HTTP probe when probeLocal returns null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const adapter = makeFakeAdapter({
      name: "nanoclaw",
      defaultPorts: [9999],
      probeLocal: vi.fn().mockResolvedValue(null), // probeLocal fails
      probe: vi.fn().mockResolvedValue({ name: "nanoclaw" }), // HTTP probe succeeds
      toClawInstance: vi.fn().mockReturnValue({
        agent_id: "nanoclaw-http",
        implementation: "nanoclaw",
      }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    const result = await probe.probe();

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("nanoclaw-http");
    expect(result!.gateway_port).toBe(9999);
    expect(adapter.probeLocal).toHaveBeenCalled();
    expect(adapter.probe).toHaveBeenCalledWith("127.0.0.1", 9999);
  });

  it("adapter HTTP probe first port fails, second port succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const probeFn = vi.fn()
      .mockResolvedValueOnce(null) // port 8000 fails
      .mockResolvedValueOnce({ name: "nanobot" }); // port 8080 succeeds

    const adapter = makeFakeAdapter({
      name: "nanobot",
      defaultPorts: [8000, 8080],
      probe: probeFn,
      toClawInstance: vi.fn().mockReturnValue({ implementation: "nanobot" }),
    });
    mockAdapters.push(makeFakeAdapter({ name: "openclaw" }), adapter);

    const result = await probe.probe();

    expect(result).not.toBeNull();
    expect(result!.gateway_port).toBe(8080);
    expect(probeFn).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------
  // probeOpenClaw field fallbacks
  // -------------------------------------------------------------------
  it("uses assistantName as display_name fallback when displayName is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "agent-1",
        assistantName: "FallbackName",
        // no displayName
      }),
    }));

    const result = await probe.probe();
    expect(result!.display_name).toBe("FallbackName");
    expect(result!.assistant_name).toBe("FallbackName");
  });

  it("uses empty string when both assistantName and displayName are missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "agent-2",
        // no assistantName, no displayName
      }),
    }));

    const result = await probe.probe();
    expect(result!.display_name).toBe("");
    expect(result!.assistant_name).toBe("");
  });

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
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

    expect(mockFetch.mock.calls[0]![0]).toContain(":19999");
    const stored = store.getByNetworkKey("127.0.0.1", 19999);
    expect(stored?.gateway_port).toBe(19999);
    customProbe.stop();
  });
});
