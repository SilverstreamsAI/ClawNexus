// HTTP API Server — fastify on :17890
// Routes: GET /health, instance management, relay routes (v0.4), agent routes (v1.0)

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { RegistryStore, AliasConflictError, AliasError, NotFoundError } from "../registry/store.js";
import { MdnsListener } from "../mdns/listener.js";
import { HealthChecker } from "../health/checker.js";
import { ActiveScanner } from "../scanner/active.js";
import type { ScanOptions } from "../scanner/active.js";
import { detectWireGuard } from "../scanner/wireguard.js";
import type { WireGuardInfo } from "../scanner/wireguard.js";
import { LocalProbe } from "../local/probe.js";
import type { UnreachableInstance } from "../types.js";
import { PolicyEngine } from "../agent/engine.js";
import { TaskManager } from "../agent/tasks.js";
import { AgentRouter } from "../agent/router.js";
import type { PolicyConfig, TaskDirection, TaskState } from "../agent/types.js";
import { BroadcastDiscovery } from "../discovery/broadcast.js";
import { loadOrCreateKeys, getPublicKeyString } from "../crypto/keys.js";
import type { IdentityKeys } from "../crypto/keys.js";
import { RegistryClient } from "../registry/client.js";
import { AutoRegister } from "../registry/auto-register.js";
import { RemoteDiscovery } from "../registry/discovery.js";
import { RelayConnector } from "../relay/connector.js";

const PORT = parseInt(process.env.CLAWNEXUS_PORT ?? "17890", 10);
const HOST = process.env.CLAWNEXUS_HOST ?? "127.0.0.1";

export function registerRelayRoutes(
  app: FastifyInstance,
  getConnector: () => RelayConnector | null,
): void {
  app.post<{ Body: { target_claw_id: string } }>(
    "/relay/connect",
    async (request, reply) => {
      const connector = getConnector();
      if (!connector) {
        return reply.status(503).send({
          error: "Relay connector not initialized",
        });
      }

      const { target_claw_id } = request.body;
      if (!target_claw_id) {
        return reply.status(400).send({
          error: "Missing target_claw_id",
        });
      }

      connector.join(target_claw_id);
      return { status: "connecting", target: target_claw_id };
    },
  );

  app.get("/relay/status", async (_request, reply) => {
    const connector = getConnector();
    if (!connector) {
      return reply.status(503).send({
        error: "Relay connector not initialized",
      });
    }
    return connector.getStatus();
  });

  app.delete<{ Params: { room_id: string } }>(
    "/relay/disconnect/:room_id",
    async (request, reply) => {
      const connector = getConnector();
      if (!connector) {
        return reply.status(503).send({
          error: "Relay connector not initialized",
        });
      }

      connector.disconnectRoom(request.params.room_id);
      return { status: "disconnected", room_id: request.params.room_id };
    },
  );
}

export interface AgentDeps {
  engine: PolicyEngine;
  tasks: TaskManager;
  getRouter: () => AgentRouter | null;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentDeps,
): void {
  const { engine, tasks, getRouter } = deps;

  // --- Policy ---

  app.get("/agent/policy", async () => engine.getConfig());

  app.put<{ Body: PolicyConfig }>("/agent/policy", async (request) => {
    await engine.updateConfig(request.body);
    return { status: "ok" };
  });

  app.patch<{ Body: Partial<PolicyConfig> }>("/agent/policy", async (request) => {
    await engine.patchConfig(request.body);
    return { status: "ok", policy: engine.getConfig() };
  });

  app.post("/agent/policy/reset", async () => {
    await engine.resetConfig();
    return { status: "ok", policy: engine.getConfig() };
  });

  // --- Tasks ---

  app.get<{ Querystring: { direction?: TaskDirection; state?: TaskState; all?: string } }>(
    "/agent/tasks",
    async (request) => {
      let result = request.query.all === "true" ? tasks.getAll() : tasks.getActive();
      if (request.query.direction) {
        result = result.filter((t) => t.direction === request.query.direction);
      }
      if (request.query.state) {
        result = result.filter((t) => t.state === request.query.state);
      }
      return { count: result.length, tasks: result };
    },
  );

  app.get("/agent/tasks/stats", async () => tasks.getStats());

  app.get<{ Params: { id: string } }>(
    "/agent/tasks/:id",
    async (request, reply) => {
      const task = tasks.getById(request.params.id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      return task;
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/agent/tasks/:id/cancel",
    async (request, reply) => {
      const result = tasks.cancelTask(request.params.id, request.body?.reason);
      if (!result) return reply.status(404).send({ error: "Task not found or already terminal" });
      return { status: "ok", task: result };
    },
  );

  // --- Propose / Query ---

  app.post<{ Body: { target_claw_id: string; room_id: string; task: { task_type: string; description: string; input?: Record<string, unknown> } } }>(
    "/agent/propose",
    async (request, reply) => {
      const router = getRouter();
      if (!router) return reply.status(503).send({ error: "Agent router not initialized" });
      const { target_claw_id, room_id, task } = request.body;
      if (!target_claw_id || !room_id || !task) {
        return reply.status(400).send({ error: "Missing target_claw_id, room_id, or task" });
      }
      const record = router.propose(room_id, target_claw_id, task);
      return { status: "ok", task: record };
    },
  );

  app.post<{ Body: { target_claw_id: string; room_id: string; query_type: "capabilities" | "status" | "availability" } }>(
    "/agent/query",
    async (request, reply) => {
      const router = getRouter();
      if (!router) return reply.status(503).send({ error: "Agent router not initialized" });
      const { target_claw_id, room_id, query_type } = request.body;
      if (!target_claw_id || !room_id || !query_type) {
        return reply.status(400).send({ error: "Missing target_claw_id, room_id, or query_type" });
      }
      const envelope = router.query(room_id, target_claw_id, query_type);
      return { status: "ok", message_id: envelope.message_id };
    },
  );

  // --- Inbox ---

  app.get("/agent/inbox", async (_request, reply) => {
    const router = getRouter();
    if (!router) return reply.status(503).send({ error: "Agent router not initialized" });
    const items = router.getInbox();
    return {
      count: items.length,
      items: items.map((i) => ({
        message_id: i.message_id,
        from: i.envelope.from,
        type: i.envelope.type,
        task: (i.envelope.payload as { task?: unknown }).task,
        timestamp: i.envelope.timestamp,
      })),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/agent/inbox/:id/approve",
    async (request, reply) => {
      const router = getRouter();
      if (!router) return reply.status(503).send({ error: "Agent router not initialized" });
      const record = router.approveInbox(request.params.id);
      if (!record) return reply.status(404).send({ error: "Inbox item not found" });
      return { status: "ok", task: record };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/agent/inbox/:id/deny",
    async (request, reply) => {
      const router = getRouter();
      if (!router) return reply.status(503).send({ error: "Agent router not initialized" });
      router.denyInbox(request.params.id, request.body?.reason);
      return { status: "ok" };
    },
  );
}

export interface RegistryDeps {
  autoRegister: AutoRegister;
  remoteDiscovery: RemoteDiscovery;
  registryClient: RegistryClient;
  identityKeys: IdentityKeys;
}

export function registerRegistryRoutes(
  app: FastifyInstance,
  deps: RegistryDeps,
): void {
  const { autoRegister, remoteDiscovery, registryClient, identityKeys } = deps;

  app.post("/registry/register", async () => {
    await autoRegister.tryRegister();
    return {
      status: "ok",
      claw_name: autoRegister.clawName,
      pubkey: autoRegister.publicKey,
    };
  });

  app.get("/registry/status", async () => {
    return {
      registered: autoRegister.clawName != null,
      claw_name: autoRegister.clawName,
      pubkey: autoRegister.publicKey,
    };
  });

  app.get<{ Params: { name: string } }>(
    "/resolve/:name",
    async (request, reply) => {
      const instance = await remoteDiscovery.resolve(request.params.name);
      if (!instance) {
        return reply.status(404).send({ error: "Name not found" });
      }
      return instance;
    },
  );

  app.get("/whoami", async () => {
    return {
      pubkey: getPublicKeyString(identityKeys.publicKeyHex),
      claw_name: autoRegister.clawName,
    };
  });
}

export function registerInstanceRoutes(
  app: FastifyInstance,
  store: RegistryStore,
  scanner: ActiveScanner,
): void {
  app.get<{ Querystring: { scope?: string } }>("/instances", async (request) => {
    let instances = store.getAll();
    if (request.query.scope) {
      instances = instances.filter((i) => i.network_scope === request.query.scope);
    }
    return { count: instances.length, instances };
  });

  app.get<{ Params: { id: string } }>(
    "/instances/:id",
    async (request, reply) => {
      const inst = store.resolve(request.params.id);
      if (!inst) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      return inst;
    },
  );

  app.put<{ Params: { id: string }; Body: { alias: string } }>(
    "/instances/:id/alias",
    async (request, reply) => {
      const inst = store.resolve(request.params.id);
      if (!inst) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      const { alias } = request.body;
      if (!alias) {
        return reply.status(400).send({ error: "Missing alias" });
      }
      try {
        const nk = store.networkKey(inst.address, inst.gateway_port);
        store.setAlias(nk, alias);
        return { status: "ok", auto_name: inst.auto_name, agent_id: inst.agent_id, alias };
      } catch (err) {
        if (err instanceof AliasConflictError) {
          return reply.status(409).send({ error: err.message });
        }
        if (err instanceof AliasError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/instances/:id",
    async (request, reply) => {
      const inst = store.resolve(request.params.id);
      if (!inst) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      const nk = store.networkKey(inst.address, inst.gateway_port);
      store.remove(nk);
      return { status: "ok", removed: inst.auto_name };
    },
  );

  app.post<{ Body: ScanOptions }>("/scan", async (request) => {
    const opts: ScanOptions = {};
    if (request.body?.ports) opts.ports = request.body.ports;
    if (request.body?.targets) opts.targets = request.body.targets;
    const discovered = await scanner.scan(opts);
    return {
      status: "ok",
      discovered: discovered.length,
      instances: discovered,
    };
  });
}

export interface DiagnosticsDeps {
  store: RegistryStore;
  localProbe: LocalProbe;
  mdns: MdnsListener;
  health: HealthChecker;
  getConnector: () => RelayConnector | null;
  getAutoRegister: () => AutoRegister | null;
  unreachable: UnreachableInstance[];
}

export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  deps: DiagnosticsDeps,
): void {
  app.get("/diagnostics", async () => {
    const { store, localProbe, mdns, getConnector, getAutoRegister, unreachable } = deps;
    const connector = getConnector();

    const instances = store.getAll();
    const lanCount = instances.filter(
      (i) => i.connectivity?.preferred_channel === "lan" || i.connectivity?.preferred_channel === "local",
    ).length;
    const relayCount = instances.filter(
      (i) => i.connectivity?.preferred_channel === "relay",
    ).length;

    return {
      local_instance: localProbe.agentId
        ? { agent_id: localProbe.agentId, status: "detected" }
        : { status: "not_detected" },
      lan_discovery: {
        mdns: "active",
        unreachable_count: unreachable.length,
        unreachable: unreachable.map((u) => ({
          address: `${u.address}:${u.port}`,
          lan_host: u.lan_host,
          reason: u.reason,
        })),
      },
      registry: (() => {
        const ar = getAutoRegister();
        if (!ar) return { status: "not_configured" };
        return ar.clawName
          ? { status: "registered", claw_name: ar.clawName }
          : { status: "not_registered" };
      })(),
      relay: {
        status: connector ? "connected" : "not_configured",
      },
      summary: {
        total_instances: instances.length,
        lan_instances: lanCount,
        relay_instances: relayCount,
      },
    };
  });

  app.get("/diagnostics/unreachable", async () => {
    return {
      count: deps.unreachable.length,
      instances: deps.unreachable,
    };
  });
}

export interface DaemonOptions {
  port?: number;
  host?: string;
}

export interface DaemonHandle {
  app: FastifyInstance;
  store: RegistryStore;
  scanner: ActiveScanner;
  mdns: MdnsListener;
  health: HealthChecker;
  localProbe: LocalProbe;
  broadcast: BroadcastDiscovery;
  getConnector: () => RelayConnector | null;
  setConnector: (c: RelayConnector) => void;
  engine: PolicyEngine;
  tasks: TaskManager;
  getRouter: () => AgentRouter | null;
  registryClient: RegistryClient | null;
  autoRegister: AutoRegister | null;
  remoteDiscovery: RemoteDiscovery | null;
  identityKeys: IdentityKeys | null;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const port = options.port ?? PORT;
  const host = options.host ?? HOST;

  let connector: RelayConnector | null = null;
  let agentRouter: AgentRouter | null = null;
  let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // Track mDNS-heard but HTTP-unreachable instances for diagnostics
  const unreachable: UnreachableInstance[] = [];

  // 1. Initialize registry store
  const store = new RegistryStore();
  await store.init();

  // 2. Create LocalProbe (detect local OpenClaw on this machine — runs first)
  const localProbe = new LocalProbe(store);

  // 3. Create scanner
  const scanner = new ActiveScanner(store);

  // 4. Create mDNS listener
  const mdns = new MdnsListener(store);

  // 5. Create health checker
  const health = new HealthChecker(store);

  // 5b. Create BroadcastDiscovery (CDP)
  const broadcast = new BroadcastDiscovery(
    store,
    () => store.getByNetworkKey("127.0.0.1", 18789) ?? null,
  );

  // 6. Initialize Layer B components
  const engine = new PolicyEngine();
  await engine.init();

  const taskManager = new TaskManager();
  await taskManager.init();

  // 7. Detect WireGuard interfaces
  const wgInfo: WireGuardInfo = await detectWireGuard();

  // 8. Create and configure Fastify app
  const app = Fastify({ logger: false });

  // Log WireGuard detection results to stdout (captured in daemon.log)
  if (wgInfo.interfaces.length > 0) {
    for (const iface of wgInfo.interfaces) {
      console.log(
        `[clawnexus] [WireGuard] Detected interface ${iface.name} (${iface.address}), mDNS unavailable on VPN — peers discovered via Active Scan`,
      );
    }
    if (wgInfo.peerIPs.length > 0) {
      console.log(
        `[clawnexus] [WireGuard] ${wgInfo.peerIPs.length} peer IP(s) extracted for precise scanning: ${wgInfo.peerIPs.join(", ")}`,
      );
    } else {
      console.log(
        "[clawnexus] [WireGuard] No peer IPs extracted (no root access?) — VPN subnets will use /24 fallback scan",
      );
    }
  } else {
    console.log("[clawnexus] [WireGuard] No WireGuard interfaces detected");
  }

  // Health endpoint with component status
  app.get("/health", async () => ({
    status: "ok",
    service: "clawnexus-daemon",
    version: "0.4.0",
    timestamp: new Date().toISOString(),
    components: {
      registry: { instances: store.size },
      local_instance: localProbe.agentId
        ? { agent_id: localProbe.agentId, status: "detected" }
        : { status: "not_detected" },
      mdns: "active",
      health_checker: "active",
      scanner: scanner.isScanning ? "scanning" : "idle",
      relay: connector
        ? { status: connector.getStatus().state, claw_id: connector.getStatus().claw_id }
        : { status: "not_initialized" },
    },
    wireguard: {
      interfaces: wgInfo.interfaces.map((i) => i.name),
      peer_count: wgInfo.peerIPs.length,
      mdns_limited: wgInfo.interfaces.length > 0,
    },
  }));

  // Instance management routes
  registerInstanceRoutes(app, store, scanner);

  // Relay routes
  registerRelayRoutes(app, () => connector);

  // Agent routes (Layer B)
  registerAgentRoutes(app, {
    engine,
    tasks: taskManager,
    getRouter: () => agentRouter,
  });

  // Diagnostics routes
  registerDiagnosticsRoutes(app, {
    store,
    localProbe,
    mdns,
    health,
    getConnector: () => connector,
    getAutoRegister: () => autoRegister,
    unreachable,
  });

  // 9. Initialize Registry integration (non-fatal — LAN must work without it)
  let identityKeys: IdentityKeys | null = null;
  let registryClient: RegistryClient | null = null;
  let autoRegister: AutoRegister | null = null;
  let remoteDiscovery: RemoteDiscovery | null = null;

  // Start LocalProbe first (non-fatal if no local OpenClaw)
  await localProbe.start();

  localProbe.on("local:discovered", (instance) => {
    app.log.info({ agent_id: instance.agent_id }, "Local OpenClaw instance discovered");
    broadcast.sendAnnounce();
  });

  localProbe.on("local:unavailable", () => {
    app.log.info("No local OpenClaw instance on :18789");
  });

  // Initialize registry after LocalProbe (needs agentId for registration)
  try {
    identityKeys = await loadOrCreateKeys();
    registryClient = new RegistryClient(identityKeys);
    autoRegister = new AutoRegister(registryClient, store, localProbe, identityKeys);
    remoteDiscovery = new RemoteDiscovery(registryClient, store);

    registerRegistryRoutes(app, {
      autoRegister,
      remoteDiscovery,
      registryClient,
      identityKeys,
    });

    autoRegister.on("registered", async (info) => {
      console.log(`[clawnexus] [Registry] Registered as ${info.claw_name} (${info.action})`);

      // Initialize relay connector after successful registration
      if (!connector && registryClient && info.claw_name) {
        try {
          const tokenResult = await registryClient.getToken(info.claw_name);
          console.log(`[clawnexus] [Relay] Got auth token, relay_hint: ${tokenResult.relay_hint}`);

          const relayUrl = process.env.CLAWNEXUS_RELAY_URL ?? `wss://${tokenResult.relay_hint}/relay`;
          const newConnector = new RelayConnector({
            relayUrl,
            clawId: info.claw_name,
            authToken: tokenResult.token,
            autoAccept: true,
          });

          newConnector.on("registered", (clawId: string) => {
            console.log(`[clawnexus] [Relay] Connected and registered as ${clawId}`);
          });
          newConnector.on("relay_error", (code: string, message: string) => {
            console.log(`[clawnexus] [Relay] Error: ${code} — ${message}`);
          });
          newConnector.on("incoming", (room: { room_id: string; peer_claw_id: string }) => {
            console.log(`[clawnexus] [Relay] Incoming connection from ${room.peer_claw_id} (room: ${room.room_id})`);
          });
          newConnector.on("joined", (roomId: string) => {
            console.log(`[clawnexus] [Relay] Joined room ${roomId}`);
          });
          newConnector.on("peer_left", (roomId: string) => {
            console.log(`[clawnexus] [Relay] Peer left room ${roomId}`);
          });

          newConnector.connect();
          setConnector(newConnector);

          // Start token refresh — every 4 minutes (token expires in 5 min)
          if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
          tokenRefreshTimer = setInterval(async () => {
            if (!registryClient || !autoRegister?.clawName) return;
            try {
              const fresh = await registryClient.getToken(autoRegister.clawName);
              // Reconnect with fresh token
              connector?.disconnect();
              const refreshed = new RelayConnector({
                relayUrl: process.env.CLAWNEXUS_RELAY_URL ?? `wss://${fresh.relay_hint}/relay`,
                clawId: autoRegister.clawName,
                authToken: fresh.token,
                autoAccept: true,
              });
              refreshed.on("registered", (clawId: string) => {
                console.log(`[clawnexus] [Relay] Reconnected (token refresh) as ${clawId}`);
              });
              refreshed.on("relay_error", (code: string, message: string) => {
                console.log(`[clawnexus] [Relay] Error: ${code} — ${message}`);
              });
              refreshed.connect();
              setConnector(refreshed);
            } catch (err) {
              console.log(`[clawnexus] [Relay] Token refresh failed (non-fatal): ${err}`);
            }
          }, 4 * 60 * 1000);
        } catch (err) {
          console.log(`[clawnexus] [Relay] Failed to initialize (non-fatal): ${err}`);
        }
      }
    });
    autoRegister.on("error", (err) => {
      console.log(`[clawnexus] [Registry] Registration failed (non-fatal): ${err}`);
    });

    autoRegister.start();
    console.log("[clawnexus] [Registry] Integration initialized");
  } catch (err) {
    console.log(`[clawnexus] [Registry] Integration failed (non-fatal): ${err}`);
    app.log.warn({ err }, "Registry integration failed to initialize (non-fatal)");
  }

  // Collect mDNS unreachable diagnostics
  mdns.on("mdns:unreachable", (info: UnreachableInstance) => {
    // Deduplicate by address:port
    const key = `${info.address}:${info.port}`;
    if (!unreachable.some((u) => `${u.address}:${u.port}` === key)) {
      unreachable.push(info);
    }
    app.log.warn(
      { address: key, reason: info.reason },
      "mDNS instance heard but HTTP unreachable",
    );
  });

  // Start mDNS and health checker
  try {
    mdns.start();
  } catch (err) {
    // mDNS may fail on some systems — non-fatal
    app.log.warn({ err }, "mDNS listener failed to start");
  }
  health.start();

  // Start CDP broadcast discovery (non-fatal)
  try {
    await broadcast.start();
  } catch (err) {
    app.log.warn({ err }, "CDP broadcast discovery failed to start (non-fatal)");
  }

  // Graceful shutdown hook
  app.addHook("onClose", async () => {
    if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
    autoRegister?.stop();
    agentRouter?.stop();
    taskManager.close();
    health.stop();
    localProbe.stop();
    mdns.stop();
    await broadcast.stop();
    connector?.disconnect();
    await store.close();
  });

  await app.listen({ port, host });

  const setConnector = (c: RelayConnector) => {
    connector = c;
    // When relay connector is set, create and start AgentRouter
    if (!agentRouter) {
      agentRouter = new AgentRouter({
        connector: c,
        engine,
        tasks: taskManager,
        localClawId: c.getStatus().claw_id ?? "",
      });
      agentRouter.start();
      app.log.info("Layer B agent router started");
    }
  };

  return {
    app,
    store,
    scanner,
    mdns,
    health,
    localProbe,
    broadcast,
    getConnector: () => connector,
    setConnector,
    engine,
    tasks: taskManager,
    getRouter: () => agentRouter,
    registryClient,
    autoRegister,
    remoteDiscovery,
    identityKeys,
  };
}
