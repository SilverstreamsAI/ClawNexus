import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { RegistryStore } from "../../src/registry/store.js";
import { MdnsListener } from "../../src/mdns/listener.js";
import type { MdnsFactory, MdnsInstance } from "../../src/mdns/listener.js";

function createMockMdns() {
  const emitter = new EventEmitter();
  const instance: MdnsInstance = {
    query: vi.fn(),
    on: (e: string, cb: (...args: unknown[]) => void) => {
      emitter.on(e, cb);
    },
    destroy: vi.fn(),
  };
  return { instance, emitter };
}

describe("MdnsListener", () => {
  let tmpDir: string;
  let store: RegistryStore;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    store = new RegistryStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("stop is safe to call multiple times", () => {
    const listener = new MdnsListener(store);
    listener.stop();
    listener.stop();
  });

  it("emits stopped event on stop", () => {
    const listener = new MdnsListener(store);
    const events: string[] = [];
    listener.on("stopped", () => events.push("stopped"));
    listener.stop();
    expect(events).toContain("stopped");
  });

  it("emits warning when factory throws", () => {
    const failFactory: MdnsFactory = () => {
      throw new Error("no multicast-dns");
    };
    const listener = new MdnsListener(store, failFactory);
    const warnings: string[] = [];
    listener.on("warning", (msg: string) => warnings.push(msg));

    listener.start();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mDNS discovery disabled");
    listener.stop();
  });

  describe("with mock mDNS factory", () => {
    let mock: ReturnType<typeof createMockMdns>;
    let listener: MdnsListener;

    beforeEach(() => {
      mock = createMockMdns();
      const factory: MdnsFactory = () => mock.instance;
      listener = new MdnsListener(store, factory);
    });

    afterEach(() => {
      listener.stop();
    });

    it("start() calls factory, sends PTR query, emits started", () => {
      const events: string[] = [];
      listener.on("started", () => events.push("started"));

      listener.start();

      expect(mock.instance.query).toHaveBeenCalledWith({
        questions: [{ name: "_openclaw-gw._tcp.local", type: "PTR" }],
      });
      expect(events).toEqual(["started"]);
    });

    it("stop() calls destroy on mdns instance", () => {
      listener.start();
      listener.stop();
      expect(mock.instance.destroy).toHaveBeenCalled();
    });

    it("parses SRV + A + TXT records and fetches agent_id", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          assistantAgentId: "mdns-agent",
          assistantName: "mDNS Agent",
        }),
      }));

      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "myhost._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "myhost._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "myhost.local" } },
          { name: "myhost.local", type: "A", data: "192.168.1.50" },
          { name: "myhost._openclaw-gw._tcp.local", type: "TXT", data: [Buffer.from("displayName=My Host"), Buffer.from("lanHost=myhost.local")] },
        ],
      });

      await vi.waitFor(() => {
        expect(store.getByNetworkKey("192.168.1.50", 18789)).toBeDefined();
      });

      const inst = store.getByNetworkKey("192.168.1.50", 18789)!;
      expect(inst.address).toBe("192.168.1.50");
      expect(inst.gateway_port).toBe(18789);
      expect(inst.display_name).toBe("My Host");
      expect(inst.lan_host).toBe("myhost.local");
      expect(inst.discovery_source).toBe("mdns");
    });

    it("deduplicates same address:port", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          assistantAgentId: "dedup-agent",
          assistantName: "Dedup",
        }),
      }));

      listener.start();

      const response = {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "host.local" } },
          { name: "host.local", type: "A", data: "192.168.1.60" },
          { name: "host._openclaw-gw._tcp.local", type: "TXT", data: [] },
        ],
      };

      mock.emitter.emit("response", response);
      await vi.waitFor(() => {
        expect(store.size).toBe(1);
      });

      mock.emitter.emit("response", response);
      await new Promise((r) => setTimeout(r, 100));
      expect(store.size).toBe(1);
    });

    it("skips records without A record and no rinfo", async () => {
      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "host.local" } },
        ],
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(store.size).toBe(0);
    });

    it("uses rinfo.address when A record is loopback (OpenClaw default)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ assistantAgentId: "remote-agent", assistantName: "Remote" }),
      }));

      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "openclaw.local" } },
          { name: "openclaw.local", type: "A", data: "127.0.0.1" },
          { name: "host._openclaw-gw._tcp.local", type: "TXT", data: [Buffer.from("displayName=Remote Host")] },
        ],
      }, { address: "192.168.1.105", port: 5353 });

      await vi.waitFor(() => {
        expect(store.getByNetworkKey("192.168.1.105", 18789)).toBeDefined();
      });

      const inst = store.getByNetworkKey("192.168.1.105", 18789)!;
      expect(inst.address).toBe("192.168.1.105");
      expect(inst.discovery_source).toBe("mdns");
    });

    it("uses rinfo.address when A record is absent", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ assistantAgentId: "rinfo-agent", assistantName: "Rinfo" }),
      }));

      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "host.local" } },
        ],
      }, { address: "192.168.1.110", port: 5353 });

      await vi.waitFor(() => {
        expect(store.getByNetworkKey("192.168.1.110", 18789)).toBeDefined();
      });

      expect(store.getByNetworkKey("192.168.1.110", 18789)!.address).toBe("192.168.1.110");
    });

    it("skips when A record is loopback and no rinfo provided", async () => {
      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "openclaw.local" } },
          { name: "openclaw.local", type: "A", data: "127.0.0.1" },
        ],
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(store.size).toBe(0);
    });

    it("ignores responses without PTR records for service type", async () => {
      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_other-service._tcp.local", type: "PTR", data: "foo" },
        ],
        additionals: [],
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(store.size).toBe(0);
    });

    it("handles fetch failure when getting agent_id", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "host.local" } },
          { name: "host.local", type: "A", data: "192.168.1.70" },
        ],
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(store.size).toBe(0);
    });

    it("handles TLS flag from TXT records", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          assistantAgentId: "tls-agent",
          assistantName: "TLS Agent",
        }),
      }));

      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "host.local" } },
          { name: "host.local", type: "A", data: "192.168.1.80" },
          { name: "host._openclaw-gw._tcp.local", type: "TXT", data: [Buffer.from("gatewayTls=1"), Buffer.from("gatewayTlsSha256=abc123")] },
        ],
      });

      await vi.waitFor(() => {
        expect(store.getByNetworkKey("192.168.1.80", 18789)).toBeDefined();
      });

      const inst = store.getByNetworkKey("192.168.1.80", 18789)!;
      expect(inst.tls).toBe(true);
      expect(inst.tls_fingerprint).toBe("abc123");
    });

    it("emits discovered event when instance found", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          assistantAgentId: "event-agent",
          assistantName: "Event",
        }),
      }));

      const discovered: unknown[] = [];
      listener.on("discovered", (inst) => discovered.push(inst));

      listener.start();

      mock.emitter.emit("response", {
        answers: [
          { name: "_openclaw-gw._tcp.local", type: "PTR", data: "host._openclaw-gw._tcp.local" },
        ],
        additionals: [
          { name: "host._openclaw-gw._tcp.local", type: "SRV", data: { port: 18789, target: "host.local" } },
          { name: "host.local", type: "A", data: "192.168.1.90" },
        ],
      });

      await vi.waitFor(() => {
        expect(discovered).toHaveLength(1);
      });
    });
  });
});
