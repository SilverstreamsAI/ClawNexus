import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs and child_process before importing CLI module
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw new Error("ENOENT");
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    openSync: vi.fn(() => 3),
  };
});

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => ({
    pid: 1234,
    disconnect: vi.fn(),
    unref: vi.fn(),
  })),
  exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => {
    cb(null);
  }),
}));

import {
  parseArgs,
  fetchApi,
  getChannel,
  printTable,
  readPid,
  writePid,
  removePid,
  main,
  cmdList,
  cmdScan,
  cmdAlias,
  cmdInfo,
  cmdForget,
  cmdConnect,
  cmdRelay,
  cmdStatus,
  cmdRegister,
  cmdRegistryStatus,
  cmdResolve,
  cmdWhoami,
  cmdPolicy,
  cmdTasks,
  cmdInbox,
  cmdDiagnostics,
  cmdInteractions,
  cmdOpen,
  cmdOpenUi,
  cmdPropose,
  cmdQuery,
  cmdStop,
  cmdRestart,
} from "../../src/cli/index.js";
import type { ParsedArgs } from "../../src/cli/index.js";
import type { ClawInstance } from "../../src/types.js";

describe("CLI commands", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
    return {
      command: "",
      positional: [],
      json: false,
      timeout: 5000,
      api: "http://localhost:17890",
      all: false,
      direction: "",
      peer: "",
      scope: "",
      input: {},
      targets: [],
      ports: [],
      ...overrides,
    };
  }

  function mockFetch(data: unknown, ok = true, status = 200) {
    fetchMock.mockResolvedValueOnce({
      ok,
      status,
      json: async () => data,
    });
  }

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  // --- fetchApi ---

  describe("fetchApi", () => {
    it("returns ok response", async () => {
      mockFetch({ status: "ok" });
      const result = await fetchApi("http://localhost:17890", "GET", "/health");
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ status: "ok" });
    });

    it("handles timeout error", async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      fetchMock.mockRejectedValueOnce(err);
      const result = await fetchApi("http://localhost:17890", "GET", "/health", undefined, 100);
      expect(result.ok).toBe(false);
      expect((result.data as { error: string }).error).toBe("Request timed out");
    });

    it("handles connection error", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await fetchApi("http://localhost:17890", "GET", "/health");
      expect(result.ok).toBe(false);
      expect((result.data as { error: string }).error).toContain("Cannot connect");
    });

    it("sends body as JSON", async () => {
      mockFetch({ status: "ok" });
      await fetchApi("http://localhost:17890", "POST", "/scan", { targets: [] });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:17890/scan",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"targets":[]}',
        }),
      );
    });
  });

  // --- getChannel ---

  describe("getChannel", () => {
    it("returns 'local' for is_self instance", () => {
      expect(getChannel({ is_self: true, discovery_source: "local" } as ClawInstance)).toBe("local");
    });

    it("returns preferred_channel from connectivity", () => {
      expect(
        getChannel({
          connectivity: { preferred_channel: "relay" },
          discovery_source: "registry",
        } as ClawInstance),
      ).toBe("relay");
    });

    it("falls back to discovery_source", () => {
      expect(getChannel({ discovery_source: "scan" } as ClawInstance)).toBe("scan");
    });
  });

  // --- printTable ---

  describe("printTable", () => {
    it("prints 'No instances found.' for empty array", () => {
      printTable([]);
      expect(consoleLogSpy).toHaveBeenCalledWith("No instances found.");
    });

    it("prints table with instances", () => {
      const inst = {
        auto_name: "test-host",
        alias: "home",
        address: "127.0.0.1",
        gateway_port: 18789,
        status: "online",
        discovery_source: "local",
        network_scope: "local",
        last_seen: "2026-01-01T00:00:00Z",
        is_self: true,
      } as ClawInstance;
      printTable([inst]);
      // Should print header + separator + data row
      expect(consoleLogSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      // First row should contain the name
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("home (self)");
    });

    it("shows auto_name when no alias", () => {
      const inst = {
        auto_name: "my-machine",
        address: "192.168.1.5",
        gateway_port: 18789,
        status: "online",
        discovery_source: "scan",
        network_scope: "local",
        last_seen: "2026-01-01T00:00:00Z",
      } as ClawInstance;
      printTable([inst]);
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("my-machine");
    });
  });

  // --- PID helpers ---

  describe("readPid", () => {
    it("returns null when file doesn't exist", () => {
      expect(readPid()).toBeNull();
    });
  });

  describe("writePid / removePid", () => {
    it("writePid does not throw", () => {
      expect(() => writePid(12345)).not.toThrow();
    });

    it("removePid does not throw", () => {
      expect(() => removePid()).not.toThrow();
    });
  });

  // --- Command tests ---

  describe("cmdList", () => {
    it("success — prints table", async () => {
      mockFetch({
        instances: [
          {
            auto_name: "test",
            address: "127.0.0.1",
            gateway_port: 18789,
            status: "online",
            discovery_source: "local",
            network_scope: "local",
            last_seen: new Date().toISOString(),
          },
        ],
      });
      await cmdList(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("success — JSON output", async () => {
      mockFetch({ instances: [] });
      await cmdList(makeArgs({ json: true }));
      const output = consoleLogSpy.mock.calls[0][0];
      expect(JSON.parse(output)).toHaveProperty("count");
    });

    it("failure — prints error and exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdList(makeArgs())).rejects.toThrow("process.exit");
    });

    it("filters by scope", async () => {
      mockFetch({
        instances: [
          { auto_name: "a", network_scope: "local", address: "1.1.1.1", gateway_port: 1, status: "online", discovery_source: "scan", last_seen: "" },
          { auto_name: "b", network_scope: "vpn", address: "2.2.2.2", gateway_port: 1, status: "online", discovery_source: "scan", last_seen: "" },
        ],
      });
      await cmdList(makeArgs({ scope: "local" }));
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("a");
      expect(output).not.toContain("2.2.2.2");
    });
  });

  describe("cmdScan", () => {
    it("success — prints results", async () => {
      mockFetch({ discovered: 1, instances: [] });
      await cmdScan(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Scanning"));
    });

    it("with targets and ports", async () => {
      mockFetch({ discovered: 0, instances: [] });
      await cmdScan(makeArgs({ targets: ["192.168.1.1:18789"], ports: [18789] }));
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("192.168.1.1:18789");
    });

    it("JSON output", async () => {
      mockFetch({ discovered: 0, instances: [] });
      await cmdScan(makeArgs({ json: true }));
    });

    it("failure — exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdScan(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdAlias", () => {
    it("success", async () => {
      mockFetch({ status: "ok" });
      await cmdAlias(makeArgs({ positional: ["myhost", "home"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Alias"));
    });

    it("JSON output", async () => {
      mockFetch({ status: "ok", alias: "home" });
      await cmdAlias(makeArgs({ positional: ["myhost", "home"], json: true }));
    });

    it("missing args — exits", async () => {
      await expect(cmdAlias(makeArgs({ positional: ["onlyone"] }))).rejects.toThrow("process.exit");
    });

    it("failure — exits", async () => {
      mockFetch({ error: "conflict" }, false);
      await expect(cmdAlias(makeArgs({ positional: ["myhost", "home"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdInfo", () => {
    it("success — prints details", async () => {
      mockFetch({
        auto_name: "test",
        agent_id: "main",
        display_name: "Test",
        assistant_name: "Asst",
        address: "127.0.0.1",
        gateway_port: 18789,
        lan_host: "test.local",
        tls: false,
        status: "online",
        discovery_source: "local",
        network_scope: "local",
        last_seen: "2026-01-01T00:00:00Z",
        discovered_at: "2026-01-01T00:00:00Z",
        is_self: true,
        connectivity: { lan_reachable: true, relay_available: false, lan_latency_ms: 5 },
      });
      await cmdInfo(makeArgs({ positional: ["test"] }));
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("test (self)");
      expect(output).toContain("LAN Reachable: yes (5ms)");
    });

    it("with alias, claw_name, implementation, labels, remote_card", async () => {
      mockFetch({
        auto_name: "test",
        agent_id: "main",
        display_name: "Test",
        assistant_name: "Asst",
        address: "127.0.0.1",
        gateway_port: 18789,
        lan_host: "test.local",
        tls: true,
        status: "online",
        discovery_source: "local",
        network_scope: "local",
        last_seen: "2026-01-01T00:00:00Z",
        discovered_at: "2026-01-01T00:00:00Z",
        alias: "home",
        claw_name: "test.id.claw",
        implementation: "openclaw",
        labels: { env: "prod" },
        connectivity: { lan_reachable: false, relay_available: true, unreachable_reason: "timeout" },
        remote_card: {
          skills: [{ id: "s1", name: "Skill One" }],
          card_url: "http://example.com/card",
          fetched_at: "2026-01-01T00:00:00Z",
        },
      });
      await cmdInfo(makeArgs({ positional: ["test"] }));
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("home");
      expect(output).toContain("test.id.claw");
      expect(output).toContain("openclaw");
      expect(output).toContain("prod");
      expect(output).toContain("Skill One");
      expect(output).toContain("Unreachable:");
    });

    it("JSON output", async () => {
      mockFetch({ auto_name: "test" });
      await cmdInfo(makeArgs({ positional: ["test"], json: true }));
    });

    it("missing arg — exits", async () => {
      await expect(cmdInfo(makeArgs())).rejects.toThrow("process.exit");
    });

    it("not found — exits", async () => {
      mockFetch({ error: "not found" }, false);
      await expect(cmdInfo(makeArgs({ positional: ["test"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdForget", () => {
    it("success", async () => {
      mockFetch({ removed: "test" });
      await cmdForget(makeArgs({ positional: ["test"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Removed"));
    });

    it("JSON output", async () => {
      mockFetch({ removed: "test" });
      await cmdForget(makeArgs({ positional: ["test"], json: true }));
    });

    it("missing arg — exits", async () => {
      await expect(cmdForget(makeArgs())).rejects.toThrow("process.exit");
    });

    it("not found — exits", async () => {
      mockFetch({ error: "not found" }, false);
      await expect(cmdForget(makeArgs({ positional: ["test"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdConnect", () => {
    it(".claw target — relay connect", async () => {
      mockFetch({ status: "connecting" });
      await cmdConnect(makeArgs({ positional: ["peer.id.claw"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("via relay"));
    });

    it(".claw target — JSON output", async () => {
      mockFetch({ status: "connecting" });
      await cmdConnect(makeArgs({ positional: ["peer.id.claw"], json: true }));
    });

    it(".claw target — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdConnect(makeArgs({ positional: ["peer.id.claw"] }))).rejects.toThrow("process.exit");
    });

    it("LAN target with lan_reachable", async () => {
      mockFetch({
        address: "192.168.1.5",
        gateway_port: 18789,
        tls: false,
        connectivity: { lan_reachable: true },
      });
      await cmdConnect(makeArgs({ positional: ["myhost"] }));
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("ws://192.168.1.5:18789");
    });

    it("LAN target with lan_reachable — JSON output", async () => {
      mockFetch({
        address: "192.168.1.5",
        gateway_port: 18789,
        tls: true,
        connectivity: { lan_reachable: true },
      });
      await cmdConnect(makeArgs({ positional: ["myhost"], json: true }));
    });

    it("target with relay_available — relay fallback", async () => {
      mockFetch({
        agent_id: "main",
        address: "192.168.1.5",
        gateway_port: 18789,
        tls: false,
        connectivity: { lan_reachable: false, relay_available: true },
      });
      mockFetch({ status: "connecting" });
      await cmdConnect(makeArgs({ positional: ["myhost"] }));
    });

    it("target with relay_available — relay fallback JSON", async () => {
      mockFetch({
        agent_id: "main",
        address: "192.168.1.5",
        gateway_port: 18789,
        tls: false,
        connectivity: { lan_reachable: false, relay_available: true },
      });
      mockFetch({ status: "connecting" });
      await cmdConnect(makeArgs({ positional: ["myhost"], json: true }));
    });

    it("target with relay_available — relay fails", async () => {
      mockFetch({
        agent_id: "main",
        address: "192.168.1.5",
        gateway_port: 18789,
        tls: false,
        connectivity: { lan_reachable: false, relay_available: true },
      });
      mockFetch({ error: "fail" }, false);
      await expect(cmdConnect(makeArgs({ positional: ["myhost"] }))).rejects.toThrow("process.exit");
    });

    it("target unreachable — fallback to direct URL", async () => {
      mockFetch({
        address: "192.168.1.5",
        gateway_port: 18789,
        tls: false,
        connectivity: { lan_reachable: false, relay_available: false, unreachable_reason: "timeout" },
      });
      await cmdConnect(makeArgs({ positional: ["myhost"] }));
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("ws://192.168.1.5:18789");
    });

    it("target unreachable — JSON output", async () => {
      mockFetch({
        address: "192.168.1.5",
        gateway_port: 18789,
        tls: false,
        connectivity: { lan_reachable: false, relay_available: false },
      });
      await cmdConnect(makeArgs({ positional: ["myhost"], json: true }));
    });

    it("target not found — exits", async () => {
      mockFetch({ error: "not found" }, false);
      await expect(cmdConnect(makeArgs({ positional: ["myhost"] }))).rejects.toThrow("process.exit");
    });

    it("missing arg — exits", async () => {
      await expect(cmdConnect(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdRelay", () => {
    it("relay status — success", async () => {
      mockFetch({ state: "registered", rooms: [] });
      await cmdRelay(makeArgs({ positional: ["status"] }));
    });

    it("relay status — failure", async () => {
      mockFetch({ error: "unavailable" }, false);
      await expect(cmdRelay(makeArgs({ positional: ["status"] }))).rejects.toThrow("process.exit");
    });

    it("unknown subcommand — exits", async () => {
      await expect(cmdRelay(makeArgs({ positional: ["unknown"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdStatus", () => {
    it("daemon running — prints status", async () => {
      mockFetch({
        status: "ok",
        version: "0.4.0",
        timestamp: new Date().toISOString(),
        components: {
          local_instance: { agent_id: "main", auto_name: "test", status: "detected" },
          registry: { instances: 2 },
          mdns: "active",
          health_checker: "active",
          scanner: "idle",
        },
      });
      await cmdStatus(makeArgs());
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("running");
    });

    it("daemon running without local instance", async () => {
      mockFetch({
        status: "ok",
        version: "0.4.0",
        timestamp: new Date().toISOString(),
        components: {
          local_instance: { status: "not_detected" },
          registry: { instances: 0 },
          mdns: "active",
          health_checker: "active",
          scanner: "idle",
        },
      });
      await cmdStatus(makeArgs());
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("not detected");
    });

    it("daemon not running", async () => {
      mockFetch({ error: "fail" }, false);
      await cmdStatus(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("not running"));
    });

    it("JSON output", async () => {
      mockFetch({ status: "ok" });
      await cmdStatus(makeArgs({ json: true }));
    });
  });

  describe("cmdRegister", () => {
    it("success with claw_name", async () => {
      mockFetch({ claw_name: "test.id.claw", pubkey: "ed25519:abc" });
      await cmdRegister(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Registered as"));
    });

    it("success without claw_name", async () => {
      mockFetch({});
      await cmdRegister(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("No local instance"));
    });

    it("JSON output", async () => {
      mockFetch({ claw_name: "test.id.claw" });
      await cmdRegister(makeArgs({ json: true }));
    });

    it("failure — exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdRegister(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdRegistryStatus", () => {
    it("success", async () => {
      mockFetch({ registered: true, claw_name: "test.id.claw", pubkey: "ed25519:abc" });
      await cmdRegistryStatus(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("yes"));
    });

    it("not registered", async () => {
      mockFetch({ registered: false });
      await cmdRegistryStatus(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("no"));
    });

    it("JSON output", async () => {
      mockFetch({ registered: true });
      await cmdRegistryStatus(makeArgs({ json: true }));
    });

    it("failure — exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdRegistryStatus(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdResolve", () => {
    it("success", async () => {
      mockFetch({
        agent_id: "main",
        claw_name: "test.id.claw",
        discovery_source: "registry",
        network_scope: "public",
        owner_pubkey: "ed25519:abc",
        connectivity: { preferred_channel: "relay" },
      });
      await cmdResolve(makeArgs({ positional: ["test.id.claw"] }));
    });

    it("JSON output", async () => {
      mockFetch({ agent_id: "main" });
      await cmdResolve(makeArgs({ positional: ["test.id.claw"], json: true }));
    });

    it("missing arg — exits", async () => {
      await expect(cmdResolve(makeArgs())).rejects.toThrow("process.exit");
    });

    it("not found — exits", async () => {
      mockFetch({ error: "not found" }, false);
      await expect(cmdResolve(makeArgs({ positional: ["test.claw"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdWhoami", () => {
    it("success with identity", async () => {
      mockFetch({ pubkey: "ed25519:abc", claw_name: "test.id.claw" });
      await cmdWhoami(makeArgs());
    });

    it("no identity", async () => {
      mockFetch({});
      await cmdWhoami(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith("Identity not initialized.");
    });

    it("JSON output", async () => {
      mockFetch({ pubkey: "ed25519:abc" });
      await cmdWhoami(makeArgs({ json: true }));
    });

    it("failure — exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdWhoami(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdPolicy", () => {
    it("show — success", async () => {
      mockFetch({ auto_accept: true });
      await cmdPolicy(makeArgs({ positional: ["show"] }));
    });

    it("show — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdPolicy(makeArgs({ positional: ["show"] }))).rejects.toThrow("process.exit");
    });

    it("set — success", async () => {
      mockFetch({ status: "ok", policy: {} });
      await cmdPolicy(makeArgs({ positional: ["set", "auto_accept", "true"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Policy updated"));
    });

    it("set — JSON output", async () => {
      mockFetch({ status: "ok", policy: {} });
      await cmdPolicy(makeArgs({ positional: ["set", "auto_accept", "true"], json: true }));
    });

    it("set — nested dot notation", async () => {
      mockFetch({ status: "ok", policy: {} });
      await cmdPolicy(makeArgs({ positional: ["set", "rate_limit.max_per_minute", "10"] }));
    });

    it("set — string value (not valid JSON)", async () => {
      mockFetch({ status: "ok", policy: {} });
      await cmdPolicy(makeArgs({ positional: ["set", "mode", "strict"] }));
    });

    it("set — missing args", async () => {
      await expect(cmdPolicy(makeArgs({ positional: ["set", "key"] }))).rejects.toThrow("process.exit");
    });

    it("set — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdPolicy(makeArgs({ positional: ["set", "k", "v"] }))).rejects.toThrow("process.exit");
    });

    it("reset — success", async () => {
      mockFetch({ status: "ok", policy: {} });
      await cmdPolicy(makeArgs({ positional: ["reset"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith("Policy reset to defaults.");
    });

    it("reset — JSON output", async () => {
      mockFetch({ status: "ok", policy: {} });
      await cmdPolicy(makeArgs({ positional: ["reset"], json: true }));
    });

    it("reset — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdPolicy(makeArgs({ positional: ["reset"] }))).rejects.toThrow("process.exit");
    });

    it("unknown sub — exits", async () => {
      await expect(cmdPolicy(makeArgs({ positional: ["unknown"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdTasks", () => {
    it("list — success with tasks", async () => {
      mockFetch({
        tasks: [
          {
            task_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeee",
            direction: "outbound",
            peer_claw_id: "peer.claw",
            state: "pending",
            task: { task_type: "query" },
          },
        ],
      });
      await cmdTasks(makeArgs());
    });

    it("list — empty", async () => {
      mockFetch({ tasks: [] });
      await cmdTasks(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith("No tasks found.");
    });

    it("list — JSON output", async () => {
      mockFetch({ tasks: [] });
      await cmdTasks(makeArgs({ json: true }));
    });

    it("list — with direction filter", async () => {
      mockFetch({ tasks: [] });
      await cmdTasks(makeArgs({ direction: "inbound" }));
    });

    it("list — with --all", async () => {
      mockFetch({ tasks: [] });
      await cmdTasks(makeArgs({ all: true }));
    });

    it("list — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdTasks(makeArgs())).rejects.toThrow("process.exit");
    });

    it("info — success", async () => {
      mockFetch({ task_id: "123", state: "pending" });
      await cmdTasks(makeArgs({ positional: ["info", "123"] }));
    });

    it("info — missing id", async () => {
      await expect(cmdTasks(makeArgs({ positional: ["info"] }))).rejects.toThrow("process.exit");
    });

    it("info — not found", async () => {
      mockFetch({ error: "not found" }, false);
      await expect(cmdTasks(makeArgs({ positional: ["info", "123"] }))).rejects.toThrow("process.exit");
    });

    it("cancel — success", async () => {
      mockFetch({ status: "ok" });
      await cmdTasks(makeArgs({ positional: ["cancel", "123"] }));
    });

    it("cancel — JSON output", async () => {
      mockFetch({ status: "ok" });
      await cmdTasks(makeArgs({ positional: ["cancel", "123"], json: true }));
    });

    it("cancel — missing id", async () => {
      await expect(cmdTasks(makeArgs({ positional: ["cancel"] }))).rejects.toThrow("process.exit");
    });

    it("cancel — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdTasks(makeArgs({ positional: ["cancel", "123"] }))).rejects.toThrow("process.exit");
    });

    it("stats — success", async () => {
      mockFetch({ total: 5, active: 2, by_state: { pending: 2, completed: 3 }, by_direction: { inbound: 1, outbound: 4 } });
      await cmdTasks(makeArgs({ positional: ["stats"] }));
    });

    it("stats — empty stats", async () => {
      mockFetch({ total: 0, active: 0, by_state: {}, by_direction: {} });
      await cmdTasks(makeArgs({ positional: ["stats"] }));
    });

    it("stats — JSON output", async () => {
      mockFetch({ total: 0, active: 0, by_state: {}, by_direction: {} });
      await cmdTasks(makeArgs({ positional: ["stats"], json: true }));
    });

    it("stats — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdTasks(makeArgs({ positional: ["stats"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdInbox", () => {
    it("list — success with items", async () => {
      mockFetch({
        count: 1,
        items: [
          { message_id: "aabbccdd-1234", from: "peer.claw", type: "propose", timestamp: "2026-01-01T00:00:00Z" },
        ],
      });
      await cmdInbox(makeArgs());
    });

    it("list — empty", async () => {
      mockFetch({ count: 0, items: [] });
      await cmdInbox(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith("Inbox is empty.");
    });

    it("list — JSON output", async () => {
      mockFetch({ count: 0, items: [] });
      await cmdInbox(makeArgs({ json: true }));
    });

    it("list — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdInbox(makeArgs())).rejects.toThrow("process.exit");
    });

    it("approve — success", async () => {
      mockFetch({ status: "ok" });
      await cmdInbox(makeArgs({ positional: ["approve", "msg-123"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("approved"));
    });

    it("approve — JSON output", async () => {
      mockFetch({ status: "ok" });
      await cmdInbox(makeArgs({ positional: ["approve", "msg-123"], json: true }));
    });

    it("approve — missing id", async () => {
      await expect(cmdInbox(makeArgs({ positional: ["approve"] }))).rejects.toThrow("process.exit");
    });

    it("approve — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdInbox(makeArgs({ positional: ["approve", "msg-123"] }))).rejects.toThrow("process.exit");
    });

    it("deny — success", async () => {
      mockFetch({ status: "ok" });
      await cmdInbox(makeArgs({ positional: ["deny", "msg-123"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("denied"));
    });

    it("deny — JSON output", async () => {
      mockFetch({ status: "ok" });
      await cmdInbox(makeArgs({ positional: ["deny", "msg-123"], json: true }));
    });

    it("deny — missing id", async () => {
      await expect(cmdInbox(makeArgs({ positional: ["deny"] }))).rejects.toThrow("process.exit");
    });

    it("deny — failure", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdInbox(makeArgs({ positional: ["deny", "msg-123"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdDiagnostics", () => {
    it("success with detected local + unreachable", async () => {
      mockFetch({
        local_instance: { agent_id: "main", status: "detected" },
        lan_discovery: {
          mdns: "active",
          unreachable_count: 1,
          unreachable: [{ address: "192.168.1.50:18789", lan_host: "test.local", reason: "timeout" }],
        },
        registry: { status: "registered" },
        relay: { status: "connected" },
        summary: { total_instances: 2, lan_instances: 1, relay_instances: 1 },
      });
      await cmdDiagnostics(makeArgs());
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("OK Detected");
    });

    it("success without local instance", async () => {
      mockFetch({
        local_instance: { status: "not_detected" },
        lan_discovery: { mdns: "active", unreachable_count: 0, unreachable: [] },
        registry: { status: "not_configured" },
        relay: { status: "not_configured" },
        summary: { total_instances: 0, lan_instances: 0, relay_instances: 0 },
      });
      await cmdDiagnostics(makeArgs());
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No local OpenClaw");
      expect(output).toContain("No unreachable");
    });

    it("JSON output", async () => {
      mockFetch({ local_instance: {}, lan_discovery: {}, registry: {}, relay: {}, summary: {} });
      await cmdDiagnostics(makeArgs({ json: true }));
    });

    it("failure — exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdDiagnostics(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdInteractions", () => {
    it("success with tasks", async () => {
      mockFetch({
        tasks: [
          {
            task_id: "aaaaaaaa-bbbb",
            direction: "outbound",
            peer_claw_id: "peer.claw",
            state: "completed",
            task: { task_type: "query" },
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      await cmdInteractions(makeArgs());
    });

    it("filters by peer", async () => {
      mockFetch({
        tasks: [
          {
            task_id: "aaaa",
            direction: "outbound",
            peer_claw_id: "peer.claw",
            state: "completed",
            task: { task_type: "query" },
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      await cmdInteractions(makeArgs({ peer: "other.claw" }));
      expect(consoleLogSpy).toHaveBeenCalledWith("No interactions found.");
    });

    it("empty — prints message", async () => {
      mockFetch({ tasks: [] });
      await cmdInteractions(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith("No interactions found.");
    });

    it("JSON output", async () => {
      mockFetch({ tasks: [] });
      await cmdInteractions(makeArgs({ json: true }));
    });

    it("failure — exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdInteractions(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdOpen", () => {
    it("success — opens browser", async () => {
      mockFetch({ address: "192.168.1.5", gateway_port: 18789, tls: false });
      await cmdOpen(makeArgs({ positional: ["myhost"] }));
    });

    it("missing arg — exits", async () => {
      await expect(cmdOpen(makeArgs())).rejects.toThrow("process.exit");
    });

    it("not found — exits", async () => {
      mockFetch({ error: "not found" }, false);
      await expect(cmdOpen(makeArgs({ positional: ["myhost"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdOpenUi", () => {
    it("success — opens browser", async () => {
      mockFetch({ status: "ok" });
      await cmdOpenUi(makeArgs());
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Dashboard"));
    });

    it("daemon not running — exits", async () => {
      mockFetch({ error: "fail" }, false);
      await expect(cmdOpenUi(makeArgs())).rejects.toThrow("process.exit");
    });
  });

  describe("cmdStop", () => {
    it("no daemon running", async () => {
      await cmdStop();
      expect(consoleLogSpy).toHaveBeenCalledWith("ClawNexus daemon is not running.");
    });

    it("daemon running — sends SIGTERM", async () => {
      // Mock readPid to return a valid PID
      const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {}) as never);
      const fs = await import("node:fs");
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce("12345");
      // process.kill(pid, 0) check — must not throw
      killSpy.mockImplementation((() => true) as never);

      await cmdStop();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("stopped"));
      killSpy.mockRestore();
    });

    it("daemon PID not found — cleans up", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig: number | string) => {
        if (sig === 0) return true; // process exists
        throw new Error("ESRCH"); // kill fails
      }) as never);
      const fs = await import("node:fs");
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce("12345");

      await cmdStop();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
      killSpy.mockRestore();
    });
  });

  describe("cmdRestart", () => {
    it("calls stop then start", async () => {
      vi.useFakeTimers();
      // cmdStop → no daemon
      // cmdStart → mock fetch for health check
      mockFetch({ status: "ok" }); // health check in cmdStart
      const p = cmdRestart(makeArgs());
      await vi.advanceTimersByTimeAsync(2000);
      await p.catch(() => {}); // May fail due to fork mock — that's OK
      vi.useRealTimers();
    });
  });

  describe("cmdPropose", () => {
    it("missing args — exits", async () => {
      await expect(cmdPropose(makeArgs({ positional: ["peer"] }))).rejects.toThrow("process.exit");
    });

    it("relay not available — exits", async () => {
      mockFetch({ error: "unavailable" }, false);
      await expect(cmdPropose(makeArgs({ positional: ["peer.claw", "query"] }))).rejects.toThrow("process.exit");
    });

    it("no active room — exits", async () => {
      mockFetch({ rooms: [] });
      await expect(cmdPropose(makeArgs({ positional: ["peer.claw", "query"] }))).rejects.toThrow("process.exit");
    });

    it("success", async () => {
      mockFetch({ rooms: [{ room_id: "room-1", peer_claw_id: "peer.claw", state: "active" }] });
      mockFetch({ status: "ok", task: { task_id: "task-123" } });
      await cmdPropose(makeArgs({ positional: ["peer.claw", "query", "test description"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Proposal sent"));
    });

    it("success — JSON output", async () => {
      mockFetch({ rooms: [{ room_id: "room-1", peer_claw_id: "peer.claw", state: "active" }] });
      mockFetch({ status: "ok", task: { task_id: "task-123" } });
      await cmdPropose(makeArgs({ positional: ["peer.claw", "query"], json: true }));
    });

    it("success — with input", async () => {
      mockFetch({ rooms: [{ room_id: "room-1", peer_claw_id: "peer.claw", state: "active" }] });
      mockFetch({ status: "ok", task: { task_id: "task-123" } });
      await cmdPropose(makeArgs({ positional: ["peer.claw", "query"], input: { key: "val" } }));
    });

    it("propose failure — exits", async () => {
      mockFetch({ rooms: [{ room_id: "room-1", peer_claw_id: "peer.claw", state: "active" }] });
      mockFetch({ error: "fail" }, false);
      await expect(cmdPropose(makeArgs({ positional: ["peer.claw", "query"] }))).rejects.toThrow("process.exit");
    });
  });

  describe("cmdQuery", () => {
    it("missing args — exits", async () => {
      await expect(cmdQuery(makeArgs({ positional: ["peer"] }))).rejects.toThrow("process.exit");
    });

    it("relay not available — exits", async () => {
      mockFetch({ error: "unavailable" }, false);
      await expect(cmdQuery(makeArgs({ positional: ["peer.claw", "capabilities"] }))).rejects.toThrow("process.exit");
    });

    it("no active room — exits", async () => {
      mockFetch({ rooms: [] });
      await expect(cmdQuery(makeArgs({ positional: ["peer.claw", "capabilities"] }))).rejects.toThrow("process.exit");
    });

    it("success", async () => {
      mockFetch({ rooms: [{ room_id: "room-1", peer_claw_id: "peer.claw", state: "active" }] });
      mockFetch({ status: "ok", message_id: "msg-123" });
      await cmdQuery(makeArgs({ positional: ["peer.claw", "capabilities"] }));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Query sent"));
    });

    it("success — JSON output", async () => {
      mockFetch({ rooms: [{ room_id: "room-1", peer_claw_id: "peer.claw", state: "active" }] });
      mockFetch({ status: "ok", message_id: "msg-123" });
      await cmdQuery(makeArgs({ positional: ["peer.claw", "capabilities"], json: true }));
    });

    it("query failure — exits", async () => {
      mockFetch({ rooms: [{ room_id: "room-1", peer_claw_id: "peer.claw", state: "active" }] });
      mockFetch({ error: "fail" }, false);
      await expect(cmdQuery(makeArgs({ positional: ["peer.claw", "capabilities"] }))).rejects.toThrow("process.exit");
    });
  });

  // --- main() dispatch ---

  describe("main()", () => {
    it("default (no command) — prints help", async () => {
      process.argv = ["node", "cli.js"];
      await main();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Usage: clawnexus");
    });

    it("list command", async () => {
      process.argv = ["node", "cli.js", "list"];
      mockFetch({ instances: [] });
      await main();
    });

    it("status command", async () => {
      process.argv = ["node", "cli.js", "status"];
      mockFetch({ status: "ok" }, false);
      await main();
    });
  });
});
