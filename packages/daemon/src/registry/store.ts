// Registry Store — persists ClawInstance records to ~/.clawnexus/registry.json
// Map key: networkKey (address:port) — agent_id is NOT unique across instances

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ClawInstance, RegistryFile } from "../types.js";
import { generateAutoName, ensureUnique } from "./auto-name.js";

const CLAWNEXUS_DIR = path.join(os.homedir(), ".clawnexus");
const DEBOUNCE_MS = 500;
const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class RegistryStore extends EventEmitter {
  private instances = new Map<string, ClawInstance>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly configDir: string;
  private readonly registryPath: string;

  constructor(configDir?: string) {
    super();
    this.configDir = configDir ?? CLAWNEXUS_DIR;
    this.registryPath = path.join(this.configDir, "registry.json");
  }

  /** Build the network key used as Map key */
  networkKey(address: string, port: number): string {
    return `${address}:${port}`;
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.configDir, { recursive: true });

    if (fs.existsSync(this.registryPath)) {
      try {
        const raw = await fs.promises.readFile(this.registryPath, "utf-8");
        const data: RegistryFile = JSON.parse(raw);

        if (data.schema_version === "5" && Array.isArray(data.instances)) {
          // v5: current schema, load directly
          for (const inst of data.instances) {
            const key = this.networkKey(inst.address, inst.gateway_port);
            this.instances.set(key, inst);
          }
        } else if (data.schema_version === "4" && Array.isArray(data.instances)) {
          // v4 → v5 migration: no data changes, just bump version
          for (const inst of data.instances) {
            const key = this.networkKey(inst.address, inst.gateway_port);
            this.instances.set(key, inst);
          }
          this.scheduleDirtyFlush();
        } else if (data.schema_version === "3" && Array.isArray(data.instances)) {
          // v3 → v4 migration: rename "tailscale" → "vpn" in network_scope
          for (const inst of data.instances) {
            if ((inst as { network_scope: string }).network_scope === "tailscale") {
              inst.network_scope = "vpn";
            }
            const key = this.networkKey(inst.address, inst.gateway_port);
            this.instances.set(key, inst);
          }
          this.scheduleDirtyFlush();
        } else if (data.schema_version === "2" && Array.isArray(data.instances)) {
          // v2 → v3 migration: generate auto_name, re-key by networkKey
          const usedNames = new Set<string>();
          for (const inst of data.instances) {
            const autoName = generateAutoName(inst.lan_host, inst.display_name, inst.address);
            (inst as ClawInstance).auto_name = ensureUnique(autoName, usedNames);
            usedNames.add((inst as ClawInstance).auto_name);
            const key = this.networkKey(inst.address, inst.gateway_port);
            this.instances.set(key, inst as ClawInstance);
          }
          // Mark dirty so the migrated data gets persisted as v3
          this.scheduleDirtyFlush();
        }
      } catch {
        // Corrupted file — start fresh
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      await this.flushNow();
    }
  }

  getAll(): ClawInstance[] {
    return Array.from(this.instances.values());
  }

  /** Get instance by network key (address:port) */
  getByNetworkKey(address: string, port: number): ClawInstance | undefined {
    return this.instances.get(this.networkKey(address, port));
  }

  /** Find all instances with a given agent_id (may return multiple) */
  findByAgentId(agentId: string): ClawInstance[] {
    const results: ClawInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.agent_id === agentId) results.push(inst);
    }
    return results;
  }

  /**
   * Resolve by: alias > auto_name > display_name > agent_id (only if unique match) > address
   */
  resolve(query: string): ClawInstance | undefined {
    const q = query.toLowerCase();

    // 1. alias
    for (const inst of this.instances.values()) {
      if (inst.alias?.toLowerCase() === q) return inst;
    }
    // 2. auto_name
    for (const inst of this.instances.values()) {
      if (inst.auto_name.toLowerCase() === q) return inst;
    }
    // 3. display_name
    for (const inst of this.instances.values()) {
      if (inst.display_name.toLowerCase() === q) return inst;
    }
    // 4. agent_id — only if exactly one match
    const agentMatches: ClawInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.agent_id.toLowerCase() === q) agentMatches.push(inst);
    }
    if (agentMatches.length === 1) return agentMatches[0];
    // 5. address
    for (const inst of this.instances.values()) {
      if (inst.address === query) return inst;
    }
    return undefined;
  }

  /** Return all instances matching the query (for ambiguity hints in CLI) */
  resolveAll(query: string): ClawInstance[] {
    const q = query.toLowerCase();
    const results: ClawInstance[] = [];

    for (const inst of this.instances.values()) {
      if (
        inst.alias?.toLowerCase() === q ||
        inst.auto_name.toLowerCase() === q ||
        inst.display_name.toLowerCase() === q ||
        inst.agent_id.toLowerCase() === q ||
        inst.address === query
      ) {
        results.push(inst);
      }
    }
    return results;
  }

  upsert(instance: ClawInstance): void {
    const key = this.networkKey(instance.address, instance.gateway_port);
    const existing = this.instances.get(key);

    if (existing) {
      // Preserve user-set fields
      instance.alias = instance.alias ?? existing.alias;
      instance.labels = instance.labels ?? existing.labels;
      instance.discovered_at = existing.discovered_at;
      // Preserve auto_name — never regenerate once assigned
      instance.auto_name = existing.auto_name;
      // Preserve registry fields
      instance.claw_name = instance.claw_name ?? existing.claw_name;
      instance.owner_pubkey = instance.owner_pubkey ?? existing.owner_pubkey;
    } else {
      // First discovery: generate auto_name if not already set
      if (!instance.auto_name) {
        const baseName = generateAutoName(instance.lan_host, instance.display_name, instance.address);
        const usedNames = new Set<string>();
        for (const inst of this.instances.values()) {
          usedNames.add(inst.auto_name);
        }
        instance.auto_name = ensureUnique(baseName, usedNames);
      }
    }

    this.instances.set(key, instance);
    this.scheduleDirtyFlush();
    this.emit("upsert", instance);
  }

  remove(networkKey: string): boolean {
    const deleted = this.instances.delete(networkKey);
    if (deleted) {
      this.scheduleDirtyFlush();
      this.emit("remove", networkKey);
    }
    return deleted;
  }

  setAlias(networkKey: string, alias: string): void {
    if (!ALIAS_RE.test(alias)) {
      throw new AliasError(`Invalid alias "${alias}": must match ${ALIAS_RE}`);
    }

    // Check uniqueness
    for (const [key, inst] of this.instances.entries()) {
      if (inst.alias === alias && key !== networkKey) {
        throw new AliasConflictError(
          `Alias "${alias}" is already assigned to "${inst.auto_name}"`,
        );
      }
    }

    const inst = this.instances.get(networkKey);
    if (!inst) {
      throw new NotFoundError(`Instance "${networkKey}" not found`);
    }

    inst.alias = alias;
    this.scheduleDirtyFlush();
    this.emit("alias", networkKey, alias);
  }

  get size(): number {
    return this.instances.size;
  }

  private scheduleDirtyFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow().catch((err) => this.emit("error", err));
    }, DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    const data: RegistryFile = {
      schema_version: "5",
      updated_at: new Date().toISOString(),
      instances: Array.from(this.instances.values()),
    };
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.registryPath + ".tmp";
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, this.registryPath);
    this.dirty = false;
  }
}

export class AliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliasError";
  }
}

export class AliasConflictError extends AliasError {
  constructor(message: string) {
    super(message);
    this.name = "AliasConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
