import { describe, it, expect } from "vitest";
import {
  createEnvelope,
  parseEnvelope,
  validatePayload,
  isExpired,
  ProtocolError,
} from "../../src/agent/protocol.js";

describe("Protocol", () => {
  describe("createEnvelope", () => {
    it("creates a valid envelope with required fields", () => {
      const env = createEnvelope("alice.id.claw", "bob.id.claw", "query", {
        query_type: "capabilities",
      });

      expect(env.protocol).toBe("clawnexus-agent");
      expect(env.version).toBe("1.0");
      expect(env.message_id).toBeTruthy();
      expect(env.from).toBe("alice.id.claw");
      expect(env.to).toBe("bob.id.claw");
      expect(env.type).toBe("query");
      expect(env.payload).toEqual({ query_type: "capabilities" });
      expect(env.timestamp).toBeTruthy();
      expect(env.ttl).toBe(300);
    });

    it("sets custom ttl and in_reply_to", () => {
      const env = createEnvelope("a", "b", "accept", { task_id: "t1" }, {
        ttl: 60,
        in_reply_to: "msg-123",
      });

      expect(env.ttl).toBe(60);
      expect(env.in_reply_to).toBe("msg-123");
    });

    it("generates unique message_ids", () => {
      const a = createEnvelope("a", "b", "heartbeat", { task_id: "t1" });
      const b = createEnvelope("a", "b", "heartbeat", { task_id: "t1" });
      expect(a.message_id).not.toBe(b.message_id);
    });
  });

  describe("parseEnvelope", () => {
    it("parses a valid JSON envelope", () => {
      const env = createEnvelope("a", "b", "query", { query_type: "status" });
      const parsed = parseEnvelope(JSON.stringify(env));
      expect(parsed.message_id).toBe(env.message_id);
      expect(parsed.type).toBe("query");
    });

    it("throws on invalid JSON", () => {
      expect(() => parseEnvelope("not json")).toThrow(ProtocolError);
      expect(() => parseEnvelope("not json")).toThrow("Invalid JSON");
    });

    it("throws on unknown protocol", () => {
      const raw = JSON.stringify({ protocol: "other", version: "1.0", message_id: "m", from: "a", to: "b", type: "query", payload: {}, timestamp: "t" });
      expect(() => parseEnvelope(raw)).toThrow("Unknown protocol");
    });

    it("throws on unsupported version", () => {
      const raw = JSON.stringify({ protocol: "clawnexus-agent", version: "2.0", message_id: "m", from: "a", to: "b", type: "query", payload: {}, timestamp: "t" });
      expect(() => parseEnvelope(raw)).toThrow("Unsupported version");
    });

    it("throws on missing fields", () => {
      const base = { protocol: "clawnexus-agent", version: "1.0" };
      expect(() => parseEnvelope(JSON.stringify(base))).toThrow("Missing message_id");

      expect(() => parseEnvelope(JSON.stringify({ ...base, message_id: "m" }))).toThrow("Missing from");

      expect(() => parseEnvelope(JSON.stringify({ ...base, message_id: "m", from: "a" }))).toThrow("Missing to");
    });

    it("throws on invalid type", () => {
      const raw = JSON.stringify({
        protocol: "clawnexus-agent", version: "1.0",
        message_id: "m", from: "a", to: "b",
        type: "invalid_type",
        payload: {}, timestamp: "t",
      });
      expect(() => parseEnvelope(raw)).toThrow("Invalid type");
    });

    it("throws on missing payload", () => {
      const raw = JSON.stringify({
        protocol: "clawnexus-agent", version: "1.0",
        message_id: "m", from: "a", to: "b",
        type: "query", timestamp: "t",
      });
      expect(() => parseEnvelope(raw)).toThrow("Missing payload");
    });
  });

  describe("validatePayload", () => {
    it("validates query payload", () => {
      expect(() => validatePayload("query", {} as any)).toThrow("missing query_type");
      expect(() => validatePayload("query", { query_type: "invalid" } as any)).toThrow("invalid query_type");
      expect(() => validatePayload("query", { query_type: "capabilities" })).not.toThrow();
      expect(() => validatePayload("query", { query_type: "status" })).not.toThrow();
      expect(() => validatePayload("query", { query_type: "availability" })).not.toThrow();
    });

    it("validates propose payload", () => {
      expect(() => validatePayload("propose", {} as any)).toThrow("missing task");
      expect(() => validatePayload("propose", { task: {} } as any)).toThrow("missing task.task_type");
      expect(() => validatePayload("propose", { task: { task_type: "t" } } as any)).toThrow("missing task.description");
      expect(() => validatePayload("propose", { task: { task_type: "t", description: "d" } })).not.toThrow();
    });

    it("validates propose delegation_depth cap", () => {
      expect(() =>
        validatePayload("propose", {
          task: { task_type: "t", description: "d", delegation_depth: 6 },
        }),
      ).toThrow("delegation_depth exceeds hard cap");
    });

    it("validates accept payload", () => {
      expect(() => validatePayload("accept", {} as any)).toThrow("missing task_id");
      expect(() => validatePayload("accept", { task_id: "t" })).not.toThrow();
    });

    it("validates reject payload", () => {
      expect(() => validatePayload("reject", {} as any)).toThrow("missing task_id");
      expect(() => validatePayload("reject", { task_id: "t" } as any)).toThrow("missing reason");
      expect(() => validatePayload("reject", { task_id: "t", reason: "policy_denied" })).not.toThrow();
    });

    it("validates delegate payload", () => {
      expect(() => validatePayload("delegate", {} as any)).toThrow("missing task_id");
      expect(() => validatePayload("delegate", { task_id: "t" } as any)).toThrow("missing original_from");
      expect(() => validatePayload("delegate", { task_id: "t", original_from: "a" } as any)).toThrow("missing task");
      expect(() =>
        validatePayload("delegate", { task_id: "t", original_from: "a", task: { task_type: "x", description: "y" } }),
      ).not.toThrow();
    });

    it("validates report payload", () => {
      expect(() => validatePayload("report", {} as any)).toThrow("missing task_id");
      expect(() => validatePayload("report", { task_id: "t" } as any)).toThrow("missing status");
      expect(() => validatePayload("report", { task_id: "t", status: "bad" } as any)).toThrow("invalid status");
      expect(() => validatePayload("report", { task_id: "t", status: "completed" })).not.toThrow();
      expect(() => validatePayload("report", { task_id: "t", status: "failed" })).not.toThrow();
      expect(() => validatePayload("report", { task_id: "t", status: "progress" })).not.toThrow();
    });

    it("validates cancel payload", () => {
      expect(() => validatePayload("cancel", {} as any)).toThrow("missing task_id");
      expect(() => validatePayload("cancel", { task_id: "t" })).not.toThrow();
    });

    it("validates capability payload", () => {
      expect(() => validatePayload("capability", {} as any)).toThrow("missing capabilities array");
      expect(() => validatePayload("capability", { capabilities: [] })).not.toThrow();
    });

    it("validates heartbeat payload", () => {
      expect(() => validatePayload("heartbeat", {} as any)).toThrow("missing task_id");
      expect(() => validatePayload("heartbeat", { task_id: "t" })).not.toThrow();
    });
  });

  describe("isExpired", () => {
    it("returns false for fresh envelope", () => {
      const env = createEnvelope("a", "b", "heartbeat", { task_id: "t" });
      expect(isExpired(env)).toBe(false);
    });

    it("returns true for expired envelope", () => {
      const env = createEnvelope("a", "b", "heartbeat", { task_id: "t" }, { ttl: 1 });
      // Override timestamp to be old
      env.timestamp = new Date(Date.now() - 5_000).toISOString();
      expect(isExpired(env)).toBe(true);
    });

    it("uses default TTL of 300s when not set", () => {
      const env = createEnvelope("a", "b", "heartbeat", { task_id: "t" });
      delete (env as any).ttl;
      expect(isExpired(env)).toBe(false);

      env.timestamp = new Date(Date.now() - 400_000).toISOString();
      expect(isExpired(env)).toBe(true);
    });
  });
});
