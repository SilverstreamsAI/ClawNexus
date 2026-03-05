// Active Scanner — probes local /24 subnet for OpenClaw instances
// WireGuard-aware: precise peer scanning when wg info available

import { EventEmitter } from "node:events";
import * as os from "node:os";
import type { RegistryStore } from "../registry/store.js";
import type { ClawInstance, ControlUiConfig } from "../types.js";
import { detectWireGuard } from "./wireguard.js";
import type { WireGuardInfo } from "./wireguard.js";

const CONCURRENCY = 50;
const TIMEOUT_PER_HOST = 2_000;
const DEFAULT_PORT = 18789;
const CONFIG_PATH = "/__openclaw/control-ui-config.json";

export interface ScanOptions {
  /** Additional ports to scan on each discovered subnet IP (default: [18789]) */
  ports?: number[];
  /** Explicit host:port targets to probe (bypass subnet scanning) */
  targets?: string[];
}

interface SubnetInfo {
  subnet: string;        // e.g. "192.168.1"
  type: "physical" | "wireguard";
  peerIPs?: string[];    // wireguard only: precise targets
}

export class ActiveScanner extends EventEmitter {
  private scanning = false;

  constructor(private readonly store: RegistryStore) {
    super();
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  /** Scan all local /24 subnets and explicit targets, return discovered instances */
  async scan(options?: ScanOptions): Promise<ClawInstance[]> {
    if (this.scanning) {
      throw new Error("Scan already in progress");
    }
    this.scanning = true;
    this.emit("start");

    try {
      const discovered: ClawInstance[] = [];
      const hasExplicitTargets = !!options?.targets?.length;

      // 1. Probe explicit targets first (fast path)
      if (hasExplicitTargets) {
        const explicitTargets = options!.targets!.map((t) => parseTarget(t));
        const results = await this.probeAll(explicitTargets);
        discovered.push(...results);
      }

      // 2. Scan subnets (skip if only explicit targets were given)
      if (!hasExplicitTargets) {
        const ports = options?.ports ?? [DEFAULT_PORT];
        const allPorts = [...new Set([DEFAULT_PORT, ...ports])];

        const wgInfo = await detectWireGuard();
        const subnets = this.detectSubnets(wgInfo);

        for (const si of subnets) {
          const networkScope: ClawInstance["network_scope"] =
            si.type === "wireguard" ? "vpn" : "local";

          let ips: string[];
          if (si.type === "wireguard" && si.peerIPs && si.peerIPs.length > 0) {
            // Precise scan: only probe known peer IPs
            ips = si.peerIPs;
          } else {
            // Full /24 scan (physical or wireguard without peer info)
            ips = this.generateIPs(si.subnet);
          }

          const subnetTargets: Array<{ host: string; port: number }> = [];
          for (const ip of ips) {
            for (const port of allPorts) {
              subnetTargets.push({ host: ip, port });
            }
          }
          const results = await this.probeAll(subnetTargets, networkScope);
          discovered.push(...results);
        }
      }

      this.emit("complete", discovered.length);
      return discovered;
    } finally {
      this.scanning = false;
    }
  }

  private detectSubnets(wgInfo: WireGuardInfo): SubnetInfo[] {
    const seen = new Set<string>();
    const result: SubnetInfo[] = [];
    const wgSubnets = new Set(wgInfo.interfaces.map((i) => i.subnet));

    const ifaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          const parts = addr.address.split(".");
          const subnet = parts.slice(0, 3).join(".");
          if (seen.has(subnet)) continue;
          seen.add(subnet);

          if (wgSubnets.has(subnet)) {
            // WireGuard subnet: attach peer IPs for precise scanning
            const peerIPs = wgInfo.peerIPs.filter(
              (ip) => ip.startsWith(subnet + "."),
            );
            result.push({ subnet, type: "wireguard", peerIPs });
          } else {
            result.push({ subnet, type: "physical" });
          }
        }
      }
    }

    return result;
  }

  private generateIPs(subnet: string): string[] {
    const ips: string[] = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${subnet}.${i}`);
    }
    return ips;
  }

  private async probeAll(
    targets: Array<{ host: string; port: number }>,
    networkScope: ClawInstance["network_scope"] = "local",
  ): Promise<ClawInstance[]> {
    const discovered: ClawInstance[] = [];
    const seen = new Set<string>(); // Deduplicate by host:port
    const queue = [...targets];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const target = queue.shift()!;
        const key = `${target.host}:${target.port}`;
        const inst = await this.probeHost(target.host, target.port, networkScope);
        if (inst && !seen.has(key)) {
          seen.add(key);
          this.store.upsert(inst);
          discovered.push(inst);
          this.emit("found", inst);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, targets.length) },
      () => worker(),
    );
    await Promise.allSettled(workers);

    return discovered;
  }

  private async probeHost(
    host: string,
    port: number = DEFAULT_PORT,
    networkScope: ClawInstance["network_scope"] = "local",
  ): Promise<ClawInstance | null> {
    const url = `http://${host}:${port}${CONFIG_PATH}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_PER_HOST),
      });
      if (!res.ok) return null;

      const config = (await res.json()) as ControlUiConfig;
      if (!config.assistantAgentId) return null;

      const now = new Date().toISOString();
      return {
        agent_id: config.assistantAgentId,
        auto_name: "", // will be assigned by store.upsert()
        assistant_name: config.assistantName ?? "",
        display_name: config.displayName ?? config.assistantName ?? "",
        lan_host: host,
        address: host,
        gateway_port: port,
        tls: false,
        discovery_source: "scan",
        network_scope: networkScope,
        status: "online",
        last_seen: now,
        discovered_at: now,
      };
    } catch {
      return null;
    }
  }
}

/** Parse "host:port" or "host" into { host, port } */
function parseTarget(target: string): { host: string; port: number } {
  const lastColon = target.lastIndexOf(":");
  if (lastColon > 0) {
    const port = parseInt(target.slice(lastColon + 1), 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      return { host: target.slice(0, lastColon), port };
    }
  }
  return { host: target, port: DEFAULT_PORT };
}
