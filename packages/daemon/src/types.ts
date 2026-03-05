// ClawNexus shared types — used across store, mDNS, health, API, scanner

export interface ClawInstance {
  // Identifiers (three layers)
  agent_id: string;           // from OpenClaw (read-only, may be duplicated e.g. "main")
  auto_name: string;          // ClawNexus auto-generated (unique, from hostname)
  alias?: string;             // user-set (unique, ≤32 chars)

  // Naming (from OpenClaw, read-only)
  assistant_name: string;
  display_name: string;

  // Network (from mDNS or scan)
  lan_host: string;
  address: string;
  gateway_port: number;
  tls: boolean;
  tls_fingerprint?: string;

  // Discovery source
  discovery_source: "mdns" | "scan" | "manual" | "local" | "registry" | "broadcast";
  network_scope: "local" | "vpn" | "public";

  // Health state (maintained by clawnexus)
  status: "online" | "offline" | "unknown";
  last_seen: string;
  discovered_at: string;

  // Dual-channel routing
  connectivity?: Connectivity;

  // Self marker (true when discovered by LocalProbe on this machine)
  is_self?: boolean;

  // Registry (v0.2 — public registry integration)
  claw_name?: string;        // "main.id.claw" — registered name on public registry
  owner_pubkey?: string;     // "ed25519:aabb..." — owner identity key

  // User-defined
  labels?: Record<string, string>;
}

export interface Connectivity {
  lan_reachable: boolean;
  relay_available: boolean;
  preferred_channel: "lan" | "relay" | "local" | "unknown";
  lan_latency_ms?: number;
  last_lan_check: string;
  unreachable_reason?: string;
}

export interface UnreachableInstance {
  address: string;
  port: number;
  lan_host: string;
  display_name: string;
  reason: string;
  discovered_at: string;
}

export interface RegistryFile {
  schema_version: "2" | "3" | "4" | "5";
  updated_at: string;
  instances: ClawInstance[];
}

export interface ControlUiConfig {
  assistantAgentId: string;
  assistantName: string;
  displayName?: string;
  [key: string]: unknown;
}
