// AutoRegister — background service that registers the local instance with the public registry
// Waits for LocalProbe, then registers and heartbeats every 5 minutes.

import { EventEmitter } from "node:events";
import { platform } from "node:os";
import type { RegistryClient } from "./client.js";
import { RegistryError } from "./client.js";
import type { AgentCardSummary } from "./client.js";
import type { RegistryStore } from "./store.js";
import type { LocalProbe } from "../local/probe.js";
import type { IdentityKeys } from "../crypto/keys.js";
import { getPublicKeyString } from "../crypto/keys.js";

const INITIAL_DELAY_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export class AutoRegister extends EventEmitter {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private registeredClawName: string | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly client: RegistryClient,
    private readonly store: RegistryStore,
    private readonly localProbe: LocalProbe,
    private readonly keys: IdentityKeys,
    private readonly daemonVersion: string = "unknown",
    private readonly getCardSummary?: () => AgentCardSummary | null,
  ) {
    super();
  }

  get clawName(): string | null {
    return this.registeredClawName;
  }

  get publicKey(): string {
    return getPublicKeyString(this.keys.publicKeyHex);
  }

  start(): void {
    // Listen for local instance detection — retry immediately if initial attempt was skipped
    // Retry registration whenever local OpenClaw is (re-)discovered
    this.localProbe.on("local:discovered", () => {
      if (!this.registeredClawName) {
        this.tryRegister().catch(() => {});
      }
    });

    // Also attempt after a short delay in case OpenClaw was already running at daemon start
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.tryRegister().catch(() => {});
    }, INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async tryRegister(): Promise<void> {
    const agentId = this.localProbe.agentId;
    if (!agentId) {
      this.emit("skip", "No local OpenClaw instance detected");
      return;
    }

    // Build list of base names to try: agentId first, then auto_name as fallback
    const selfInstance = this.store.getAll().find((i) => i.is_self);
    const autoName = selfInstance?.auto_name;
    const bases = [agentId];
    if (autoName && autoName !== agentId) bases.push(autoName);

    // Build metadata and card summary for this heartbeat
    const uptimeHours = Math.round((Date.now() - this.startedAt) / 3_600_000 * 100) / 100;
    const metadata = {
      software_version: this.daemonVersion,
      uptime_hours: uptimeHours,
      os_platform: platform(),
      instance_count: this.store.getAll().length,
    };
    const cardSummary = this.getCardSummary?.() ?? undefined;

    // Try each base with suffixes -1, -2, ... up to MAX_SUFFIX if taken by another owner
    const MAX_SUFFIX = 10;
    let result = null;
    outer: for (const base of bases) {
      for (let i = 0; i <= MAX_SUFFIX; i++) {
        const clawId = i === 0 ? base : `${base}-${i}`;
        try {
          result = await this.client.register({
            claw_id: clawId,
            metadata,
            agent_card: cardSummary,
          });
          break outer;
        } catch (err) {
          if (err instanceof RegistryError && err.statusCode === 409 && i < MAX_SUFFIX) {
            continue; // name taken by another owner, try next suffix
          }
          if (err instanceof RegistryError && err.statusCode === 409 && i === MAX_SUFFIX) {
            break; // exhausted suffixes for this base, try next base
          }
          this.emit("error", err);
          return;
        }
      }
    }
    if (!result) {
      this.emit("error", new Error(`All candidate names exhausted (bases: ${bases.join(", ")})`));
      return;
    }

    this.registeredClawName = result.record.name;

    // Start heartbeat on first successful registration
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.tryRegister().catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
    }

    // Write claw_name back to the local instance in store (re-fetch after possible state change)
    const registeredSelf = this.store.getAll().find((i) => i.is_self && i.agent_id === agentId);
    if (registeredSelf) {
      registeredSelf.claw_name = result.record.name;
      registeredSelf.owner_pubkey = result.record.ownerPubkey;
      this.store.upsert(registeredSelf);
    }

    this.emit("registered", {
      action: result.action,
      claw_name: result.record.name,
    });
  }
}
