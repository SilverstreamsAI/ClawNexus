import type { ClawInstance } from "../src/types.js";
import type { TaskRecord, TaskSpec, LayerBEnvelope, ProposePayload } from "../src/agent/types.js";
import { randomUUID } from "node:crypto";

let counter = 0;

export function makeInstance(overrides: Partial<ClawInstance> = {}): ClawInstance {
  counter++;
  const now = new Date().toISOString();
  return {
    agent_id: overrides.agent_id ?? `agent-${counter}`,
    auto_name: overrides.auto_name ?? `test-instance-${counter}`,
    assistant_name: overrides.assistant_name ?? `Assistant ${counter}`,
    display_name: overrides.display_name ?? `Display ${counter}`,
    alias: overrides.alias,
    lan_host: overrides.lan_host ?? `host-${counter}.local`,
    address: overrides.address ?? `192.168.1.${counter}`,
    gateway_port: overrides.gateway_port ?? 18789,
    tls: overrides.tls ?? false,
    tls_fingerprint: overrides.tls_fingerprint,
    discovery_source: overrides.discovery_source ?? "scan",
    network_scope: overrides.network_scope ?? "local",
    status: overrides.status ?? "online",
    last_seen: overrides.last_seen ?? now,
    discovered_at: overrides.discovered_at ?? now,
    connectivity: overrides.connectivity,
    is_self: overrides.is_self,
    claw_name: overrides.claw_name,
    owner_pubkey: overrides.owner_pubkey,
    labels: overrides.labels,
  };
}

export function makeTaskSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    task_type: overrides.task_type ?? "test-task",
    description: overrides.description ?? "A test task",
    input: overrides.input,
    constraints: overrides.constraints,
    delegation_depth: overrides.delegation_depth,
  };
}

export function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    task_id: overrides.task_id ?? randomUUID(),
    direction: overrides.direction ?? "outbound",
    peer_claw_id: overrides.peer_claw_id ?? "peer.id.claw",
    task: overrides.task ?? makeTaskSpec(),
    state: overrides.state ?? "pending",
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    message_id: overrides.message_id ?? randomUUID(),
    room_id: overrides.room_id,
    decision: overrides.decision,
    accepted_at: overrides.accepted_at,
    completed_at: overrides.completed_at,
    result: overrides.result,
    error: overrides.error,
    progress_pct: overrides.progress_pct,
    last_heartbeat: overrides.last_heartbeat,
  };
}

export function makeProposeEnvelope(
  from: string,
  to: string,
  task?: Partial<TaskSpec>,
  overrides?: Partial<LayerBEnvelope>,
): LayerBEnvelope {
  return {
    protocol: "clawnexus-agent",
    version: "1.0",
    message_id: overrides?.message_id ?? randomUUID(),
    from,
    to,
    type: "propose",
    payload: {
      task: makeTaskSpec(task),
      reply_timeout_s: 60,
    } as ProposePayload,
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    ttl: overrides?.ttl ?? 300,
  };
}
