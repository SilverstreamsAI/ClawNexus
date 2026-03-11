// CardFetcher — fetches remote Agent Cards from discovered instances
// Listens to store "upsert" events and populates remote_card on each instance.
// Self instances are skipped (they use local SkillsRegistry).

import { EventEmitter } from "node:events";
import type { RegistryStore } from "../registry/store.js";
import type { ClawInstance, RemoteCard } from "../types.js";
import type { AgentCard } from "./card.js";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 3000;
const STALE_MS = 5 * 60 * 1000; // 5 minutes

export interface CardFetcherOptions {
  refreshIntervalMs?: number;
  fetchTimeoutMs?: number;
  staleMs?: number;
}

export class CardFetcher extends EventEmitter {
  private readonly store: RegistryStore;
  private readonly refreshIntervalMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly staleMs: number;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingKeys = new Set<string>();
  private stopped = false;

  constructor(store: RegistryStore, opts: CardFetcherOptions = {}) {
    super();
    this.store = store;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.staleMs = opts.staleMs ?? STALE_MS;
  }

  start(): void {
    this.stopped = false;
    this.store.on("upsert", this.onUpsert);

    // Initial fetch for all existing instances
    this.refreshAll().catch((err) => {
      console.log(`[clawnexus] [CardFetcher] Initial refresh failed (non-fatal): ${err}`);
    });

    // Periodic refresh
    this.refreshTimer = setInterval(() => {
      this.refreshAll().catch((err) => {
        console.log(`[clawnexus] [CardFetcher] Periodic refresh failed (non-fatal): ${err}`);
      });
    }, this.refreshIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.store.off("upsert", this.onUpsert);
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingKeys.clear();
  }

  private onUpsert = (instance: ClawInstance): void => {
    if (this.stopped) return;
    if (this.shouldSkip(instance)) return;

    const key = this.store.networkKey(instance.address, instance.gateway_port);

    // Guard against infinite loop: if we're currently processing this key, skip
    if (this.pendingKeys.has(key)) return;

    this.pendingKeys.add(key);
    this.fetchAndApply(instance, key).finally(() => {
      this.pendingKeys.delete(key);
    });
  };

  private shouldSkip(instance: ClawInstance): boolean {
    // Skip self instances — they use local SkillsRegistry
    if (instance.is_self) return true;

    // Skip offline instances
    if (instance.status === "offline") return true;

    // Skip if remote_card is fresh enough
    if (instance.remote_card) {
      const age = Date.now() - new Date(instance.remote_card.fetched_at).getTime();
      if (age < this.staleMs) return true;
    }

    return false;
  }

  private async fetchAndApply(instance: ClawInstance, key: string): Promise<void> {
    try {
      const card = await this.fetchCard(instance);
      if (!card || this.stopped) return;

      // Re-fetch the instance from store (it may have been updated during fetch)
      const current = this.store.getByNetworkKey(instance.address, instance.gateway_port);
      if (!current) return;

      // Apply remote_card directly and re-upsert
      current.remote_card = card;
      // Use upsert so it persists (the pendingKeys guard prevents re-entry)
      this.store.upsert(current);
      this.emit("card_fetched", { key, skills_count: card.skills.length });
      console.log(
        `[clawnexus] [CardFetcher] Fetched card for ${current.auto_name}: ${card.skills.length} skill(s)`,
      );
    } catch (err) {
      this.emit("card_error", { key, error: err });
    }
  }

  async fetchCard(instance: ClawInstance): Promise<RemoteCard | null> {
    const url = this.determineCardUrl(instance);
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
        headers: { Accept: "application/json" },
      });

      if (!resp.ok) return null;

      const data = (await resp.json()) as Partial<AgentCard>;
      if (!data || !Array.isArray(data.skills)) return null;

      return {
        skills: data.skills,
        capabilities: data.capabilities,
        input_modes: data.defaultInputModes,
        output_modes: data.defaultOutputModes,
        card_url: url,
        fetched_at: new Date().toISOString(),
      };
    } catch {
      // Timeout, network error, JSON parse error — all graceful
      return null;
    }
  }

  async refreshAll(): Promise<void> {
    if (this.stopped) return;

    const instances = this.store.getAll();
    const promises: Promise<void>[] = [];

    for (const inst of instances) {
      if (this.shouldSkip(inst)) continue;

      const key = this.store.networkKey(inst.address, inst.gateway_port);
      if (this.pendingKeys.has(key)) continue;

      this.pendingKeys.add(key);
      promises.push(
        this.fetchAndApply(inst, key).finally(() => {
          this.pendingKeys.delete(key);
        }),
      );
    }

    await Promise.allSettled(promises);
  }

  determineCardUrl(instance: ClawInstance): string {
    const proto = instance.tls ? "https" : "http";
    // CDP-discovered instances have a ClawNexus daemon on port 17890
    // Other discovery sources: try the daemon port too (if they have ClawNexus)
    const port = 17890;
    return `${proto}://${instance.address}:${port}/.well-known/agent-card.json`;
  }
}
