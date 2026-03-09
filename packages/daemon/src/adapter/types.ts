// Framework adapter interface — pluggable probe logic for non-OpenClaw variants
// that don't share port 18789 or serve /__openclaw/control-ui-config.json

import type { ClawInstance } from "../types.js";

export interface ProbeResult {
  name: string;
  version?: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export interface FrameworkAdapter {
  readonly name: string;            // matches ClawImplementation
  readonly defaultPorts: number[];
  probe(host: string, port: number): Promise<ProbeResult | null>;
  toClawInstance(host: string, port: number, probe: ProbeResult): Partial<ClawInstance>;
  healthCheck(host: string, port: number): Promise<boolean>;

  // Local filesystem probe (for frameworks without HTTP servers)
  probeLocal?(): Promise<ProbeResult | null>;
  healthCheckLocal?(): Promise<boolean>;
}
