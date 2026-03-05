// Layer B — Message Protocol
// Pure functions: envelope construction, parsing, validation

import { randomUUID } from "node:crypto";
import type {
  LayerBEnvelope,
  LayerBMessageType,
  LayerBPayload,
  QueryPayload,
  ProposePayload,
  AcceptPayload,
  RejectPayload,
  DelegatePayload,
  ReportPayload,
  CancelPayload,
  CapabilityPayload,
  HeartbeatPayload,
} from "./types.js";

const PROTOCOL = "clawnexus-agent" as const;
const VERSION = "1.0" as const;
const DEFAULT_TTL = 300; // 5 minutes

const VALID_TYPES: ReadonlySet<LayerBMessageType> = new Set([
  "query", "propose", "accept", "reject", "delegate",
  "report", "cancel", "capability", "heartbeat",
]);

export interface EnvelopeOptions {
  in_reply_to?: string;
  ttl?: number;
}

export function createEnvelope(
  from: string,
  to: string,
  type: LayerBMessageType,
  payload: LayerBPayload,
  opts?: EnvelopeOptions,
): LayerBEnvelope {
  return {
    protocol: PROTOCOL,
    version: VERSION,
    message_id: randomUUID(),
    in_reply_to: opts?.in_reply_to,
    from,
    to,
    type,
    payload,
    timestamp: new Date().toISOString(),
    ttl: opts?.ttl ?? DEFAULT_TTL,
  };
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function parseEnvelope(raw: string): LayerBEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("Invalid JSON");
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.protocol !== PROTOCOL) {
    throw new ProtocolError(`Unknown protocol: ${obj.protocol}`);
  }
  if (obj.version !== VERSION) {
    throw new ProtocolError(`Unsupported version: ${obj.version}`);
  }
  if (!obj.message_id || typeof obj.message_id !== "string") {
    throw new ProtocolError("Missing message_id");
  }
  if (!obj.from || typeof obj.from !== "string") {
    throw new ProtocolError("Missing from");
  }
  if (!obj.to || typeof obj.to !== "string") {
    throw new ProtocolError("Missing to");
  }
  if (!VALID_TYPES.has(obj.type as LayerBMessageType)) {
    throw new ProtocolError(`Invalid type: ${obj.type}`);
  }
  if (!obj.payload || typeof obj.payload !== "object") {
    throw new ProtocolError("Missing payload");
  }
  if (!obj.timestamp || typeof obj.timestamp !== "string") {
    throw new ProtocolError("Missing timestamp");
  }

  validatePayload(obj.type as LayerBMessageType, obj.payload as LayerBPayload);

  return obj as unknown as LayerBEnvelope;
}

export function validatePayload(type: LayerBMessageType, payload: LayerBPayload): void {
  switch (type) {
    case "query": {
      const p = payload as QueryPayload;
      if (!p.query_type) throw new ProtocolError("query: missing query_type");
      if (!["capabilities", "status", "availability"].includes(p.query_type)) {
        throw new ProtocolError(`query: invalid query_type: ${p.query_type}`);
      }
      break;
    }
    case "propose": {
      const p = payload as ProposePayload;
      if (!p.task) throw new ProtocolError("propose: missing task");
      if (!p.task.task_type) throw new ProtocolError("propose: missing task.task_type");
      if (!p.task.description) throw new ProtocolError("propose: missing task.description");
      if (p.task.delegation_depth !== undefined && p.task.delegation_depth > 5) {
        throw new ProtocolError("propose: delegation_depth exceeds hard cap (5)");
      }
      break;
    }
    case "accept": {
      const p = payload as AcceptPayload;
      if (!p.task_id) throw new ProtocolError("accept: missing task_id");
      break;
    }
    case "reject": {
      const p = payload as RejectPayload;
      if (!p.task_id) throw new ProtocolError("reject: missing task_id");
      if (!p.reason) throw new ProtocolError("reject: missing reason");
      break;
    }
    case "delegate": {
      const p = payload as DelegatePayload;
      if (!p.task_id) throw new ProtocolError("delegate: missing task_id");
      if (!p.original_from) throw new ProtocolError("delegate: missing original_from");
      if (!p.task) throw new ProtocolError("delegate: missing task");
      break;
    }
    case "report": {
      const p = payload as ReportPayload;
      if (!p.task_id) throw new ProtocolError("report: missing task_id");
      if (!p.status) throw new ProtocolError("report: missing status");
      if (!["completed", "failed", "progress"].includes(p.status)) {
        throw new ProtocolError(`report: invalid status: ${p.status}`);
      }
      break;
    }
    case "cancel": {
      const p = payload as CancelPayload;
      if (!p.task_id) throw new ProtocolError("cancel: missing task_id");
      break;
    }
    case "capability": {
      const p = payload as CapabilityPayload;
      if (!Array.isArray(p.capabilities)) {
        throw new ProtocolError("capability: missing capabilities array");
      }
      break;
    }
    case "heartbeat": {
      const p = payload as HeartbeatPayload;
      if (!p.task_id) throw new ProtocolError("heartbeat: missing task_id");
      break;
    }
  }
}

export function isExpired(envelope: LayerBEnvelope): boolean {
  const ttl = envelope.ttl ?? DEFAULT_TTL;
  const created = new Date(envelope.timestamp).getTime();
  return Date.now() - created > ttl * 1000;
}
