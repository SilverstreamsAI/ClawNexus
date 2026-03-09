// NanoClaw adapter — ProjectProbe implementation
// NanoClaw has no HTTP server, so discovery uses local filesystem probing:
// /proc scan for running processes, package.json, .env, data/ipc/ directory.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ClawInstance } from "../types.js";
import type { FrameworkAdapter, ProbeResult } from "./types.js";

const NANOCLAW_PACKAGE_NAME = "nanoclaw";

// Common paths where nanoclaw might be installed
const CANDIDATE_DIRS = [
  "nanoclaw",
  "NanoClaw",
  "projects/nanoclaw",
  "projects/NanoClaw",
];

export class NanoClawAdapter implements FrameworkAdapter {
  readonly name = "nanoclaw";
  readonly defaultPorts: number[] = [];

  // Cached project dir from last successful probe
  private _lastProjectDir: string | null = null;

  async probe(_host: string, _port: number): Promise<ProbeResult | null> {
    return null;
  }

  async probeLocal(): Promise<ProbeResult | null> {
    // 1. Try to find via running Node.js processes (/proc scan)
    let projectDir = await this._findFromProc();

    // 2. Fallback: scan common home directory paths
    if (!projectDir) {
      projectDir = await this._findFromCandidateDirs();
    }

    if (!projectDir) return null;

    this._lastProjectDir = projectDir;

    // Read package.json for version
    const pkgInfo = await this._readPackageJson(projectDir);
    if (!pkgInfo) return null; // not actually nanoclaw

    // Read .env for ASSISTANT_NAME (optional)
    const assistantName = await this._readAssistantName(projectDir);

    // Check if process is running
    const procInfo = await this._findRunningPid(projectDir);

    // Count active IPC tasks (data/ipc/*/messages/*.json)
    const activeTasks = await this._countIpcTasks(projectDir);

    // Check if store/messages.db exists (has been run before)
    const hasMessageDb = await this._fileExists(path.join(projectDir, "store", "messages.db"));

    return {
      name: NANOCLAW_PACKAGE_NAME,
      version: pkgInfo.version,
      display_name: assistantName ?? undefined,
      metadata: {
        project_dir: projectDir,
        is_running: procInfo !== null,
        pid: procInfo,
        active_tasks: activeTasks,
        has_message_db: hasMessageDb,
      },
    };
  }

  async healthCheckLocal(): Promise<boolean> {
    const projectDir = this._lastProjectDir;
    if (!projectDir) return false;

    // Check if a nanoclaw process is running with this project dir
    const pid = await this._findRunningPid(projectDir);
    if (pid !== null) return true;

    // Fallback: check store/messages.db mtime (recent activity = likely alive)
    try {
      const dbPath = path.join(projectDir, "store", "messages.db");
      const stat = await fs.promises.stat(dbPath);
      const ageMs = Date.now() - stat.mtimeMs;
      // Consider "healthy" if db was modified in last 5 minutes
      return ageMs < 5 * 60 * 1000;
    } catch {
      return false;
    }
  }

  toClawInstance(host: string, _port: number, probe: ProbeResult): Partial<ClawInstance> {
    const meta = probe.metadata as Record<string, unknown> | undefined;
    return {
      agent_id: `nanoclaw@${host}`,
      assistant_name: probe.display_name ?? "",
      display_name: probe.display_name ?? "nanoclaw",
      lan_host: host,
      address: host,
      gateway_port: 0,
      tls: false,
      discovery_source: "local",
      implementation: "nanoclaw",
      labels: meta?.project_dir ? { project_dir: meta.project_dir as string } : undefined,
    };
  }

  async healthCheck(_host: string, _port: number): Promise<boolean> {
    return false;
  }

  /** Scan /proc for Node.js processes whose cwd contains a nanoclaw package.json */
  private async _findFromProc(): Promise<string | null> {
    if (process.platform !== "linux") return null;

    try {
      const entries = await fs.promises.readdir("/proc");
      for (const entry of entries) {
        // Only numeric dirs (PIDs)
        if (!/^\d+$/.test(entry)) continue;

        try {
          const cwd = await fs.promises.readlink(`/proc/${entry}/cwd`);
          if (await this._isNanoClawDir(cwd)) {
            return cwd;
          }
        } catch {
          // Permission denied or process gone — skip
        }
      }
    } catch {
      // /proc not available
    }
    return null;
  }

  /** Check common paths under home directory */
  private async _findFromCandidateDirs(): Promise<string | null> {
    const home = os.homedir();
    for (const rel of CANDIDATE_DIRS) {
      const dir = path.join(home, rel);
      if (await this._isNanoClawDir(dir)) {
        return dir;
      }
    }
    return null;
  }

  /** Check if a directory is a nanoclaw project */
  private async _isNanoClawDir(dir: string): Promise<boolean> {
    const info = await this._readPackageJson(dir);
    return info !== null;
  }

  /** Read package.json and verify it's nanoclaw */
  private async _readPackageJson(dir: string): Promise<{ version?: string } | null> {
    try {
      const raw = await fs.promises.readFile(path.join(dir, "package.json"), "utf-8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === NANOCLAW_PACKAGE_NAME) {
        return { version: pkg.version };
      }
    } catch {
      // Not found or invalid
    }
    return null;
  }

  /** Extract ASSISTANT_NAME from .env file */
  private async _readAssistantName(dir: string): Promise<string | null> {
    try {
      const raw = await fs.promises.readFile(path.join(dir, ".env"), "utf-8");
      const match = raw.match(/^ASSISTANT_NAME=(.*)$/m);
      if (match?.[1]) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      // .env not found
    }
    return null;
  }

  /** Find a running process with cwd matching the project dir */
  private async _findRunningPid(dir: string): Promise<number | null> {
    if (process.platform !== "linux") return null;

    try {
      const entries = await fs.promises.readdir("/proc");
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cwd = await fs.promises.readlink(`/proc/${entry}/cwd`);
          if (cwd === dir) {
            return parseInt(entry, 10);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // /proc not available
    }
    return null;
  }

  /** Count JSON files in data/ipc/{channel}/messages/ as a proxy for active tasks */
  private async _countIpcTasks(dir: string): Promise<number> {
    const ipcDir = path.join(dir, "data", "ipc");
    try {
      const channels = await fs.promises.readdir(ipcDir);
      let count = 0;
      for (const ch of channels) {
        const messagesDir = path.join(ipcDir, ch, "messages");
        try {
          const files = await fs.promises.readdir(messagesDir);
          count += files.filter((f) => f.endsWith(".json")).length;
        } catch {
          // messages dir doesn't exist for this channel
        }
      }
      return count;
    } catch {
      // data/ipc doesn't exist
      return 0;
    }
  }

  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
