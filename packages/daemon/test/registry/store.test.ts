import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RegistryStore, AliasError, AliasConflictError, NotFoundError } from "../../src/registry/store.js";
import { makeInstance } from "../fixtures.js";

describe("RegistryStore", () => {
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

  describe("init", () => {
    it("creates config directory if missing", () => {
      expect(fs.existsSync(tmpDir)).toBe(true);
    });

    it("loads v3 registry file", async () => {
      const inst = makeInstance({ agent_id: "existing-1", address: "10.0.0.1", gateway_port: 18789, auto_name: "my-server" });
      const data = {
        schema_version: "3",
        updated_at: new Date().toISOString(),
        instances: [inst],
      };
      await fs.promises.writeFile(
        path.join(tmpDir, "registry.json"),
        JSON.stringify(data),
      );

      const store2 = new RegistryStore(tmpDir);
      await store2.init();
      expect(store2.getByNetworkKey("10.0.0.1", 18789)).toBeDefined();
      expect(store2.getByNetworkKey("10.0.0.1", 18789)!.auto_name).toBe("my-server");
      expect(store2.size).toBe(1);
      await store2.close();
    });

    it("migrates v2 registry to v4 (generates auto_name, re-keys by networkKey, saves as v4)", async () => {
      const inst = {
        agent_id: "old-agent",
        assistant_name: "Old",
        display_name: "Old Display",
        lan_host: "macbook.local",
        address: "192.168.1.50",
        gateway_port: 18789,
        tls: false,
        discovery_source: "scan",
        network_scope: "local",
        status: "online",
        last_seen: new Date().toISOString(),
        discovered_at: new Date().toISOString(),
      };
      const data = {
        schema_version: "2",
        updated_at: new Date().toISOString(),
        instances: [inst],
      };
      await fs.promises.writeFile(
        path.join(tmpDir, "registry.json"),
        JSON.stringify(data),
      );

      const store2 = new RegistryStore(tmpDir);
      await store2.init();
      expect(store2.size).toBe(1);
      const migrated = store2.getByNetworkKey("192.168.1.50", 18789);
      expect(migrated).toBeDefined();
      expect(migrated!.auto_name).toBe("macbook");
      await store2.close();

      // Verify it persists as v4
      await new Promise((r) => setTimeout(r, 600)); // wait for debounced flush
      const raw = await fs.promises.readFile(path.join(tmpDir, "registry.json"), "utf-8");
      const persisted = JSON.parse(raw);
      expect(persisted.schema_version).toBe("5");
    });

    it("migrates v3 registry to v4 (renames tailscale → vpn in network_scope)", async () => {
      const inst = makeInstance({ agent_id: "vpn-agent", address: "10.66.66.3", gateway_port: 18789, auto_name: "remote-peer" });
      (inst as { network_scope: string }).network_scope = "tailscale";
      const data = {
        schema_version: "3",
        updated_at: new Date().toISOString(),
        instances: [inst],
      };
      await fs.promises.writeFile(
        path.join(tmpDir, "registry.json"),
        JSON.stringify(data),
      );

      const store2 = new RegistryStore(tmpDir);
      await store2.init();
      const migrated = store2.getByNetworkKey("10.66.66.3", 18789);
      expect(migrated).toBeDefined();
      expect(migrated!.network_scope).toBe("vpn");
      await store2.close();

      await new Promise((r) => setTimeout(r, 600));
      const raw = await fs.promises.readFile(path.join(tmpDir, "registry.json"), "utf-8");
      const persisted = JSON.parse(raw);
      expect(persisted.schema_version).toBe("5");
      expect(persisted.instances[0].network_scope).toBe("vpn");
    });

    it("handles corrupted registry file gracefully", async () => {
      await fs.promises.writeFile(
        path.join(tmpDir, "registry.json"),
        "not valid json{{{",
      );

      const store2 = new RegistryStore(tmpDir);
      await store2.init();
      expect(store2.size).toBe(0);
      await store2.close();
    });
  });

  describe("networkKey", () => {
    it("formats address:port", () => {
      expect(store.networkKey("192.168.1.1", 18789)).toBe("192.168.1.1:18789");
    });
  });

  describe("upsert", () => {
    it("adds a new instance keyed by networkKey", () => {
      const inst = makeInstance({ address: "10.0.0.1", gateway_port: 18789 });
      store.upsert(inst);
      expect(store.size).toBe(1);
      expect(store.getByNetworkKey("10.0.0.1", 18789)).toBeDefined();
    });

    it("generates auto_name on first upsert when auto_name is empty", () => {
      const inst = makeInstance({ auto_name: "", lan_host: "raspi.local", address: "10.0.0.1" });
      store.upsert(inst);
      expect(store.getByNetworkKey("10.0.0.1", 18789)!.auto_name).toBe("raspi");
    });

    it("preserves existing auto_name on update", () => {
      const inst = makeInstance({ auto_name: "first-name", address: "10.0.0.1" });
      store.upsert(inst);

      const updated = makeInstance({ auto_name: "", address: "10.0.0.1", lan_host: "different.local" });
      store.upsert(updated);

      expect(store.getByNetworkKey("10.0.0.1", 18789)!.auto_name).toBe("first-name");
    });

    it("allows two instances with same agent_id at different addresses", () => {
      const inst1 = makeInstance({ agent_id: "main", address: "10.0.0.1", auto_name: "server-1" });
      const inst2 = makeInstance({ agent_id: "main", address: "10.0.0.2", auto_name: "server-2" });
      store.upsert(inst1);
      store.upsert(inst2);
      expect(store.size).toBe(2);
    });

    it("deduplicates auto_name with suffix", () => {
      const inst1 = makeInstance({ auto_name: "", lan_host: "raspi.local", address: "10.0.0.1" });
      store.upsert(inst1);

      const inst2 = makeInstance({ auto_name: "", lan_host: "raspi.local", address: "10.0.0.2" });
      store.upsert(inst2);

      const names = store.getAll().map((i) => i.auto_name);
      expect(names).toContain("raspi");
      expect(names).toContain("raspi-2");
    });

    it("preserves alias on update", () => {
      const inst = makeInstance({ address: "10.0.0.1", alias: "my-alias" });
      store.upsert(inst);

      const updated = makeInstance({ address: "10.0.0.1", status: "offline" });
      store.upsert(updated);

      expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("my-alias");
    });

    it("preserves labels on update", () => {
      const inst = makeInstance({ address: "10.0.0.1", labels: { env: "prod" } });
      store.upsert(inst);

      const updated = makeInstance({ address: "10.0.0.1" });
      store.upsert(updated);

      expect(store.getByNetworkKey("10.0.0.1", 18789)!.labels).toEqual({ env: "prod" });
    });

    it("preserves discovered_at on update", () => {
      const original = "2025-01-01T00:00:00.000Z";
      const inst = makeInstance({ address: "10.0.0.1", discovered_at: original });
      store.upsert(inst);

      const updated = makeInstance({ address: "10.0.0.1", discovered_at: "2026-01-01T00:00:00.000Z" });
      store.upsert(updated);

      expect(store.getByNetworkKey("10.0.0.1", 18789)!.discovered_at).toBe(original);
    });

    it("emits upsert event", () => {
      const events: unknown[] = [];
      store.on("upsert", (inst) => events.push(inst));

      const inst = makeInstance();
      store.upsert(inst);
      expect(events).toHaveLength(1);
    });
  });

  describe("resolve", () => {
    it("resolves by alias (highest priority)", () => {
      const inst = makeInstance({ address: "10.0.0.1", alias: "home", auto_name: "server" });
      store.upsert(inst);
      expect(store.resolve("home")?.auto_name).toBe("server");
    });

    it("resolves by auto_name", () => {
      const inst = makeInstance({ address: "10.0.0.1", auto_name: "macbook-pro" });
      store.upsert(inst);
      expect(store.resolve("macbook-pro")?.address).toBe("10.0.0.1");
    });

    it("resolves by display_name", () => {
      const inst = makeInstance({ address: "10.0.0.1", display_name: "My Server", auto_name: "server" });
      store.upsert(inst);
      expect(store.resolve("my server")?.auto_name).toBe("server");
    });

    it("resolves by agent_id when unique", () => {
      const inst = makeInstance({ address: "10.0.0.1", agent_id: "unique-agent", auto_name: "server" });
      store.upsert(inst);
      expect(store.resolve("unique-agent")?.auto_name).toBe("server");
    });

    it("returns undefined when agent_id matches multiple instances", () => {
      const inst1 = makeInstance({ agent_id: "main", address: "10.0.0.1", auto_name: "server-1" });
      const inst2 = makeInstance({ agent_id: "main", address: "10.0.0.2", auto_name: "server-2" });
      store.upsert(inst1);
      store.upsert(inst2);
      expect(store.resolve("main")).toBeUndefined();
    });

    it("resolves by address", () => {
      const inst = makeInstance({ address: "10.0.0.5", auto_name: "server" });
      store.upsert(inst);
      expect(store.resolve("10.0.0.5")?.auto_name).toBe("server");
    });

    it("alias takes priority over auto_name", () => {
      const inst1 = makeInstance({ address: "10.0.0.1", auto_name: "target", alias: "other" });
      const inst2 = makeInstance({ address: "10.0.0.2", auto_name: "something", alias: "target" });
      store.upsert(inst1);
      store.upsert(inst2);
      expect(store.resolve("target")?.auto_name).toBe("something");
    });

    it("auto_name takes priority over agent_id", () => {
      const inst1 = makeInstance({ address: "10.0.0.1", auto_name: "my-name", agent_id: "other" });
      const inst2 = makeInstance({ address: "10.0.0.2", auto_name: "other-name", agent_id: "my-name" });
      store.upsert(inst1);
      store.upsert(inst2);
      expect(store.resolve("my-name")?.address).toBe("10.0.0.1");
    });

    it("returns undefined for unknown query", () => {
      expect(store.resolve("nonexistent")).toBeUndefined();
    });
  });

  describe("resolveAll", () => {
    it("returns all matching instances", () => {
      const inst1 = makeInstance({ agent_id: "main", address: "10.0.0.1", auto_name: "s1" });
      const inst2 = makeInstance({ agent_id: "main", address: "10.0.0.2", auto_name: "s2" });
      store.upsert(inst1);
      store.upsert(inst2);
      expect(store.resolveAll("main")).toHaveLength(2);
    });
  });

  describe("findByAgentId", () => {
    it("returns all instances with matching agent_id", () => {
      const inst1 = makeInstance({ agent_id: "main", address: "10.0.0.1", auto_name: "s1" });
      const inst2 = makeInstance({ agent_id: "main", address: "10.0.0.2", auto_name: "s2" });
      const inst3 = makeInstance({ agent_id: "other", address: "10.0.0.3", auto_name: "s3" });
      store.upsert(inst1);
      store.upsert(inst2);
      store.upsert(inst3);
      expect(store.findByAgentId("main")).toHaveLength(2);
    });
  });

  describe("setAlias", () => {
    it("sets alias using networkKey", () => {
      const inst = makeInstance({ address: "10.0.0.1" });
      store.upsert(inst);
      const nk = store.networkKey("10.0.0.1", 18789);
      store.setAlias(nk, "home");
      expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("home");
    });

    it("rejects invalid alias format", () => {
      const inst = makeInstance({ address: "10.0.0.1" });
      store.upsert(inst);
      const nk = store.networkKey("10.0.0.1", 18789);
      expect(() => store.setAlias(nk, "UPPER")).toThrow(AliasError);
      expect(() => store.setAlias(nk, "-start")).toThrow(AliasError);
      expect(() => store.setAlias(nk, "")).toThrow(AliasError);
    });

    it("rejects duplicate alias (409 conflict)", () => {
      const inst1 = makeInstance({ address: "10.0.0.1" });
      const inst2 = makeInstance({ address: "10.0.0.2" });
      store.upsert(inst1);
      store.upsert(inst2);
      const nk1 = store.networkKey("10.0.0.1", 18789);
      const nk2 = store.networkKey("10.0.0.2", 18789);
      store.setAlias(nk1, "home");
      expect(() => store.setAlias(nk2, "home")).toThrow(AliasConflictError);
    });

    it("allows same alias re-assignment to same instance", () => {
      const inst = makeInstance({ address: "10.0.0.1" });
      store.upsert(inst);
      const nk = store.networkKey("10.0.0.1", 18789);
      store.setAlias(nk, "home");
      expect(() => store.setAlias(nk, "home")).not.toThrow();
    });

    it("throws NotFoundError for unknown networkKey", () => {
      expect(() => store.setAlias("1.2.3.4:99999", "home")).toThrow(NotFoundError);
    });

    it("emits alias event", () => {
      const events: unknown[] = [];
      store.on("alias", (...args) => events.push(args));
      const inst = makeInstance({ address: "10.0.0.1" });
      store.upsert(inst);
      const nk = store.networkKey("10.0.0.1", 18789);
      store.setAlias(nk, "home");
      expect(events).toHaveLength(1);
    });
  });

  describe("remove", () => {
    it("removes an instance by networkKey", () => {
      const inst = makeInstance({ address: "10.0.0.1" });
      store.upsert(inst);
      const nk = store.networkKey("10.0.0.1", 18789);
      expect(store.remove(nk)).toBe(true);
      expect(store.size).toBe(0);
    });

    it("returns false for unknown networkKey", () => {
      expect(store.remove("1.2.3.4:99999")).toBe(false);
    });

    it("emits remove event", () => {
      const events: string[] = [];
      store.on("remove", (id) => events.push(id));
      const inst = makeInstance({ address: "10.0.0.1" });
      store.upsert(inst);
      const nk = store.networkKey("10.0.0.1", 18789);
      store.remove(nk);
      expect(events).toEqual([nk]);
    });
  });

  describe("flush / persistence", () => {
    it("persists data to disk on close as v3", async () => {
      const inst = makeInstance({ address: "10.0.0.1", auto_name: "persist-test" });
      store.upsert(inst);
      await store.close();

      const raw = await fs.promises.readFile(
        path.join(tmpDir, "registry.json"),
        "utf-8",
      );
      const data = JSON.parse(raw);
      expect(data.schema_version).toBe("5");
      expect(data.instances).toHaveLength(1);
      expect(data.instances[0].auto_name).toBe("persist-test");
    });
  });

  describe("getAll", () => {
    it("returns all instances", () => {
      store.upsert(makeInstance({ address: "10.0.0.1" }));
      store.upsert(makeInstance({ address: "10.0.0.2" }));
      expect(store.getAll()).toHaveLength(2);
    });
  });
});
