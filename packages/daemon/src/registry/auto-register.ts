// AutoRegister — background service that registers the local instance with the public registry
// Waits for LocalProbe, then registers and heartbeats every 5 minutes.

import { EventEmitter } from "node:events";
import type { RegistryClient } from "./client.js";
import { RegistryError } from "./client.js";
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

  constructor(
    private readonly client: RegistryClient,
    private readonly store: RegistryStore,
    private readonly localProbe: LocalProbe,
    private readonly keys: IdentityKeys,
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

    // Try agentId, then agentId-2, agentId-3, ... if name already taken by another owner
    const MAX_SUFFIX = 10;
    let result = null;
    for (let i = 0; i <= MAX_SUFFIX; i++) {
      const clawId = i === 0 ? agentId : `${agentId}-${i}`;
      try {
        result = await this.client.register({ claw_id: clawId });
        break;
      } catch (err) {
        if (err instanceof RegistryError && err.statusCode === 409 && i < MAX_SUFFIX) {
          continue; // name taken by another owner, try next suffix
        }
        this.emit("error", err);
        return;
      }
    }
    if (!result) return;

    this.registeredClawName = result.record.name;

    // Start heartbeat on first successful registration
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.tryRegister().catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
    }

    // Write claw_name back to the local instance in store
    const instances = this.store.getAll();
    const selfInstance = instances.find((i) => i.is_self && i.agent_id === agentId);
    if (selfInstance) {
      selfInstance.claw_name = result.record.name;
      selfInstance.owner_pubkey = result.record.ownerPubkey;
      this.store.upsert(selfInstance);
    }

    this.emit("registered", {
      action: result.action,
      claw_name: result.record.name,
    });
  }
}
