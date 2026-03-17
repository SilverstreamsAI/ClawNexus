/**
 * relay-keepalive-test.ts — Long-running NAT keepalive validation (TICKET-087)
 *
 * Keeps a relay connection alive for DURATION minutes, sending encrypted
 * messages every INTERVAL seconds. Monitors for unexpected disconnects,
 * failed decryptions, and latency spikes.
 *
 * Usage:
 *   tsx test/relay-keepalive-test.ts [duration_min] [interval_sec]
 *
 * Defaults: 10 minutes, 30 second intervals
 */

import * as crypto from "node:crypto";
import { RelayConnector } from "../src/relay/connector.js";

const REGISTRY_URL =
  process.env.CLAWNEXUS_REGISTRY_URL ?? "https://clawnexus-registry.silvonastream.com";

const DURATION_MIN = Number(process.argv[2]) || 10;
const INTERVAL_SEC = Number(process.argv[3]) || 30;
const DURATION_MS = DURATION_MIN * 60_000;
const INTERVAL_MS = INTERVAL_SEC * 1_000;

const RUN_ID = Date.now().toString(36);

// --- Crypto helpers ---

interface EphemeralIdentity {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
}

function generateIdentity(): EphemeralIdentity {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const publicKeyHex = spkiDer.subarray(12).toString("hex");
  return { privateKey, publicKeyHex };
}

function sign(privateKey: crypto.KeyObject, payload: unknown): string {
  const message = Buffer.from(JSON.stringify(payload), "utf-8");
  return crypto.sign(null, message, privateKey).toString("base64");
}

// --- Registry helpers ---

async function registryRegister(
  id: EphemeralIdentity,
  clawId: string,
): Promise<{ record: { name: string } }> {
  const payload = { claw_id: clawId };
  const res = await fetch(`${REGISTRY_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload,
      pubkey: `ed25519:${id.publicKeyHex}`,
      signature: sign(id.privateKey, payload),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Register failed: ${res.status}`);
  return res.json() as Promise<{ record: { name: string } }>;
}

async function registryGetToken(
  id: EphemeralIdentity,
  clawId: string,
): Promise<{ token: string; relay_hint: string }> {
  const payload = { claw_id: clawId };
  const res = await fetch(`${REGISTRY_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload,
      pubkey: `ed25519:${id.publicKeyHex}`,
      signature: sign(id.privateKey, payload),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status}`);
  return res.json() as Promise<{ token: string; relay_hint: string }>;
}

// --- Helpers ---

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function waitForEvent(
  emitter: RelayConnector,
  event: string,
  timeoutMs = 15_000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for: ${event}`)),
      timeoutMs,
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

// --- Main ---

async function run(): Promise<void> {
  console.log(`=== Relay Keepalive Test (TICKET-087) ===`);
  console.log(`Duration: ${DURATION_MIN} min, Interval: ${INTERVAL_SEC}s, Run: ${RUN_ID}\n`);

  // Setup
  const aliceId = generateIdentity();
  const bobId = generateIdentity();

  const aliceReg = await registryRegister(aliceId, `ka-alice-${RUN_ID}`);
  const bobReg = await registryRegister(bobId, `ka-bob-${RUN_ID}`);
  const aliceName = aliceReg.record.name;
  const bobName = bobReg.record.name;
  console.log(`Alice: ${aliceName}`);
  console.log(`Bob:   ${bobName}`);

  const aliceToken = await registryGetToken(aliceId, aliceName);
  const bobToken = await registryGetToken(bobId, bobName);
  const relayUrl = `wss://${aliceToken.relay_hint}/relay`;
  console.log(`Relay: ${relayUrl}\n`);

  // Connect
  const alice = new RelayConnector({ relayUrl, clawId: aliceName, authToken: aliceToken.token, autoAccept: true });
  const bob = new RelayConnector({ relayUrl, clawId: bobName, authToken: bobToken.token, autoAccept: true });

  // Track disconnects
  let aliceDisconnects = 0;
  let bobDisconnects = 0;
  alice.on("peer_left", () => { aliceDisconnects++; console.log(`  [${ts()}] ⚠ Alice saw PEER_LEFT`); });
  bob.on("peer_left", () => { bobDisconnects++; console.log(`  [${ts()}] ⚠ Bob saw PEER_LEFT`); });

  const aliceRegP = waitForEvent(alice, "registered");
  alice.connect();
  await aliceRegP;
  console.log(`[${ts()}] Alice connected`);

  const bobRegP = waitForEvent(bob, "registered");
  bob.connect();
  await bobRegP;
  console.log(`[${ts()}] Bob connected`);

  // Join room
  const bobIncoming = waitForEvent(bob, "incoming");
  const aliceJoined = waitForEvent(alice, "joined");
  const bobJoined = waitForEvent(bob, "joined");
  alice.join(bobName);
  await bobIncoming;
  const [roomId] = await aliceJoined;
  await bobJoined;
  console.log(`[${ts()}] Room established: ${roomId}`);

  // Wait for key exchange
  await Promise.all([
    waitForEvent(alice, "key_exchanged"),
    waitForEvent(bob, "key_exchanged"),
  ]);
  console.log(`[${ts()}] Key exchange done\n`);

  // Keepalive loop
  const startTime = Date.now();
  let seq = 0;
  let successCount = 0;
  let failCount = 0;
  const latencies: number[] = [];

  console.log(`[${ts()}] Starting keepalive loop (${DURATION_MIN} min, every ${INTERVAL_SEC}s)...\n`);
  console.log("  #   | Direction   | Latency | Status");
  console.log("  ----|-------------|---------|-------");

  while (Date.now() - startTime < DURATION_MS) {
    seq++;
    const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);

    // Alice → Bob
    try {
      const t0 = Date.now();
      const bobRecv = waitForEvent(bob, "data", 10_000);
      const sent = alice.sendData(roomId as string, `keepalive-a2b-${seq}`);
      if (!sent) throw new Error("sendData returned false");
      const [, text] = await bobRecv;
      const lat = Date.now() - t0;
      latencies.push(lat);
      if (text === `keepalive-a2b-${seq}`) {
        successCount++;
        console.log(`  ${String(seq).padStart(3)}a | Alice→Bob   | ${String(lat).padStart(5)}ms | ✓  (${elapsed}min)`);
      } else {
        failCount++;
        console.log(`  ${String(seq).padStart(3)}a | Alice→Bob   | ${String(lat).padStart(5)}ms | ✗ wrong content  (${elapsed}min)`);
      }
    } catch (err) {
      failCount++;
      console.log(`  ${String(seq).padStart(3)}a | Alice→Bob   |     — | ✗ ${(err as Error).message}  (${elapsed}min)`);
    }

    // Bob → Alice
    try {
      const t0 = Date.now();
      const aliceRecv = waitForEvent(alice, "data", 10_000);
      const sent = bob.sendData(roomId as string, `keepalive-b2a-${seq}`);
      if (!sent) throw new Error("sendData returned false");
      const [, text] = await aliceRecv;
      const lat = Date.now() - t0;
      latencies.push(lat);
      if (text === `keepalive-b2a-${seq}`) {
        successCount++;
        console.log(`  ${String(seq).padStart(3)}b | Bob→Alice   | ${String(lat).padStart(5)}ms | ✓`);
      } else {
        failCount++;
        console.log(`  ${String(seq).padStart(3)}b | Bob→Alice   | ${String(lat).padStart(5)}ms | ✗ wrong content`);
      }
    } catch (err) {
      failCount++;
      console.log(`  ${String(seq).padStart(3)}b | Bob→Alice   |     — | ✗ ${(err as Error).message}`);
    }

    // Wait for next interval
    if (Date.now() - startTime < DURATION_MS) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  // Summary
  const totalTime = ((Date.now() - startTime) / 60_000).toFixed(1);
  const avgLat = latencies.length > 0
    ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1)
    : "—";
  const maxLat = latencies.length > 0 ? Math.max(...latencies) : 0;
  const minLat = latencies.length > 0 ? Math.min(...latencies) : 0;

  console.log(`\n=== Keepalive Test Results ===`);
  console.log(`Duration:        ${totalTime} min`);
  console.log(`Messages:        ${successCount} ok, ${failCount} failed (${seq} rounds)`);
  console.log(`Latency:         avg=${avgLat}ms, min=${minLat}ms, max=${maxLat}ms`);
  console.log(`Disconnects:     Alice saw ${aliceDisconnects}, Bob saw ${bobDisconnects}`);
  console.log(`Verdict:         ${failCount === 0 && aliceDisconnects === 0 ? "✓ PASS" : "✗ FAIL"}`);

  alice.disconnect();
  bob.disconnect();
  await new Promise((r) => setTimeout(r, 500));

  process.exit(failCount > 0 || aliceDisconnects > 0 ? 1 : 0);
}

run().catch((err: unknown) => {
  console.error("\n✗ Fatal:", err);
  process.exit(1);
});
