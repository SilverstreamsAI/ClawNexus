import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted ensures they exist before vi.mock factories run
// ---------------------------------------------------------------------------
const { mockExecFile, mockReadFileSync, mockNetworkInterfaces } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockNetworkInterfaces: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: () => mockExecFile,
  };
});

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: mockNetworkInterfaces,
  };
});

import { detectWireGuard } from "../../src/scanner/wireguard.js";

describe("scanner/wireguard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const wgInterface = {
    address: "10.66.66.5",
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    internal: false,
    mac: "00:00:00:00:00:00",
    cidr: "10.66.66.5/24",
  };

  it("Strategy 1: wg show interfaces succeeds — returns matched interfaces", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      if (cmd === "wg" && cmdArgs[0] === "show" && cmdArgs[1] === "interfaces") {
        return Promise.resolve({ stdout: "wg0\n" });
      }
      if (cmd === "wg" && cmdArgs[0] === "show" && cmdArgs[2] === "dump") {
        return Promise.resolve({ stdout: "" });
      }
      return Promise.reject(new Error("not found"));
    });
    mockNetworkInterfaces.mockReturnValue({
      wg0: [wgInterface],
    });

    const result = await detectWireGuard();
    expect(result.interfaces).toEqual([
      { name: "wg0", address: "10.66.66.5", subnet: "10.66.66" },
    ]);
  });

  it("Strategy 2: sysfs type=65534 on Linux — returns WG interfaces", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    mockExecFile.mockRejectedValue(new Error("wg not found"));
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === "/sys/class/net/wg0/type") return "65534\n";
      throw new Error("ENOENT");
    });
    mockNetworkInterfaces.mockReturnValue({
      wg0: [wgInterface],
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
    });

    const result = await detectWireGuard();
    expect(result.interfaces).toEqual([
      { name: "wg0", address: "10.66.66.5", subnet: "10.66.66" },
    ]);

    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("Strategy 3: name heuristic (interface name contains 'wg') — returns matches", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    mockExecFile.mockRejectedValue(new Error("wg not found"));
    mockNetworkInterfaces.mockReturnValue({
      "wg0-client": [wgInterface],
    });

    const result = await detectWireGuard();
    expect(result.interfaces).toEqual([
      { name: "wg0-client", address: "10.66.66.5", subnet: "10.66.66" },
    ]);

    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("All strategies fail — returns empty info", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    mockExecFile.mockRejectedValue(new Error("wg not found"));
    mockNetworkInterfaces.mockReturnValue({
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
    });

    const result = await detectWireGuard();
    expect(result).toEqual({ interfaces: [], peerIPs: [] });

    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("extractPeerIPs — parses wg dump, extracts /32 peers only, deduplicates", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === "show" && cmdArgs[1] === "interfaces") {
        return Promise.resolve({ stdout: "wg0\n" });
      }
      if (cmdArgs[0] === "show" && cmdArgs[2] === "dump") {
        const dump = [
          "private-key\tpublic-key\tlisten-port\tfwmark",
          "peer-pubkey1\tpreshared\tendpoint\t10.66.66.2/32,10.66.66.2/32\t0\t0\t0\t0",
          "peer-pubkey2\tpreshared\tendpoint\t10.66.66.3/32\t0\t0\t0\t0",
        ].join("\n");
        return Promise.resolve({ stdout: dump });
      }
      return Promise.reject(new Error("not found"));
    });
    mockNetworkInterfaces.mockReturnValue({ wg0: [wgInterface] });

    const result = await detectWireGuard();
    expect(result.peerIPs).toEqual(["10.66.66.2", "10.66.66.3"]);
  });

  it("extractPeerIPs — skips non-/32 subnets", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === "show" && cmdArgs[1] === "interfaces") {
        return Promise.resolve({ stdout: "wg0\n" });
      }
      if (cmdArgs[0] === "show" && cmdArgs[2] === "dump") {
        const dump = [
          "private-key\tpublic-key\tlisten-port\tfwmark",
          "peer-pubkey1\tpreshared\tendpoint\t10.66.66.0/24\t0\t0\t0\t0",
        ].join("\n");
        return Promise.resolve({ stdout: dump });
      }
      return Promise.reject(new Error("not found"));
    });
    mockNetworkInterfaces.mockReturnValue({ wg0: [wgInterface] });

    const result = await detectWireGuard();
    expect(result.peerIPs).toEqual([]);
  });

  it("extractPeerIPs — handles wg command failure gracefully", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === "show" && cmdArgs[1] === "interfaces") {
        return Promise.resolve({ stdout: "wg0\n" });
      }
      return Promise.reject(new Error("permission denied"));
    });
    mockNetworkInterfaces.mockReturnValue({ wg0: [wgInterface] });

    const result = await detectWireGuard();
    expect(result.peerIPs).toEqual([]);
  });

  it("matchInterfacesToOS — skips interfaces not in OS, filters IPv4 only", async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === "show" && cmdArgs[1] === "interfaces") {
        return Promise.resolve({ stdout: "wg0 wg1\n" });
      }
      return Promise.resolve({ stdout: "" });
    });
    mockNetworkInterfaces.mockReturnValue({
      wg0: [
        wgInterface,
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          internal: false,
          mac: "00:00:00:00:00:00",
          cidr: "fe80::1/64",
          scopeid: 0,
        },
      ],
    });

    const result = await detectWireGuard();
    expect(result.interfaces).toEqual([
      { name: "wg0", address: "10.66.66.5", subnet: "10.66.66" },
    ]);
  });

  it("no interfaces detected → returns EMPTY_INFO early", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    mockExecFile.mockRejectedValue(new Error("wg not found"));
    mockNetworkInterfaces.mockReturnValue({
      en0: [
        {
          address: "192.168.1.100",
          netmask: "255.255.255.0",
          family: "IPv4",
          internal: false,
          mac: "00:00:00:00:00:00",
          cidr: "192.168.1.100/24",
        },
      ],
    });

    const result = await detectWireGuard();
    expect(result).toEqual({ interfaces: [], peerIPs: [] });

    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });
});
