import { describe, it, expect, vi } from "vitest";
import { RemoteDiscovery } from "../../src/registry/discovery.js";
import type { RegistryClient, ResolveResult } from "../../src/registry/client.js";
import type { RegistryStore } from "../../src/registry/store.js";

function createMockClient(resolveResult?: ResolveResult): RegistryClient {
  return {
    resolve: resolveResult
      ? vi.fn().mockResolvedValue(resolveResult)
      : vi.fn().mockRejectedValue(new Error("not found")),
  } as unknown as RegistryClient;
}

function createMockStore(): RegistryStore & { upsert: ReturnType<typeof vi.fn> } {
  return {
    upsert: vi.fn(),
  } as unknown as RegistryStore & { upsert: ReturnType<typeof vi.fn> };
}

describe("RemoteDiscovery", () => {
  const mockResolveResult: ResolveResult = {
    record: {
      id: 1,
      name: "test.id.claw",
      clawId: "test-agent",
      ownerPubkey: "ed25519:aabbcc",
      tier: "free",
      capabilities: [],
      relayHint: "relay.example.com",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  };

  it("resolve() success — creates ClawInstance with correct fields and calls store.upsert", async () => {
    const client = createMockClient(mockResolveResult);
    const store = createMockStore();
    const discovery = new RemoteDiscovery(client, store);

    const result = await discovery.resolve("test.id.claw");
    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("test-agent");
    expect(result!.auto_name).toBe("test-agent");
    expect(result!.claw_name).toBe("test.id.claw");
    expect(result!.owner_pubkey).toBe("ed25519:aabbcc");
    expect(result!.discovery_source).toBe("registry");
    expect(result!.network_scope).toBe("public");
    expect(result!.connectivity?.preferred_channel).toBe("relay");
    expect(result!.connectivity?.relay_available).toBe(true);
    expect(result!.connectivity?.lan_reachable).toBe(false);
    expect(store.upsert).toHaveBeenCalledWith(result);
  });

  it("resolve() when client throws — returns null", async () => {
    const client = createMockClient(); // rejects
    const store = createMockStore();
    const discovery = new RemoteDiscovery(client, store);

    const result = await discovery.resolve("nonexistent.claw");
    expect(result).toBeNull();
    expect(store.upsert).not.toHaveBeenCalled();
  });
});
