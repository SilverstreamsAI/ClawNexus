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
