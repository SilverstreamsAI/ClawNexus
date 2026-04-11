// Fetch wrapper for ClawNexus daemon API

const BASE = "";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface ClawInstance {
  agent_id: string;
  auto_name: string;
  alias?: string;
  display_name: string;
  assistant_name: string;
  implementation?: string;
  lan_host: string;
  address: string;
  gateway_port: number;
  tls: boolean;
  discovery_source: string;
  network_scope: string;
  status: string;
  last_seen: string;
  discovered_at: string;
  is_self?: boolean;
  claw_name?: string;
  connectivity?: {
    preferred_channel: string;
    lan_reachable: boolean;
    lan_latency_ms?: number;
    relay_available: boolean;
    unreachable_reason?: string;
  };
  remote_card?: {
    card_url: string;
    fetched_at: string;
    skills?: Array<{ id?: string; name?: string }>;
  };
}

export interface InstancesResponse {
  count: number;
  instances: ClawInstance[];
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  timestamp: string;
  components: Record<string, unknown>;
  wireguard?: Record<string, unknown>;
}

export interface DiagnosticsResponse {
  local_instance: { agent_id?: string; status: string };
  lan_discovery: {
    mdns: string;
    unreachable_count: number;
    unreachable: Array<{ address: string; lan_host: string; reason: string }>;
  };
  registry: { status: string; claw_name?: string };
  relay: { status: string };
  summary: { total_instances: number; lan_instances: number; relay_instances: number };
}

export interface TaskRecord {
  task_id: string;
  direction: string;
  peer_claw_id: string;
  state: string;
  task: { task_type: string; description: string };
  created_at: string;
}

export interface TasksResponse {
  count: number;
  tasks: TaskRecord[];
}

export interface TaskStats {
  total: number;
  active: number;
  by_state: Record<string, number>;
  by_direction: Record<string, number>;
}

export interface PolicyConfig {
  auto_accept: boolean;
  allowed_task_types: string[];
  trusted_peers: string[];
  max_concurrent_tasks: number;
  [key: string]: unknown;
}

export interface PricingModel {
  id: string;
  name: string;
  provider: string;
  pricing: {
    prompt: number;
    completion: number;
    image: number;
    request: number;
    unit: string;
  };
  context_length: number;
  max_completion_tokens: number | null;
  input_modalities: string[];
  output_modalities: string[];
  created: number;
}

export interface PricingResponse {
  schema_version: string;
  fetched_at: string;
  source: string;
  model_count: number;
  models: PricingModel[];
}

export interface ProvidersResponse {
  count: number;
  providers: string[];
}

export const api = {
  getInstances: () => request<InstancesResponse>("GET", "/instances"),
  setAlias: (id: string, alias: string) =>
    request<{ status: string }>("PUT", `/instances/${encodeURIComponent(id)}/alias`, { alias }),
  deleteInstance: (id: string) =>
    request<{ status: string }>("DELETE", `/instances/${encodeURIComponent(id)}`),
  triggerScan: () => request<{ status: string; discovered: number }>("POST", "/scan"),
  getHealth: () => request<HealthResponse>("GET", "/health"),
  getDiagnostics: () => request<DiagnosticsResponse>("GET", "/diagnostics"),
  getTasks: (all = false) => request<TasksResponse>("GET", `/agent/tasks${all ? "?all=true" : ""}`),
  getTaskStats: () => request<TaskStats>("GET", "/agent/tasks/stats"),
  getPolicy: () => request<PolicyConfig>("GET", "/agent/policy"),
  updatePolicy: (patch: Partial<PolicyConfig>) =>
    request<{ status: string; policy: PolicyConfig }>("PATCH", "/agent/policy", patch),
  resetPolicy: () =>
    request<{ status: string; policy: PolicyConfig }>("POST", "/agent/policy/reset"),
  getWhoami: () => request<{ pubkey?: string; claw_name?: string }>("GET", "/whoami"),
  getPricing: (provider?: string) =>
    request<PricingResponse>("GET", provider ? `/pricing?provider=${encodeURIComponent(provider)}` : "/pricing"),
  getPricingProviders: () => request<ProvidersResponse>("GET", "/pricing/providers"),
};
