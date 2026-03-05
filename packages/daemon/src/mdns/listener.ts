// mDNS Listener — monitors _openclaw-gw._tcp.local broadcasts
// Uses multicast-dns for service discovery (pure JS, cross-platform)
// Falls back gracefully if mDNS is unavailable on the system

import { EventEmitter } from "node:events";
import type { RegistryStore } from "../registry/store.js";
import type { ClawInstance, ControlUiConfig } from "../types.js";

const SERVICE_TYPE = "_openclaw-gw._tcp.local";
const CONFIG_PATH = "/__openclaw/control-ui-config.json";
const FETCH_TIMEOUT = 3_000;
const QUERY_INTERVAL = 30_000;

interface MdnsAnswer {
  name: string;
  type: string;
  data: string | { priority?: number; weight?: number; port?: number; target?: string } | Buffer | Array<Buffer>;
}

interface MdnsResponse {
  answers: MdnsAnswer[];
  additionals: MdnsAnswer[];
}

export interface MdnsInstance {
  query: (q: unknown) => void;
  on: (e: string, cb: (...args: unknown[]) => void) => void;
  destroy: () => void;
}

export type MdnsFactory = () => MdnsInstance;

function defaultMdnsFactory(): MdnsInstance {
  // Dynamic require — multicast-dns is optional
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mDNS = require("multicast-dns");
  return mDNS() as MdnsInstance;
}

export class MdnsListener extends EventEmitter {
  private mdns: MdnsInstance | null = null;
  private queryTimer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private readonly mdnsFactory: MdnsFactory;

  constructor(
    private readonly store: RegistryStore,
    mdnsFactory?: MdnsFactory,
  ) {
    super();
    this.mdnsFactory = mdnsFactory ?? defaultMdnsFactory;
  }

  start(): void {
    try {
      this.mdns = this.mdnsFactory();
    } catch {
      this.emit("warning", "multicast-dns not available — mDNS discovery disabled");
      return;
    }

    this.mdns.on("response", (...args: unknown[]) => {
      const response = args[0] as MdnsResponse;
      const rinfo = args[1] as { address: string } | undefined;
      this.handleResponse(response, rinfo).catch((err) =>
        this.emit("error", err),
      );
    });

    // Send initial query and repeat periodically
    this.sendQuery();
    this.queryTimer = setInterval(() => this.sendQuery(), QUERY_INTERVAL);
    this.emit("started");
  }

  stop(): void {
    if (this.queryTimer) {
      clearInterval(this.queryTimer);
      this.queryTimer = null;
    }
    if (this.mdns) {
      this.mdns.destroy();
      this.mdns = null;
    }
    this.emit("stopped");
  }

  private sendQuery(): void {
    this.mdns?.query({
      questions: [{ name: SERVICE_TYPE, type: "PTR" }],
    });
  }

  private async handleResponse(response: MdnsResponse, rinfo?: { address: string }): Promise<void> {
    const allRecords = [...(response.answers ?? []), ...(response.additionals ?? [])];

    // Look for PTR records pointing to our service type
    const ptrRecords = allRecords.filter(
      (r) => r.type === "PTR" && r.name === SERVICE_TYPE,
    );
    if (ptrRecords.length === 0) return;

    // Collect SRV and TXT records from the response
    const srvRecords = allRecords.filter((r) => r.type === "SRV");
    const txtRecords = allRecords.filter((r) => r.type === "TXT");
    const aRecords = allRecords.filter((r) => r.type === "A");

    for (const srv of srvRecords) {
      const srvData = srv.data as { port?: number; target?: string };
      const port = srvData.port ?? 18789;
      const target = srvData.target ?? "";

      // Get IP: prefer A record when it's a real LAN address.
      // OpenClaw defaults to loopback binding and advertises openclaw.local -> 127.0.0.1.
      // Fall back to rinfo.address (UDP packet source IP) so discovery works without
      // requiring any OpenClaw configuration changes (Box Rule).
      const aRecord = aRecords.find((r) => r.name === target);
      const aRecordIp = aRecord ? String(aRecord.data) : "";
      const isLoopback =
        aRecordIp === "127.0.0.1" || aRecordIp === "::1" || aRecordIp.startsWith("127.");
      const address = aRecordIp && !isLoopback ? aRecordIp : (rinfo?.address ?? "");
      if (!address) continue;

      const key = `${address}:${port}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);

      // Parse TXT records
      const txt = this.parseTxt(txtRecords);

      // Fetch agent_id from the OpenClaw instance
      const agentId = await this.fetchAgentId(address, port, txt["gatewayTls"] === "1");
      if (!agentId) {
        // Record unreachable instance for diagnostics (TICKET-021)
        this.emit("mdns:unreachable", {
          address,
          port,
          lan_host: txt["lanHost"] ?? target,
          display_name: txt["displayName"] ?? "",
          reason: "HTTP fetch failed — OpenClaw may be unreachable (firewall, AP isolation, or port not open).",
          discovered_at: new Date().toISOString(),
        });
        continue;
      }

      const now = new Date().toISOString();
      const instance: ClawInstance = {
        agent_id: agentId,
        auto_name: "", // will be assigned by store.upsert()
        assistant_name: "",
        display_name: txt["displayName"] ?? "",
        lan_host: txt["lanHost"] ?? target,
        address,
        gateway_port: parseInt(txt["gatewayPort"] ?? String(port), 10),
        tls: txt["gatewayTls"] === "1",
        tls_fingerprint: txt["gatewayTlsSha256"],
        discovery_source: "mdns",
        network_scope: "local",
        status: "online",
        last_seen: now,
        discovered_at: now,
      };

      this.store.upsert(instance);
      this.emit("discovered", instance);
    }
  }

  private parseTxt(txtRecords: MdnsAnswer[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const record of txtRecords) {
      const buffers = Array.isArray(record.data) ? record.data : [record.data];
      for (const buf of buffers) {
        const str = Buffer.isBuffer(buf) ? buf.toString("utf-8") : String(buf);
        const eq = str.indexOf("=");
        if (eq > 0) {
          result[str.substring(0, eq)] = str.substring(eq + 1);
        }
      }
    }
    return result;
  }

  private async fetchAgentId(
    address: string,
    port: number,
    tls: boolean,
  ): Promise<string | null> {
    const protocol = tls ? "https" : "http";
    const url = `${protocol}://${address}:${port}${CONFIG_PATH}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) return null;
      const config = (await res.json()) as ControlUiConfig;
      return config.assistantAgentId || null;
    } catch {
      return null;
    }
  }
}
