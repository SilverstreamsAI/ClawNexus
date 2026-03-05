import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { PolicyEngine } from "../../src/agent/engine.js";
import { TaskManager } from "../../src/agent/tasks.js";
import { registerAgentRoutes } from "../../src/api/server.js";
import { makeTaskRecord } from "../fixtures.js";

describe("Agent API routes", () => {
  let tmpDir: string;
  let engine: PolicyEngine;
  let tasks: TaskManager;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-test-"));
    engine = new PolicyEngine(tmpDir);
    await engine.init();
    tasks = new TaskManager(tmpDir);
    await tasks.init();

    app = Fastify();
    registerAgentRoutes(app, { engine, tasks, getRouter: () => null });
    await app.ready();
  });

  afterEach(async () => {
    await tasks.close();
    await app.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("GET /agent/policy", () => {
    it("returns current policy", async () => {
      const res = await app.inject({ method: "GET", url: "/agent/policy" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mode).toBe("queue");
      expect(body.trust_threshold).toBe(50);
    });
  });

  describe("PUT /agent/policy", () => {
    it("replaces entire policy", async () => {
      const policy = engine.getConfig();
      policy.mode = "auto";
      policy.trust_threshold = 99;

      const res = await app.inject({
        method: "PUT",
        url: "/agent/policy",
        payload: policy,
      });
      expect(res.statusCode).toBe(200);
      expect(engine.getConfig().mode).toBe("auto");
      expect(engine.getConfig().trust_threshold).toBe(99);
    });
  });

  describe("PATCH /agent/policy", () => {
    it("merges partial policy", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/agent/policy",
        payload: { mode: "hybrid" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.policy.mode).toBe("hybrid");
      // Other fields preserved
      expect(body.policy.trust_threshold).toBe(50);
    });
  });

  describe("POST /agent/policy/reset", () => {
    it("resets policy to defaults", async () => {
      await engine.patchConfig({ mode: "auto", trust_threshold: 99 });

      const res = await app.inject({ method: "POST", url: "/agent/policy/reset" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.policy.mode).toBe("queue");
      expect(body.policy.trust_threshold).toBe(50);
    });
  });

  describe("GET /agent/tasks", () => {
    it("returns active tasks by default", async () => {
      tasks.create(makeTaskRecord({ task_id: "t1", state: "pending" }));

      const res = await app.inject({ method: "GET", url: "/agent/tasks" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.tasks).toHaveLength(1);
    });

    it("returns all tasks with ?all=true", async () => {
      tasks.create(makeTaskRecord({ task_id: "t1", state: "pending" }));

      const res = await app.inject({ method: "GET", url: "/agent/tasks?all=true" });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBeGreaterThanOrEqual(1);
    });

    it("filters by direction", async () => {
      tasks.create(makeTaskRecord({ task_id: "t1", state: "pending", direction: "outbound" }));
      tasks.create(makeTaskRecord({ task_id: "t2", state: "pending", direction: "inbound" }));

      const res = await app.inject({ method: "GET", url: "/agent/tasks?direction=inbound" });
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.tasks[0].direction).toBe("inbound");
    });
  });

  describe("GET /agent/tasks/stats", () => {
    it("returns task statistics", async () => {
      tasks.create(makeTaskRecord({ task_id: "t1", state: "pending" }));

      const res = await app.inject({ method: "GET", url: "/agent/tasks/stats" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.active).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /agent/tasks/:id", () => {
    it("returns task by id", async () => {
      tasks.create(makeTaskRecord({ task_id: "t1" }));

      const res = await app.inject({ method: "GET", url: "/agent/tasks/t1" });
      expect(res.statusCode).toBe(200);
      expect(res.json().task_id).toBe("t1");
    });

    it("returns 404 for unknown task", async () => {
      const res = await app.inject({ method: "GET", url: "/agent/tasks/unknown" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /agent/tasks/:id/cancel", () => {
    it("cancels a task", async () => {
      tasks.create(makeTaskRecord({ task_id: "t1", state: "pending" }));

      const res = await app.inject({
        method: "POST",
        url: "/agent/tasks/t1/cancel",
        payload: { reason: "Testing" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().task.state).toBe("cancelled");
    });

    it("returns 404 for unknown or terminal task", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/agent/tasks/unknown/cancel",
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Agent router routes (503 when no router)", () => {
    it("POST /agent/propose returns 503", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/agent/propose",
        payload: { target_claw_id: "x", room_id: "r", task: { task_type: "t", description: "d" } },
      });
      expect(res.statusCode).toBe(503);
    });

    it("POST /agent/query returns 503", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/agent/query",
        payload: { target_claw_id: "x", room_id: "r", query_type: "capabilities" },
      });
      expect(res.statusCode).toBe(503);
    });

    it("GET /agent/inbox returns 503", async () => {
      const res = await app.inject({ method: "GET", url: "/agent/inbox" });
      expect(res.statusCode).toBe(503);
    });

    it("POST /agent/inbox/:id/approve returns 503", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/agent/inbox/m1/approve",
        payload: {},
      });
      expect(res.statusCode).toBe(503);
    });

    it("POST /agent/inbox/:id/deny returns 503", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/agent/inbox/m1/deny",
        payload: {},
      });
      expect(res.statusCode).toBe(503);
    });
  });
});
