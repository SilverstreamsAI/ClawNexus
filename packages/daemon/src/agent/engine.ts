// Layer B — Policy Decision Engine
// Evaluates inbound proposals against local policy config

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  PolicyConfig,
  PolicyDecision,
  LayerBEnvelope,
  ProposePayload,
  DelegatePayload,
} from "./types.js";

const CLAWNEXUS_DIR = path.join(os.homedir(), ".clawnexus");
const POLICY_PATH = path.join(CLAWNEXUS_DIR, "policy.json");

const DEFAULT_POLICY: PolicyConfig = {
  mode: "queue",
  trust_threshold: 50,
  rate_limit: {
    max_per_minute: 10,
    max_per_peer_minute: 3,
  },
  delegation: {
    allow: false,
    max_depth: 3,
  },
  capability_filter: [],
  access_control: {
    whitelist: [],
    blacklist: [],
  },
  auto_approve_types: [],
  max_concurrent_tasks: 5,
};

export class PolicyEngine {
  private config: PolicyConfig = { ...DEFAULT_POLICY };
  private readonly configDir: string;
  private readonly configPath: string;
  private rateCounters = new Map<string, { count: number; resetAt: number }>();

  constructor(configDir?: string) {
    this.configDir = configDir ?? CLAWNEXUS_DIR;
    this.configPath = path.join(this.configDir, "policy.json");
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.configDir, { recursive: true });

    if (fs.existsSync(this.configPath)) {
      try {
        const raw = await fs.promises.readFile(this.configPath, "utf-8");
        const data = JSON.parse(raw) as Partial<PolicyConfig>;
        this.config = { ...DEFAULT_POLICY, ...data };
      } catch {
        // Corrupted — use defaults
        this.config = { ...DEFAULT_POLICY };
      }
    } else {
      await this.saveConfig();
    }
  }

  evaluate(envelope: LayerBEnvelope, peerTrustScore = 0): PolicyDecision {
    const peer = envelope.from;

    // 1. Blacklist check
    if (this.config.access_control.blacklist.includes(peer)) {
      return { result: "reject", reason: "policy_denied", details: "Peer is blacklisted" };
    }

    // 2. Rate limit check
    if (this.isRateLimited(peer)) {
      return { result: "reject", reason: "rate_limited", details: "Rate limit exceeded" };
    }
    this.incrementRate(peer);

    // 3. Whitelist check — whitelisted peers bypass trust/capability checks
    const isWhitelisted = this.config.access_control.whitelist.includes(peer);

    // 4. Trust score check (skip for whitelisted)
    if (!isWhitelisted && peerTrustScore < this.config.trust_threshold) {
      return { result: "reject", reason: "trust_insufficient", details: `Score ${peerTrustScore} < threshold ${this.config.trust_threshold}` };
    }

    // 5. Delegation depth check
    if (envelope.type === "delegate") {
      const dp = envelope.payload as DelegatePayload;
      if (!this.config.delegation.allow) {
        return { result: "reject", reason: "policy_denied", details: "Delegation not allowed" };
      }
      if ((dp.task?.delegation_depth ?? 0) > this.config.delegation.max_depth) {
        return { result: "reject", reason: "policy_denied", details: "Delegation depth exceeded" };
      }
    }

    // 6. Capability filter (if non-empty, task_type must match)
    if (envelope.type === "propose" || envelope.type === "delegate") {
      const task = envelope.type === "propose"
        ? (envelope.payload as ProposePayload).task
        : (envelope.payload as DelegatePayload).task;
      if (this.config.capability_filter.length > 0) {
        const matches = this.config.capability_filter.some(
          (pattern) => task.task_type === pattern || matchGlob(pattern, task.task_type),
        );
        if (!matches) {
          return { result: "reject", reason: "capability_mismatch", details: `task_type "${task.task_type}" not in capability filter` };
        }
      }
    }

    // 7. Approval mode
    switch (this.config.mode) {
      case "auto":
        return { result: "accept", reason: "auto_approved" };

      case "queue":
        return { result: "queue", reason: "queued_for_review" };

      case "hybrid": {
        if (isWhitelisted) {
          return { result: "accept", reason: "auto_approved", details: "Whitelisted peer" };
        }
        // Check auto_approve_types
        if (envelope.type === "propose") {
          const taskType = (envelope.payload as ProposePayload).task.task_type;
          if (this.config.auto_approve_types.includes(taskType)) {
            return { result: "accept", reason: "auto_approved", details: `task_type "${taskType}" auto-approved` };
          }
        }
        return { result: "queue", reason: "queued_for_review" };
      }

      default:
        return { result: "queue", reason: "queued_for_review" };
    }
  }

  getConfig(): PolicyConfig {
    return { ...this.config };
  }

  async updateConfig(full: PolicyConfig): Promise<void> {
    this.config = { ...full };
    await this.saveConfig();
  }

  async patchConfig(partial: Partial<PolicyConfig>): Promise<void> {
    this.config = deepMerge(this.config, partial);
    await this.saveConfig();
  }

  async resetConfig(): Promise<void> {
    this.config = { ...DEFAULT_POLICY };
    await this.saveConfig();
  }

  private isRateLimited(peer: string): boolean {
    const now = Date.now();

    // Global rate
    const global = this.rateCounters.get("__global__");
    if (global && global.resetAt > now && global.count >= this.config.rate_limit.max_per_minute) {
      return true;
    }

    // Per-peer rate
    const peerRate = this.rateCounters.get(peer);
    if (peerRate && peerRate.resetAt > now && peerRate.count >= this.config.rate_limit.max_per_peer_minute) {
      return true;
    }

    return false;
  }

  private incrementRate(peer: string): void {
    const now = Date.now();
    const windowEnd = now + 60_000;

    for (const key of ["__global__", peer]) {
      const existing = this.rateCounters.get(key);
      if (!existing || existing.resetAt <= now) {
        this.rateCounters.set(key, { count: 1, resetAt: windowEnd });
      } else {
        existing.count++;
      }
    }
  }

  private async saveConfig(): Promise<void> {
    const json = JSON.stringify(this.config, null, 2);
    const tmpPath = this.configPath + ".tmp";
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, this.configPath);
  }
}

function matchGlob(pattern: string, value: string): boolean {
  // Simple glob: only supports trailing *
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

function deepMerge(target: PolicyConfig, source: Partial<PolicyConfig>): PolicyConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = { ...target };
  const src = source as Record<string, unknown>;
  const tgt = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const sv = src[key];
    const tv = tgt[key];
    if (
      sv !== null &&
      sv !== undefined &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv !== null &&
      tv !== undefined &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = { ...tv as object, ...sv as object };
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result as PolicyConfig;
}
