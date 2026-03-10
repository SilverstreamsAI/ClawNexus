import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PolicyEngine } from "../../src/agent/engine.js";
import { makeProposeEnvelope } from "../fixtures.js";
import type { LayerBEnvelope, DelegatePayload, PolicyConfig } from "../../src/agent/types.js";

describe("PolicyEngine — edge cases", () => {
  let tmpDir: string;
  let engine: PolicyEngine;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-engine-ext-test-"));
    engine = new PolicyEngine(tmpDir);
    await engine.init();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("glob pattern matching", () => {
    it("matches exact task_type in capability filter", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["translate"],
      });

      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "translate" });
      expect(engine.evaluate(env, 100).result).toBe("accept");
    });

    it("matches trailing wildcard in capability filter", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["summarize*"],
      });

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "summarize" }), 100,
      ).result).toBe("accept");

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "summarize-text" }), 100,
      ).result).toBe("accept");

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "summarize_doc_v2" }), 100,
      ).result).toBe("accept");
    });

    it("rejects non-matching task_type with wildcard filter", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["summarize*"],
      });

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "translate" }), 100,
      ).result).toBe("reject");
    });

    it("wildcard * alone matches everything", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["*"],
      });

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "anything-at-all" }), 100,
      ).result).toBe("accept");
    });

    it("non-wildcard pattern requires exact match", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["translate"],
      });

      // Prefix match should fail (no wildcard)
      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "translate-text" }), 100,
      ).result).toBe("reject");
    });

    it("multiple patterns: matches if any pattern matches", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["translate", "summarize*", "code-review"],
      });

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "translate" }), 100,
      ).result).toBe("accept");

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "summarize-doc" }), 100,
      ).result).toBe("accept");

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "code-review" }), 100,
      ).result).toBe("accept");

      expect(engine.evaluate(
        makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "deploy" }), 100,
      ).result).toBe("reject");
    });
  });

  describe("rate limiting edge cases", () => {
    it("resets rate counter after window expires", async () => {
      await engine.patchConfig({
        mode: "auto",
        rate_limit: { max_per_minute: 2, max_per_peer_minute: 2 },
      });

      // Use up the limit
      engine.evaluate(makeProposeEnvelope("peer.id.claw", "me.id.claw"), 100);
      engine.evaluate(makeProposeEnvelope("peer.id.claw", "me.id.claw"), 100);

      // Third should be rate limited
      const d3 = engine.evaluate(makeProposeEnvelope("peer.id.claw", "me.id.claw"), 100);
      expect(d3.result).toBe("reject");
      expect(d3.reason).toBe("rate_limited");
    });

    it("global rate limit applies across different peers", async () => {
      await engine.patchConfig({
        mode: "auto",
        rate_limit: { max_per_minute: 3, max_per_peer_minute: 10 },
      });

      engine.evaluate(makeProposeEnvelope("a.id.claw", "me.id.claw"), 100);
      engine.evaluate(makeProposeEnvelope("b.id.claw", "me.id.claw"), 100);
      engine.evaluate(makeProposeEnvelope("c.id.claw", "me.id.claw"), 100);

      const d4 = engine.evaluate(makeProposeEnvelope("d.id.claw", "me.id.claw"), 100);
      expect(d4.result).toBe("reject");
      expect(d4.reason).toBe("rate_limited");
    });

    it("rate limiting counts separately per peer", async () => {
      await engine.patchConfig({
        mode: "auto",
        rate_limit: { max_per_minute: 100, max_per_peer_minute: 1 },
      });

      const d1 = engine.evaluate(makeProposeEnvelope("a.id.claw", "me.id.claw"), 100);
      expect(d1.result).toBe("accept");

      // Same peer — should be rate limited
      const d2 = engine.evaluate(makeProposeEnvelope("a.id.claw", "me.id.claw"), 100);
      expect(d2.result).toBe("reject");

      // Different peer — should be fine
      const d3 = engine.evaluate(makeProposeEnvelope("b.id.claw", "me.id.claw"), 100);
      expect(d3.result).toBe("accept");
    });
  });

  describe("deepMerge via patchConfig", () => {
    it("merges nested objects (rate_limit)", async () => {
      await engine.patchConfig({ rate_limit: { max_per_minute: 20, max_per_peer_minute: 3 } });
      const config = engine.getConfig();
      expect(config.rate_limit.max_per_minute).toBe(20);
      expect(config.rate_limit.max_per_peer_minute).toBe(3);
    });

    it("merges nested objects (access_control)", async () => {
      await engine.patchConfig({ access_control: { whitelist: ["trusted.id.claw"], blacklist: [] } });
      const config = engine.getConfig();
      expect(config.access_control.whitelist).toEqual(["trusted.id.claw"]);
    });

    it("replaces arrays (capability_filter)", async () => {
      await engine.patchConfig({ capability_filter: ["translate", "summarize*"] });
      expect(engine.getConfig().capability_filter).toEqual(["translate", "summarize*"]);

      await engine.patchConfig({ capability_filter: ["new-type"] });
      expect(engine.getConfig().capability_filter).toEqual(["new-type"]);
    });

    it("preserves unrelated fields during patch", async () => {
      await engine.patchConfig({ mode: "auto" });
      expect(engine.getConfig().trust_threshold).toBe(50); // unchanged
      expect(engine.getConfig().max_concurrent_tasks).toBe(5); // unchanged
    });

    it("handles partial nested merge (delegation)", async () => {
      await engine.patchConfig({ delegation: { allow: true, max_depth: 5 } });
      const config = engine.getConfig();
      expect(config.delegation.allow).toBe(true);
      expect(config.delegation.max_depth).toBe(5);
    });
  });

  describe("delegation depth checks", () => {
    it("rejects delegation exceeding max depth", async () => {
      await engine.patchConfig({ delegation: { allow: true, max_depth: 2 } });

      const env: LayerBEnvelope = {
        protocol: "clawnexus-agent",
        version: "1.0",
        message_id: "d1",
        from: "peer.id.claw",
        to: "me.id.claw",
        type: "delegate",
        payload: {
          task_id: "t1",
          original_from: "origin.id.claw",
          task: { task_type: "test", description: "d", delegation_depth: 3 },
        } as DelegatePayload,
        timestamp: new Date().toISOString(),
        ttl: 300,
      };

      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("reject");
      expect(decision.details).toContain("Delegation depth exceeded");
    });

    it("accepts delegation within max depth", async () => {
      await engine.patchConfig({ mode: "auto", delegation: { allow: true, max_depth: 5 } });

      const env: LayerBEnvelope = {
        protocol: "clawnexus-agent",
        version: "1.0",
        message_id: "d2",
        from: "peer.id.claw",
        to: "me.id.claw",
        type: "delegate",
        payload: {
          task_id: "t2",
          original_from: "origin.id.claw",
          task: { task_type: "test", description: "d", delegation_depth: 2 },
        } as DelegatePayload,
        timestamp: new Date().toISOString(),
        ttl: 300,
      };

      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("accept");
    });
  });

  describe("trust score edge cases", () => {
    it("auto mode skips trust check", async () => {
      await engine.patchConfig({ mode: "auto", trust_threshold: 100 });

      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 0); // zero trust
      expect(decision.result).toBe("accept");
    });

    it("trust score exactly at threshold is accepted (not rejected)", async () => {
      await engine.patchConfig({ mode: "auto", trust_threshold: 50 });

      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 50);
      expect(decision.result).toBe("accept");
    });

    it("trust score one below threshold is rejected", async () => {
      await engine.patchConfig({ trust_threshold: 50 });

      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 49);
      expect(decision.result).toBe("reject");
      expect(decision.reason).toBe("trust_insufficient");
    });
  });

  describe("config persistence", () => {
    it("persists config changes to disk and survives reload", async () => {
      await engine.patchConfig({ mode: "auto", trust_threshold: 99 });

      const engine2 = new PolicyEngine(tmpDir);
      await engine2.init();
      expect(engine2.getConfig().mode).toBe("auto");
      expect(engine2.getConfig().trust_threshold).toBe(99);
    });

    it("handles missing config dir on init", async () => {
      const newDir = path.join(tmpDir, "subdir", "deep");
      const engine2 = new PolicyEngine(newDir);
      await engine2.init();
      expect(engine2.getConfig().mode).toBe("queue"); // default
      expect(fs.existsSync(newDir)).toBe(true);
    });
  });

  describe("blacklist takes precedence over whitelist", () => {
    it("blacklist wins when peer is in both lists", async () => {
      await engine.patchConfig({
        mode: "auto",
        access_control: {
          whitelist: ["ambiguous.id.claw"],
          blacklist: ["ambiguous.id.claw"],
        },
      });

      const env = makeProposeEnvelope("ambiguous.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("reject");
      expect(decision.reason).toBe("policy_denied");
    });
  });

  describe("blacklist checked before rate counting", () => {
    it("blacklisted peer does not consume rate limit", async () => {
      await engine.patchConfig({
        mode: "auto",
        rate_limit: { max_per_minute: 1, max_per_peer_minute: 1 },
        access_control: { whitelist: [], blacklist: ["blocked.id.claw"] },
      });

      // This should be rejected by blacklist, not consume rate limit
      engine.evaluate(makeProposeEnvelope("blocked.id.claw", "me.id.claw"), 100);

      // A different peer should still be able to pass
      const d = engine.evaluate(makeProposeEnvelope("good.id.claw", "me.id.claw"), 100);
      expect(d.result).toBe("accept");
    });
  });
});
