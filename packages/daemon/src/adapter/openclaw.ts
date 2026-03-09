// OpenClaw adapter — canonical OpenClaw (and compatible variants like GoClaw)
// Probe: /__openclaw/control-ui-config.json → extract agentId, assistantName, displayName

import type { ClawInstance, ControlUiConfig } from "../types.js";
import type { FrameworkAdapter, ProbeResult } from "./types.js";

const PROBE_TIMEOUT = 2_000;
const CONFIG_PATH = "/__openclaw/control-ui-config.json";

export class OpenClawAdapter implements FrameworkAdapter {
  readonly name = "openclaw";
  readonly defaultPorts = [18789];

  async probe(host: string, port: number): Promise<ProbeResult | null> {
    try {
      const res = await fetch(`http://${host}:${port}${CONFIG_PATH}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!res.ok) return null;

      const config = (await res.json()) as ControlUiConfig;
      if (!config.assistantAgentId) return null;

      return {
        name: "openclaw",
        display_name: config.displayName ?? config.assistantName ?? undefined,
        metadata: {
          assistantAgentId: config.assistantAgentId,
          assistantName: config.assistantName,
          displayName: config.displayName,
        },
      };
    } catch {
      return null;
    }
  }

  toClawInstance(host: string, port: number, probe: ProbeResult): Partial<ClawInstance> {
    const meta = probe.metadata as Record<string, string | undefined> | undefined;
    return {
      agent_id: meta?.assistantAgentId ?? `openclaw@${host}`,
      assistant_name: meta?.assistantName ?? "",
      display_name: meta?.displayName ?? meta?.assistantName ?? "",
      lan_host: host,
      address: host,
      gateway_port: port,
      tls: false,
      discovery_source: "scan",
      status: "online",
      implementation: "openclaw",
    };
  }

  async healthCheck(host: string, port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://${host}:${port}${CONFIG_PATH}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
