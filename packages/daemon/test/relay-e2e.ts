/**
 * relay-e2e.ts — End-to-end test for Layer 2 relay
 *
 * Prerequisites:
 *   - ClawNexus-Cloud relay running on ws://localhost:18800/relay
 *   - JWT_SECRET matches relay config (default: "clawnexus-dev-secret")
 *
 * Usage:
 *   tsx test/relay-e2e.ts
 */

import * as crypto from "node:crypto";
import { RelayConnector } from "../src/relay/connector.js";

// --- Config ---
const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:18800/relay";
const JWT_SECRET = process.env.JWT_SECRET ?? "clawnexus-dev-secret";
const JWT_ISSUER = "registry.silverstream.tech";

const ALICE_ID = "alice-test-instance";
const BOB_ID = "bob-test-instance";

// --- Helpers ---

/** Create a HS256 JWT compatible with relay auth */
function createTestJWT(clawId: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: clawId,
    iss: JWT_ISSUER,
    iat: now,
    exp: now + 300,
  };

  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const data = `${headerB64}.${payloadB64}`;
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(data)
    .digest("base64url");

  return `${data}.${signature}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEvent(
  emitter: RelayConnector,
  event: string,
  timeoutMs = 10_000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for event: ${event}`)),
      timeoutMs,
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

// --- Test runner ---

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

async function runTests(): Promise<void> {
  console.log("=== ClawNexus Relay E2E Test ===\n");
  console.log(`Relay URL: ${RELAY_URL}`);
  console.log(`Alice: ${ALICE_ID}`);
  console.log(`Bob:   ${BOB_ID}\n`);

  // Create JWT tokens for both instances
  const aliceToken = createTestJWT(ALICE_ID);
  const bobToken = createTestJWT(BOB_ID);

  // Create connectors
  const alice = new RelayConnector({
    relayUrl: RELAY_URL,
    clawId: ALICE_ID,
    authToken: aliceToken,
    autoAccept: true,
  });

  const bob = new RelayConnector({
    relayUrl: RELAY_URL,
    clawId: BOB_ID,
    authToken: bobToken,
    autoAccept: true,
  });

  try {
    // ---- Step 1: REGISTER ----
    console.log("Step 1: REGISTER → REGISTERED");

    const aliceRegistered = waitForEvent(alice, "registered");
    alice.connect();
    const [aliceRegId] = await aliceRegistered;
    assert(aliceRegId === ALICE_ID, `Alice registered as "${aliceRegId}"`);

    const bobRegistered = waitForEvent(bob, "registered");
    bob.connect();
    const [bobRegId] = await bobRegistered;
    assert(bobRegId === BOB_ID, `Bob registered as "${bobRegId}"`);

    // ---- Step 2: JOIN → INCOMING → ACCEPT → JOINED ----
    console.log("\nStep 2: JOIN → INCOMING → ACCEPT → JOINED");

    const bobIncoming = waitForEvent(bob, "incoming");
    const aliceJoined = waitForEvent(alice, "joined");
    const bobJoined = waitForEvent(bob, "joined");

    alice.join(BOB_ID);

    const [incomingRoom] = (await bobIncoming) as [{ room_id: string; peer_claw_id: string }];
    assert(!!incomingRoom.room_id, `Bob received INCOMING with room_id="${incomingRoom.room_id}"`);
    assert(
      incomingRoom.peer_claw_id === ALICE_ID,
      `Bob sees peer is Alice: "${incomingRoom.peer_claw_id}"`,
    );

    const [aliceRoomId] = await aliceJoined;
    const [bobRoomId] = await bobJoined;
    assert(aliceRoomId === bobRoomId, `Both joined same room: "${aliceRoomId}"`);

    const roomId = aliceRoomId as string;

    // ---- Step 3: KEY_EXCHANGE ----
    console.log("\nStep 3: KEY_EXCHANGE → session key derived");

    const aliceKeyDone = waitForEvent(alice, "key_exchanged");
    const bobKeyDone = waitForEvent(bob, "key_exchanged");

    await Promise.all([aliceKeyDone, bobKeyDone]);
    assert(true, "Both sides completed key exchange");

    // ---- Step 4: Encrypted DATA transfer ----
    console.log("\nStep 4: Encrypted DATA — bidirectional");

    const testMessageAliceToBob = "Hello from Alice! 🦝";
    const testMessageBobToAlice = "Hello from Bob! 🐻";

    const bobReceives = waitForEvent(bob, "data");
    const sent1 = alice.sendData(roomId, testMessageAliceToBob);
    assert(sent1, "Alice sent encrypted message");

    const [recvRoom1, recvText1] = await bobReceives;
    assert(recvRoom1 === roomId, `Bob received in correct room`);
    assert(recvText1 === testMessageAliceToBob, `Bob decrypted: "${recvText1}"`);

    const aliceReceives = waitForEvent(alice, "data");
    const sent2 = bob.sendData(roomId, testMessageBobToAlice);
    assert(sent2, "Bob sent encrypted message");

    const [recvRoom2, recvText2] = await aliceReceives;
    assert(recvRoom2 === roomId, `Alice received in correct room`);
    assert(recvText2 === testMessageBobToAlice, `Alice decrypted: "${recvText2}"`);

    // ---- Step 5: PEER_LEFT ----
    console.log("\nStep 5: Disconnect → PEER_LEFT");

    const alicePeerLeft = waitForEvent(alice, "peer_left");
    bob.disconnect();

    const [leftRoomId] = await alicePeerLeft;
    assert(leftRoomId === roomId, `Alice received PEER_LEFT for room "${leftRoomId}"`);

    // ---- Step 6: Reconnect ----
    console.log("\nStep 6: Reconnect after disconnect");

    const bobReregistered = waitForEvent(bob, "registered");
    bob.connect();
    const [bobReregId] = await bobReregistered;
    assert(bobReregId === BOB_ID, `Bob re-registered as "${bobReregId}"`);

    // Cleanup
    alice.disconnect();
    bob.disconnect();

    // ---- Summary ----
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("\n✗ Test error:", err);
    alice.disconnect();
    bob.disconnect();
    process.exit(1);
  }
}

runTests();
