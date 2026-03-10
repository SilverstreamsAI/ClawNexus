import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { loadOrCreateDeviceIdentity, connectGateway } from "../../src/agent/gateway.js";

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/**
 * Mock Gateway v3 server that handles handshake and optional request methods.
 */
function createMockGateway(port: number, opts: {
  rejectConnect?: boolean;
  rejectError?: { code: string; message: string };
  returnDeviceToken?: string;
  onConnect?: (params: Record<string, unknown>) => void;
  onRequest?: (method: string, params: unknown, respond: (ok: boolean, payload: unknown) => void) => void;
  closeAfterChallenge?: boolean;
  noChallenge?: boolean;
} = {}): { wss: WebSocketServer; connections: WebSocket[]; close: () => Promise<void> } {
  const connections: WebSocket[] = [];
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    connections.push(ws);

    if (opts.noChallenge) return;

    if (opts.closeAfterChallenge) {
      ws.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: randomUUID(), ts: Date.now() },
      }));
      setTimeout(() => ws.close(), 50);
      return;
    }

    const nonce = randomUUID();
    ws.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce, ts: Date.now() },
    }));

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "req" && msg.method === "connect") {
        opts.onConnect?.(msg.params);

        if (opts.rejectConnect) {
          const error = opts.rejectError ?? { code: "UNAUTHORIZED", message: "Rejected" };
          ws.send(JSON.stringify({
            type: "res",
            id: msg.id,
            ok: false,
            error,
          }));
          return;
        }

        const helloPayload: Record<string, unknown> = {
          type: "hello-ok",
          protocol: 3,
          server: { version: "mock", connId: randomUUID() },
          features: { methods: ["tools.catalog", "chat.send"], events: ["chat"] },
          snapshot: {},
          policy: {},
        };

        if (opts.returnDeviceToken) {
          helloPayload.auth = { deviceToken: opts.returnDeviceToken, role: "operator" };
        }

        ws.send(JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          payload: helloPayload,
        }));
      }

      // Handle other requests after handshake
      if (msg.type === "req" && msg.method !== "connect" && opts.onRequest) {
        opts.onRequest(msg.method, msg.params, (ok, payload) => {
          ws.send(JSON.stringify({
            type: "res",
            id: msg.id,
            ok,
            payload: ok ? payload : undefined,
            error: ok ? undefined : payload,
          }));
        });
      }
    });
  });

  return {
    wss,
    connections,
    close: () => new Promise<void>((resolve) => {
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
      wss.close(() => resolve());
    }),
  };
}

// gateway.ts uses os.homedir() at module level to compute paths.
// We cannot override those constants, so identity tests use the real ~/.clawnexus dir.
// The identity file is created once and reused — we just verify its properties.

describe("Device Identity", () => {
  it("returns a valid Ed25519 identity", () => {
    const identity = loadOrCreateDeviceIdentity();

    expect(identity.deviceId).toBeTruthy();
    expect(identity.deviceId).toHaveLength(64); // SHA256 hex
    expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("returns the same identity on repeated calls (loads from disk)", () => {
    const first = loadOrCreateDeviceIdentity();
    const second = loadOrCreateDeviceIdentity();

    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
  });

  it("produces deviceId = SHA256 of raw public key", () => {
    const identity = loadOrCreateDeviceIdentity();
    const pubKey = crypto.createPublicKey(identity.publicKeyPem);
    const spki = pubKey.export({ type: "spki", format: "der" });
    const raw32 = spki.subarray(spki.length - 32);
    const expected = crypto.createHash("sha256").update(raw32).digest("hex");
    expect(identity.deviceId).toBe(expected);
  });

  it("can sign and verify with the generated identity", () => {
    const identity = loadOrCreateDeviceIdentity();
    const message = Buffer.from("test-payload-for-verification");
    const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
    const publicKey = crypto.createPublicKey(identity.publicKeyPem);

    const signature = crypto.sign(null, message, privateKey);
    const valid = crypto.verify(null, message, publicKey, signature);
    expect(valid).toBe(true);
  });

  it("identity file exists on disk after creation", () => {
    loadOrCreateDeviceIdentity();
    const identityPath = path.join(os.homedir(), ".clawnexus", "oc-device-identity.json");
    expect(fs.existsSync(identityPath)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.deviceId).toBeTruthy();
    expect(stored.publicKeyPem).toBeTruthy();
    expect(stored.privateKeyPem).toBeTruthy();
  });
});

describe("connectGateway", () => {
  let gateway: ReturnType<typeof createMockGateway> | null = null;

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("completes v3 handshake and returns GatewayConnection", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port);

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });
    expect(conn.ws).toBeDefined();
    expect(conn.deviceId).toBeTruthy();
    expect(conn.deviceId).toHaveLength(64);
    expect(typeof conn.request).toBe("function");
    expect(typeof conn.close).toBe("function");

    conn.close();
  });

  it("sends correct connect frame with device signature", async () => {
    const port = getRandomPort();
    let connectParams: Record<string, unknown> | null = null;

    gateway = createMockGateway(port, {
      onConnect: (params) => { connectParams = params as Record<string, unknown>; },
    });

    const conn = await connectGateway({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });

    expect(connectParams).toBeTruthy();
    expect(connectParams!.role).toBe("operator");
    expect(connectParams!.scopes).toEqual(["operator.read", "operator.write"]);
    expect(connectParams!.minProtocol).toBe(3);
    expect(connectParams!.maxProtocol).toBe(3);

    const device = connectParams!.device as Record<string, unknown>;
    expect(device.id).toBeTruthy();
    expect(device.publicKey).toBeTruthy();
    expect(device.signature).toBeTruthy();
    expect(device.signedAt).toBeTruthy();
    expect(device.nonce).toBeTruthy();

    const client = connectParams!.client as Record<string, unknown>;
    expect(client.id).toBe("gateway-client");
    expect(client.mode).toBe("backend");
    expect(client.platform).toBe(process.platform);

    conn.close();
  });

  it("rejects when gateway sends error response", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      rejectConnect: true,
      rejectError: { code: "FORBIDDEN", message: "Not allowed" },
    });

    await expect(
      connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` }),
    ).rejects.toThrow("Not allowed");
  });

  it("rejects on connection timeout", async () => {
    const port = getRandomPort();
    // Gateway that never sends challenge
    gateway = createMockGateway(port, { noChallenge: true });

    await expect(
      connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}`, connectTimeoutMs: 500 }),
    ).rejects.toThrow("Gateway connection timeout");
  });

  it("rejects when gateway is unreachable", async () => {
    const port = getRandomPort();

    await expect(
      connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` }),
    ).rejects.toThrow("Gateway connection error");
  });

  it("rejects when gateway closes during handshake", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, { closeAfterChallenge: true });

    await expect(
      connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` }),
    ).rejects.toThrow();
  });

  it("request() sends frame and receives response", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      onRequest: (method, _params, respond) => {
        if (method === "tools.catalog") {
          respond(true, {
            groups: [{ id: "default", tools: [{ id: "web_search" }] }],
          });
        }
      },
    });

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });
    const result = await conn.request("tools.catalog", {}) as Record<string, unknown>;

    expect(result.groups).toBeDefined();
    const groups = result.groups as Array<Record<string, unknown>>;
    expect(groups[0].tools).toHaveLength(1);

    conn.close();
  });

  it("request() rejects on error response", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      onRequest: (method, _params, respond) => {
        if (method === "bad.method") {
          respond(false, { code: "NOT_FOUND", message: "Method not found" });
        }
      },
    });

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });
    await expect(conn.request("bad.method", {})).rejects.toThrow("Method not found");
    conn.close();
  });

  it("pending requests rejected when connection closes", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      onRequest: () => {
        // Never respond
      },
    });

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });
    const requestPromise = conn.request("slow.method", {});

    // Close from server side
    for (const ws of gateway.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }

    await expect(requestPromise).rejects.toThrow("Gateway connection closed");
  });

  it("stores device token from hello-ok response", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      returnDeviceToken: "test-device-token-abc",
    });

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });

    // Check that the token was stored on disk
    const tokenDir = path.join(os.homedir(), ".clawnexus", "device-auth-tokens");
    expect(fs.existsSync(tokenDir)).toBe(true);

    const files = fs.readdirSync(tokenDir);
    const tokenFile = files.find((f) => f.endsWith("-operator.json"));
    expect(tokenFile).toBeTruthy();

    const tokenData = JSON.parse(fs.readFileSync(path.join(tokenDir, tokenFile!), "utf8"));
    expect(tokenData.token).toBe("test-device-token-abc");

    conn.close();
  });

  it("uses stored token in subsequent connection", async () => {
    const port = getRandomPort();
    let connectCount = 0;
    let secondConnectParams: Record<string, unknown> | null = null;

    gateway = createMockGateway(port, {
      returnDeviceToken: "stored-token-123",
      onConnect: (params) => {
        connectCount++;
        if (connectCount === 2) {
          secondConnectParams = params as Record<string, unknown>;
        }
      },
    });

    // First connection — stores token
    const conn1 = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });
    conn1.close();

    // Second connection — should use stored token
    const conn2 = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });

    expect(secondConnectParams).toBeTruthy();
    const auth = secondConnectParams!.auth as Record<string, unknown> | undefined;
    expect(auth).toBeTruthy();
    expect(auth!.deviceToken).toBe("stored-token-123");

    conn2.close();
  });

  it("uses OPENCLAW_GATEWAY_TOKEN env var when set", async () => {
    const port = getRandomPort();
    let connectParams: Record<string, unknown> | null = null;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-xyz";

    gateway = createMockGateway(port, {
      onConnect: (params) => { connectParams = params as Record<string, unknown>; },
    });

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });

    const auth = connectParams!.auth as Record<string, unknown>;
    expect(auth).toBeTruthy();
    expect(auth.token).toBe("env-token-xyz");

    conn.close();
  });

  it("uses default values when options not specified", async () => {
    const port = getRandomPort();
    let connectParams: Record<string, unknown> | null = null;

    gateway = createMockGateway(port, {
      onConnect: (params) => { connectParams = params as Record<string, unknown>; },
    });

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });

    expect(connectParams!.role).toBe("operator");
    expect(connectParams!.scopes).toEqual(["operator.read", "operator.write"]);

    conn.close();
  });

  it("signature in connect frame is base64url encoded (no +/= chars)", async () => {
    const port = getRandomPort();
    let connectParams: Record<string, unknown> | null = null;

    gateway = createMockGateway(port, {
      onConnect: (params) => { connectParams = params as Record<string, unknown>; },
    });

    const conn = await connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` });

    const device = connectParams!.device as Record<string, unknown>;
    const sig = device.signature as string;
    const pubKey = device.publicKey as string;

    // base64url should not contain +, /, or =
    expect(sig).not.toMatch(/[+/=]/);
    expect(pubKey).not.toMatch(/[+/=]/);

    conn.close();
  });

  it("rejects with generic message when error has no message", async () => {
    const port = getRandomPort();
    gateway = createMockGateway(port, {
      rejectConnect: true,
      rejectError: { code: "UNKNOWN" } as any,
    });

    await expect(
      connectGateway({ gatewayUrl: `ws://127.0.0.1:${port}` }),
    ).rejects.toThrow(/Gateway request failed|UNKNOWN/);
  });
});
