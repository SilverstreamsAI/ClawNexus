// Layer B — Skills Registry
// Connects to local OpenClaw Gateway, fetches installed tools via tools.catalog,
// and exposes them as AgentSkill[] for Agent Card and capability queries.

import { EventEmitter } from "node:events";
import type { AgentSkill } from "../a2a/card.js";
import type { ServiceCapability } from "./types.js";
import { connectGateway } from "./gateway.js";

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_SKILL: AgentSkill = {
  id: "general-assistant",
  name: "General Assistant",
  description: "General-purpose AI assistant",
  tags: ["general"],
};

export interface SkillsRegistryOptions {
  gatewayUrl?: string;
  refreshIntervalMs?: number;
}

export class SkillsRegistry extends EventEmitter {
  private readonly gatewayUrl: string;
  private readonly refreshIntervalMs: number;
  private skills: AgentSkill[] = [];
  private lastRefreshed: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(opts: SkillsRegistryOptions = {}) {
    super();
    this.gatewayUrl = opts.gatewayUrl ?? "ws://127.0.0.1:18789";
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  /** Start the registry — initial refresh + periodic timer */
  start(): void {
    // Initial refresh (async, non-blocking)
    this.refresh().catch((err) => {
      console.log(`[clawnexus] [Skills] Initial refresh failed (non-fatal): ${err}`);
    });

    // Periodic refresh
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        console.log(`[clawnexus] [Skills] Periodic refresh failed (non-fatal): ${err}`);
      });
    }, this.refreshIntervalMs);
  }

  /** Stop the registry */
  stop(): void {
    this.closed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Get current skills (returns DEFAULT_SKILL if none fetched) */
  getSkills(): AgentSkill[] {
    return this.skills.length > 0 ? this.skills : [DEFAULT_SKILL];
  }

  /** Get skills as ServiceCapability[] for Layer B capability responses */
  getCapabilities(): ServiceCapability[] {
    return this.getSkills().map((skill) => ({
      service_type: skill.id,
      description: skill.description,
    }));
  }

  /** Get registry status */
  getStatus(): {
    skill_count: number;
    last_refreshed: string | null;
    source: "gateway" | "default";
  } {
    return {
      skill_count: this.skills.length > 0 ? this.skills.length : 1,
      last_refreshed: this.lastRefreshed,
      source: this.skills.length > 0 ? "gateway" : "default",
    };
  }

  /** Refresh skills from the Gateway. Returns true if successful. */
  async refresh(): Promise<boolean> {
    if (this.closed) return false;

    try {
      const tools = await this.fetchToolsCatalog();
      this.skills = tools.map(toolToSkill);
      this.lastRefreshed = new Date().toISOString();
      this.emit("refreshed", this.skills);
      console.log(`[clawnexus] [Skills] Refreshed: ${this.skills.length} skill(s) from Gateway`);
      return true;
    } catch (err) {
      this.emit("refresh_error", err);
      // Keep existing skills (or default) — don't clear on failure
      return false;
    }
  }

  /** Connect to Gateway, call tools.catalog, disconnect */
  private async fetchToolsCatalog(): Promise<Array<Record<string, unknown>>> {
    const conn = await connectGateway({
      gatewayUrl: this.gatewayUrl,
      scopes: ["operator.read"],
    });

    try {
      const result = (await conn.request("tools.catalog", {})) as Record<string, unknown>;

      // v3 catalog returns { groups: [{ tools: [...] }] }
      const groups = result?.groups as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(groups)) {
        const tools: Array<Record<string, unknown>> = [];
        for (const group of groups) {
          const groupTools = group.tools as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(groupTools)) {
            tools.push(...groupTools);
          }
        }
        return tools;
      }

      // Fallback: flat array
      if (Array.isArray(result)) {
        return result as Array<Record<string, unknown>>;
      }

      return [];
    } finally {
      conn.close();
    }
  }
}

/** Convert an OpenClaw tool entry to AgentSkill */
function toolToSkill(tool: Record<string, unknown>): AgentSkill {
  const id = (tool.id as string) ?? (tool.name as string) ?? "unknown";
  const label = (tool.label as string) ?? (tool.name as string) ?? id;
  return {
    id,
    name: formatSkillName(label),
    description: (tool.description as string) ?? "",
    tags: inferTags(id),
  };
}

/** Convert snake_case/kebab-case tool name to human-readable */
function formatSkillName(name: string): string {
  return name.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Infer tags from tool name */
function inferTags(name: string): string[] {
  const lower = name.toLowerCase();
  const tags: string[] = [];

  if (lower.includes("web") || lower.includes("search") || lower.includes("browse"))
    tags.push("web");
  if (lower.includes("file") || lower.includes("read") || lower.includes("write"))
    tags.push("filesystem");
  if (lower.includes("code") || lower.includes("exec") || lower.includes("run")) tags.push("code");
  if (lower.includes("image") || lower.includes("draw") || lower.includes("vision"))
    tags.push("media");
  if (lower.includes("api") || lower.includes("http") || lower.includes("fetch"))
    tags.push("network");

  if (tags.length === 0) tags.push("general");
  return tags;
}

export { DEFAULT_SKILL };
