import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Mock dgram
// ---------------------------------------------------------------------------
class MockSocket extends EventEmitter {
  sends: Array<{ msg: Buffer; port: number; address: string }> = [];
  private _bindCb: (() => void) | null = null;

  bind(_port: number, cb: () => void): void {
    this._bindCb = cb;
    // Call synchronously in tests
    cb();
  }
  setBroadcast(_val: boolean): void {}
  send(msg: Buffer, port: number, address: string): void {
    this.sends.push({ msg, port, address });
  }
  close(cb: () => void): void {
    cb();
  }
}

let mockSocket: MockSocket;

vi.mock("node:dgram", () => ({
  createSocket: (_type: string) => {
    mockSocket = new MockSocket();
    return mockSocket;
  },
}));

// ---------------------------------------------------------------------------
// Mock os.networkInterfaces — fixed 192.168.1.100/24
// ---------------------------------------------------------------------------
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    networkInterfaces: vi.fn(() => ({
      eth0: [
        {
          address: "192.168.1.100",
          netmask: "255.255.255.0",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          cidr: "192.168.1.100/24",
        },
      ],
    })),
    hostname: vi.fn(() => "test-host"),
  };
});

// ---------------------------------------------------------------------------
// Mock child_process.execSync
// ---------------------------------------------------------------------------
const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }));
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import { BroadcastDiscovery } from "../../src/discovery/broadcast.js";
import { RegistryStore } from "../../src/registry/store.js";
import type { ClawInstance } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeLocalInstance(): ClawInstance {
  return {
    agent_id: "main",
    auto_name: "test-host",
    assistant_name: "Test",
    display_name: "Test Instance",
    lan_host: "127.0.0.1",
    address: "127.0.0.1",
    gateway_port: 18789,
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
  };
}

function makeAnnounceMsg(overrides: Partial<{
  agent_id: string;
  auto_name: string;
  display_name: string;
  gateway_port: number;
  tls: boolean;
}> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    type: "claw_announce",
    version: 1,
    agent_id: "peer-agent",
    auto_name: "peer-host",
    display_name: "Peer Instance",
    gateway_port: 18789,
    tls: false,
    ...overrides,
  }));
}

function makeDiscoverMsg(): Buffer {
  return Buffer.from(JSON.stringify({ type: "claw_discover", version: 1 }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("BroadcastDiscovery", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let discovery: BroadcastDiscovery;
  let localInstance: ClawInstance | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());

    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-broadcast-test-"));
    store = new RegistryStore(tmpDir);
    await store.init();

    localInstance = null;
    discovery = new BroadcastDiscovery(store, () => localInstance);
  });

  afterEach(async () => {
    await discovery.stop();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  // 1. start() — binds port 17891 and sends claw_discover broadcast
  it("start() binds to 17891 and sends claw_discover to 192.168.1.255", async () => {
    await discovery.start();

    expect(mockSocket).toBeDefined();
    // Should have sent at least one message to 192.168.1.255:17891
    const discovers = mockSocket.sends.filter((s) => {
      try {
        const msg = JSON.parse(s.msg.toString());
        return msg.type === "claw_discover";
      } catch {
        return false;
      }
    });
    expect(discovers.length).toBeGreaterThan(0);
    expect(discovers[0]!.address).toBe("192.168.1.255");
    expect(discovers[0]!.port).toBe(17891);
  });

  // 2. stop() — closes socket and clears timer
  it("stop() closes the socket", async () => {
    await discovery.start();
    const closeSpy = vi.spyOn(mockSocket, "close");
    await discovery.stop();
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  // 3. Receiving claw_discover — unicast reply with claw_announce
  it("replies with claw_announce on receiving claw_discover", async () => {
    localInstance = makeLocalInstance();
    await discovery.start();
    mockSocket.sends = []; // clear discover

    mockSocket.emit("message", makeDiscoverMsg(), { address: "192.168.1.200", port: 17891 });

    // Reply should be unicast to sender
    const replies = mockSocket.sends.filter((s) => {
      try {
        const msg = JSON.parse(s.msg.toString());
        return msg.type === "claw_announce";
      } catch {
        return false;
      }
    });
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]!.address).toBe("192.168.1.200");
  });

  // 4. Receiving claw_discover when no local instance — no reply
  it("does not reply to claw_discover when no local instance", async () => {
    localInstance = null;
    await discovery.start();
    mockSocket.sends = [];

    mockSocket.emit("message", makeDiscoverMsg(), { address: "192.168.1.200", port: 17891 });

    const replies = mockSocket.sends.filter((s) => {
      try {
        return JSON.parse(s.msg.toString()).type === "claw_announce";
      } catch { return false; }
    });
    expect(replies).toHaveLength(0);
  });

  // 5. claw_announce + TCP verify success → store.upsert called with discovery_source="broadcast"
  it("upserts instance on valid claw_announce with successful TCP probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const upsertSpy = vi.spyOn(store, "upsert");

    await discovery.start();
    mockSocket.emit("message", makeAnnounceMsg(), { address: "192.168.1.50", port: 17891 });

    // Wait for async _handleAnnounce
    await new Promise((r) => setTimeout(r, 50));

    expect(upsertSpy).toHaveBeenCalledOnce();
    const inst = upsertSpy.mock.calls[0]![0];
    expect(inst.discovery_source).toBe("broadcast");
    expect(inst.address).toBe("192.168.1.50");
    expect(inst.gateway_port).toBe(18789);
  });

  // 6. claw_announce from non-local subnet → filtered, no upsert
  it("ignores claw_announce from non-local subnet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const upsertSpy = vi.spyOn(store, "upsert");

    await discovery.start();
    // 10.0.0.5 is not in 192.168.1.0/24
    mockSocket.emit("message", makeAnnounceMsg(), { address: "10.0.0.5", port: 17891 });

    await new Promise((r) => setTimeout(r, 50));

    expect(upsertSpy).not.toHaveBeenCalled();
  });

  // 7. claw_announce + TCP verify fails → no upsert
  it("ignores claw_announce when TCP probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const upsertSpy = vi.spyOn(store, "upsert");

    await discovery.start();
    mockSocket.emit("message", makeAnnounceMsg(), { address: "192.168.1.50", port: 17891 });

    await new Promise((r) => setTimeout(r, 50));

    expect(upsertSpy).not.toHaveBeenCalled();
  });

  // 8. sendAnnounce() — no local instance → no send
  it("sendAnnounce() sends nothing when no local instance", async () => {
    localInstance = null;
    await discovery.start();
    mockSocket.sends = [];

    discovery.sendAnnounce();

    const announces = mockSocket.sends.filter((s) => {
      try { return JSON.parse(s.msg.toString()).type === "claw_announce"; }
      catch { return false; }
    });
    expect(announces).toHaveLength(0);
  });

  // 9. sendAnnounce() — with local instance → broadcasts to 192.168.1.255
  it("sendAnnounce() broadcasts claw_announce when local instance exists", async () => {
    localInstance = makeLocalInstance();
    await discovery.start();
    mockSocket.sends = [];

    discovery.sendAnnounce();

    const announces = mockSocket.sends.filter((s) => {
      try { return JSON.parse(s.msg.toString()).type === "claw_announce"; }
      catch { return false; }
    });
    expect(announces.length).toBeGreaterThan(0);
    expect(announces[0]!.address).toBe("192.168.1.255");
  });

  // 10. Windows firewall rule — execSync called on win32
  it("calls execSync to add firewall rule on win32", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      await discovery.start();
      expect(mockExecSync).toHaveBeenCalledOnce();
      const cmd = mockExecSync.mock.calls[0]![0] as string;
      expect(cmd).toContain("netsh");
      expect(cmd).toContain("17891");
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  // 11. Windows firewall — execSync failure is non-fatal
  it("does not throw when firewall rule addition fails on win32", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    mockExecSync.mockImplementation(() => { throw new Error("Access denied"); });

    try {
      await expect(discovery.start()).resolves.toBeUndefined();
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  // 12. _calcBroadcast — correct calculation
  it("_calcBroadcast computes correct broadcast address", () => {
    expect(discovery._calcBroadcast("192.168.1.100", "255.255.255.0")).toBe("192.168.1.255");
    expect(discovery._calcBroadcast("10.0.0.5", "255.0.0.0")).toBe("10.255.255.255");
    expect(discovery._calcBroadcast("172.16.5.10", "255.255.0.0")).toBe("172.16.255.255");
  });

  // 13. Invalid JSON → ignored, no crash
  it("ignores invalid JSON messages without crashing", async () => {
    await discovery.start();
    expect(() => {
      mockSocket.emit("message", Buffer.from("not json{{{"), { address: "192.168.1.50", port: 17891 });
    }).not.toThrow();
  });

  // 14. Unknown message type → ignored
  it("ignores messages with unknown type", async () => {
    const upsertSpy = vi.spyOn(store, "upsert");
    await discovery.start();
    mockSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "unknown_type", version: 1 })),
      { address: "192.168.1.50", port: 17891 },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  // 15. BUG-1 fix: claw_announce from own IP → ignored (no upsert)
  it("ignores claw_announce from own interface IP (self-loop)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const upsertSpy = vi.spyOn(store, "upsert");

    await discovery.start();
    // 192.168.1.100 is the mocked local interface IP
    mockSocket.emit("message", makeAnnounceMsg(), { address: "192.168.1.100", port: 17891 });

    await new Promise((r) => setTimeout(r, 50));

    expect(upsertSpy).not.toHaveBeenCalled();
  });

  // 16. BUG-2 fix: virtual interface (WireGuard) not included in broadcast targets
  it("excludes virtual interfaces (WireGuard, tun, docker) from broadcast targets", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValueOnce({
      eth0: [
        {
          address: "192.168.1.100",
          netmask: "255.255.255.0",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          cidr: "192.168.1.100/24",
        },
      ],
      "WireGuard Tunnel": [
        {
          address: "172.20.80.1",
          netmask: "255.255.255.0",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          cidr: "172.20.80.1/24",
        },
      ],
      tun0: [
        {
          address: "10.8.0.1",
          netmask: "255.255.255.0",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:02",
          cidr: "10.8.0.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    await discovery.start();

    const broadcastTargets = mockSocket.sends
      .filter((s) => {
        try { return JSON.parse(s.msg.toString()).type === "claw_discover"; }
        catch { return false; }
      })
      .map((s) => s.address);

    // Only eth0 broadcast should be sent
    expect(broadcastTargets).toContain("192.168.1.255");
    expect(broadcastTargets).not.toContain("172.20.80.255");  // WireGuard excluded
    expect(broadcastTargets).not.toContain("10.8.0.255");     // tun0 excluded
  });

  // 17. BUG-2 fix: claw_announce from WireGuard subnet → ignored (not local subnet)
  it("ignores claw_announce from WireGuard subnet IP", async () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      eth0: [
        {
          address: "192.168.1.100",
          netmask: "255.255.255.0",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          cidr: "192.168.1.100/24",
        },
      ],
      "WireGuard Tunnel": [
        {
          address: "172.20.80.1",
          netmask: "255.255.255.0",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:01",
          cidr: "172.20.80.1/24",
        },
      ],
    } as ReturnType<typeof os.networkInterfaces>);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const upsertSpy = vi.spyOn(store, "upsert");

    await discovery.start();
    // Announce from WireGuard subnet — should be rejected since WireGuard is virtual
    mockSocket.emit("message", makeAnnounceMsg(), { address: "172.20.80.2", port: 17891 });

    await new Promise((r) => setTimeout(r, 50));

    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
