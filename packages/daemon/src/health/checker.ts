// Health Checker — periodically pings known instances and updates status
// Enhanced with dual-channel connectivity detection
// Adapter-aware: uses framework-specific health checks for non-OpenClaw instances

import { EventEmitter } from "node:events";
import type { RegistryStore } from "../registry/store.js";
import type { Connectivity, ControlUiConfig } from "../types.js";
import { getAdapter } from "../adapter/index.js";

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
    const impl = inst.implementation ?? "openclaw";

    const now = new Date().toISOString();
    let lanOk = false;
    let lanLatency: number | undefined;
    let unreachableReason: string | undefined;

    if (impl === "openclaw" || impl === "goclaw") {
      // OpenClaw path: detailed check with name updates (original behavior)
      const result = await this.checkOpenClaw(inst, now);
      lanOk = result.ok;
      lanLatency = result.latency;
      unreachableReason = result.reason;
    } else {
      // Non-OpenClaw: use adapter healthCheck
      const adapter = getAdapter(impl);
      if (adapter) {
        try {
          const start = performance.now();
          // Use healthCheckLocal for port-0 instances (no HTTP server)
          if (inst.gateway_port === 0 && adapter.healthCheckLocal) {
            lanOk = await adapter.healthCheckLocal();
          } else {
            lanOk = await adapter.healthCheck(inst.address, inst.gateway_port);
          }
          lanLatency = Math.round(performance.now() - start);
          if (lanOk) {
            inst.last_seen = now;
          } else {
            unreachableReason = "Health check failed";
          }
        } catch (err) {
          unreachableReason = err instanceof Error ? err.message : "Connection failed";
        }
      } else {
        // Unknown implementation: generic HTTP check
        const result = await this.genericHttpCheck(inst, now);
        lanOk = result.ok;
        lanLatency = result.latency;
        unreachableReason = result.reason;
      }
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

  /** OpenClaw-specific health check with name updates */
  private async checkOpenClaw(
    inst: import("../types.js").ClawInstance,
    now: string,
  ): Promise<{ ok: boolean; latency?: number; reason?: string }> {
    const protocol = inst.tls ? "https" : "http";
    const url = `${protocol}://${inst.address}:${inst.gateway_port}${CONFIG_PATH}`;

    try {
      const start = performance.now();
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PING_TIMEOUT),
      });
      const latency = Math.round(performance.now() - start);

      if (res.ok) {
        const config = (await res.json()) as ControlUiConfig;
        inst.last_seen = now;
        if (config.assistantName) {
          inst.assistant_name = config.assistantName;
        }
        if (config.displayName) {
          inst.display_name = config.displayName;
        }
        return { ok: true, latency };
      }
      return { ok: false, latency, reason: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "Connection failed" };
    }
  }

  /** Fallback health check for instances without a known adapter */
  private async genericHttpCheck(
    inst: import("../types.js").ClawInstance,
    now: string,
  ): Promise<{ ok: boolean; latency?: number; reason?: string }> {
    const protocol = inst.tls ? "https" : "http";
    const url = `${protocol}://${inst.address}:${inst.gateway_port}/`;
    try {
      const start = performance.now();
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PING_TIMEOUT),
      });
      const latency = Math.round(performance.now() - start);
      if (res.ok) {
        inst.last_seen = now;
        return { ok: true, latency };
      }
      return { ok: false, latency, reason: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}
