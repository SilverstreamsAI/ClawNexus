import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HealthChecker } from "../../src/health/checker.js";
import { RegistryStore } from "../../src/registry/store.js";
import { makeInstance } from "../fixtures.js";

describe("HealthChecker", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let checker: HealthChecker;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    checker = new HealthChecker(store);
  });

  afterEach(async () => {
    checker.stop();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("marks instance online when fetch succeeds", async () => {
    const inst = makeInstance({ agent_id: "a1", status: "offline", address: "10.0.0.1" });
    store.upsert(inst);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "a1",
        assistantName: "Updated Name",
        displayName: "Updated Display",
      }),
    }));

    await checker.checkAll();

    const updated = store.getByNetworkKey("10.0.0.1", 18789)!;
    expect(updated.status).toBe("online");
    expect(updated.assistant_name).toBe("Updated Name");
    expect(updated.display_name).toBe("Updated Display");
  });

  it("populates connectivity field on check", async () => {
    const inst = makeInstance({ agent_id: "a1", address: "10.0.0.1" });
    store.upsert(inst);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantAgentId: "a1", assistantName: "N" }),
    }));

    await checker.checkAll();

    const updated = store.getByNetworkKey("10.0.0.1", 18789)!;
    expect(updated.connectivity).toBeDefined();
    expect(updated.connectivity!.lan_reachable).toBe(true);
    expect(updated.connectivity!.preferred_channel).toBe("lan");
    expect(updated.connectivity!.lan_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("marks instance offline when fetch fails", async () => {
    const inst = makeInstance({ agent_id: "a1", status: "online", address: "10.0.0.1" });
    store.upsert(inst);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    await checker.checkAll();

    const updated = store.getByNetworkKey("10.0.0.1", 18789)!;
    expect(updated.status).toBe("offline");
    expect(updated.connectivity!.lan_reachable).toBe(false);
    expect(updated.connectivity!.unreachable_reason).toBe("timeout");
  });

  it("marks instance offline on non-ok response", async () => {
    const inst = makeInstance({ agent_id: "a1", status: "online", address: "10.0.0.1" });
    store.upsert(inst);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await checker.checkAll();

    const updated = store.getByNetworkKey("10.0.0.1", 18789)!;
    expect(updated.status).toBe("offline");
    expect(updated.connectivity!.unreachable_reason).toBe("HTTP 500");
  });

  it("keeps instance online when relay is available but LAN fails", async () => {
    const inst = makeInstance({ agent_id: "a1", status: "online", address: "10.0.0.1" });
    store.upsert(inst);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    checker.setRelayChecker(() => true);

    await checker.checkAll();

    const updated = store.getByNetworkKey("10.0.0.1", 18789)!;
    expect(updated.status).toBe("online");
    expect(updated.connectivity!.lan_reachable).toBe(false);
    expect(updated.connectivity!.relay_available).toBe(true);
    expect(updated.connectivity!.preferred_channel).toBe("relay");
  });

  it("updates last_seen on successful check", async () => {
    const inst = makeInstance({ agent_id: "a1", last_seen: "2020-01-01T00:00:00.000Z", address: "10.0.0.1" });
    store.upsert(inst);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantAgentId: "a1", assistantName: "Name" }),
    }));

    await checker.checkAll();

    const updated = store.getByNetworkKey("10.0.0.1", 18789)!;
    expect(new Date(updated.last_seen).getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());
  });

  it("emits online/offline events", async () => {
    const inst = makeInstance({ agent_id: "a1", address: "10.0.0.1" });
    store.upsert(inst);

    const events: string[] = [];
    checker.on("online", () => events.push("online"));
    checker.on("offline", () => events.push("offline"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantAgentId: "a1", assistantName: "N" }),
    }));

    await checker.checkAll();
    expect(events).toContain("online");
  });

  it("emits unreachable event when LAN check fails", async () => {
    const inst = makeInstance({ agent_id: "a1", address: "10.0.0.1" });
    store.upsert(inst);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

    const unreachable: unknown[] = [];
    checker.on("unreachable", (info: unknown) => unreachable.push(info));

    await checker.checkAll();

    expect(unreachable).toHaveLength(1);
  });

  it("skips is_self instances", async () => {
    const inst = makeInstance({ agent_id: "a1", address: "127.0.0.1" });
    inst.is_self = true;
    store.upsert(inst);

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await checker.checkAll();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses correct protocol for TLS instances", async () => {
    const inst = makeInstance({ agent_id: "a1", tls: true, address: "10.0.0.1" });
    store.upsert(inst);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantAgentId: "a1", assistantName: "N" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await checker.checkAll();

    expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\//);
  });

  it("handles empty store gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await checker.checkAll();
    // Should not throw
  });

  it("start and stop control the timer", () => {
    checker.start();
    // Should not throw
    checker.stop();
    // Double stop should be safe
    checker.stop();
  });
});
