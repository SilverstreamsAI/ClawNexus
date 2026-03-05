// Health Checker — periodically pings known instances and updates status
// Enhanced with dual-channel connectivity detection (TICKET-021)

import { EventEmitter } from "node:events";
import type { RegistryStore } from "../registry/store.js";
import type { Connectivity, ControlUiConfig } from "../types.js";

const CHECK_INTERVAL = 30_000;
const PING_TIMEOUT = 5_000;
const CONFIG_PATH = "/__openclaw/control-ui-config.json";

export class HealthChecker extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private relayChecker: ((agentId: string) => boolean) | null = null;

  constructor(private readonly store: RegistryStore) {
    super();
  }

  /** Register a function that checks if relay is available for a given agent_id */
  setRelayChecker(fn: (agentId: string) => boolean): void {
    this.relayChecker = fn;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.checkAll().catch((err) => this.emit("error", err));
    }, CHECK_INTERVAL);
    this.emit("started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkAll(): Promise<void> {
    const instances = this.store.getAll();
    await Promise.allSettled(
      instances.map((inst) => this.checkOne(inst)),
    );
  }

  private async checkOne(inst: import("../types.js").ClawInstance): Promise<void> {
    // Skip local (self) instances — LocalProbe manages their status
    if (inst.is_self) return;

    const networkKey = this.store.networkKey(inst.address, inst.gateway_port);
    const protocol = inst.tls ? "https" : "http";
    const url = `${protocol}://${inst.address}:${inst.gateway_port}${CONFIG_PATH}`;

    const now = new Date().toISOString();
    let lanOk = false;
    let lanLatency: number | undefined;
    let unreachableReason: string | undefined;

    try {
      const start = performance.now();
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PING_TIMEOUT),
      });
      lanLatency = Math.round(performance.now() - start);

      if (res.ok) {
        lanOk = true;
        const config = (await res.json()) as ControlUiConfig;
        inst.last_seen = now;
        if (config.assistantName) {
          inst.assistant_name = config.assistantName;
        }
        if (config.displayName) {
          inst.display_name = config.displayName;
        }
      } else {
        unreachableReason = `HTTP ${res.status}`;
      }
    } catch (err) {
      unreachableReason = err instanceof Error ? err.message : "Connection failed";
    }

    // Check relay availability
    const relayAvailable = this.relayChecker?.(inst.agent_id) ?? false;

    // Update connectivity
    const connectivity: Connectivity = {
      lan_reachable: lanOk,
      relay_available: relayAvailable,
      preferred_channel: lanOk ? "lan" : relayAvailable ? "relay" : "unknown",
      lan_latency_ms: lanLatency,
      last_lan_check: now,
      unreachable_reason: lanOk ? undefined : unreachableReason,
    };
    inst.connectivity = connectivity;

    // Status: online if any channel is reachable
    if (lanOk) {
      inst.status = "online";
    } else if (relayAvailable) {
      inst.status = "online";
    } else {
      inst.status = "offline";
    }

    this.store.upsert(inst);
    this.emit(inst.status, networkKey);

    // Diagnostic event: heard but not reachable via LAN
    if (!lanOk && unreachableReason) {
      this.emit("unreachable", {
        agent_id: inst.agent_id,
        address: inst.address,
        reason: unreachableReason,
      });
    }
  }
}
