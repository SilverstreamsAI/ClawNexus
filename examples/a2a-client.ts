#!/usr/bin/env npx tsx
// Minimal A2A client — sends a message to ClawNexus daemon and prints the response.
//
// Prerequisites:
//   1. OpenClaw Gateway running on localhost:18789
//   2. ClawNexus daemon running: clawnexus start
//
// Usage:
//   npx tsx examples/a2a-client.ts "What can you do?"
//   npx tsx examples/a2a-client.ts                     # uses default prompt

const DAEMON_URL = process.env.CLAWNEXUS_URL ?? "http://localhost:17890";
const message = process.argv[2] || "Hello! What can you help me with?";

interface A2AResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: {
    id: string;
    status: { state: string; message?: { parts: Array<{ text: string }> } };
    artifacts?: Array<{ parts: Array<{ text: string }> }>;
  };
  error?: { code: number; message: string };
}

async function main() {
  console.log(`→ Sending to ${DAEMON_URL}/a2a`);
  console.log(`→ Message: "${message}"\n`);

  const res = await fetch(`${DAEMON_URL}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tasks/send",
      id: "1",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: message }],
        },
      },
    }),
  });

  const data: A2AResponse = await res.json();

  if (data.error) {
    console.error(`Error [${data.error.code}]: ${data.error.message}`);
    process.exit(1);
  }

  const task = data.result!;
  console.log(`Task ID:    ${task.id}`);
  console.log(`State:      ${task.status.state}`);

  if (task.status.message) {
    console.log(`\nResponse:\n${task.status.message.parts.map((p) => p.text).join("\n")}`);
  }

  // Verify task retrieval
  console.log(`\n--- Verifying tasks/get ---`);
  const getRes = await fetch(`${DAEMON_URL}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tasks/get",
      id: "2",
      params: { id: task.id },
    }),
  });
  const getData: A2AResponse = await getRes.json();
  console.log(`tasks/get state: ${getData.result?.status.state ?? "error"}`);
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
