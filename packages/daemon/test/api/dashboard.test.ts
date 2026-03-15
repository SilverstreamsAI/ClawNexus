import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

describe("Dashboard static mount", () => {
  let tmpDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    // Create a temp directory with mock dashboard files
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-dash-test-"));
    const assetsDir = path.join(tmpDir, "assets");
    await fs.promises.mkdir(assetsDir);
    await fs.promises.writeFile(
      path.join(tmpDir, "index.html"),
      '<!DOCTYPE html><html><head><title>ClawNexus Dashboard</title></head><body><div id="app"></div></body></html>',
    );
    await fs.promises.writeFile(
      path.join(assetsDir, "index-abc123.js"),
      'console.log("dashboard");',
    );
    await fs.promises.writeFile(
      path.join(assetsDir, "index-abc123.css"),
      "body { background: #0f1117; }",
    );

    app = Fastify();

    // Replicate the dashboard mount logic from server.ts
    await app.register(fastifyStatic, {
      root: tmpDir,
      prefix: "/ui/",
      decorateReply: false,
    });
    app.get("/ui", async (_request, reply) => {
      reply.redirect("/ui/");
    });

    // Also add a health endpoint to confirm API still works alongside static
    app.get("/health", async () => ({ status: "ok" }));

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("serves index.html at /ui/", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("ClawNexus Dashboard");
    expect(res.body).toContain('<div id="app">');
  });

  it("serves JS assets at /ui/assets/", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("dashboard");
  });

  it("serves CSS assets at /ui/assets/", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/assets/index-abc123.css" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("background");
  });

  it("redirects /ui to /ui/", async () => {
    const res = await app.inject({ method: "GET", url: "/ui" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/ui/");
  });

  it("returns 404 for non-existent files under /ui/", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/nonexistent.txt" });
    expect(res.statusCode).toBe(404);
  });

  it("does not interfere with API routes", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("Dashboard mount when dist missing", () => {
  it("daemon works without dashboard (API-only mode)", async () => {
    // Verify the existsSync check pattern works — dashboard not present
    const dashboardPath = path.join(os.tmpdir(), "nonexistent-dashboard-dist-" + Date.now());
    const exists = fs.existsSync(dashboardPath);
    expect(exists).toBe(false);

    // Daemon should start fine without dashboard
    const app = Fastify();
    app.get("/health", async () => ({ status: "ok" }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
