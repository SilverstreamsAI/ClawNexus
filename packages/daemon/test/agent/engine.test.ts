import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PolicyEngine } from "../../src/agent/engine.js";
import { makeProposeEnvelope } from "../fixtures.js";
import type { LayerBEnvelope, DelegatePayload } from "../../src/agent/types.js";

describe("PolicyEngine", () => {
  let tmpDir: string;
  let engine: PolicyEngine;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    engine = new PolicyEngine(tmpDir);
    await engine.init();
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates config directory", () => {
      expect(fs.existsSync(tmpDir)).toBe(true);
    });

    it("creates default policy file", () => {
      expect(fs.existsSync(path.join(tmpDir, "policy.json"))).toBe(true);
    });

    it("loads existing policy file", async () => {
      await engine.patchConfig({ mode: "auto" });

      const engine2 = new PolicyEngine(tmpDir);
      await engine2.init();
      expect(engine2.getConfig().mode).toBe("auto");
    });

    it("handles corrupted policy file", async () => {
      await fs.promises.writeFile(path.join(tmpDir, "policy.json"), "bad json");
      const engine2 = new PolicyEngine(tmpDir);
      await engine2.init();
      expect(engine2.getConfig().mode).toBe("queue"); // default
    });
  });

  describe("evaluate — blacklist", () => {
    it("rejects blacklisted peers", async () => {
      await engine.patchConfig({ access_control: { whitelist: [], blacklist: ["evil.id.claw"] } });
      const env = makeProposeEnvelope("evil.id.claw", "me.id.claw");
      const decision = engine.evaluate(env);
      expect(decision.result).toBe("reject");
      expect(decision.reason).toBe("policy_denied");
    });
  });

  describe("evaluate — rate limiting", () => {
    it("rejects when per-peer limit is exceeded", async () => {
      await engine.patchConfig({ rate_limit: { max_per_minute: 100, max_per_peer_minute: 2 } });

      const env1 = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const env2 = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const env3 = makeProposeEnvelope("peer.id.claw", "me.id.claw");

      engine.evaluate(env1, 100);
      engine.evaluate(env2, 100);
      const d3 = engine.evaluate(env3, 100);
      expect(d3.result).toBe("reject");
      expect(d3.reason).toBe("rate_limited");
    });
  });

  describe("evaluate — whitelist", () => {
    it("whitelisted peers bypass trust check", async () => {
      await engine.patchConfig({
        mode: "auto",
        trust_threshold: 90,
        access_control: { whitelist: ["trusted.id.claw"], blacklist: [] },
      });

      const env = makeProposeEnvelope("trusted.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 0); // trust score 0, but whitelisted
      expect(decision.result).toBe("accept");
    });
  });

  describe("evaluate — trust score", () => {
    it("rejects low trust score", async () => {
      await engine.patchConfig({ trust_threshold: 50 });
      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 30);
      expect(decision.result).toBe("reject");
      expect(decision.reason).toBe("trust_insufficient");
    });

    it("accepts sufficient trust score", async () => {
      await engine.patchConfig({ mode: "auto", trust_threshold: 50 });
      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 60);
      expect(decision.result).toBe("accept");
    });
  });

  describe("evaluate — auto mode", () => {
    it("auto-approves all (non-blacklisted, rate-limited)", async () => {
      await engine.patchConfig({ mode: "auto" });
      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("accept");
      expect(decision.reason).toBe("auto_approved");
    });
  });

  describe("evaluate — queue mode", () => {
    it("queues proposals for review", async () => {
      await engine.patchConfig({ mode: "queue" });
      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("queue");
      expect(decision.reason).toBe("queued_for_review");
    });
  });

  describe("evaluate — hybrid mode", () => {
    it("auto-approves whitelisted peers", async () => {
      await engine.patchConfig({
        mode: "hybrid",
        access_control: { whitelist: ["vip.id.claw"], blacklist: [] },
      });
      const env = makeProposeEnvelope("vip.id.claw", "me.id.claw");
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("accept");
    });

    it("auto-approves matching task types", async () => {
      await engine.patchConfig({
        mode: "hybrid",
        auto_approve_types: ["translate"],
      });
      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "translate" });
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("accept");
    });

    it("queues non-matching proposals", async () => {
      await engine.patchConfig({
        mode: "hybrid",
        auto_approve_types: ["translate"],
      });
      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "execute" });
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("queue");
    });
  });

  describe("evaluate — delegation", () => {
    it("rejects delegation when not allowed", async () => {
      await engine.patchConfig({ delegation: { allow: false, max_depth: 3 } });

      const env: LayerBEnvelope = {
        protocol: "clawnexus-agent",
        version: "1.0",
        message_id: "m1",
        from: "peer.id.claw",
        to: "me.id.claw",
        type: "delegate",
        payload: {
          task_id: "t1",
          original_from: "origin.id.claw",
          task: { task_type: "test", description: "d" },
        } as DelegatePayload,
        timestamp: new Date().toISOString(),
        ttl: 300,
      };

      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("reject");
      expect(decision.details).toContain("Delegation not allowed");
    });
  });

  describe("evaluate — capability filter", () => {
    it("rejects task_type not in capability filter", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["translate", "summarize*"],
      });

      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "execute" });
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("reject");
      expect(decision.reason).toBe("capability_mismatch");
    });

    it("accepts task_type matching glob pattern", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: ["summarize*"],
      });

      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "summarize-text" });
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("accept");
    });

    it("accepts when capability filter is empty (allow all)", async () => {
      await engine.patchConfig({
        mode: "auto",
        capability_filter: [],
      });

      const env = makeProposeEnvelope("peer.id.claw", "me.id.claw", { task_type: "anything" });
      const decision = engine.evaluate(env, 100);
      expect(decision.result).toBe("accept");
    });
  });

  describe("config management", () => {
    it("updateConfig replaces entire config", async () => {
      const full = engine.getConfig();
      full.mode = "auto";
      full.trust_threshold = 99;
      await engine.updateConfig(full);
      expect(engine.getConfig().mode).toBe("auto");
      expect(engine.getConfig().trust_threshold).toBe(99);
    });

    it("patchConfig merges partial config", async () => {
      await engine.patchConfig({ mode: "auto" });
      expect(engine.getConfig().mode).toBe("auto");
      // Other fields should remain
      expect(engine.getConfig().trust_threshold).toBe(50);
    });

    it("resetConfig restores defaults", async () => {
      await engine.patchConfig({ mode: "auto", trust_threshold: 99 });
      await engine.resetConfig();
      expect(engine.getConfig().mode).toBe("queue");
      expect(engine.getConfig().trust_threshold).toBe(50);
    });

    it("persists config to disk", async () => {
      await engine.patchConfig({ mode: "auto" });
      const raw = await fs.promises.readFile(path.join(tmpDir, "policy.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.mode).toBe("auto");
    });
  });
});
