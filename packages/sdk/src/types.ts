// Core types — mirrored from daemon for SDK consumers

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
  discovery_source: "mdns" | "scan" | "manual" | "local" | "registry";
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

// --- Registry Types (v0.2) ---

export interface RegistryStatus {
  registered: boolean;
  claw_name: string | null;
  pubkey: string | null;
}

export interface WhoamiResponse {
  pubkey: string | null;
  claw_name: string | null;
}

// --- Layer B Types (for SDK consumers) ---

export interface PolicyConfig {
  mode: "auto" | "queue" | "hybrid";
  trust_threshold: number;
  rate_limit: {
    max_per_minute: number;
    max_per_peer_minute: number;
  };
  delegation: {
    allow: boolean;
    max_depth: number;
  };
  capability_filter: string[];
  access_control: {
    whitelist: string[];
    blacklist: string[];
  };
  auto_approve_types: string[];
  max_concurrent_tasks: number;
}

export interface TaskSpec {
  task_type: string;
  description: string;
  input?: Record<string, unknown>;
  constraints?: {
    max_duration_s?: number;
    max_cost?: number;
    priority?: "low" | "normal" | "high" | "critical";
  };
  delegation_depth?: number;
}

export type TaskState =
  | "pending" | "accepted" | "executing" | "completed"
  | "failed" | "rejected" | "cancelled" | "timeout";

export type TaskDirection = "outbound" | "inbound";

export interface TaskRecord {
  task_id: string;
  direction: TaskDirection;
  peer_claw_id: string;
  task: TaskSpec;
  state: TaskState;
  created_at: string;
  updated_at: string;
  accepted_at?: string;
  completed_at?: string;
  result?: unknown;
  error?: string;
  progress_pct?: number;
  message_id: string;
  room_id?: string;
}

export interface TaskStats {
  total: number;
  by_state: Record<TaskState, number>;
  by_direction: Record<TaskDirection, number>;
  active: number;
}

export interface InboxItem {
  message_id: string;
  from: string;
  type: string;
  task?: TaskSpec;
  timestamp: string;
}
