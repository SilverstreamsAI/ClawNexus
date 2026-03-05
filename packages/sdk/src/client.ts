// ClawNexus SDK — HTTP client for clawnexus daemon API

import type {
  ClawInstance,
  RegistryStatus,
  WhoamiResponse,
  PolicyConfig,
  TaskRecord,
  TaskStats,
  TaskDirection,
  TaskState,
  TaskSpec,
  InboxItem,
} from "./types.js";

export interface ClawNexusClientOptions {
  apiUrl?: string;
  timeout?: number;
}

export class ClawNexusClient {
  private readonly apiUrl: string;
  private readonly timeout: number;

  constructor(options: ClawNexusClientOptions = {}) {
    this.apiUrl = options.apiUrl ?? "http://localhost:17890";
    this.timeout = options.timeout ?? 5000;
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/health");
  }

  async listInstances(): Promise<{ count: number; instances: ClawInstance[] }> {
    return this.request("GET", "/instances");
  }

  async getInstance(idOrName: string): Promise<ClawInstance> {
    return this.request("GET", `/instances/${encodeURIComponent(idOrName)}`);
  }

  async setAlias(idOrName: string, alias: string): Promise<{ status: string; agent_id: string; alias: string }> {
    return this.request("PUT", `/instances/${encodeURIComponent(idOrName)}/alias`, { alias });
  }

  async removeInstance(idOrName: string): Promise<{ status: string; removed: string }> {
    return this.request("DELETE", `/instances/${encodeURIComponent(idOrName)}`);
  }

  async scan(): Promise<{ status: string; discovered: number; instances: ClawInstance[] }> {
    return this.request("POST", "/scan");
  }

  // --- Registry (v0.2) ---

  async register(): Promise<{ status: string; claw_name: string | null; pubkey: string | null }> {
    return this.request("POST", "/registry/register");
  }

  async registryStatus(): Promise<RegistryStatus> {
    return this.request("GET", "/registry/status");
  }

  async resolve(name: string): Promise<ClawInstance> {
    return this.request("GET", `/resolve/${encodeURIComponent(name)}`);
  }

  async whoami(): Promise<WhoamiResponse> {
    return this.request("GET", "/whoami");
  }

  // --- Relay ---

  async relayConnect(targetClawId: string): Promise<{ status: string; target: string }> {
    return this.request("POST", "/relay/connect", { target_claw_id: targetClawId });
  }

  async relayStatus(): Promise<Record<string, unknown>> {
    return this.request("GET", "/relay/status");
  }

  async relayDisconnect(roomId: string): Promise<{ status: string; room_id: string }> {
    return this.request("DELETE", `/relay/disconnect/${encodeURIComponent(roomId)}`);
  }

  // --- Layer B: Agent / Policy ---

  async getPolicy(): Promise<PolicyConfig> {
    return this.request("GET", "/agent/policy");
  }

  async updatePolicy(policy: PolicyConfig): Promise<{ status: string }> {
    return this.request("PUT", "/agent/policy", policy);
  }

  async patchPolicy(partial: Partial<PolicyConfig>): Promise<{ status: string; policy: PolicyConfig }> {
    return this.request("PATCH", "/agent/policy", partial);
  }

  async resetPolicy(): Promise<{ status: string; policy: PolicyConfig }> {
    return this.request("POST", "/agent/policy/reset");
  }

  // --- Layer B: Tasks ---

  async listTasks(opts?: { all?: boolean; direction?: TaskDirection; state?: TaskState }): Promise<{ count: number; tasks: TaskRecord[] }> {
    const params = new URLSearchParams();
    if (opts?.all) params.set("all", "true");
    if (opts?.direction) params.set("direction", opts.direction);
    if (opts?.state) params.set("state", opts.state);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.request("GET", `/agent/tasks${qs}`);
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    return this.request("GET", `/agent/tasks/${encodeURIComponent(taskId)}`);
  }

  async cancelTask(taskId: string, reason?: string): Promise<{ status: string; task: TaskRecord }> {
    return this.request("POST", `/agent/tasks/${encodeURIComponent(taskId)}/cancel`, { reason });
  }

  async getTaskStats(): Promise<TaskStats> {
    return this.request("GET", "/agent/tasks/stats");
  }

  // --- Layer B: Propose / Query ---

  async propose(targetClawId: string, roomId: string, task: TaskSpec): Promise<{ status: string; task: TaskRecord }> {
    return this.request("POST", "/agent/propose", { target_claw_id: targetClawId, room_id: roomId, task });
  }

  async query(targetClawId: string, roomId: string, queryType: "capabilities" | "status" | "availability"): Promise<{ status: string; message_id: string }> {
    return this.request("POST", "/agent/query", { target_claw_id: targetClawId, room_id: roomId, query_type: queryType });
  }

  // --- Layer B: Inbox ---

  async getInbox(): Promise<{ count: number; items: InboxItem[] }> {
    return this.request("GET", "/agent/inbox");
  }

  async approveInbox(messageId: string): Promise<{ status: string; task: TaskRecord }> {
    return this.request("POST", `/agent/inbox/${encodeURIComponent(messageId)}/approve`);
  }

  async denyInbox(messageId: string, reason?: string): Promise<{ status: string }> {
    return this.request("POST", `/agent/inbox/${encodeURIComponent(messageId)}/deny`, { reason });
  }

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${urlPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });

    const data = await res.json();

    if (!res.ok) {
      const error = (data as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new ClawNexusApiError(error, res.status);
    }

    return data as T;
  }
}

export class ClawNexusApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ClawNexusApiError";
  }
}
