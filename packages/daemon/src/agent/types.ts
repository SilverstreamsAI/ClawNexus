// Layer B — Autonomous Agent Interaction Types

// --- Message Protocol ---

export type LayerBMessageType =
  | "query"
  | "propose"
  | "accept"
  | "reject"
  | "delegate"
  | "report"
  | "cancel"
  | "capability"
  | "heartbeat";

export interface LayerBEnvelope {
  protocol: "clawnexus-agent";
  version: "1.0";
  message_id: string;
  in_reply_to?: string;
  from: string;         // sender claw_id
  to: string;           // recipient claw_id
  type: LayerBMessageType;
  payload: LayerBPayload;
  timestamp: string;    // ISO 8601
  ttl?: number;         // seconds, default 300
}

export type LayerBPayload =
  | QueryPayload
  | ProposePayload
  | AcceptPayload
  | RejectPayload
  | DelegatePayload
  | ReportPayload
  | CancelPayload
  | CapabilityPayload
  | HeartbeatPayload;

// --- Payloads ---

export interface QueryPayload {
  query_type: "capabilities" | "status" | "availability";
  filters?: Record<string, string>;
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
  delegation_depth?: number;  // current depth, hard cap 5
}

export interface ProposePayload {
  task: TaskSpec;
  reply_timeout_s?: number;  // default 60
}

export interface AcceptPayload {
  task_id: string;
  estimated_duration_s?: number;
}

export type RejectReason =
  | "policy_denied"
  | "capability_mismatch"
  | "overloaded"
  | "trust_insufficient"
  | "rate_limited"
  | "user_denied"
  | "unknown";

export interface RejectPayload {
  task_id: string;
  reason: RejectReason;
  message?: string;
}

export interface DelegatePayload {
  task_id: string;
  original_from: string;
  task: TaskSpec;
}

export interface ReportPayload {
  task_id: string;
  status: "completed" | "failed" | "progress";
  result?: unknown;
  error?: string;
  progress_pct?: number;
}

export interface CancelPayload {
  task_id: string;
  reason?: string;
}

export interface CapabilityPayload {
  capabilities: ServiceCapability[];
}

export interface HeartbeatPayload {
  task_id: string;
  progress_pct?: number;
  message?: string;
}

// --- Policy Engine ---

export interface PolicyConfig {
  mode: "auto" | "queue" | "hybrid";
  trust_threshold: number;       // 0-100, default 50
  rate_limit: {
    max_per_minute: number;      // default 10
    max_per_peer_minute: number; // default 3
  };
  delegation: {
    allow: boolean;
    max_depth: number;           // default 3, hard cap 5
  };
  capability_filter: string[];   // allowed task_type patterns, empty = all
  access_control: {
    whitelist: string[];         // claw_ids always allowed
    blacklist: string[];         // claw_ids always denied
  };
  auto_approve_types: string[];  // task_types auto-approved in hybrid mode
  max_concurrent_tasks: number;  // default 5
}

export type PolicyDecisionResult = "accept" | "reject" | "queue";

export interface PolicyDecision {
  result: PolicyDecisionResult;
  reason: RejectReason | "auto_approved" | "queued_for_review";
  details?: string;
}

// --- Task Management ---

export type TaskState =
  | "pending"
  | "accepted"
  | "executing"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled"
  | "timeout";

export type TaskDirection = "outbound" | "inbound";

export interface TaskRecord {
  task_id: string;
  direction: TaskDirection;
  peer_claw_id: string;
  task: TaskSpec;
  state: TaskState;
  decision?: PolicyDecision;
  created_at: string;
  updated_at: string;
  accepted_at?: string;
  completed_at?: string;
  result?: unknown;
  error?: string;
  progress_pct?: number;
  last_heartbeat?: string;
  message_id: string;        // original propose message_id
  room_id?: string;          // relay room for this interaction
}

export interface ActiveTasksFile {
  schema_version: "1";
  updated_at: string;
  tasks: TaskRecord[];
}

export interface TaskStats {
  total: number;
  by_state: Record<TaskState, number>;
  by_direction: Record<TaskDirection, number>;
  active: number;
}

// --- Service Discovery ---

export interface ServiceCapability {
  service_type: string;
  description: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  verified?: boolean;
}

export interface WantedService {
  service_type: string;
  auto_connect: boolean;
  preferred_peers?: string[];
}

export interface ServicesFile {
  schema_version: "1";
  updated_at: string;
  offered: ServiceCapability[];
  wanted: WantedService[];
}
