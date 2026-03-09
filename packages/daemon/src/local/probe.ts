// LocalProbe — detects AI instances on localhost and registers them
// Runs on daemon startup, then periodically re-checks
// Adapter-aware: tries all registered adapters on their default ports

import { EventEmitter } from "node:events";
import * as os from "node:os";
import type { RegistryStore } from "../registry/store.js";
import type { ClawInstance, ControlUiConfig } from "../types.js";
import { ADAPTERS } from "../adapter/index.js";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 18789;
const CONFIG_PATH = "/__openclaw/control-ui-config.json";
const PROBE_INTERVAL = 30_000;
const PROBE_TIMEOUT = 3_000;

export class LocalProbe extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private localAgentId: string | null = null;

  constructor(
    private readonly store: RegistryStore,
    private readonly port: number = DEFAULT_PORT,
  ) {
    super();
  }

  get agentId(): string | null {
    return this.localAgentId;
  }

  async start(): Promise<void> {
    // Probe immediately on start
    await this.probe();
    // Then periodically
    this.timer = setInterval(() => {
      this.probe().catch((err) => this.emit("error", err));
    }, PROBE_INTERVAL);
    this.emit("started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private _markOffline(port: number): void {
    const existing = this.store.getByNetworkKey(LOCAL_HOST, port);
    if (existing && existing.status !== "offline") {
      this.store.upsert({
        ...existing,
        status: "offline",
        connectivity: { ...existing.connectivity!, lan_reachable: false },
      });
    }
  }

  /** Mark offline any previously-known self instances that were not rediscovered this cycle */
  private _markOfflineStaleSelf(staleKeys: Set<string>): void {
    for (const key of staleKeys) {
      const [address, portStr] = key.split(":");
      this._markOffline(Number(portStr));
    }
  }

  async probe(): Promise<ClawInstance | null> {
    // Snapshot all current is_self instances so we can mark stale ones offline later
    const previousSelfKeys = new Set(
      this.store
        .getAll()
        .filter((inst) => inst.is_self)
        .map((inst) => `${inst.address}:${inst.gateway_port}`),
    );

    // 1. Try OpenClaw on the configured port (backward-compatible primary path)
    const openClawResult = await this.probeOpenClaw(this.port);
    if (openClawResult) {
      previousSelfKeys.delete(`${LOCAL_HOST}:${this.port}`);
      this._markOfflineStaleSelf(previousSelfKeys);
      return openClawResult;
    }

    // 2. Try all adapters on their default ports (skip OpenClaw on this.port, already tried)
    let found: ClawInstance | null = null;

    for (const adapter of ADAPTERS) {
      if (adapter.name === "openclaw") continue; // already tried above

      // Try probeLocal first (for frameworks without HTTP servers, e.g. NanoClaw)
      if (adapter.probeLocal) {
        const probeResult = await adapter.probeLocal();
        if (probeResult) {
          const now = new Date().toISOString();
          const partial = adapter.toClawInstance(LOCAL_HOST, 0, probeResult);
          const instance: ClawInstance = {
            agent_id: partial.agent_id ?? `${adapter.name}@localhost`,
            auto_name: "",
            assistant_name: partial.assistant_name ?? "",
            display_name: partial.display_name ?? adapter.name,
            lan_host: os.hostname(),
            address: LOCAL_HOST,
            gateway_port: partial.gateway_port ?? 0,
            tls: false,
            discovery_source: "local",
            network_scope: "local",
            status: "online",
            last_seen: now,
            discovered_at: now,
            implementation: partial.implementation,
            connectivity: {
              lan_reachable: false,
              relay_available: false,
              preferred_channel: "local",
              last_lan_check: now,
            },
            is_self: true,
            labels: partial.labels,
          };

          this.store.upsert(instance);
          this.emit("local:discovered", instance);
          previousSelfKeys.delete(`${LOCAL_HOST}:${instance.gateway_port}`);
          found = instance;
          break;
        }
      }

      // Then try HTTP probe on default ports
      if (!found) {
        for (const port of adapter.defaultPorts) {
          const probeResult = await adapter.probe(LOCAL_HOST, port);
          if (probeResult) {
            const now = new Date().toISOString();
            const partial = adapter.toClawInstance(LOCAL_HOST, port, probeResult);
            const instance: ClawInstance = {
              agent_id: partial.agent_id ?? `${adapter.name}@localhost`,
              auto_name: "",
              assistant_name: partial.assistant_name ?? "",
              display_name: partial.display_name ?? adapter.name,
              lan_host: os.hostname(),
              address: LOCAL_HOST,
              gateway_port: port,
              tls: false,
              discovery_source: "local",
              network_scope: "local",
              status: "online",
              last_seen: now,
              discovered_at: now,
              implementation: partial.implementation,
              connectivity: {
                lan_reachable: true,
                relay_available: false,
                preferred_channel: "local",
                last_lan_check: now,
              },
              is_self: true,
            };

            this.store.upsert(instance);
            this.emit("local:discovered", instance);
            previousSelfKeys.delete(`${LOCAL_HOST}:${port}`);
            found = instance;
            break;
          }
        }
      }

      if (found) break;
    }

    if (found) {
      this._markOfflineStaleSelf(previousSelfKeys);
      return found;
    }

    // Nothing found
    this.localAgentId = null;
    this._markOfflineStaleSelf(previousSelfKeys);
    this.emit("local:unavailable");
    return null;
  }

  /** Original OpenClaw probe logic (kept as primary path for backward compatibility) */
  private async probeOpenClaw(port: number): Promise<ClawInstance | null> {
    const url = `http://${LOCAL_HOST}:${port}${CONFIG_PATH}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) {
        // Port responded but not valid OpenClaw — don't mark offline or emit unreachable,
        // because another adapter may be occupying this port. Let the adapter loop try.
        return null;
      }

      const config = (await res.json()) as ControlUiConfig;
      if (!config.assistantAgentId) {
        // Has an HTTP server but no assistantAgentId — not a valid OpenClaw instance.
        // Don't mark offline; another adapter may match this endpoint.
        return null;
      }

      this.localAgentId = config.assistantAgentId;

      const now = new Date().toISOString();
      const instance: ClawInstance = {
        agent_id: config.assistantAgentId,
        auto_name: "", // will be assigned by store.upsert()
        assistant_name: config.assistantName ?? "",
        display_name: config.displayName ?? config.assistantName ?? "",
        lan_host: os.hostname(),
        address: LOCAL_HOST,
        gateway_port: port,
        tls: false,
        discovery_source: "local",
        network_scope: "local",
        status: "online",
        last_seen: now,
        discovered_at: now,
        implementation: "openclaw",
        connectivity: {
          lan_reachable: true,
          relay_available: false,
          preferred_channel: "local",
          last_lan_check: now,
        },
        is_self: true,
      };

      this.store.upsert(instance);
      this.emit("local:discovered", instance);
      return instance;
    } catch {
      // OpenClaw not running on this port — don't emit yet, try adapters first
      return null;
    }
  }
}
