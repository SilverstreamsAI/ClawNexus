/**
 * E2E lifecycle tests for three previously unverified scenarios:
 *   1. mDNS auto-discovery (mock mDNS + mock HTTP)
 *   2. Health check status transitions (online ↔ offline)
 *   3. Persistence across restart (flush + reload)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { RegistryStore } from "../src/registry/store.js";
import { ActiveScanner } from "../src/scanner/active.js";
import { HealthChecker } from "../src/health/checker.js";
import { MdnsListener } from "../src/mdns/listener.js";
import type { MdnsInstance } from "../src/mdns/listener.js";
import { registerInstanceRoutes } from "../src/api/server.js";

// --- Helpers (reused from e2e-scan.test.ts patterns) ---

function createMockOpenClaw(agentId: string, name: string): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        basePath: "",
        assistantName: name,
        assistantAvatar: name[0],
        assistantAgentId: agentId,
      }),
    );
  });
}

function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server port"));
      }
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ──────────────────────────────────────────────────────────────
// 1. mDNS auto-discovery E2E
// ──────────────────────────────────────────────────────────────

describe("E2E: mDNS auto-discovery", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let listener: MdnsListener;
  let app: FastifyInstance;
  let scanner: ActiveScanner;
  let mockServer: http.Server;
  let mockPort: number;
  let responseHandler: ((response: unknown) => void) | null = null;

  function createFakeMdns(): MdnsInstance {
    return {
      query: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "response") {
          responseHandler = cb;
        }
      }),
      destroy: vi.fn(),
    };
  }

  function emitMdnsResponse(address: string, port: number, target: string) {
    if (!responseHandler) throw new Error("No response handler registered");
    responseHandler({
      answers: [
        { name: "_openclaw-gw._tcp.local", type: "PTR", data: target },
      ],
      additionals: [
        {
          name: target,
          type: "SRV",
          data: { port, target: `${target}.local` },
        },
        {
          name: target,
          type: "TXT",
          data: [
            Buffer.from(`displayName=MockAgent`),
            Buffer.from(`lanHost=${target}.local`),
            Buffer.from(`gatewayPort=${port}`),
          ],
        },
        {
          name: `${target}.local`,
          type: "A",
          data: address,
        },
      ],
    }, { address, port: 5353 });
  }

  beforeAll(async () => {
    mockServer = createMockOpenClaw("mdns-agent", "MdnsAssistant");
    mockPort = await listenOnRandomPort(mockServer);

    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-e2e-mdns-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    scanner = new ActiveScanner(store);
    listener = new MdnsListener(store, createFakeMdns);

    app = Fastify();
    registerInstanceRoutes(app, store, scanner);
    await app.ready();
  });

  afterAll(async () => {
    listener.stop();
    await app.close();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await closeServer(mockServer);
  });

  it("discovers instance via mDNS response and registers in store", async () => {
    listener.start();

    // Emit a fake mDNS response pointing to our mock server
    emitMdnsResponse("127.0.0.1", mockPort, "mock-openclaw");

    // MdnsListener.handleResponse is async — wait for the discovered event
    await vi.waitFor(() => {
      expect(store.size).toBe(1);
    }, { timeout: 5_000 });

    const inst = store.getByNetworkKey("127.0.0.1", mockPort);
    expect(inst).toBeDefined();
    expect(inst!.discovery_source).toBe("mdns");
    expect(inst!.status).toBe("online");
    expect(inst!.gateway_port).toBe(mockPort);
    expect(inst!.display_name).toBe("MockAgent");
  });

  it("deduplicates same address:port on repeated mDNS response", async () => {
    // Emit the same response again
    emitMdnsResponse("127.0.0.1", mockPort, "mock-openclaw");

    // Give it a moment
    await new Promise((r) => setTimeout(r, 200));

    // Still only 1 instance
    expect(store.size).toBe(1);
  });

  it("mDNS-discovered instance is visible via API", async () => {
    // Resolve via auto_name or agent_id
    const inst2 = store.getByNetworkKey("127.0.0.1", mockPort)!;
    const res = await app.inject({ method: "GET", url: `/instances/${encodeURIComponent(inst2.auto_name)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent_id).toBe("mdns-agent");
    expect(body.discovery_source).toBe("mdns");
  });
});

// ──────────────────────────────────────────────────────────────
// 2. Health check status transitions E2E
// ──────────────────────────────────────────────────────────────

describe("E2E: health check status transitions", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let scanner: ActiveScanner;
  let healthChecker: HealthChecker;
  let app: FastifyInstance;
  let mockServer: http.Server;
  let port: number;

  beforeAll(async () => {
    mockServer = createMockOpenClaw("health-agent", "HealthAssistant");
    port = await listenOnRandomPort(mockServer);

    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-e2e-health-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    scanner = new ActiveScanner(store);
    healthChecker = new HealthChecker(store);

    app = Fastify();
    registerInstanceRoutes(app, store, scanner);
    await app.ready();
  });

  afterAll(async () => {
    healthChecker.stop();
    await app.close();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    // Server may already be closed; ignore errors
    await closeServer(mockServer).catch(() => {});
  });

  it("full online → offline → online cycle with API visibility", async () => {
    // Step 1: Scan to discover instance (should be online)
    const scanRes = await app.inject({
      method: "POST",
      url: "/scan",
      payload: { targets: [`127.0.0.1:${port}`] },
    });
    expect(scanRes.statusCode).toBe(200);
    expect(scanRes.json().discovered).toBe(1);

    const nk = store.networkKey("127.0.0.1", port);
    const inst1 = store.getByNetworkKey("127.0.0.1", port)!;
    expect(inst1.status).toBe("online");
    const lastSeenOnline = inst1.last_seen;
    const autoName = inst1.auto_name;

    // Step 2: Close mock server → health check → status becomes offline
    await closeServer(mockServer);

    // Small delay so last_seen timestamp would differ if updated
    await new Promise((r) => setTimeout(r, 50));

    await healthChecker.checkAll();

    const inst2 = store.getByNetworkKey("127.0.0.1", port)!;
    expect(inst2.status).toBe("offline");
    // last_seen should NOT update when going offline
    expect(inst2.last_seen).toBe(lastSeenOnline);

    // Verify API shows offline
    const apiRes1 = await app.inject({ method: "GET", url: `/instances/${encodeURIComponent(autoName)}` });
    expect(apiRes1.json().status).toBe("offline");

    // Step 3: Restart mock server on same port → health check → online again
    mockServer = createMockOpenClaw("health-agent", "HealthAssistant");
    await new Promise<void>((resolve, reject) => {
      mockServer.listen(port, "127.0.0.1", () => resolve());
      mockServer.on("error", reject);
    });

    await healthChecker.checkAll();

    const inst3 = store.getByNetworkKey("127.0.0.1", port)!;
    expect(inst3.status).toBe("online");
    // last_seen should be updated now
    expect(new Date(inst3.last_seen).getTime()).toBeGreaterThanOrEqual(
      new Date(lastSeenOnline).getTime(),
    );

    // Verify API shows online
    const apiRes2 = await app.inject({ method: "GET", url: `/instances/${encodeURIComponent(autoName)}` });
    expect(apiRes2.json().status).toBe("online");
  });
});

// ──────────────────────────────────────────────────────────────
// 3. Persistence across restart E2E
// ──────────────────────────────────────────────────────────────

describe("E2E: persistence across restart", () => {
  let tmpDir: string;
  let mockServer: http.Server;
  let port: number;

  beforeAll(async () => {
    mockServer = createMockOpenClaw("persist-agent", "PersistAssistant");
    port = await listenOnRandomPort(mockServer);
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-e2e-persist-"));
  });

  afterAll(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await closeServer(mockServer);
  });

  it("data survives store close + reopen, including alias and labels", async () => {
    // Phase 1: Create store, discover instance, set alias + labels
    const store1 = new RegistryStore(tmpDir);
    await store1.init();
    const scanner1 = new ActiveScanner(store1);

    const discovered = await scanner1.scan({ targets: [`127.0.0.1:${port}`] });
    expect(discovered.length).toBe(1);
    expect(discovered[0].agent_id).toBe("persist-agent");

    // Set alias using networkKey
    const nk = store1.networkKey("127.0.0.1", port);
    store1.setAlias(nk, "my-home");

    // Set labels via direct mutation + upsert
    const inst = store1.getByNetworkKey("127.0.0.1", port)!;
    inst.labels = { env: "test", role: "primary" };
    store1.upsert(inst);

    const originalDiscoveredAt = inst.discovered_at;
    const originalLastSeen = inst.last_seen;

    // Close store (triggers flush)
    await store1.close();

    // Phase 2: Create brand-new store pointing to same dir
    const store2 = new RegistryStore(tmpDir);
    await store2.init();

    expect(store2.size).toBe(1);

    const reloaded = store2.getByNetworkKey("127.0.0.1", port)!;
    expect(reloaded).toBeDefined();
    expect(reloaded.agent_id).toBe("persist-agent");
    expect(reloaded.auto_name).toBeTruthy();
    expect(reloaded.alias).toBe("my-home");
    expect(reloaded.assistant_name).toBe("PersistAssistant");
    expect(reloaded.status).toBe("online");
    expect(reloaded.labels).toEqual({ env: "test", role: "primary" });
    expect(reloaded.discovered_at).toBe(originalDiscoveredAt);
    expect(reloaded.last_seen).toBe(originalLastSeen);

    // Phase 3: Verify via API on new store
    const app = Fastify();
    const scanner2 = new ActiveScanner(store2);
    registerInstanceRoutes(app, store2, scanner2);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/instances/my-home" });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent_id).toBe("persist-agent");
    expect(res.json().alias).toBe("my-home");

    await app.close();
    await store2.close();
  });

  it("gracefully recovers from corrupted registry file", async () => {
    // Write corrupted JSON
    const registryPath = path.join(tmpDir, "registry.json");
    await fs.promises.writeFile(registryPath, "{ broken json !!!", "utf-8");

    const store = new RegistryStore(tmpDir);
    await store.init();

    // Should start fresh — no crash, no instances
    expect(store.size).toBe(0);

    await store.close();
  });
});
