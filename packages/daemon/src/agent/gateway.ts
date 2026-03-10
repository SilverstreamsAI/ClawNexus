// Shared OpenClaw Gateway WebSocket connection helper
// Handles Protocol v3 handshake: device identity, Ed25519 signing, connect frame format.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const CLAWNEXUS_DIR = path.join(os.homedir(), ".clawnexus");
const IDENTITY_PATH = path.join(CLAWNEXUS_DIR, "oc-device-identity.json");
const AUTH_TOKEN_DIR = path.join(CLAWNEXUS_DIR, "device-auth-tokens");
const PROTOCOL_VERSION = 3;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// --- Device Identity ---

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

export function loadOrCreateDeviceIdentity(): DeviceIdentity {
  try {
    if (fs.existsSync(IDENTITY_PATH)) {
      const raw = fs.readFileSync(IDENTITY_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    // Generate fresh identity
  }
  const identity = generateIdentity();
  fs.mkdirSync(CLAWNEXUS_DIR, { recursive: true });
  const stored = { version: 1, ...identity, createdAtMs: Date.now() };
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  return identity;
}

// --- Device Auth Token Storage ---

function authTokenPath(deviceId: string, role: string): string {
  return path.join(AUTH_TOKEN_DIR, `${deviceId}-${role}.json`);
}

function loadDeviceAuthToken(deviceId: string, role: string): string | null {
  try {
    const p = authTokenPath(deviceId, role);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return data?.token ?? null;
    }
  } catch {
    // Ignore
  }
  return null;
}

function storeDeviceAuthToken(deviceId: string, role: string, token: string): void {
  try {
    fs.mkdirSync(AUTH_TOKEN_DIR, { recursive: true });
    const p = authTokenPath(deviceId, role);
    fs.writeFileSync(p, JSON.stringify({ token, role, storedAtMs: Date.now() }, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal
  }
}

// --- Protocol Helpers ---

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key) as unknown as Buffer);
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): string {
  const platform = (params.platform || "").toLowerCase();
  const deviceFamily = (params.deviceFamily || "").toLowerCase();
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

// --- Gateway Connection ---

export interface GatewayConnectionOptions {
  gatewayUrl?: string;
  connectTimeoutMs?: number;
  role?: string;
  scopes?: string[];
}

export interface GatewayConnection {
  ws: WebSocket;
  deviceId: string;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

/**
 * Connect to the OpenClaw Gateway using Protocol v3 handshake.
 * Handles device identity, Ed25519 signing, and device token storage.
 */
export function connectGateway(opts: GatewayConnectionOptions = {}): Promise<GatewayConnection> {
  const gatewayUrl = opts.gatewayUrl ?? "ws://127.0.0.1:18789";
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const role = opts.role ?? "operator";
  const scopes = opts.scopes ?? ["operator.read", "operator.write"];

  const identity = loadOrCreateDeviceIdentity();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl);
    const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    const connectTimeout = setTimeout(() => {
      ws.close();
      reject(new Error("Gateway connection timeout"));
    }, connectTimeoutMs);

    ws.on("error", (err: Error) => {
      clearTimeout(connectTimeout);
      reject(new Error(`Gateway connection error: ${err.message}`));
    });

    ws.on("close", () => {
      clearTimeout(connectTimeout);
      // Reject all pending requests
      for (const [, pending] of pendingRequests) {
        pending.reject(new Error("Gateway connection closed"));
      }
      pendingRequests.clear();
    });

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const type = msg.type as string | undefined;

      // Handshake: connect.challenge → connect → hello-ok
      if (type === "event" && msg.event === "connect.challenge") {
        const payload = msg.payload as Record<string, unknown> | undefined;
        const nonce = (payload?.nonce as string) ?? randomUUID();
        const signedAtMs = Date.now();
        const clientId = "gateway-client";
        const clientMode = "backend";

        // Load stored device auth token
        const storedToken = loadDeviceAuthToken(identity.deviceId, role);
        const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
        const authToken = envToken ?? storedToken ?? undefined;

        // Build device signature
        const authPayload = buildDeviceAuthPayloadV3({
          deviceId: identity.deviceId,
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs,
          token: authToken ?? null,
          nonce,
          platform: process.platform,
        });
        const signature = signDevicePayload(identity.privateKeyPem, authPayload);

        const connectId = randomUUID();
        const frame = {
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: clientId,
              version: "0.3.0",
              platform: process.platform,
              mode: clientMode,
            },
            role,
            scopes,
            auth: authToken ? { token: authToken, deviceToken: storedToken ?? undefined } : undefined,
            device: {
              id: identity.deviceId,
              publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
              signature,
              signedAt: signedAtMs,
              nonce,
            },
          },
        };

        // Track this as a pending request
        pendingRequests.set(connectId, {
          resolve: (payload) => {
            clearTimeout(connectTimeout);

            // Store device token if returned
            const helloOk = payload as Record<string, unknown> | undefined;
            const authInfo = helloOk?.auth as Record<string, unknown> | undefined;
            if (authInfo?.deviceToken && typeof authInfo.deviceToken === "string") {
              storeDeviceAuthToken(identity.deviceId, (authInfo.role as string) ?? role, authInfo.deviceToken);
            }

            const conn: GatewayConnection = {
              ws,
              deviceId: identity.deviceId,
              request(method: string, params?: unknown): Promise<unknown> {
                return new Promise((res, rej) => {
                  const id = randomUUID();
                  pendingRequests.set(id, { resolve: res, reject: rej });
                  ws.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
                });
              },
              close() {
                ws.close();
              },
            };
            resolve(conn);
          },
          reject: (err) => {
            clearTimeout(connectTimeout);
            reject(err);
          },
        });

        ws.send(JSON.stringify(frame));
        return;
      }

      // Response frame
      if (type === "res") {
        const id = msg.id as string;
        const pending = pendingRequests.get(id);
        if (pending) {
          pendingRequests.delete(id);
          if (msg.ok === true) {
            pending.resolve(msg.payload);
          } else {
            const error = msg.error as Record<string, unknown> | undefined;
            pending.reject(new Error(
              (error?.message as string) ?? `Gateway request failed: ${error?.code ?? "unknown"}`
            ));
          }
        }
      }
    });
  });
}
