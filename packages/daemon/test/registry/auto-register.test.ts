import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AutoRegister } from "../../src/registry/auto-register.js";
import { RegistryClient } from "../../src/registry/client.js";
import { RegistryStore } from "../../src/registry/store.js";
import { loadOrCreateKeys } from "../../src/crypto/keys.js";
import type { IdentityKeys } from "../../src/crypto/keys.js";
import { makeInstance } from "../fixtures.js";

describe("AutoRegister", () => {
  let tmpDir: string;
  let keysDir: string;
  let keys: IdentityKeys;
  let store: RegistryStore;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-autoreg-test-"));
    keysDir = path.join(tmpDir, "keys");
    keys = await loadOrCreateKeys(keysDir);
    store = new RegistryStore(tmpDir);
    await store.init();

    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  function makeLocalProbe(agentId: string | null) {
    return { agentId, on: () => {}, off: () => {} } as { agentId: string | null; on: (...args: unknown[]) => void; off: (...args: unknown[]) => void };
  }

  it("skips registration when no local instance", async () => {
    const client = new RegistryClient(keys, "http://mock:3000");
    const probe = makeLocalProbe(null);
    const ar = new AutoRegister(client, store, probe as never, keys);

    const skipHandler = vi.fn();
    ar.on("skip", skipHandler);

    await ar.tryRegister();

    expect(skipHandler).toHaveBeenCalledWith("No local OpenClaw instance detected");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ar.clawName).toBeNull();
  });

  it("registers successfully and writes claw_name to store", async () => {
    const record = {
      id: 1,
      name: "test-agent.id.claw",
      clawId: "test-agent",
      ownerPubkey: `ed25519:${keys.publicKeyHex}`,
      tier: "free",
      capabilities: [],
      relayHint: null,
      visibility: "public",
      registeredAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ action: "registered", record }),
    });

    // Add a self instance to the store
    const selfInstance = makeInstance({
      agent_id: "test-agent",
      address: "127.0.0.1",
      gateway_port: 18789,
      is_self: true,
    });
    store.upsert(selfInstance);

    const client = new RegistryClient(keys, "http://mock:3000");
    const probe = makeLocalProbe("test-agent");
    const ar = new AutoRegister(client, store, probe as never, keys);

    const registeredHandler = vi.fn();
    ar.on("registered", registeredHandler);

    await ar.tryRegister();

    expect(ar.clawName).toBe("test-agent.id.claw");
    expect(registeredHandler).toHaveBeenCalledWith({
      action: "registered",
      claw_name: "test-agent.id.claw",
    });

    // Check store was updated
    const updated = store.getByNetworkKey("127.0.0.1", 18789);
    expect(updated?.claw_name).toBe("test-agent.id.claw");
  });

  it("emits error on registration failure without throwing", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));

    const client = new RegistryClient(keys, "http://mock:3000");
    const probe = makeLocalProbe("test-agent");
    const ar = new AutoRegister(client, store, probe as never, keys);

    const errorHandler = vi.fn();
    ar.on("error", errorHandler);

    // Should not throw
    await ar.tryRegister();

    expect(errorHandler).toHaveBeenCalled();
  });

  it("start and stop manage timers", async () => {
    const client = new RegistryClient(keys, "http://mock:3000");
    const probe = makeLocalProbe(null);
    const ar = new AutoRegister(client, store, probe as never, keys);

    ar.start();
    // Should not throw
    ar.stop();
    ar.stop(); // Double stop should be safe
  });
});
