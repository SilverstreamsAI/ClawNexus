import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { RegistryStore } from "../../src/registry/store.js";
import { registerInstanceRoutes } from "../../src/api/server.js";
import { makeInstance } from "../fixtures.js";

// Mock os.networkInterfaces for ActiveScanner
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, networkInterfaces: vi.fn(() => actual.networkInterfaces()) };
});

const { ActiveScanner } = await import("../../src/scanner/active.js");

describe("Instance API routes", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let scanner: InstanceType<typeof ActiveScanner>;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    scanner = new ActiveScanner(store);

    app = Fastify();
    app.get("/health", async () => ({
      status: "ok",
      service: "clawnexus-daemon",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      components: {
        registry: { instances: store.size },
        mdns: "active",
        health_checker: "active",
        scanner: scanner.isScanning ? "scanning" : "idle",
      },
    }));
    registerInstanceRoutes(app, store, scanner);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("GET /health", () => {
    it("returns health status", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.service).toBe("clawnexus-daemon");
      expect(body.components.registry.instances).toBe(0);
    });
  });

  describe("GET /instances", () => {
    it("returns empty list initially", async () => {
      const res = await app.inject({ method: "GET", url: "/instances" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(0);
      expect(body.instances).toEqual([]);
    });

    it("returns all instances", async () => {
      store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "s1" }));
      store.upsert(makeInstance({ address: "10.0.0.2", auto_name: "s2" }));

      const res = await app.inject({ method: "GET", url: "/instances" });
      const body = res.json();
      expect(body.count).toBe(2);
      expect(body.instances).toHaveLength(2);
    });
  });

  describe("GET /instances/:id", () => {
    it("returns instance by auto_name", async () => {
      store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "my-server", agent_id: "a1" }));

      const res = await app.inject({ method: "GET", url: "/instances/my-server" });
      expect(res.statusCode).toBe(200);
      expect(res.json().auto_name).toBe("my-server");
    });

    it("resolves by alias", async () => {
      const inst = makeInstance({ address: "10.0.0.1", auto_name: "server" });
      store.upsert(inst);
      const nk = store.networkKey("10.0.0.1", 18789);
      store.setAlias(nk, "home");

      const res = await app.inject({ method: "GET", url: "/instances/home" });
      expect(res.statusCode).toBe(200);
      expect(res.json().alias).toBe("home");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.inject({ method: "GET", url: "/instances/unknown" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("Instance not found");
    });
  });

  describe("PUT /instances/:id/alias", () => {
    it("sets alias on instance", async () => {
      store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "server" }));

      const res = await app.inject({
        method: "PUT",
        url: "/instances/server/alias",
        payload: { alias: "home" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().alias).toBe("home");
      expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("home");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/instances/unknown/alias",
        payload: { alias: "home" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for missing alias", async () => {
      store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "server" }));
      const res = await app.inject({
        method: "PUT",
        url: "/instances/server/alias",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for invalid alias format", async () => {
      store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "server" }));
      const res = await app.inject({
        method: "PUT",
        url: "/instances/server/alias",
        payload: { alias: "INVALID" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 409 for duplicate alias", async () => {
      store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "s1" }));
      store.upsert(makeInstance({ address: "10.0.0.2", auto_name: "s2" }));
      const nk1 = store.networkKey("10.0.0.1", 18789);
      store.setAlias(nk1, "home");

      const res = await app.inject({
        method: "PUT",
        url: "/instances/s2/alias",
        payload: { alias: "home" },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("DELETE /instances/:id", () => {
    it("removes an instance", async () => {
      store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "server" }));

      const res = await app.inject({ method: "DELETE", url: "/instances/server" });
      expect(res.statusCode).toBe(200);
      expect(res.json().removed).toBe("server");
      expect(store.size).toBe(0);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.inject({ method: "DELETE", url: "/instances/unknown" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /scan", () => {
    it("triggers scan and returns results", async () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({});
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));

      const res = await app.inject({ method: "POST", url: "/scan" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.discovered).toBe(0);
    });
  });
});
