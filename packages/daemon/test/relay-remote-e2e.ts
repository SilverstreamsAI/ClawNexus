/**
 * relay-remote-e2e.ts — Cross-network relay validation (TICKET-087)
 *
 * Tests relay functionality against the PRODUCTION relay server.
 * Registers two ephemeral test identities with the production registry,
 * obtains real JWT tokens, and runs a full E2E encrypted relay session.
 *
 * Prerequisites:
 *   - Production registry reachable (https://clawnexus-registry.silvonastream.com)
 *   - Production relay reachable (wss://clawnexus-relay.silvonastream.com)
 *
 * Usage:
 *   tsx test/relay-remote-e2e.ts
 *
 * Env vars:
 *   CLAWNEXUS_REGISTRY_URL  — registry URL override (default: production)
 *   CLAWNEXUS_RELAY_URL     — relay URL override (default: from registry token hint)
 */

import * as crypto from "node:crypto";
import { RelayConnector } from "../src/relay/connector.js";

const REGISTRY_URL =
  process.env.CLAWNEXUS_REGISTRY_URL ?? "https://clawnexus-registry.silvonastream.com";
const RELAY_URL_OVERRIDE = process.env.CLAWNEXUS_RELAY_URL;

// Unique suffix to avoid name collisions between runs
const RUN_ID = Date.now().toString(36);
const ALICE_BASE = `test-alice-${RUN_ID}`;
const BOB_BASE = `test-bob-${RUN_ID}`;

// --- Crypto helpers (inline, no dependency on daemon keys module) ---

interface EphemeralIdentity {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
}

function generateIdentity(): EphemeralIdentity {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  // SPKI DER for Ed25519: 12-byte prefix, raw 32-byte key at offset 12
  const publicKeyHex = spkiDer.subarray(12).toString("hex");
  return { privateKey, publicKeyHex };
}

function sign(privateKey: crypto.KeyObject, payload: unknown): string {
  const message = Buffer.from(JSON.stringify(payload), "utf-8");
  return crypto.sign(null, message, privateKey).toString("base64");
}

function pubkeyString(hex: string): string {
  return `ed25519:${hex}`;
}

// --- Registry helpers ---

interface RegisterResult {
  record: { name: string; relayHint: string | null };
}

interface TokenResult {
  token: string;
  expires_in: number;
  relay_hint: string;
}

async function registryRegister(
  id: EphemeralIdentity,
  clawId: string,
): Promise<RegisterResult> {
  const payload = { claw_id: clawId };
  const body = {
    payload,
    pubkey: pubkeyString(id.publicKeyHex),
    signature: sign(id.privateKey, payload),
  };

  const res = await fetch(`${REGISTRY_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(`Registry register failed (${res.status}): ${data.error ?? "unknown"}`);
  }

  return res.json() as Promise<RegisterResult>;
}

async function registryGetToken(
  id: EphemeralIdentity,
  clawId: string,
): Promise<TokenResult> {
  const payload = { claw_id: clawId };
  const body = {
    payload,
    pubkey: pubkeyString(id.publicKeyHex),
    signature: sign(id.privateKey, payload),
  };

  const res = await fetch(`${REGISTRY_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(`Registry token failed (${res.status}): ${data.error ?? "unknown"}`);
  }

  return res.json() as Promise<TokenResult>;
}

// --- Test harness ---

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEvent(
  emitter: RelayConnector,
  event: string,
  timeoutMs = 15_000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout (${timeoutMs}ms) waiting for event: ${event}`)),
      timeoutMs,
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// --- Main ---

async function runTests(): Promise<void> {
  console.log("=== ClawNexus Relay Cross-Network E2E Test (TICKET-087) ===\n");
  console.log(`Registry:   ${REGISTRY_URL}`);
  console.log(`Run ID:     ${RUN_ID}`);
  console.log(`Alice base: ${ALICE_BASE}`);
  console.log(`Bob base:   ${BOB_BASE}\n`);

  // ---- Step 0: Registry health ----
  console.log("Step 0: Registry health check");
  const healthRes = await fetch(`${REGISTRY_URL}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert(healthRes.ok, `Registry /health → ${healthRes.status}`);
  const healthData = (await healthRes.json()) as { status: string };
  assert(healthData.status === "ok", `Registry status = "${healthData.status}"`);

  // ---- Step 1: Register ephemeral identities ----
  console.log("\nStep 1: Register ephemeral identities with production registry");

  const aliceId = generateIdentity();
  const bobId = generateIdentity();

  const t0 = Date.now();
  const aliceReg = await registryRegister(aliceId, ALICE_BASE);
  const aliceClawName = aliceReg.record.name;
  console.log(`  [${ts()}] Alice registered → ${aliceClawName} (${Date.now() - t0}ms)`);
  assert(aliceClawName.startsWith(ALICE_BASE), `Alice claw name contains base: "${aliceClawName}"`);

  const t1 = Date.now();
  const bobReg = await registryRegister(bobId, BOB_BASE);
  const bobClawName = bobReg.record.name;
  console.log(`  [${ts()}] Bob registered   → ${bobClawName} (${Date.now() - t1}ms)`);
  assert(bobClawName.startsWith(BOB_BASE), `Bob claw name contains base: "${bobClawName}"`);

  // ---- Step 2: Get JWT tokens ----
  console.log("\nStep 2: Obtain JWT tokens from production registry");

  const t2 = Date.now();
  const aliceToken = await registryGetToken(aliceId, aliceClawName);
  console.log(
    `  [${ts()}] Alice token obtained (${Date.now() - t2}ms, expires_in=${aliceToken.expires_in}s, relay_hint=${aliceToken.relay_hint})`,
  );
  assert(!!aliceToken.token, "Alice JWT token received");
  assert(!!aliceToken.relay_hint, `relay_hint present: "${aliceToken.relay_hint}"`);

  const t3 = Date.now();
  const bobToken = await registryGetToken(bobId, bobClawName);
  console.log(
    `  [${ts()}] Bob token obtained   (${Date.now() - t3}ms, expires_in=${bobToken.expires_in}s)`,
  );
  assert(!!bobToken.token, "Bob JWT token received");

  // ---- Determine relay URL ----
  const relayUrl =
    RELAY_URL_OVERRIDE ?? `wss://${aliceToken.relay_hint}/relay`;
  console.log(`\nRelay URL:  ${relayUrl}`);

  // ---- Step 3: REGISTER with relay ----
  console.log("\nStep 3: REGISTER both connectors with production relay");

  const alice = new RelayConnector({
    relayUrl,
    clawId: aliceClawName,
    authToken: aliceToken.token,
    autoAccept: true,
  });

  const bob = new RelayConnector({
    relayUrl,
    clawId: bobClawName,
    authToken: bobToken.token,
    autoAccept: true,
  });

  const t4 = Date.now();
  const aliceRegistered = waitForEvent(alice, "registered");
  alice.connect();
  const [aliceRegId] = await aliceRegistered;
  console.log(`  [${ts()}] Alice registered with relay (${Date.now() - t4}ms)`);
  assert(aliceRegId === aliceClawName, `Alice registered as "${aliceRegId}"`);

  const t5 = Date.now();
  const bobRegistered = waitForEvent(bob, "registered");
  bob.connect();
  const [bobRegId] = await bobRegistered;
  console.log(`  [${ts()}] Bob registered with relay (${Date.now() - t5}ms)`);
  assert(bobRegId === bobClawName, `Bob registered as "${bobRegId}"`);

  // ---- Step 4: JOIN → INCOMING → ACCEPT → JOINED ----
  console.log("\nStep 4: JOIN → INCOMING → ACCEPT → JOINED");

  const bobIncoming = waitForEvent(bob, "incoming");
  const aliceJoined = waitForEvent(alice, "joined");
  const bobJoined = waitForEvent(bob, "joined");

  const t6 = Date.now();
  alice.join(bobClawName);

  const [incomingRoom] = (await bobIncoming) as [{ room_id: string; peer_claw_id: string }];
  assert(
    !!incomingRoom.room_id,
    `Bob received INCOMING with room_id="${incomingRoom.room_id}"`,
  );
  assert(
    incomingRoom.peer_claw_id === aliceClawName,
    `Bob sees peer is Alice: "${incomingRoom.peer_claw_id}"`,
  );

  const [aliceRoomId] = await aliceJoined;
  const [bobRoomId] = await bobJoined;
  assert(aliceRoomId === bobRoomId, `Both joined same room: "${aliceRoomId}"`);
  console.log(`  [${ts()}] Room established (${Date.now() - t6}ms)`);

  const roomId = aliceRoomId as string;

  // ---- Step 5: KEY_EXCHANGE ----
  console.log("\nStep 5: KEY_EXCHANGE → session key derived");

  const aliceKeyDone = waitForEvent(alice, "key_exchanged");
  const bobKeyDone = waitForEvent(bob, "key_exchanged");

  const t7 = Date.now();
  await Promise.all([aliceKeyDone, bobKeyDone]);
  const keyExchangeMs = Date.now() - t7;
  console.log(`  [${ts()}] Key exchange completed (${keyExchangeMs}ms)`);
  assert(true, `X25519 ECDH completed in ${keyExchangeMs}ms`);

  // ---- Step 6: Encrypted DATA transfer ----
  console.log("\nStep 6: Encrypted DATA — bidirectional");

  const msgAliceToBob = `Hello from Alice over real relay! run=${RUN_ID}`;
  const msgBobToAlice = `Hello from Bob over real relay! run=${RUN_ID}`;

  const bobReceives = waitForEvent(bob, "data");
  const sent1 = alice.sendData(roomId, msgAliceToBob);
  assert(sent1, "Alice sent encrypted message");

  const [recvRoom1, recvText1] = await bobReceives;
  assert(recvRoom1 === roomId, `Bob received in correct room`);
  assert(recvText1 === msgAliceToBob, `Bob decrypted: "${recvText1}"`);

  const aliceReceives = waitForEvent(alice, "data");
  const sent2 = bob.sendData(roomId, msgBobToAlice);
  assert(sent2, "Bob sent encrypted message");

  const [recvRoom2, recvText2] = await aliceReceives;
  assert(recvRoom2 === roomId, `Alice received in correct room`);
  assert(recvText2 === msgBobToAlice, `Alice decrypted: "${recvText2}"`);

  // ---- Step 7: PEER_LEFT ----
  console.log("\nStep 7: Disconnect → PEER_LEFT");

  const alicePeerLeft = waitForEvent(alice, "peer_left");
  bob.disconnect();

  const [leftRoomId] = await alicePeerLeft;
  assert(leftRoomId === roomId, `Alice received PEER_LEFT for room "${leftRoomId}"`);

  // ---- Step 8: Reconnect ----
  console.log("\nStep 8: Reconnect after disconnect");

  const bobReregistered = waitForEvent(bob, "registered");
  bob.connect();
  const [bobReregId] = await bobReregistered;
  assert(bobReregId === bobClawName, `Bob re-registered as "${bobReregId}"`);

  // ---- Step 9: Relay status check ----
  console.log("\nStep 9: /relay/status via daemon HTTP API");
  const daemonRes = await fetch("http://localhost:17890/relay/status", {
    signal: AbortSignal.timeout(3_000),
  }).catch(() => null);

  if (daemonRes) {
    const statusData = (await daemonRes.json()) as { state?: string; relay_url?: string };
    console.log(`  [${ts()}] Daemon relay status: state=${statusData.state}, url=${statusData.relay_url}`);
    assert(
      statusData.state === "registered" || statusData.state === "connecting",
      `Daemon relay state: "${statusData.state}"`,
    );
  } else {
    console.log("  [skip] Daemon not running locally — skipping HTTP API check");
  }

  // Cleanup
  alice.disconnect();
  bob.disconnect();

  // Small wait to let WebSocket close cleanly
  await wait(500);

  // ---- Summary ----
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("\nFailed assertions detected. Check relay/registry connectivity.");
  } else {
    console.log("\n✓ All assertions passed. Cross-network relay E2E validation complete.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err: unknown) => {
  console.error("\n✗ Test error:", err);
  process.exit(1);
});
