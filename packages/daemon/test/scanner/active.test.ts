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

// Import after mock
const { ActiveScanner } = await import("../../src/scanner/active.js");

describe("ActiveScanner", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let scanner: InstanceType<typeof ActiveScanner>;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    scanner = new ActiveScanner(store);
  });

  afterEach(async () => {
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects subnets from network interfaces", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      eth0: [
        {
          address: "192.168.1.42",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.42/24",
        },
      ],
    });

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("192.168.1.1:")) {
        return {
          ok: true,
          json: async () => ({
            assistantAgentId: "found-agent",
            assistantName: "Found",
            displayName: "Found Display",
          }),
        };
      }
      throw new Error("Connection refused");
    }));

    const discovered = await scanner.scan();
    expect(discovered.length).toBeGreaterThanOrEqual(1);
    expect(discovered[0].agent_id).toBe("found-agent");
    expect(discovered[0].discovery_source).toBe("scan");
    // Verify stored by networkKey (not agent_id)
    expect(store.getByNetworkKey("192.168.1.1", 18789)).toBeDefined();
  });

  it("handles fetch timeouts gracefully", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      eth0: [
        {
          address: "10.0.0.1",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "10.0.0.1/24",
        },
      ],
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const discovered = await scanner.scan();
    expect(discovered).toHaveLength(0);
  });

  it("skips hosts that return non-ok responses", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      eth0: [
        {
          address: "10.0.0.1",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "10.0.0.1/24",
        },
      ],
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const discovered = await scanner.scan();
    expect(discovered).toHaveLength(0);
  });

  it("skips hosts without assistantAgentId", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      eth0: [
        {
          address: "10.0.0.1",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "10.0.0.1/24",
        },
      ],
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantName: "NoId" }),
    }));

    const discovered = await scanner.scan();
    expect(discovered).toHaveLength(0);
  });

  it("isScanning starts as false", () => {
    expect(scanner.isScanning).toBe(false);
  });

  it("emits start and complete events", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));

    const events: string[] = [];
    scanner.on("start", () => events.push("start"));
    scanner.on("complete", () => events.push("complete"));

    await scanner.scan();
    expect(events).toEqual(["start", "complete"]);
  });

  it("resolves lan_host from existing registry entry for multi-NIC dedup", async () => {
    // Simulate: mDNS already discovered an instance with a real hostname
    store.upsert({
      agent_id: "main",
      auto_name: "desktop-allpakd",
      assistant_name: "Assistant",
      display_name: "DESKTOP-ALLPAKD",
      lan_host: "openclaw.local",
      address: "192.168.1.118",
      gateway_port: 18789,
      tls: false,
      discovery_source: "mdns",
      network_scope: "local",
      status: "online",
      last_seen: new Date().toISOString(),
      discovered_at: new Date().toISOString(),
    });

    // Now scan the same machine via a different IP (WireGuard)
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("10.66.66.3:18789")) {
        return {
          ok: true,
          json: async () => ({
            assistantAgentId: "main",
            assistantName: "Assistant",
            displayName: "DESKTOP-ALLPAKD",
          }),
        };
      }
      throw new Error("Connection refused");
    }));

    const discovered = await scanner.scan({ targets: ["10.66.66.3:18789"] });
    expect(discovered).toHaveLength(1);

    // Should have merged — only 1 instance in store (not 2)
    const all = store.getAll();
    const mainInstances = all.filter((i) => i.agent_id === "main");
    expect(mainInstances).toHaveLength(1);
    // Merged instance should keep the LAN address (higher priority)
    expect(mainInstances[0].lan_host).toBe("openclaw.local");
  });

  it("does not merge scan results with different agent_id", async () => {
    // Existing instance with different agent_id
    store.upsert({
      agent_id: "other-agent",
      auto_name: "other",
      assistant_name: "Other",
      display_name: "Other",
      lan_host: "other-host.local",
      address: "192.168.1.118",
      gateway_port: 18789,
      tls: false,
      discovery_source: "mdns",
      network_scope: "local",
      status: "online",
      last_seen: new Date().toISOString(),
      discovered_at: new Date().toISOString(),
    });

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("10.66.66.3:18789")) {
        return {
          ok: true,
          json: async () => ({
            assistantAgentId: "main",
            assistantName: "Assistant",
          }),
        };
      }
      throw new Error("Connection refused");
    }));

    const discovered = await scanner.scan({ targets: ["10.66.66.3:18789"] });
    expect(discovered).toHaveLength(1);

    // Different agent_id → should NOT merge, 2 separate instances
    const all = store.getAll();
    expect(all).toHaveLength(2);
  });

  it("falls back to IP as lan_host when no hostname found in registry", async () => {
    // No existing entries — scan result should use IP as lan_host
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("10.66.66.3:18789")) {
        return {
          ok: true,
          json: async () => ({
            assistantAgentId: "main",
            assistantName: "Assistant",
          }),
        };
      }
      throw new Error("Connection refused");
    }));

    const discovered = await scanner.scan({ targets: ["10.66.66.3:18789"] });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].lan_host).toBe("10.66.66.3");
  });

  it("skips internal/IPv6 interfaces", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      eth0: [
        {
          address: "::1",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "::1/128",
        },
      ],
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));

    const discovered = await scanner.scan();
    expect(discovered).toHaveLength(0);
  });
});
