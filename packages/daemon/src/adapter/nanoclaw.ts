// NanoClaw adapter — TypeScript variant, default ports 3100/3101
// Probe: /health → check for framework: "nanoclaw", fallback /api/info

import type { ClawInstance } from "../types.js";
import type { FrameworkAdapter, ProbeResult } from "./types.js";

const PROBE_TIMEOUT = 2_000;

export class NanoClawAdapter implements FrameworkAdapter {
  readonly name = "nanoclaw";
  readonly defaultPorts = [3100, 3101];

  async probe(host: string, port: number): Promise<ProbeResult | null> {
    // Try /health first
    const healthResult = await this.probeHealth(host, port);
    if (healthResult) return healthResult;

    // Fallback: /api/info
    return this.probeApiInfo(host, port);
  }

  toClawInstance(host: string, port: number, probe: ProbeResult): Partial<ClawInstance> {
    return {
      agent_id: `nanoclaw@${host}`,
      assistant_name: probe.display_name ?? "",
      display_name: probe.display_name ?? "nanoclaw",
      lan_host: host,
      address: host,
      gateway_port: port,
      tls: false,
      discovery_source: "scan",
      status: "online",
      implementation: "nanoclaw",
    };
  }

  private async probeHealth(host: string, port: number): Promise<ProbeResult | null> {
    try {
      const res = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      if (data.framework === "nanoclaw") {
        return {
          name: "nanoclaw",
          version: typeof data.version === "string" ? data.version : undefined,
          display_name: typeof data.name === "string" ? data.name : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async probeApiInfo(host: string, port: number): Promise<ProbeResult | null> {
    try {
      const res = await fetch(`http://${host}:${port}/api/info`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      if (data.framework === "nanoclaw") {
        return {
          name: "nanoclaw",
          version: typeof data.version === "string" ? data.version : undefined,
          display_name: typeof data.name === "string" ? data.name : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
