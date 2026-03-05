// LocalProbe — detects OpenClaw instance on localhost and registers it
// Runs on daemon startup, then periodically re-checks

import { EventEmitter } from "node:events";
import * as os from "node:os";
import type { RegistryStore } from "../registry/store.js";
import type { ClawInstance, ControlUiConfig } from "../types.js";

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

  private _markOffline(): void {
    const existing = this.store.getByNetworkKey(LOCAL_HOST, this.port);
    if (existing && existing.status !== "offline") {
      this.store.upsert({
        ...existing,
        status: "offline",
        connectivity: { ...existing.connectivity!, lan_reachable: false },
      });
    }
  }

  async probe(): Promise<ClawInstance | null> {
    const url = `http://${LOCAL_HOST}:${this.port}${CONFIG_PATH}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) {
        this._markOffline();
        this.emit("local:unreachable", { reason: `HTTP ${res.status}` });
        return null;
      }

      const config = (await res.json()) as ControlUiConfig;
      if (!config.assistantAgentId) {
        this._markOffline();
        this.emit("local:unreachable", { reason: "missing assistantAgentId" });
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
        gateway_port: this.port,
        tls: false,
        discovery_source: "local",
        network_scope: "local",
        status: "online",
        last_seen: now,
        discovered_at: now,
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
      this.localAgentId = null;
      this._markOffline();
      this.emit("local:unavailable");
      return null;
    }
  }
}
