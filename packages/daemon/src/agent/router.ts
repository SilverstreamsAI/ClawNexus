// Layer B — Agent Message Router
// Bridges relay DATA events with protocol parsing, policy engine, and task manager

import { EventEmitter } from "node:events";
import type { RelayConnector } from "../relay/connector.js";
import type { PolicyEngine } from "./engine.js";
import type { TaskManager } from "./tasks.js";
import type {
  LayerBEnvelope,
  ProposePayload,
  TaskRecord,
  TaskDirection,
  PolicyDecision,
} from "./types.js";
import { parseEnvelope, createEnvelope, isExpired, ProtocolError } from "./protocol.js";
import { randomUUID } from "node:crypto";

export interface AgentRouterOptions {
  connector: RelayConnector;
  engine: PolicyEngine;
  tasks: TaskManager;
  localClawId: string;
}

export class AgentRouter extends EventEmitter {
  private readonly connector: RelayConnector;
  private readonly engine: PolicyEngine;
  private readonly tasks: TaskManager;
  private readonly localClawId: string;
  private dataHandler: ((roomId: string, plaintext: string) => void) | null = null;
  // Map queued message_id → { envelope, roomId } for manual approve/deny
  private inbox = new Map<string, { envelope: LayerBEnvelope; roomId: string }>();

  constructor(opts: AgentRouterOptions) {
    super();
    this.connector = opts.connector;
    this.engine = opts.engine;
    this.tasks = opts.tasks;
    this.localClawId = opts.localClawId;
  }

  start(): void {
    this.dataHandler = (roomId: string, plaintext: string) => {
      this.handleData(roomId, plaintext);
    };
    this.connector.on("data", this.dataHandler);
  }

  stop(): void {
    if (this.dataHandler) {
      this.connector.off("data", this.dataHandler);
      this.dataHandler = null;
    }
  }

  sendMessage(roomId: string, envelope: LayerBEnvelope): boolean {
    return this.connector.sendData(roomId, JSON.stringify(envelope));
  }

  /** Initiate a propose to a peer (outbound task) */
  propose(roomId: string, targetClawId: string, task: ProposePayload["task"]): TaskRecord {
    const envelope = createEnvelope(this.localClawId, targetClawId, "propose", {
      task,
      reply_timeout_s: 60,
    } as ProposePayload);

    const record: TaskRecord = {
      task_id: envelope.message_id,
      direction: "outbound",
      peer_claw_id: targetClawId,
      task,
      state: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      message_id: envelope.message_id,
      room_id: roomId,
    };

    this.tasks.create(record);
    this.sendMessage(roomId, envelope);
    this.emit("outbound", envelope);
    return record;
  }

  /** Send a query to a peer */
  query(roomId: string, targetClawId: string, queryType: "capabilities" | "status" | "availability"): LayerBEnvelope {
    const envelope = createEnvelope(this.localClawId, targetClawId, "query", {
      query_type: queryType,
    });
    this.sendMessage(roomId, envelope);
    this.emit("outbound", envelope);
    return envelope;
  }

  /** Approve a queued inbound proposal */
  approveInbox(messageId: string): TaskRecord | null {
    const entry = this.inbox.get(messageId);
    if (!entry) return null;
    this.inbox.delete(messageId);

    return this.acceptProposal(entry.envelope, entry.roomId);
  }

  /** Deny a queued inbound proposal */
  denyInbox(messageId: string, reason?: string): void {
    const entry = this.inbox.get(messageId);
    if (!entry) return;
    this.inbox.delete(messageId);

    const reply = createEnvelope(
      this.localClawId,
      entry.envelope.from,
      "reject",
      { task_id: entry.envelope.message_id, reason: "user_denied", message: reason },
      { in_reply_to: entry.envelope.message_id },
    );
    this.sendMessage(entry.roomId, reply);
  }

  /** Get pending inbox items */
  getInbox(): Array<{ message_id: string; envelope: LayerBEnvelope; roomId: string }> {
    return Array.from(this.inbox.entries()).map(([id, entry]) => ({
      message_id: id,
      ...entry,
    }));
  }

  private handleData(roomId: string, plaintext: string): void {
    let envelope: LayerBEnvelope;
    try {
      envelope = parseEnvelope(plaintext);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.emit("protocol_error", err, roomId);
      }
      return; // Not a Layer B message — ignore silently
    }

    // Ignore expired messages
    if (isExpired(envelope)) {
      this.emit("expired", envelope);
      return;
    }

    this.emit("inbound", envelope, roomId);

    switch (envelope.type) {
      case "propose":
      case "delegate":
        this.handleProposal(envelope, roomId);
        break;

      case "accept":
      case "reject":
      case "report":
      case "cancel":
        this.tasks.handleResponse(envelope);
        this.emit("response", envelope, roomId);
        break;

      case "heartbeat":
        this.tasks.updateHeartbeat(envelope);
        break;

      case "query":
        this.handleQuery(envelope, roomId);
        break;

      case "capability":
        this.emit("capability", envelope, roomId);
        break;
    }
  }

  private handleProposal(envelope: LayerBEnvelope, roomId: string): void {
    const decision = this.engine.evaluate(envelope);
    this.emit("decision", envelope, decision, roomId);

    switch (decision.result) {
      case "accept":
        this.acceptProposal(envelope, roomId);
        break;

      case "reject": {
        const reply = createEnvelope(
          this.localClawId,
          envelope.from,
          "reject",
          { task_id: envelope.message_id, reason: decision.reason as string, message: decision.details },
          { in_reply_to: envelope.message_id },
        );
        this.sendMessage(roomId, reply);
        break;
      }

      case "queue":
        this.inbox.set(envelope.message_id, { envelope, roomId });
        this.emit("queued", envelope, roomId);
        break;
    }
  }

  private acceptProposal(envelope: LayerBEnvelope, roomId: string): TaskRecord {
    const task = envelope.type === "propose"
      ? (envelope.payload as ProposePayload).task
      : (envelope.payload as { task: ProposePayload["task"] }).task;

    const record: TaskRecord = {
      task_id: envelope.message_id,
      direction: "inbound" as TaskDirection,
      peer_claw_id: envelope.from,
      task,
      state: "accepted",
      decision: { result: "accept", reason: "auto_approved" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      accepted_at: new Date().toISOString(),
      message_id: envelope.message_id,
      room_id: roomId,
    };

    this.tasks.create(record);

    const reply = createEnvelope(
      this.localClawId,
      envelope.from,
      "accept",
      { task_id: envelope.message_id },
      { in_reply_to: envelope.message_id },
    );
    this.sendMessage(roomId, reply);

    return record;
  }

  private handleQuery(envelope: LayerBEnvelope, roomId: string): void {
    // Respond with capability info (placeholder — actual capabilities from services.ts in future)
    const reply = createEnvelope(
      this.localClawId,
      envelope.from,
      "capability",
      { capabilities: [] },
      { in_reply_to: envelope.message_id },
    );
    this.sendMessage(roomId, reply);
  }
}
