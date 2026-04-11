import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  registerRelayRoutes,
  registerRegistryRoutes,
  registerDiagnosticsRoutes,
} from "../../src/api/server.js";
import type { RelayConnector } from "../../src/relay/connector.js";
import type { AutoRegister } from "../../src/registry/auto-register.js";
import type { RemoteDiscovery } from "../../src/registry/discovery.js";
import type { RegistryClient } from "../../src/registry/client.js";
import type { IdentityKeys } from "../../src/crypto/keys.js";
import type { RegistryStore } from "../../src/registry/store.js";
import type { LocalProbe } from "../../src/local/probe.js";
import type { MdnsListener } from "../../src/mdns/listener.js";
import type { HealthChecker } from "../../src/health/checker.js";
import type { UnreachableInstance } from "../../src/types.js";

describe("registerRelayRoutes", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /relay/connect — connector null → 503", async () => {
    registerRelayRoutes(app, () => null);
    const res = await app.inject({ method: "POST", url: "/relay/connect", payload: { target_claw_id: "x" } });
    expect(res.statusCode).toBe(503);
  });

  it("POST /relay/connect — missing target_claw_id → 400", async () => {
    const connector = mockConnector();
    registerRelayRoutes(app, () => connector);
    const res = await app.inject({ method: "POST", url: "/relay/connect", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("POST /relay/connect — success → calls join()", async () => {
    const connector = mockConnector();
    registerRelayRoutes(app, () => connector);
    const res = await app.inject({
      method: "POST",
      url: "/relay/connect",
      payload: { target_claw_id: "peer.id.claw" },
    });
    expect(res.statusCode).toBe(200);
    expect(connector.join).toHaveBeenCalledWith("peer.id.claw");
  });

  it("POST /relay/connect — with token refresher → refreshes before join", async () => {
    const connector = mockConnector();
    const refresher = vi.fn().mockResolvedValue("new-token");
    registerRelayRoutes(app, () => connector, () => refresher);
    const res = await app.inject({
      method: "POST",
      url: "/relay/connect",
      payload: { target_claw_id: "peer.id.claw" },
    });
    expect(res.statusCode).toBe(200);
    expect(refresher).toHaveBeenCalled();
    expect(connector.updateAuthToken).toHaveBeenCalledWith("new-token");
    expect(connector.join).toHaveBeenCalledWith("peer.id.claw");
  });

  it("GET /relay/status — returns connector status", async () => {
    const connector = mockConnector();
    registerRelayRoutes(app, () => connector);
    const res = await app.inject({ method: "GET", url: "/relay/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: "registered", relay_url: "wss://test", claw_id: "test.claw", rooms: [] });
  });

  it("GET /relay/status — connector null → 503", async () => {
    registerRelayRoutes(app, () => null);
    const res = await app.inject({ method: "GET", url: "/relay/status" });
    expect(res.statusCode).toBe(503);
  });

  it("DELETE /relay/disconnect/:room_id — calls disconnectRoom()", async () => {
    const connector = mockConnector();
    registerRelayRoutes(app, () => connector);
    const res = await app.inject({ method: "DELETE", url: "/relay/disconnect/room-123" });
    expect(res.statusCode).toBe(200);
    expect(connector.disconnectRoom).toHaveBeenCalledWith("room-123");
  });
});

describe("registerRegistryRoutes", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /registry/register → calls tryRegister", async () => {
    const deps = mockRegistryDeps();
    registerRegistryRoutes(app, deps);
    const res = await app.inject({ method: "POST", url: "/registry/register" });
    expect(res.statusCode).toBe(200);
    expect(deps.autoRegister.tryRegister).toHaveBeenCalled();
  });

  it("GET /registry/status → returns registered state", async () => {
    const deps = mockRegistryDeps();
    registerRegistryRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/registry/status" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.registered).toBe(true);
    expect(data.claw_name).toBe("test.id.claw");
  });

  it("GET /resolve/:name → calls remoteDiscovery.resolve", async () => {
    const deps = mockRegistryDeps();
    registerRegistryRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/resolve/test.id.claw" });
    expect(res.statusCode).toBe(200);
    expect(deps.remoteDiscovery.resolve).toHaveBeenCalledWith("test.id.claw");
  });

  it("GET /resolve/:name not found → 404", async () => {
    const deps = mockRegistryDeps();
    (deps.remoteDiscovery.resolve as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    registerRegistryRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/resolve/nonexistent.claw" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /whoami → returns pubkey + claw_name", async () => {
    const deps = mockRegistryDeps();
    registerRegistryRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/whoami" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.claw_name).toBe("test.id.claw");
    expect(data.pubkey).toContain("ed25519:");
  });
});

describe("registerDiagnosticsRoutes", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /diagnostics — with local instance → includes detected", async () => {
    const deps = mockDiagnosticsDeps({ hasLocal: true });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.local_instance.status).toBe("detected");
    expect(data.local_instance.agent_id).toBe("main");
  });

  it("GET /diagnostics — without local instance → not_detected", async () => {
    const deps = mockDiagnosticsDeps({ hasLocal: false });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.local_instance.status).toBe("not_detected");
  });

  it("GET /diagnostics — with unreachable instances", async () => {
    const unreachable: UnreachableInstance[] = [
      { address: "192.168.1.50", port: 18789, lan_host: "test.local", reason: "timeout" },
    ];
    const deps = mockDiagnosticsDeps({ hasLocal: false, unreachable });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics" });
    const data = res.json();
    expect(data.lan_discovery.unreachable_count).toBe(1);
  });

  it("GET /diagnostics — with connector → 'connected' status", async () => {
    const deps = mockDiagnosticsDeps({ hasLocal: false, hasConnector: true });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics" });
    const data = res.json();
    expect(data.relay.status).toBe("connected");
  });

  it("GET /diagnostics — without connector → 'not_configured'", async () => {
    const deps = mockDiagnosticsDeps({ hasLocal: false, hasConnector: false });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics" });
    const data = res.json();
    expect(data.relay.status).toBe("not_configured");
  });

  it("GET /diagnostics — with autoRegister → shows registry status", async () => {
    const deps = mockDiagnosticsDeps({ hasLocal: false, hasAutoRegister: true });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics" });
    const data = res.json();
    expect(data.registry.status).toBe("registered");
  });

  it("GET /diagnostics — without autoRegister → 'not_configured'", async () => {
    const deps = mockDiagnosticsDeps({ hasLocal: false });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics" });
    const data = res.json();
    expect(data.registry.status).toBe("not_configured");
  });

  it("GET /diagnostics/unreachable — returns unreachable list", async () => {
    const unreachable: UnreachableInstance[] = [
      { address: "192.168.1.50", port: 18789, lan_host: "test.local", reason: "timeout" },
    ];
    const deps = mockDiagnosticsDeps({ hasLocal: false, unreachable });
    registerDiagnosticsRoutes(app, deps);
    const res = await app.inject({ method: "GET", url: "/diagnostics/unreachable" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.count).toBe(1);
    expect(data.instances[0].address).toBe("192.168.1.50");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockConnector() {
  return {
    join: vi.fn(),
    getStatus: vi.fn(() => ({
      state: "registered",
      relay_url: "wss://test",
      claw_id: "test.claw",
      rooms: [],
    })),
    disconnectRoom: vi.fn(),
    updateAuthToken: vi.fn(),
  } as unknown as RelayConnector & {
    join: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    disconnectRoom: ReturnType<typeof vi.fn>;
    updateAuthToken: ReturnType<typeof vi.fn>;
  };
}

function mockRegistryDeps() {
  return {
    autoRegister: {
      tryRegister: vi.fn().mockResolvedValue(undefined),
      clawName: "test.id.claw",
      publicKey: "ed25519:abc",
    } as unknown as AutoRegister & { tryRegister: ReturnType<typeof vi.fn> },
    remoteDiscovery: {
      resolve: vi.fn().mockResolvedValue({
        agent_id: "test-agent",
        auto_name: "test-agent",
        claw_name: "test.id.claw",
        discovery_source: "registry",
        network_scope: "public",
      }),
    } as unknown as RemoteDiscovery & { resolve: ReturnType<typeof vi.fn> },
    registryClient: {} as unknown as RegistryClient,
    identityKeys: {
      publicKeyHex: "aabbccdd",
    } as unknown as IdentityKeys,
  };
}

function mockDiagnosticsDeps(opts: {
  hasLocal: boolean;
  unreachable?: UnreachableInstance[];
  hasConnector?: boolean;
  hasAutoRegister?: boolean;
}) {
  return {
    store: {
      getAll: vi.fn(() => []),
    } as unknown as RegistryStore,
    localProbe: {
      agentId: opts.hasLocal ? "main" : null,
    } as unknown as LocalProbe,
    mdns: {} as unknown as MdnsListener,
    health: {} as unknown as HealthChecker,
    getConnector: () => (opts.hasConnector ? ({} as unknown as RelayConnector) : null),
    getAutoRegister: () =>
      opts.hasAutoRegister
        ? ({ clawName: "test.id.claw" } as unknown as AutoRegister)
        : null,
    unreachable: opts.unreachable ?? [],
  };
}
