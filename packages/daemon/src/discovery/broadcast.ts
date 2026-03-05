// BroadcastDiscovery — UDP Broadcast (CDP) peer discovery
// Allows two ClawNexus daemons on the same subnet to find each other
// without mDNS multicast, without manual scan.
// Port: 17891 (UDP), Broadcast: 255.255.255.x per interface

import { EventEmitter } from "node:events";
import * as dgram from "node:dgram";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { RegistryStore } from "../registry/store.js";
import type { ClawInstance } from "../types.js";

const CDP_PORT = 17891;
const TCP_PROBE_TIMEOUT = 2_000;
const ANNOUNCE_INTERVAL_BASE = 60_000;
const ANNOUNCE_JITTER = 10_000;
const CONFIG_PATH = "/__openclaw/control-ui-config.json";

interface CdpDiscover {
  type: "claw_discover";
  version: 1;
}

interface CdpAnnounce {
  type: "claw_announce";
  version: 1;
  agent_id: string;
  auto_name: string;
  display_name: string;
  gateway_port: number;
  tls: boolean;
}

type CdpMessage = CdpDiscover | CdpAnnounce;

interface RemoteInfo {
  address: string;
  port: number;
}

export class BroadcastDiscovery extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: RegistryStore,
    private readonly getLocalInstance: () => ClawInstance | null,
  ) {
    super();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket("udp4");

      sock.on("error", (err) => {
        if (!this.socket) {
          // Error during bind — reject start()
          reject(err);
        } else {
          this.emit("error", err);
        }
      });

      sock.on("message", (msg, rinfo) => {
        this._onMessage(msg, rinfo);
      });

      sock.bind(CDP_PORT, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          // non-fatal — continue without broadcast send
        }
        this.socket = sock;
        this._ensureFirewallRule();
        this._sendDiscover();
        this._scheduleNextAnnounce();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      await new Promise<void>((resolve) => sock.close(() => resolve()));
    }
  }

  /** Send a claw_announce to all broadcast targets. Called by server.ts on local:discovered. */
  sendAnnounce(): void {
    const local = this.getLocalInstance();
    if (!local) return;
    const msg: CdpAnnounce = {
      type: "claw_announce",
      version: 1,
      agent_id: local.agent_id,
      auto_name: local.auto_name,
      display_name: local.display_name,
      gateway_port: local.gateway_port,
      tls: local.tls,
    };
    this._broadcast(JSON.stringify(msg));
  }

  private _ensureFirewallRule(): void {
    if (process.platform !== "win32") return;
    try {
      execSync(
        `netsh advfirewall firewall add rule name="ClawNexus CDP" dir=in action=allow protocol=UDP localport=${CDP_PORT}`,
        { stdio: "pipe" },
      );
    } catch {
      // Already exists or no admin — non-fatal, warn silently
      console.warn("[clawnexus] [CDP] Could not add firewall rule (non-fatal — may need admin)");
    }
  }

  private _isVirtualInterface(name: string): boolean {
    const n = name.toLowerCase();
    return (
      n.startsWith("wg") ||         // WireGuard (Linux): wg0, wg1
      n.startsWith("tun") ||        // TUN: tun0, OpenVPN
      n.startsWith("tap") ||        // TAP: tap0, OpenVPN bridge
      n.includes("wireguard") ||    // WireGuard (Windows): "WireGuard Tunnel"
      n.startsWith("docker") ||     // Docker: docker0
      n.startsWith("br-") ||        // Docker bridge
      n.startsWith("veth") ||       // Docker veth
      n.startsWith("virbr") ||      // KVM: virbr0
      n.startsWith("vmnet") ||      // VMware
      n.startsWith("vboxnet")       // VirtualBox
    );
  }

  private _getBroadcastTargets(): string[] {
    const targets: string[] = [];
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs || this._isVirtualInterface(name)) continue;
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          const broadcast = this._calcBroadcast(addr.address, addr.netmask);
          targets.push(broadcast);
        }
      }
    }
    return targets;
  }

  _calcBroadcast(ip: string, mask: string): string {
    const ipParts = ip.split(".").map(Number);
    const maskParts = mask.split(".").map(Number);
    return ipParts.map((b, i) => (b | (~maskParts[i]! & 0xff))).join(".");
  }

  private _isSelfIp(ip: string): boolean {
    for (const addrs of Object.values(os.networkInterfaces())) {
      if (addrs?.some((a) => a.family === "IPv4" && a.address === ip)) return true;
    }
    return false;
  }

  private _isInLocalSubnet(remoteIp: string): boolean {
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs || this._isVirtualInterface(name)) continue;
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          const ipParts = addr.address.split(".").map(Number);
          const maskParts = addr.netmask.split(".").map(Number);
          const remoteParts = remoteIp.split(".").map(Number);
          const localNet = ipParts.map((b, i) => b & maskParts[i]!);
          const remoteNet = remoteParts.map((b, i) => b & maskParts[i]!);
          if (localNet.every((b, i) => b === remoteNet[i])) return true;
        }
      }
    }
    return false;
  }

  private _sendDiscover(): void {
    const msg = JSON.stringify({ type: "claw_discover", version: 1 } satisfies CdpDiscover);
    this._broadcast(msg);
  }

  private _broadcast(payload: string): void {
    if (!this.socket) return;
    const buf = Buffer.from(payload);
    for (const target of this._getBroadcastTargets()) {
      this.socket.send(buf, CDP_PORT, target);
    }
  }

  private _sendTo(payload: string, address: string, port: number): void {
    if (!this.socket) return;
    this.socket.send(Buffer.from(payload), port, address);
  }

  private _scheduleNextAnnounce(): void {
    const delay = ANNOUNCE_INTERVAL_BASE + Math.random() * ANNOUNCE_JITTER;
    this.announceTimer = setTimeout(() => {
      this.sendAnnounce();
      this._scheduleNextAnnounce();
    }, delay);
  }

  private _onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    let data: CdpMessage;
    try {
      data = JSON.parse(msg.toString()) as CdpMessage;
    } catch {
      return; // Invalid JSON — ignore silently
    }

    if (!data || typeof data !== "object" || data.version !== 1) return;

    if (data.type === "claw_discover") {
      // Reply with our announce (unicast back to requester)
      const local = this.getLocalInstance();
      if (!local) return;
      const reply: CdpAnnounce = {
        type: "claw_announce",
        version: 1,
        agent_id: local.agent_id,
        auto_name: local.auto_name,
        display_name: local.display_name,
        gateway_port: local.gateway_port,
        tls: local.tls,
      };
      this._sendTo(JSON.stringify(reply), rinfo.address, rinfo.port);
    } else if (data.type === "claw_announce") {
      this._handleAnnounce(data, rinfo).catch(() => {/* non-fatal */});
    }
  }

  private async _handleAnnounce(data: CdpAnnounce, rinfo: RemoteInfo): Promise<void> {
    // BUG-1: ignore UDP loopback (own broadcast received back)
    if (this._isSelfIp(rinfo.address)) return;
    // Security: only accept from same subnet (excludes virtual interfaces)
    if (!this._isInLocalSubnet(rinfo.address)) return;

    // TCP probe to verify OpenClaw is actually listening
    const alive = await this._tcpProbe(rinfo.address, data.gateway_port);
    if (!alive) return;

    const now = new Date().toISOString();
    this.store.upsert({
      agent_id: data.agent_id,
      auto_name: "", // store.upsert() assigns auto_name
      assistant_name: data.display_name,
      display_name: data.display_name,
      lan_host: rinfo.address,
      address: rinfo.address,
      gateway_port: data.gateway_port,
      tls: data.tls,
      discovery_source: "broadcast",
      network_scope: "local",
      status: "online",
      last_seen: now,
      discovered_at: now,
      connectivity: {
        lan_reachable: true,
        relay_available: false,
        preferred_channel: "lan",
        last_lan_check: now,
      },
    });
  }

  private async _tcpProbe(address: string, port: number): Promise<boolean> {
    const url = `http://${address}:${port}${CONFIG_PATH}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TCP_PROBE_TIMEOUT),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
