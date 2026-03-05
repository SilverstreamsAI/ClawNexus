/**
 * Comprehensive tests for instance identifier resolution across all CLI-facing API endpoints.
 *
 * CLI commands that accept <id|address> all route through store.resolve().
 * This file covers all 6 identifier forms × all 3 endpoints, plus error cases and list filtering.
 *
 * Covered commands:
 *   clawnexus info <id>        → GET /instances/:id
 *   clawnexus alias <id> <n>   → PUT /instances/:id/alias
 *   clawnexus forget <id>      → DELETE /instances/:id
 *   clawnexus list [--scope]   → GET /instances[?scope=]
 *   clawnexus connect <id>     → GET /instances/:id (same resolve, WS URL built client-side)
 *
 * Identifier forms tested for each endpoint:
 *   1. alias
 *   2. auto_name
 *   3. display_name (case-insensitive)
 *   4. agent_id (unique)
 *   5. bare IP address
 *   6. address:port
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { RegistryStore } from "../../src/registry/store.js";
import { registerInstanceRoutes } from "../../src/api/server.js";
import { makeInstance } from "../fixtures.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, networkInterfaces: vi.fn(() => ({})) };
});

const { ActiveScanner } = await import("../../src/scanner/active.js");

// ─────────────────────────────────────────────
// Shared setup
// ─────────────────────────────────────────────

async function setupApp(): Promise<{
  app: FastifyInstance;
  store: RegistryStore;
  tmpDir: string;
  teardown: () => Promise<void>;
}> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-resolve-"));
  const store = new RegistryStore(tmpDir);
  await store.init();
  const scanner = new ActiveScanner(store);
  const app = Fastify();
  registerInstanceRoutes(app, store, scanner);
  await app.ready();

  return {
    app,
    store,
    tmpDir,
    teardown: async () => {
      await app.close();
      await store.close();
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────
// 1. GET /instances/:id — all identifier forms
// ─────────────────────────────────────────────

describe("GET /instances/:id — identifier resolution", () => {
  let app: FastifyInstance;
  let store: RegistryStore;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ app, store, teardown } = await setupApp());

    const inst = makeInstance({
      agent_id: "unique-agent",
      auto_name: "my-server",
      display_name: "My Server",
      address: "10.0.0.1",
      gateway_port: 18789,
    });
    store.upsert(inst);
    store.setAlias(store.networkKey("10.0.0.1", 18789), "home");
  });

  afterEach(() => teardown());

  it("resolves by alias", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/home" });
    expect(res.statusCode).toBe(200);
    expect(res.json().auto_name).toBe("my-server");
  });

  it("resolves by auto_name", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/my-server" });
    expect(res.statusCode).toBe(200);
    expect(res.json().auto_name).toBe("my-server");
  });

  it("resolves by display_name (case-insensitive)", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/my%20server" });
    expect(res.statusCode).toBe(200);
    expect(res.json().display_name).toBe("My Server");
  });

  it("resolves by agent_id when unique", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/unique-agent" });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent_id).toBe("unique-agent");
  });

  it("resolves by bare IP address", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/10.0.0.1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe("10.0.0.1");
  });

  it("resolves by address:port", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/10.0.0.1%3A18789" });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe("10.0.0.1");
    expect(res.json().gateway_port).toBe(18789);
  });

  it("returns 404 for unknown identifier", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/nonexistent" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Instance not found");
  });

  it("returns 404 when agent_id is ambiguous (multiple 'main')", async () => {
    store.upsert(makeInstance({ agent_id: "main", address: "10.0.0.2", auto_name: "s1" }));
    store.upsert(makeInstance({ agent_id: "main", address: "10.0.0.3", auto_name: "s2" }));
    const res = await app.inject({ method: "GET", url: "/instances/main" });
    expect(res.statusCode).toBe(404);
  });

  it("alias takes priority over auto_name with same string", async () => {
    // Another instance whose auto_name equals our alias "home"
    store.upsert(makeInstance({ address: "10.0.0.9", auto_name: "home" }));
    // "home" should still resolve to the aliased one
    const res = await app.inject({ method: "GET", url: "/instances/home" });
    expect(res.statusCode).toBe(200);
    expect(res.json().address).toBe("10.0.0.1");
  });
});

// ─────────────────────────────────────────────
// 2. PUT /instances/:id/alias — all identifier forms
// ─────────────────────────────────────────────

describe("PUT /instances/:id/alias — identifier resolution", () => {
  let app: FastifyInstance;
  let store: RegistryStore;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ app, store, teardown } = await setupApp());

    const inst = makeInstance({
      agent_id: "unique-agent",
      auto_name: "my-server",
      display_name: "My Server",
      address: "10.0.0.1",
      gateway_port: 18789,
    });
    store.upsert(inst);
    store.setAlias(store.networkKey("10.0.0.1", 18789), "home");
  });

  afterEach(() => teardown());

  it("sets alias when resolved by current alias", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/home/alias",
      payload: { alias: "renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alias).toBe("renamed");
    expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("renamed");
  });

  it("sets alias when resolved by auto_name", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/my-server/alias",
      payload: { alias: "new-alias" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("new-alias");
  });

  it("sets alias when resolved by display_name", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/my%20server/alias",
      payload: { alias: "display-alias" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("display-alias");
  });

  it("sets alias when resolved by agent_id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/unique-agent/alias",
      payload: { alias: "agent-alias" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("agent-alias");
  });

  it("sets alias when resolved by bare IP", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/10.0.0.1/alias",
      payload: { alias: "ip-alias" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("ip-alias");
  });

  it("sets alias when resolved by address:port", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/10.0.0.1%3A18789/alias",
      payload: { alias: "port-alias" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getByNetworkKey("10.0.0.1", 18789)!.alias).toBe("port-alias");
  });

  it("returns 404 for unknown identifier", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/nope/alias",
      payload: { alias: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 for duplicate alias", async () => {
    store.upsert(makeInstance({ address: "10.0.0.2", auto_name: "other" }));
    const res = await app.inject({
      method: "PUT",
      url: "/instances/other/alias",
      payload: { alias: "home" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 400 for missing alias body", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/my-server/alias",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid alias format (uppercase)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/my-server/alias",
      payload: { alias: "BAD_ALIAS" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────
// 3. DELETE /instances/:id — all identifier forms
// ─────────────────────────────────────────────

describe("DELETE /instances/:id — identifier resolution", () => {
  let app: FastifyInstance;
  let store: RegistryStore;
  let teardown: () => Promise<void>;

  function seed() {
    const inst = makeInstance({
      agent_id: "unique-agent",
      auto_name: "my-server",
      display_name: "My Server",
      address: "10.0.0.1",
      gateway_port: 18789,
    });
    store.upsert(inst);
    store.setAlias(store.networkKey("10.0.0.1", 18789), "home");
  }

  beforeEach(async () => {
    ({ app, store, teardown } = await setupApp());
  });

  afterEach(() => teardown());

  it("removes instance when resolved by alias", async () => {
    seed();
    const res = await app.inject({ method: "DELETE", url: "/instances/home" });
    expect(res.statusCode).toBe(200);
    expect(store.size).toBe(0);
  });

  it("removes instance when resolved by auto_name", async () => {
    seed();
    const res = await app.inject({ method: "DELETE", url: "/instances/my-server" });
    expect(res.statusCode).toBe(200);
    expect(store.size).toBe(0);
  });

  it("removes instance when resolved by display_name", async () => {
    seed();
    const res = await app.inject({ method: "DELETE", url: "/instances/my%20server" });
    expect(res.statusCode).toBe(200);
    expect(store.size).toBe(0);
  });

  it("removes instance when resolved by agent_id", async () => {
    seed();
    const res = await app.inject({ method: "DELETE", url: "/instances/unique-agent" });
    expect(res.statusCode).toBe(200);
    expect(store.size).toBe(0);
  });

  it("removes instance when resolved by bare IP", async () => {
    seed();
    const res = await app.inject({ method: "DELETE", url: "/instances/10.0.0.1" });
    expect(res.statusCode).toBe(200);
    expect(store.size).toBe(0);
  });

  it("removes instance when resolved by address:port", async () => {
    seed();
    const res = await app.inject({ method: "DELETE", url: "/instances/10.0.0.1%3A18789" });
    expect(res.statusCode).toBe(200);
    expect(store.size).toBe(0);
  });

  it("returns 404 for unknown identifier", async () => {
    const res = await app.inject({ method: "DELETE", url: "/instances/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────
// 4. GET /instances — list filtering (clawnexus list --scope)
// ─────────────────────────────────────────────

describe("GET /instances — list and scope filtering", () => {
  let app: FastifyInstance;
  let store: RegistryStore;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ app, store, teardown } = await setupApp());

    store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "local-1", network_scope: "local" }));
    store.upsert(makeInstance({ address: "10.0.0.2", auto_name: "local-2", network_scope: "local" }));
    store.upsert(makeInstance({ address: "10.66.0.1", auto_name: "vpn-1", network_scope: "vpn" }));
    store.upsert(makeInstance({ address: "1.2.3.4", auto_name: "public-1", network_scope: "public" }));
  });

  afterEach(() => teardown());

  it("returns all instances when no scope filter", async () => {
    const res = await app.inject({ method: "GET", url: "/instances" });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(4);
  });

  it("filters by scope=local", async () => {
    const res = await app.inject({ method: "GET", url: "/instances?scope=local" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.instances.every((i: { network_scope: string }) => i.network_scope === "local")).toBe(true);
  });

  it("filters by scope=vpn", async () => {
    const res = await app.inject({ method: "GET", url: "/instances?scope=vpn" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.instances[0].auto_name).toBe("vpn-1");
  });

  it("filters by scope=public", async () => {
    const res = await app.inject({ method: "GET", url: "/instances?scope=public" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.instances[0].auto_name).toBe("public-1");
  });

  it("returns empty list for scope with no matches", async () => {
    const res = await app.inject({ method: "GET", url: "/instances?scope=public" });
    const body = res.json();
    // Remove public instance and re-check
    store.remove(store.networkKey("1.2.3.4", 18789));
    const res2 = await app.inject({ method: "GET", url: "/instances?scope=public" });
    expect(res2.json().count).toBe(0);
    expect(res2.json().instances).toEqual([]);
  });

  it("response includes expected fields per instance", async () => {
    const res = await app.inject({ method: "GET", url: "/instances?scope=local" });
    const inst = res.json().instances[0];
    expect(inst).toHaveProperty("agent_id");
    expect(inst).toHaveProperty("auto_name");
    expect(inst).toHaveProperty("address");
    expect(inst).toHaveProperty("status");
    expect(inst).toHaveProperty("network_scope");
  });
});

// ─────────────────────────────────────────────
// 5. Identifier priority order
// ─────────────────────────────────────────────

describe("resolve() priority: alias > auto_name > display_name > agent_id > address", () => {
  let app: FastifyInstance;
  let store: RegistryStore;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ app, store, teardown } = await setupApp());
  });

  afterEach(() => teardown());

  it("alias beats auto_name", async () => {
    store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "winner", alias: undefined }));
    store.upsert(makeInstance({ address: "10.0.0.2", auto_name: "loser" }));
    store.setAlias(store.networkKey("10.0.0.2", 18789), "winner");

    const res = await app.inject({ method: "GET", url: "/instances/winner" });
    expect(res.json().address).toBe("10.0.0.2");
  });

  it("auto_name beats display_name", async () => {
    store.upsert(makeInstance({ address: "10.0.0.1", auto_name: "target", display_name: "Other" }));
    store.upsert(makeInstance({ address: "10.0.0.2", auto_name: "other", display_name: "target" }));

    const res = await app.inject({ method: "GET", url: "/instances/target" });
    expect(res.json().address).toBe("10.0.0.1");
  });

  it("display_name beats agent_id", async () => {
    store.upsert(makeInstance({ address: "10.0.0.1", display_name: "target", agent_id: "other-id", auto_name: "s1" }));
    store.upsert(makeInstance({ address: "10.0.0.2", display_name: "other", agent_id: "target", auto_name: "s2" }));

    const res = await app.inject({ method: "GET", url: "/instances/target" });
    expect(res.json().address).toBe("10.0.0.1");
  });

  it("agent_id beats address when unique", async () => {
    // agent_id "10.0.0.2" looks like an IP but should match agent_id first
    store.upsert(makeInstance({ address: "10.0.0.1", agent_id: "10.0.0.2", auto_name: "s1" }));
    store.upsert(makeInstance({ address: "10.0.0.2", agent_id: "other", auto_name: "s2" }));

    const res = await app.inject({ method: "GET", url: "/instances/10.0.0.2" });
    // agent_id match is NOT above address in priority; address match should return s2
    // Actually: priority is alias > auto_name > display_name > agent_id > address
    // "10.0.0.2" matches agent_id of s1 AND address of s2; agent_id wins (step 4 before step 5)
    expect(res.json().address).toBe("10.0.0.1");
  });
});
