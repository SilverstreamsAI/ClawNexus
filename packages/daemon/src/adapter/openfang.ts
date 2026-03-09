// OpenFang adapter — port 4200, REST API
// Probe: /api/health → confirm OpenFang, identity from /.well-known/agent.json

import type { ClawInstance } from "../types.js";
import type { FrameworkAdapter, ProbeResult } from "./types.js";

const PROBE_TIMEOUT = 2_000;

interface OpenFangHealth {
  status?: string;
  framework?: string;
  version?: string;
  [key: string]: unknown;
}

interface AgentJson {
  name?: string;
  agent_id?: string;
  display_name?: string;
  version?: string;
  [key: string]: unknown;
}

export class OpenFangAdapter implements FrameworkAdapter {
  readonly name = "openfang";
  readonly defaultPorts = [4200];

  async probe(host: string, port: number): Promise<ProbeResult | null> {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as OpenFangHealth;
      if (!this.isOpenFang(data)) return null;

      // Try to get identity from /.well-known/agent.json
      const agent = await this.fetchAgentJson(host, port);

      return {
        name: "openfang",
        version: data.version ?? agent?.version,
        display_name: agent?.display_name ?? agent?.name,
        metadata: {
          agent_id: agent?.agent_id,
          agent_name: agent?.name,
        },
      };
    } catch {
      return null;
    }
  }

  toClawInstance(host: string, port: number, probe: ProbeResult): Partial<ClawInstance> {
    const meta = probe.metadata as Record<string, string | undefined> | undefined;
    return {
      agent_id: meta?.agent_id ?? `openfang@${host}`,
      assistant_name: meta?.agent_name ?? "",
      display_name: probe.display_name ?? "openfang",
      lan_host: host,
      address: host,
      gateway_port: port,
      tls: false,
      discovery_source: "scan",
      status: "online",
      implementation: "openfang",
    };
  }

  async healthCheck(host: string, port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as OpenFangHealth;
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  private isOpenFang(data: OpenFangHealth): boolean {
    // Confirm OpenFang by framework field or status shape
    if (data.framework === "openfang") return true;
    // Heuristic: /api/health with status: "ok" on default port
    if (data.status === "ok") return true;
    return false;
  }

  private async fetchAgentJson(host: string, port: number): Promise<AgentJson | null> {
    try {
      const res = await fetch(`http://${host}:${port}/.well-known/agent.json`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return null;
      return (await res.json()) as AgentJson;
    } catch {
      return null;
    }
  }
}
