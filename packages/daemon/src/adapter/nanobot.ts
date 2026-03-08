// NanoBot adapter — Python variant, default ports 8000/8080
// Probe: /health → check for framework/app: "nanobot", fallback /api/health
// Heuristic: python_version field on expected port → infer nanobot

import type { ClawInstance } from "../types.js";
import type { FrameworkAdapter, ProbeResult } from "./types.js";

const PROBE_TIMEOUT = 2_000;

export class NanoBotAdapter implements FrameworkAdapter {
  readonly name = "nanobot";
  readonly defaultPorts = [8000, 8080];

  async probe(host: string, port: number): Promise<ProbeResult | null> {
    // Try /health first
    const healthResult = await this.probeHealth(host, port);
    if (healthResult) return healthResult;

    // Fallback: /api/health
    return this.probeApiHealth(host, port);
  }

  toClawInstance(host: string, port: number, probe: ProbeResult): Partial<ClawInstance> {
    return {
      agent_id: `nanobot@${host}`,
      assistant_name: probe.display_name ?? "",
      display_name: probe.display_name ?? "nanobot",
      lan_host: host,
      address: host,
      gateway_port: port,
      tls: false,
      discovery_source: "scan",
      status: "online",
      implementation: "nanobot",
    };
  }

  private async probeHealth(host: string, port: number): Promise<ProbeResult | null> {
    try {
      const res = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      if (data.framework === "nanobot" || data.app === "nanobot") {
        return this.extractProbeResult(data);
      }

      // Heuristic: python_version on expected port → infer nanobot
      if (typeof data.python_version === "string" && this.defaultPorts.includes(port)) {
        return this.extractProbeResult(data);
      }

      return null;
    } catch {
      return null;
    }
  }

  private async probeApiHealth(host: string, port: number): Promise<ProbeResult | null> {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      if (data.framework === "nanobot" || data.app === "nanobot") {
        return this.extractProbeResult(data);
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractProbeResult(data: Record<string, unknown>): ProbeResult {
    return {
      name: "nanobot",
      version: typeof data.version === "string" ? data.version : undefined,
      display_name: typeof data.name === "string" ? data.name : undefined,
      metadata: typeof data.python_version === "string"
        ? { python_version: data.python_version }
        : undefined,
    };
  }
}
