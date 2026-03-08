// Adapter registry — central place to register framework adapters

import type { FrameworkAdapter } from "./types.js";
import { NanoClawAdapter } from "./nanoclaw.js";
import { NanoBotAdapter } from "./nanobot.js";

export const ADAPTERS: readonly FrameworkAdapter[] = [
  new NanoClawAdapter(),
  new NanoBotAdapter(),
];

export function getAdapter(name: string): FrameworkAdapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}

export function getAllAdapterPorts(): number[] {
  const ports = new Set<number>();
  for (const adapter of ADAPTERS) {
    for (const port of adapter.defaultPorts) {
      ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}
