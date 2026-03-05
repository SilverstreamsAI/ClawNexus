/**
 * E2E test: scanner → registry → API
 *
 * Spins up mock OpenClaw instances (HTTP servers returning control-ui-config.json),
 * then starts the daemon in-process and exercises the full flow:
 *   scan → list → info → alias → resolve by alias → delete
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { RegistryStore } from "../src/registry/store.js";
import { ActiveScanner } from "../src/scanner/active.js";
import { registerInstanceRoutes } from "../src/api/server.js";

// --- Mock OpenClaw servers ---

function createMockOpenClaw(agentId: string, name: string): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        basePath: "",
        assistantName: name,
        assistantAvatar: name[0],
        assistantAgentId: agentId,
      }),
    );
  });
}

function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server port"));
      }
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- Tests ---

describe("E2E: scan → registry → API", () => {
  let tmpDir: string;
  let store: RegistryStore;
  let scanner: ActiveScanner;
  let app: FastifyInstance;

  let mockServer1: http.Server;
  let mockServer2: http.Server;
  let port1: number;
  let port2: number;

  beforeAll(async () => {
    // 1. Start mock OpenClaw instances
    mockServer1 = createMockOpenClaw("main", "MainAssistant");
    mockServer2 = createMockOpenClaw("second", "SecondAssistant");
    port1 = await listenOnRandomPort(mockServer1);
    port2 = await listenOnRandomPort(mockServer2);

    // 2. Create registry + scanner + API
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-e2e-"));
    store = new RegistryStore(tmpDir);
    await store.init();
    scanner = new ActiveScanner(store);

    app = Fastify();
    registerInstanceRoutes(app, store, scanner);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await store.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await closeServer(mockServer1);
    await closeServer(mockServer2);
  });

  it("Step 1: POST /scan with explicit targets discovers both instances", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/scan",
      payload: {
        targets: [`127.0.0.1:${port1}`, `127.0.0.1:${port2}`],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.discovered).toBe(2);

    const ids = body.instances.map((i: { agent_id: string }) => i.agent_id).sort();
    expect(ids).toEqual(["main", "second"]);
  });

  it("Step 2: GET /instances returns 2 instances", async () => {
    const res = await app.inject({ method: "GET", url: "/instances" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
  });

  it("Step 3: GET /instances/main returns the correct instance", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/main" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent_id).toBe("main");
    expect(body.assistant_name).toBe("MainAssistant");
    expect(body.gateway_port).toBe(port1);
    expect(body.status).toBe("online");
    expect(body.discovery_source).toBe("scan");
  });

  it("Step 4: GET /instances/second returns the correct instance", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/second" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent_id).toBe("second");
    expect(body.assistant_name).toBe("SecondAssistant");
    expect(body.gateway_port).toBe(port2);
  });

  it("Step 5: PUT /instances/main/alias sets alias 'home'", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/main/alias",
      payload: { alias: "home" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alias).toBe("home");
  });

  it("Step 6: GET /instances/home resolves by alias", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/home" });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent_id).toBe("main");
    expect(res.json().alias).toBe("home");
  });

  it("Step 7: PUT duplicate alias returns 409", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/second/alias",
      payload: { alias: "home" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("Step 8: DELETE /instances/second removes instance", async () => {
    const res = await app.inject({ method: "DELETE", url: "/instances/second" });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe("secondassistant");
  });

  it("Step 9: GET /instances now returns 1 instance", async () => {
    const res = await app.inject({ method: "GET", url: "/instances" });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);
    expect(res.json().instances[0].agent_id).toBe("main");
  });

  it("Step 10: GET /instances/second returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/second" });
    expect(res.statusCode).toBe(404);
  });

  it("Step 11: Re-scan discovers second instance again", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/scan",
      payload: {
        targets: [`127.0.0.1:${port2}`],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().discovered).toBe(1);
    expect(res.json().instances[0].agent_id).toBe("second");

    // Verify total is now 2 again
    const listRes = await app.inject({ method: "GET", url: "/instances" });
    expect(listRes.json().count).toBe(2);
  });
});
