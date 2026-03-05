#!/usr/bin/env node
// ClawNexus CLI — entry point
// Commands: start, stop, restart, status, scan, list, alias, info, forget, connect, open
//
// Relay commands (v0.4):
//   clawnexus relay status              — show relay connection state
//   clawnexus connect <name.claw>       — connect to remote instance via relay
//
// Agent commands (v1.0 Layer B):
//   clawnexus policy show|set|reset     — manage policy
//   clawnexus tasks [--all]             — list tasks
//   clawnexus propose <claw_id> ...     — send proposal
//   clawnexus query <claw_id> ...       — query peer
//   clawnexus inbox                     — view/manage inbox

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fork } from "node:child_process";
import type { ClawInstance, Connectivity } from "../types.js";

const PID_FILE = path.join(os.homedir(), ".clawnexus", "daemon.pid");
const DEFAULT_API = "http://localhost:17890";

// --- Global flag parsing ---

export interface ParsedArgs {
  command: string;
  positional: string[];
  json: boolean;
  timeout: number;
  api: string;
  all: boolean;
  direction: string;
  peer: string;
  scope: string;
  input: Record<string, string>;
  targets: string[];
  ports: number[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let json = false;
  let timeout = 5000;
  let api = process.env.CLAWNEXUS_API ?? DEFAULT_API;
  let all = false;
  let direction = "";
  let peer = "";
  let scope = "";
  const input: Record<string, string> = {};
  const targets: string[] = [];
  const ports: number[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--timeout" && argv[i + 1]) {
      timeout = parseInt(argv[++i], 10);
    } else if (arg === "--api" && argv[i + 1]) {
      api = argv[++i];
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--direction" && argv[i + 1]) {
      direction = argv[++i];
    } else if (arg === "--peer" && argv[i + 1]) {
      peer = argv[++i];
    } else if (arg === "--scope" && argv[i + 1]) {
      scope = argv[++i];
    } else if (arg === "--target" && argv[i + 1]) {
      targets.push(argv[++i]);
    } else if (arg === "--ports" && argv[i + 1]) {
      for (const p of argv[++i].split(",")) {
        const n = parseInt(p.trim(), 10);
        if (n > 0 && n <= 65535) ports.push(n);
      }
    } else if (arg === "--input" && argv[i + 1]) {
      const val = argv[++i];
      const eqIdx = val.indexOf("=");
      if (eqIdx > 0) {
        input[val.slice(0, eqIdx)] = val.slice(eqIdx + 1);
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] ?? "",
    positional: positional.slice(1),
    json,
    timeout,
    api,
    all,
    direction,
    peer,
    scope,
    input,
    targets,
    ports,
  };
}

async function fetchApi(
  api: string,
  method: string,
  urlPath: string,
  body?: unknown,
  timeout?: number,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetch(`${api}${urlPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, status: 0, data: { error: "Request timed out" } };
    }
    return { ok: false, status: 0, data: { error: "Cannot connect to daemon. Is it running?" } };
  }
}

// --- Table formatting ---

function getChannel(inst: ClawInstance): string {
  if (inst.is_self) return "local";
  return inst.connectivity?.preferred_channel ?? inst.discovery_source;
}

function printTable(instances: ClawInstance[]): void {
  if (instances.length === 0) {
    console.log("No instances found.");
    return;
  }

  const header = {
    name: "NAME",
    address: "ADDRESS",
    status: "STATUS",
    channel: "CHANNEL",
    source: "SOURCE",
    lastSeen: "LAST SEEN",
  };

  const rows = instances.map((i) => {
    const baseName = i.alias ?? i.auto_name;
    return {
      name: i.is_self ? `${baseName} (self)` : baseName,
      address: `${i.address}:${i.gateway_port}`,
      status: i.status,
      channel: getChannel(i),
      source: i.discovery_source,
      lastSeen: i.last_seen ? new Date(i.last_seen).toLocaleString() : "-",
    };
  });

  const colWidths = {
    name: Math.max(header.name.length, ...rows.map((r) => r.name.length)),
    address: Math.max(header.address.length, ...rows.map((r) => r.address.length)),
    status: Math.max(header.status.length, ...rows.map((r) => r.status.length)),
    channel: Math.max(header.channel.length, ...rows.map((r) => r.channel.length)),
    source: Math.max(header.source.length, ...rows.map((r) => r.source.length)),
    lastSeen: Math.max(header.lastSeen.length, ...rows.map((r) => r.lastSeen.length)),
  };

  const line = (r: typeof header) =>
    `${r.name.padEnd(colWidths.name)}  ${r.address.padEnd(colWidths.address)}  ${r.status.padEnd(colWidths.status)}  ${r.channel.padEnd(colWidths.channel)}  ${r.source.padEnd(colWidths.source)}  ${r.lastSeen}`;

  console.log(line(header));
  console.log("-".repeat(colWidths.name + colWidths.address + colWidths.status + colWidths.channel + colWidths.source + colWidths.lastSeen + 10));
  for (const row of rows) {
    console.log(line(row));
  }
}

// --- PID file helpers ---

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    // Check if process exists
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), "utf-8");
}

function removePid(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

// --- Commands ---

async function cmdStart(args: ParsedArgs): Promise<void> {
  // Check if already running
  const existing = readPid();
  if (existing) {
    console.log(`ClawNexus daemon is already running (PID ${existing}).`);
    return;
  }

  // If --_daemon flag: run in foreground (child process entry)
  if (process.argv.includes("--_daemon")) {
    writePid(process.pid);

    process.on("SIGTERM", () => {
      removePid();
      process.exit(0);
    });
    process.on("SIGINT", () => {
      removePid();
      process.exit(0);
    });

    const { startDaemon } = await import("../api/server.js");
    const port = parseInt(process.env.CLAWNEXUS_PORT ?? "17890", 10);
    const host = process.env.CLAWNEXUS_HOST ?? "127.0.0.1";
    await startDaemon({ port, host });
    return;
  }

  // Fork a child process as daemon — redirect stdout/stderr to daemon.log
  const logPath = path.join(os.homedir(), ".clawnexus", "daemon.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = fork(__filename, ["start", "--_daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd, "ipc"],
    env: { ...process.env },
    windowsHide: true,
  } as Parameters<typeof fork>[2]);

  child.disconnect();
  child.unref();

  if (child.pid) {
    // Wait briefly for daemon to start
    await new Promise((r) => setTimeout(r, 1000));
    const apiUrl = args.api;
    try {
      const res = await fetch(`${apiUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        console.log(`ClawNexus daemon started (PID ${child.pid}).`);
        return;
      }
    } catch {
      // Daemon may still be starting
    }
    console.log(`ClawNexus daemon forked (PID ${child.pid}). Waiting for it to be ready...`);
  }
}

async function cmdStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log("ClawNexus daemon is not running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    removePid();
    console.log(`ClawNexus daemon stopped (PID ${pid}).`);
  } catch {
    removePid();
    console.log("ClawNexus daemon process not found. Cleaned up PID file.");
  }
}

async function cmdRestart(args: ParsedArgs): Promise<void> {
  await cmdStop();
  await new Promise((r) => setTimeout(r, 500));
  await cmdStart(args);
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
  const pid = readPid();
  const { ok, data } = await fetchApi(args.api, "GET", "/health", undefined, args.timeout);

  if (args.json) {
    console.log(JSON.stringify({ pid, ...data as object }, null, 2));
    return;
  }

  if (!ok) {
    console.log(`ClawNexus daemon: not running${pid ? ` (stale PID ${pid})` : ""}`);
    return;
  }

  const d = data as Record<string, unknown>;
  console.log(`ClawNexus daemon: running (PID ${pid ?? "unknown"})`);
  console.log(`  Version:    ${d.version}`);
  console.log(`  Timestamp:  ${d.timestamp}`);
  const components = d.components as Record<string, unknown> | undefined;
  if (components) {
    const localInst = components.local_instance as { agent_id?: string; auto_name?: string; status: string } | undefined;
    if (localInst?.agent_id) {
      console.log(`  Local:      ${localInst.auto_name ?? localInst.agent_id} (127.0.0.1:18789)`);
    } else {
      console.log(`  Local:      not detected`);
    }
    const reg = components.registry as { instances: number } | undefined;
    console.log(`  Instances:  ${reg?.instances ?? 0}`);
    console.log(`  mDNS:       ${components.mdns}`);
    console.log(`  Health:     ${components.health_checker}`);
    console.log(`  Scanner:    ${components.scanner}`);
  }
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const { ok, data } = await fetchApi(args.api, "GET", "/instances", undefined, args.timeout);
  if (!ok) {
    console.error("Failed to fetch instances:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  let { instances } = data as { instances: ClawInstance[] };

  // Filter by scope if specified
  if (args.scope) {
    instances = instances.filter((i) => i.network_scope === args.scope);
  }

  if (args.json) {
    console.log(JSON.stringify({ count: instances.length, instances }, null, 2));
  } else {
    printTable(instances);
  }
}

async function cmdScan(args: ParsedArgs): Promise<void> {
  const body: Record<string, unknown> = {};
  if (args.targets.length > 0) body.targets = args.targets;
  if (args.ports.length > 0) body.ports = args.ports;

  const hasExplicit = args.targets.length > 0 || args.ports.length > 0;
  if (hasExplicit) {
    console.log(`Scanning${args.targets.length ? ` targets: ${args.targets.join(", ")}` : ""}${args.ports.length ? ` ports: ${args.ports.join(", ")}` : ""}...`);
  } else {
    console.log("Scanning local network...");
  }

  const { ok, data } = await fetchApi(args.api, "POST", "/scan", Object.keys(body).length > 0 ? body : undefined, 30_000);
  if (!ok) {
    console.error("Scan failed:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  const result = data as { discovered: number; instances: ClawInstance[] };

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Found ${result.discovered} instance(s).`);
    if (result.instances.length > 0) {
      printTable(result.instances);
    }
  }
}

async function cmdAlias(args: ParsedArgs): Promise<void> {
  const [id, alias] = args.positional;
  if (!id || !alias) {
    console.error("Usage: clawnexus alias <id|address> <name>");
    process.exit(1);
  }

  const { ok, data } = await fetchApi(
    args.api,
    "PUT",
    `/instances/${encodeURIComponent(id)}/alias`,
    { alias },
    args.timeout,
  );

  if (!ok) {
    const err = data as { error?: string };
    console.error(`Failed to set alias: ${err.error ?? "Unknown error"}`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Alias "${alias}" set for instance "${id}".`);
  }
}

async function cmdInfo(args: ParsedArgs): Promise<void> {
  const [name] = args.positional;
  if (!name) {
    console.error("Usage: clawnexus info <name|address>");
    process.exit(1);
  }

  const { ok, data } = await fetchApi(
    args.api,
    "GET",
    `/instances/${encodeURIComponent(name)}`,
    undefined,
    args.timeout,
  );

  if (!ok) {
    console.error(`Instance "${name}" not found.`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const inst = data as ClawInstance;
    console.log(`Auto Name:     ${inst.auto_name}${inst.is_self ? " (self)" : ""}`);
    console.log(`Agent ID:      ${inst.agent_id}`);
    console.log(`Display Name:  ${inst.display_name}`);
    console.log(`Assistant:     ${inst.assistant_name}`);
    if (inst.alias) console.log(`Alias:         ${inst.alias}`);
    if ((inst as ClawInstance & { claw_name?: string }).claw_name) console.log(`Claw Name:     ${(inst as ClawInstance & { claw_name?: string }).claw_name}`);
    console.log(`Address:       ${inst.address}:${inst.gateway_port}`);
    console.log(`LAN Host:      ${inst.lan_host}`);
    console.log(`TLS:           ${inst.tls ? "yes" : "no"}`);
    console.log(`Status:        ${inst.status}`);
    console.log(`Channel:       ${getChannel(inst)}`);
    console.log(`Source:        ${inst.discovery_source}`);
    console.log(`Scope:         ${inst.network_scope}`);
    console.log(`Last Seen:     ${inst.last_seen ? new Date(inst.last_seen).toLocaleString() : "-"}`);
    console.log(`Discovered:    ${inst.discovered_at ? new Date(inst.discovered_at).toLocaleString() : "-"}`);
    if (inst.connectivity) {
      console.log(`LAN Reachable: ${inst.connectivity.lan_reachable ? "yes" : "no"}${inst.connectivity.lan_latency_ms != null ? ` (${inst.connectivity.lan_latency_ms}ms)` : ""}`);
      console.log(`Relay:         ${inst.connectivity.relay_available ? "available" : "unavailable"}`);
      if (inst.connectivity.unreachable_reason) {
        console.log(`Unreachable:   ${inst.connectivity.unreachable_reason}`);
      }
    }
    if (inst.labels && Object.keys(inst.labels).length > 0) {
      console.log(`Labels:        ${JSON.stringify(inst.labels)}`);
    }
  }
}

async function cmdForget(args: ParsedArgs): Promise<void> {
  const [name] = args.positional;
  if (!name) {
    console.error("Usage: clawnexus forget <name|address>");
    process.exit(1);
  }

  const { ok, data } = await fetchApi(
    args.api,
    "DELETE",
    `/instances/${encodeURIComponent(name)}`,
    undefined,
    args.timeout,
  );

  if (!ok) {
    console.error(`Instance "${name}" not found.`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const result = data as { removed: string };
    console.log(`Removed instance "${result.removed}".`);
  }
}

async function cmdConnect(args: ParsedArgs): Promise<void> {
  const [target] = args.positional;
  if (!target) {
    console.error("Usage: clawnexus connect <name|name.claw>");
    process.exit(1);
  }

  if (target.endsWith(".claw")) {
    // Connect via relay
    const { ok, data } = await fetchApi(
      args.api,
      "POST",
      "/relay/connect",
      { target_claw_id: target },
      args.timeout,
    );
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else if (ok) {
      console.log(`Connecting to ${target} via relay...`);
    } else {
      console.error("Relay connection failed:", (data as { error?: string }).error ?? "Unknown error");
      process.exit(1);
    }
  } else {
    // Resolve instance and choose channel intelligently
    const { ok, data } = await fetchApi(
      args.api,
      "GET",
      `/instances/${encodeURIComponent(target)}`,
      undefined,
      args.timeout,
    );
    if (!ok) {
      console.error(`Instance "${target}" not found.`);
      process.exit(1);
    }
    const inst = data as ClawInstance & { connectivity?: Connectivity };

    if (inst.connectivity?.lan_reachable) {
      // LAN direct
      const protocol = inst.tls ? "wss" : "ws";
      const url = `${protocol}://${inst.address}:${inst.gateway_port}`;
      if (args.json) {
        console.log(JSON.stringify({ url, channel: "lan", instance: inst }, null, 2));
      } else {
        console.log(url);
        console.log("(via LAN direct)");
      }
    } else if (inst.connectivity?.relay_available) {
      // Relay fallback
      const { ok: relayOk, data: relayData } = await fetchApi(
        args.api,
        "POST",
        "/relay/connect",
        { target_claw_id: inst.agent_id },
        args.timeout,
      );
      if (args.json) {
        console.log(JSON.stringify({ channel: "relay", ...relayData as object }, null, 2));
      } else if (relayOk) {
        console.log(`Connecting to ${target} via relay...`);
      } else {
        console.error("Relay connection failed:", (relayData as { error?: string }).error ?? "Unknown error");
        process.exit(1);
      }
    } else {
      // Fallback to direct URL (legacy behavior)
      const protocol = inst.tls ? "wss" : "ws";
      const url = `${protocol}://${inst.address}:${inst.gateway_port}`;
      if (args.json) {
        console.log(JSON.stringify({ url, channel: "unknown", instance: inst }, null, 2));
      } else {
        console.log(url);
        if (inst.connectivity?.unreachable_reason) {
          console.error(`Warning: instance may be unreachable (${inst.connectivity.unreachable_reason})`);
          console.error("Run 'clawnexus diagnostics' for details.");
        }
      }
    }
  }
}

async function cmdOpen(args: ParsedArgs): Promise<void> {
  const [name] = args.positional;
  if (!name) {
    console.error("Usage: clawnexus open <name>");
    process.exit(1);
  }

  const { ok, data } = await fetchApi(
    args.api,
    "GET",
    `/instances/${encodeURIComponent(name)}`,
    undefined,
    args.timeout,
  );

  if (!ok) {
    console.error(`Instance "${name}" not found.`);
    process.exit(1);
  }

  const inst = data as ClawInstance;
  const protocol = inst.tls ? "https" : "http";
  const url = `${protocol}://${inst.address}:${inst.gateway_port}`;

  const { exec } = await import("node:child_process");
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" :
    platform === "win32" ? "start" :
    "xdg-open";

  exec(`${cmd} ${url}`, (err) => {
    if (err) {
      console.error(`Failed to open browser: ${err.message}`);
      console.log(`URL: ${url}`);
    }
  });
}

async function cmdRelay(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  if (sub === "status") {
    const { ok, data } = await fetchApi(args.api, "GET", "/relay/status", undefined, args.timeout);
    if (!ok) {
      console.error("Relay status unavailable:", (data as { error?: string }).error ?? "Unknown error");
      process.exit(1);
    }
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.error("Usage: clawnexus relay status");
    process.exit(1);
  }
}

// --- Layer B Agent Commands ---

async function cmdPolicy(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case "show": {
      const { ok, data } = await fetchApi(args.api, "GET", "/agent/policy", undefined, args.timeout);
      if (!ok) {
        console.error("Failed to get policy:", (data as { error?: string }).error ?? "Unknown error");
        process.exit(1);
      }
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "set": {
      const key = args.positional[1];
      const value = args.positional[2];
      if (!key || value === undefined) {
        console.error("Usage: clawnexus policy set <key> <value>");
        process.exit(1);
      }
      // Parse value as JSON if possible, else use as string
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
      const patch: Record<string, unknown> = {};
      // Support dot notation: "rate_limit.max_per_minute" → nested object
      const parts = key.split(".");
      let current = patch;
      for (let i = 0; i < parts.length - 1; i++) {
        current[parts[i]] = {};
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = parsed;

      const { ok, data } = await fetchApi(args.api, "PATCH", "/agent/policy", patch, args.timeout);
      if (!ok) {
        console.error("Failed to update policy:", (data as { error?: string }).error ?? "Unknown error");
        process.exit(1);
      }
      if (args.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Policy updated: ${key} = ${JSON.stringify(parsed)}`);
      }
      break;
    }
    case "reset": {
      const { ok, data } = await fetchApi(args.api, "POST", "/agent/policy/reset", undefined, args.timeout);
      if (!ok) {
        console.error("Failed to reset policy:", (data as { error?: string }).error ?? "Unknown error");
        process.exit(1);
      }
      if (args.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log("Policy reset to defaults.");
      }
      break;
    }
    default:
      console.error("Usage: clawnexus policy <show|set|reset>");
      process.exit(1);
  }
}

async function cmdTasks(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  if (sub === "info") {
    const taskId = args.positional[1];
    if (!taskId) {
      console.error("Usage: clawnexus tasks info <task_id>");
      process.exit(1);
    }
    const { ok, data } = await fetchApi(args.api, "GET", `/agent/tasks/${encodeURIComponent(taskId)}`, undefined, args.timeout);
    if (!ok) {
      console.error("Task not found:", (data as { error?: string }).error ?? "Unknown error");
      process.exit(1);
    }
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (sub === "cancel") {
    const taskId = args.positional[1];
    if (!taskId) {
      console.error("Usage: clawnexus tasks cancel <task_id>");
      process.exit(1);
    }
    const { ok, data } = await fetchApi(args.api, "POST", `/agent/tasks/${encodeURIComponent(taskId)}/cancel`, {}, args.timeout);
    if (!ok) {
      console.error("Failed to cancel task:", (data as { error?: string }).error ?? "Unknown error");
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Task ${taskId} cancelled.`);
    }
    return;
  }

  if (sub === "stats") {
    const { ok, data } = await fetchApi(args.api, "GET", "/agent/tasks/stats", undefined, args.timeout);
    if (!ok) {
      console.error("Failed to get stats:", (data as { error?: string }).error ?? "Unknown error");
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const stats = data as { total: number; active: number; by_state: Record<string, number>; by_direction: Record<string, number> };
      console.log(`Total: ${stats.total}  Active: ${stats.active}`);
      console.log(`  By state:     ${Object.entries(stats.by_state).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
      console.log(`  By direction: ${Object.entries(stats.by_direction).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
    }
    return;
  }

  // Default: list tasks
  const params = new URLSearchParams();
  if (args.all) params.set("all", "true");
  if (args.direction) params.set("direction", args.direction);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const { ok, data } = await fetchApi(args.api, "GET", `/agent/tasks${qs}`, undefined, args.timeout);
  if (!ok) {
    console.error("Failed to list tasks:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const { tasks: taskList } = data as { tasks: Array<{ task_id: string; direction: string; peer_claw_id: string; state: string; task: { task_type: string } }> };
    if (taskList.length === 0) {
      console.log("No tasks found.");
      return;
    }
    const header = { id: "TASK ID", dir: "DIR", peer: "PEER", state: "STATE", type: "TYPE" };
    const rows = taskList.map((t) => ({
      id: t.task_id.slice(0, 8),
      dir: t.direction,
      peer: t.peer_claw_id,
      state: t.state,
      type: t.task.task_type,
    }));
    const w = {
      id: Math.max(header.id.length, ...rows.map((r) => r.id.length)),
      dir: Math.max(header.dir.length, ...rows.map((r) => r.dir.length)),
      peer: Math.max(header.peer.length, ...rows.map((r) => r.peer.length)),
      state: Math.max(header.state.length, ...rows.map((r) => r.state.length)),
      type: Math.max(header.type.length, ...rows.map((r) => r.type.length)),
    };
    const line = (r: typeof header) =>
      `${r.id.padEnd(w.id)}  ${r.dir.padEnd(w.dir)}  ${r.peer.padEnd(w.peer)}  ${r.state.padEnd(w.state)}  ${r.type}`;
    console.log(line(header));
    console.log("-".repeat(w.id + w.dir + w.peer + w.state + w.type + 8));
    for (const row of rows) console.log(line(row));
  }
}

async function cmdPropose(args: ParsedArgs): Promise<void> {
  const [clawId, taskType, ...descParts] = args.positional;
  if (!clawId || !taskType) {
    console.error("Usage: clawnexus propose <claw_id> <task_type> [description] [--input key=value ...]");
    process.exit(1);
  }

  // Need a room_id — look up relay status to find room for this peer
  const { ok: relayOk, data: relayData } = await fetchApi(args.api, "GET", "/relay/status", undefined, args.timeout);
  if (!relayOk) {
    console.error("Relay not available. Connect to a peer first.");
    process.exit(1);
  }
  const relayStatus = relayData as { rooms: Array<{ room_id: string; peer_claw_id: string; state: string }> };
  const room = relayStatus.rooms.find((r) => r.peer_claw_id === clawId && r.state === "active");
  if (!room) {
    console.error(`No active relay room for peer "${clawId}". Use 'clawnexus connect ${clawId}' first.`);
    process.exit(1);
  }

  const { ok, data } = await fetchApi(args.api, "POST", "/agent/propose", {
    target_claw_id: clawId,
    room_id: room.room_id,
    task: {
      task_type: taskType,
      description: descParts.join(" ") || taskType,
      input: Object.keys(args.input).length > 0 ? args.input : undefined,
    },
  }, args.timeout);

  if (!ok) {
    console.error("Propose failed:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const result = data as { task: { task_id: string } };
    console.log(`Proposal sent. Task ID: ${result.task.task_id}`);
  }
}

async function cmdQuery(args: ParsedArgs): Promise<void> {
  const [clawId, queryType] = args.positional;
  if (!clawId || !queryType) {
    console.error("Usage: clawnexus query <claw_id> <capabilities|status|availability>");
    process.exit(1);
  }

  // Find room for peer
  const { ok: relayOk, data: relayData } = await fetchApi(args.api, "GET", "/relay/status", undefined, args.timeout);
  if (!relayOk) {
    console.error("Relay not available.");
    process.exit(1);
  }
  const relayStatus = relayData as { rooms: Array<{ room_id: string; peer_claw_id: string; state: string }> };
  const room = relayStatus.rooms.find((r) => r.peer_claw_id === clawId && r.state === "active");
  if (!room) {
    console.error(`No active relay room for peer "${clawId}".`);
    process.exit(1);
  }

  const { ok, data } = await fetchApi(args.api, "POST", "/agent/query", {
    target_claw_id: clawId,
    room_id: room.room_id,
    query_type: queryType,
  }, args.timeout);

  if (!ok) {
    console.error("Query failed:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const result = data as { message_id: string };
    console.log(`Query sent. Message ID: ${result.message_id}`);
  }
}

async function cmdInbox(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  if (sub === "approve") {
    const id = args.positional[1];
    if (!id) {
      console.error("Usage: clawnexus inbox approve <message_id>");
      process.exit(1);
    }
    const { ok, data } = await fetchApi(args.api, "POST", `/agent/inbox/${encodeURIComponent(id)}/approve`, {}, args.timeout);
    if (!ok) {
      console.error("Approve failed:", (data as { error?: string }).error ?? "Unknown error");
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Inbox item ${id} approved.`);
    }
    return;
  }

  if (sub === "deny") {
    const id = args.positional[1];
    if (!id) {
      console.error("Usage: clawnexus inbox deny <message_id>");
      process.exit(1);
    }
    const { ok, data } = await fetchApi(args.api, "POST", `/agent/inbox/${encodeURIComponent(id)}/deny`, {}, args.timeout);
    if (!ok) {
      console.error("Deny failed:", (data as { error?: string }).error ?? "Unknown error");
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Inbox item ${id} denied.`);
    }
    return;
  }

  // Default: list inbox
  const { ok, data } = await fetchApi(args.api, "GET", "/agent/inbox", undefined, args.timeout);
  if (!ok) {
    console.error("Failed to get inbox:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const result = data as { count: number; items: Array<{ message_id: string; from: string; type: string; timestamp: string }> };
    if (result.count === 0) {
      console.log("Inbox is empty.");
      return;
    }
    for (const item of result.items) {
      console.log(`  ${item.message_id.slice(0, 8)}  from=${item.from}  type=${item.type}  at=${new Date(item.timestamp).toLocaleString()}`);
    }
    console.log(`\n${result.count} item(s). Use 'clawnexus inbox approve <id>' or 'clawnexus inbox deny <id>'.`);
  }
}

async function cmdRegister(args: ParsedArgs): Promise<void> {
  console.log("Registering with public registry...");
  const { ok, data } = await fetchApi(args.api, "POST", "/registry/register", undefined, args.timeout);
  if (!ok) {
    console.error("Registration failed:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const result = data as { claw_name?: string; pubkey?: string };
    if (result.claw_name) {
      console.log(`Registered as: ${result.claw_name}`);
    } else {
      console.log("Registration attempted. No local instance to register.");
    }
  }
}

async function cmdRegistryStatus(args: ParsedArgs): Promise<void> {
  const { ok, data } = await fetchApi(args.api, "GET", "/registry/status", undefined, args.timeout);
  if (!ok) {
    console.error("Failed to get registry status:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const status = data as { registered: boolean; claw_name?: string; pubkey?: string };
    console.log(`Registered: ${status.registered ? "yes" : "no"}`);
    if (status.claw_name) console.log(`Claw Name:  ${status.claw_name}`);
    if (status.pubkey) console.log(`Public Key: ${status.pubkey}`);
  }
}

async function cmdResolve(args: ParsedArgs): Promise<void> {
  const [name] = args.positional;
  if (!name) {
    console.error("Usage: clawnexus resolve <name.id.claw>");
    process.exit(1);
  }

  const { ok, data } = await fetchApi(
    args.api,
    "GET",
    `/resolve/${encodeURIComponent(name)}`,
    undefined,
    args.timeout,
  );

  if (!ok) {
    console.error(`Name "${name}" not found.`);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const inst = data as ClawInstance;
    console.log(`Claw Name:  ${inst.claw_name ?? name}`);
    console.log(`Agent ID:   ${inst.agent_id}`);
    console.log(`Source:     ${inst.discovery_source}`);
    console.log(`Scope:      ${inst.network_scope}`);
    if (inst.owner_pubkey) console.log(`Owner:      ${inst.owner_pubkey}`);
    if (inst.connectivity) {
      console.log(`Channel:    ${inst.connectivity.preferred_channel}`);
    }
  }
}

async function cmdWhoami(args: ParsedArgs): Promise<void> {
  const { ok, data } = await fetchApi(args.api, "GET", "/whoami", undefined, args.timeout);
  if (!ok) {
    console.error("Failed to get identity:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const identity = data as { pubkey?: string; claw_name?: string };
    if (identity.pubkey) console.log(`Public Key: ${identity.pubkey}`);
    if (identity.claw_name) console.log(`Claw Name:  ${identity.claw_name}`);
    if (!identity.pubkey) console.log("Identity not initialized.");
  }
}

async function cmdDiagnostics(args: ParsedArgs): Promise<void> {
  const { ok, data } = await fetchApi(args.api, "GET", "/diagnostics", undefined, args.timeout);
  if (!ok) {
    console.error("Failed to get diagnostics:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const diag = data as {
    local_instance: { agent_id?: string; status: string };
    lan_discovery: { mdns: string; unreachable_count: number; unreachable: Array<{ address: string; lan_host: string; reason: string }> };
    registry: { status: string };
    relay: { status: string };
    summary: { total_instances: number; lan_instances: number; relay_instances: number };
  };

  console.log("Local OpenClaw:");
  if (diag.local_instance.agent_id) {
    console.log(`  OK Detected at 127.0.0.1:18789 (agent_id: ${diag.local_instance.agent_id})`);
  } else {
    console.log("  -- No local OpenClaw instance on :18789");
  }
  console.log("");

  console.log("LAN Discovery:");
  console.log(`  mDNS: ${diag.lan_discovery.mdns}`);
  if (diag.lan_discovery.unreachable_count > 0) {
    console.log(`  !! ${diag.lan_discovery.unreachable_count} instance(s) heard via mDNS but HTTP unreachable:`);
    for (const u of diag.lan_discovery.unreachable) {
      console.log(`    - ${u.address} (${u.lan_host})`);
      console.log(`      Reason: ${u.reason}`);
    }
  } else {
    console.log("  No unreachable instances.");
  }
  console.log("");

  console.log("Registry:");
  console.log(`  ${diag.registry.status}`);
  console.log("");

  console.log("Relay:");
  console.log(`  ${diag.relay.status}`);
  console.log("");

  console.log("Summary:");
  console.log(`  Total instances: ${diag.summary.total_instances}`);
  console.log(`  LAN: ${diag.summary.lan_instances}  Relay: ${diag.summary.relay_instances}`);
}

async function cmdInteractions(args: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  params.set("all", "true");
  if (args.direction) params.set("direction", args.direction);
  const qs = `?${params.toString()}`;

  const { ok, data } = await fetchApi(args.api, "GET", `/agent/tasks${qs}`, undefined, args.timeout);
  if (!ok) {
    console.error("Failed to list interactions:", (data as { error?: string }).error ?? "Unknown error");
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const { tasks: taskList } = data as { tasks: Array<{ task_id: string; direction: string; peer_claw_id: string; state: string; task: { task_type: string }; created_at: string }> };
    let filtered = taskList;
    if (args.peer) {
      filtered = filtered.filter((t) => t.peer_claw_id === args.peer);
    }
    if (filtered.length === 0) {
      console.log("No interactions found.");
      return;
    }
    for (const t of filtered) {
      console.log(`  ${t.task_id.slice(0, 8)}  ${t.direction.padEnd(8)}  ${t.peer_claw_id}  ${t.state.padEnd(10)}  ${t.task.task_type}  ${new Date(t.created_at).toLocaleString()}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "start":
      await cmdStart(args);
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart(args);
      break;
    case "status":
      await cmdStatus(args);
      break;
    case "list":
      await cmdList(args);
      break;
    case "scan":
      await cmdScan(args);
      break;
    case "alias":
      await cmdAlias(args);
      break;
    case "info":
      await cmdInfo(args);
      break;
    case "forget":
      await cmdForget(args);
      break;
    case "connect":
      await cmdConnect(args);
      break;
    case "open":
      await cmdOpen(args);
      break;
    case "relay":
      await cmdRelay(args);
      break;
    case "register":
      await cmdRegister(args);
      break;
    case "registry":
      await cmdRegistryStatus(args);
      break;
    case "resolve":
      await cmdResolve(args);
      break;
    case "whoami":
      await cmdWhoami(args);
      break;
    case "policy":
      await cmdPolicy(args);
      break;
    case "tasks":
      await cmdTasks(args);
      break;
    case "propose":
      await cmdPropose(args);
      break;
    case "query":
      await cmdQuery(args);
      break;
    case "inbox":
      await cmdInbox(args);
      break;
    case "diagnostics":
      await cmdDiagnostics(args);
      break;
    case "interactions":
      await cmdInteractions(args);
      break;
    default:
      console.log("ClawNexus CLI v0.2.0");
      console.log("");
      console.log("Usage: clawnexus <command> [options]");
      console.log("");
      console.log("Daemon:");
      console.log("  start              Start the daemon");
      console.log("  stop               Stop the daemon");
      console.log("  restart            Restart the daemon");
      console.log("  status             Show daemon status");
      console.log("");
      console.log("Discovery:");
      console.log("  scan               Scan local network for instances");
      console.log("                     --target <host:port>  Probe specific target (repeatable)");
      console.log("                     --ports <p1,p2,...>   Additional ports to scan");
      console.log("  list               List known instances");
      console.log("                     --scope <local|vpn|public>  Filter by network scope");
      console.log("");
      console.log("Management:");
      console.log("  alias <id> <name>  Set alias for an instance");
      console.log("  info <name>        Show instance details");
      console.log("  forget <name>      Remove instance from registry");
      console.log("");
      console.log("Registry:");
      console.log("  register           Register local instance with public registry");
      console.log("  registry status    Show registry registration status");
      console.log("  resolve <name>     Resolve a .claw name via public registry");
      console.log("  whoami             Show local identity (pubkey + claw_name)");
      console.log("");
      console.log("Connection:");
      console.log("  connect <name>     Smart connect (LAN direct or relay fallback)");
      console.log("  open <name>        Open instance WebChat in browser");
      console.log("  relay status       Show relay connection status");
      console.log("  diagnostics        Show connectivity diagnostics");
      console.log("");
      console.log("Agent (Layer B):");
      console.log("  policy show        Show current policy");
      console.log("  policy set <k> <v> Update policy field");
      console.log("  policy reset       Reset policy to defaults");
      console.log("  tasks [--all]      List tasks (active by default)");
      console.log("  tasks info <id>    Show task details");
      console.log("  tasks cancel <id>  Cancel a task");
      console.log("  tasks stats        Show task statistics");
      console.log("  propose <id> <type> [desc]  Send a proposal");
      console.log("  query <id> <type>  Query a peer");
      console.log("  inbox              View pending inbox");
      console.log("  inbox approve <id> Approve an inbox item");
      console.log("  inbox deny <id>    Deny an inbox item");
      console.log("  interactions       Show interaction history");
      console.log("");
      console.log("Flags:");
      console.log("  --json             Machine-readable JSON output");
      console.log("  --timeout <ms>     Request timeout (default: 5000)");
      console.log("  --api <url>        Daemon API URL (default: http://localhost:17890)");
      console.log("  --scope <scope>    Filter by network scope (local, vpn, public)");
      console.log("  --all              Include completed tasks");
      console.log("  --direction <dir>  Filter by direction (inbound/outbound)");
      console.log("  --peer <id>        Filter by peer claw_id");
      console.log("  --input <k=v>      Input key-value for proposals");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
