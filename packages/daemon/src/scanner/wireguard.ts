// WireGuard detection — detect WireGuard interfaces and extract peer IPs
// Strategy: wg CLI → sysfs → name heuristic → empty (graceful degradation)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

export interface WireGuardInterface {
  name: string;       // e.g. "wg0-client-Olivia"
  address: string;    // e.g. "10.66.66.5"
  subnet: string;     // e.g. "10.66.66"
}

export interface WireGuardInfo {
  interfaces: WireGuardInterface[];
  peerIPs: string[];  // /32 peer IPs extracted from `wg show dump`
}

const EMPTY_INFO: WireGuardInfo = { interfaces: [], peerIPs: [] };

/**
 * Detect WireGuard interfaces and extract peer IPs.
 * Falls back gracefully at each step — never throws.
 */
export async function detectWireGuard(): Promise<WireGuardInfo> {
  const interfaces = await detectWireGuardInterfaces();
  if (interfaces.length === 0) return EMPTY_INFO;

  const peerIPs = await extractPeerIPs(interfaces);
  return { interfaces, peerIPs };
}

/**
 * Detect WireGuard interfaces using layered strategy:
 * 1. `wg show interfaces` (most accurate, needs root)
 * 2. Linux sysfs: /sys/class/net/<iface>/type == 65534
 * 3. Name heuristic: interface name contains "wg"
 */
async function detectWireGuardInterfaces(): Promise<WireGuardInterface[]> {
  const osIfaces = os.networkInterfaces();

  // Strategy 1: wg CLI
  const wgNames = await getWgCliInterfaces();
  if (wgNames.length > 0) {
    return matchInterfacesToOS(wgNames, osIfaces);
  }

  // Strategy 2: Linux sysfs
  if (process.platform === "linux") {
    const sysfsNames = getSysfsWireGuardInterfaces(osIfaces);
    if (sysfsNames.length > 0) {
      return matchInterfacesToOS(sysfsNames, osIfaces);
    }
  }

  // Strategy 3: Name heuristic (cross-platform)
  const heuristicNames = getHeuristicWireGuardInterfaces(osIfaces);
  if (heuristicNames.length > 0) {
    return matchInterfacesToOS(heuristicNames, osIfaces);
  }

  return [];
}

/** Strategy 1: Parse `wg show interfaces` output */
async function getWgCliInterfaces(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("wg", ["show", "interfaces"], {
      timeout: 3000,
    });
    const names = stdout.trim().split(/\s+/).filter(Boolean);
    return names;
  } catch {
    return [];
  }
}

/** Strategy 2: Check /sys/class/net/<iface>/type for WireGuard type 65534 */
function getSysfsWireGuardInterfaces(
  osIfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  const names: string[] = [];
  for (const name of Object.keys(osIfaces)) {
    try {
      const typePath = `/sys/class/net/${name}/type`;
      const typeVal = fs.readFileSync(typePath, "utf-8").trim();
      if (typeVal === "65534") {
        names.push(name);
      }
    } catch {
      // Not readable or doesn't exist
    }
  }
  return names;
}

/** Strategy 3: Interface name contains "wg" */
function getHeuristicWireGuardInterfaces(
  osIfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  const names: string[] = [];
  for (const name of Object.keys(osIfaces)) {
    if (name.toLowerCase().includes("wg")) {
      names.push(name);
    }
  }
  return names;
}

/** Match detected WireGuard interface names to OS network info */
function matchInterfacesToOS(
  wgNames: string[],
  osIfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): WireGuardInterface[] {
  const result: WireGuardInterface[] = [];

  for (const name of wgNames) {
    const addrs = osIfaces[name];
    if (!addrs) continue;

    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        const parts = addr.address.split(".");
        result.push({
          name,
          address: addr.address,
          subnet: parts.slice(0, 3).join("."),
        });
      }
    }
  }

  return result;
}

/**
 * Extract peer IPs from `wg show <iface> dump`.
 * Only includes /32 addresses (precise peer targets).
 * Larger subnets are skipped (logged at debug level by caller).
 */
async function extractPeerIPs(
  interfaces: WireGuardInterface[],
): Promise<string[]> {
  const peerIPs: string[] = [];

  for (const iface of interfaces) {
    try {
      const { stdout } = await execFileAsync(
        "wg",
        ["show", iface.name, "dump"],
        { timeout: 3000 },
      );

      // dump format: one line per peer, tab-separated
      // Fields: public-key, preshared-key, endpoint, allowed-ips, latest-handshake, transfer-rx, transfer-tx, persistent-keepalive
      const lines = stdout.trim().split("\n");
      // Skip first line (interface line)
      for (let i = 1; i < lines.length; i++) {
        const fields = lines[i].split("\t");
        const allowedIPs = fields[3]; // comma-separated CIDR list
        if (!allowedIPs) continue;

        for (const cidr of allowedIPs.split(",")) {
          const trimmed = cidr.trim();
          if (trimmed.endsWith("/32")) {
            const ip = trimmed.slice(0, -3);
            // Only include IPv4
            if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
              peerIPs.push(ip);
            }
          }
          // /24 or larger → skip (too many targets, defeats the purpose)
        }
      }
    } catch {
      // No permission or wg not available — return empty for this iface
    }
  }

  return [...new Set(peerIPs)];
}
