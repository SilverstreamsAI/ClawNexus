// RemoteDiscovery — resolves .claw names via the public registry
// Returns ClawInstance records with discovery_source: "registry"

import type { RegistryClient, ResolveResult } from "./client.js";
import type { RegistryStore } from "./store.js";
import type { ClawInstance } from "../types.js";

export class RemoteDiscovery {
  constructor(
    private readonly client: RegistryClient,
    private readonly store: RegistryStore,
  ) {}

  /**
   * Resolve a .claw name via the public registry.
   * Creates a ClawInstance with discovery_source: "registry" and writes it to the store.
   * Remote instances have no direct LAN IP — connectivity.preferred_channel = "relay".
   */
  async resolve(name: string): Promise<ClawInstance | null> {
    let result: ResolveResult;
    try {
      result = await this.client.resolve(name);
    } catch {
      return null;
    }

    const record = result.record;
    const now = new Date().toISOString();

    const instance: ClawInstance = {
      agent_id: record.clawId,
      auto_name: record.clawId,
      assistant_name: "",
      display_name: record.clawId,
      lan_host: "",
      address: "",
      gateway_port: 0,
      tls: false,
      discovery_source: "registry",
      network_scope: "public",
      status: "unknown",
      last_seen: now,
      discovered_at: now,
      claw_name: record.name,
      owner_pubkey: record.ownerPubkey,
      connectivity: {
        lan_reachable: false,
        relay_available: true,
        preferred_channel: "relay",
        last_lan_check: now,
      },
    };

    // Remote instances use claw_name as key since they have no address:port
    // Store with a synthetic key to avoid collisions
    this.store.upsert(instance);

    return instance;
  }
}
