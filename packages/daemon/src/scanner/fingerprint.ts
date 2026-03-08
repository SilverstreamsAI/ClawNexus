// Fingerprint identification — multi-signal cascade to identify OpenClaw variants
//
// Supported implementations:
//   openclaw  — Node.js, port 18789, serves /__openclaw/control-ui-config.json
//   goclaw   — Go (chi), port 18789, serves /__openclaw/control-ui-config.json (compat mode)
//   zeroclaw — Rust (Axum), port 42617, /health with "paired" field
//   picoclaw — Go (net/http), port 18790, /health + /ready (K8s-style probes)

import type { ClawImplementation, ControlUiConfig } from "../types.js";

const FINGERPRINT_TIMEOUT = 2_000;

export interface FingerprintResult {
  implementation: ClawImplementation;
  confidence: number; // 0.0–1.0
}

interface ClawIdentity {
  implementation?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Identify the implementation variant of a host.
 *
 * Probe order (highest to lowest confidence):
 *   1. /.well-known/claw-identity.json — ClawLink Protocol (self-declared)
 *   2. /__openclaw/control-ui-config.json analysis — field count heuristic
 *   3. /health endpoint — ZeroClaw vs PicoClaw differentiation
 */
export async function identifyImplementation(
  host: string,
  port: number,
  config?: ControlUiConfig | null,
): Promise<FingerprintResult> {
  // Signal 1: ClawLink identity endpoint (highest priority)
  const clawlink = await probeClawIdentity(host, port);
  if (clawlink) return clawlink;

  // Signal 2: If we got a control-ui-config, analyze it
  if (config) {
    return analyzeConfig(config);
  }

  // Signal 3: No config → check /health for non-OpenClaw variants
  const healthResult = await probeHealth(host, port);
  if (healthResult) return healthResult;

  return { implementation: "unknown", confidence: 0.1 };
}

async function probeClawIdentity(
  host: string,
  port: number,
): Promise<FingerprintResult | null> {
  try {
    const res = await fetch(
      `http://${host}:${port}/.well-known/claw-identity.json`,
      { signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT) },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as ClawIdentity;
    if (data.implementation && typeof data.implementation === "string") {
      const impl = data.implementation.toLowerCase() as ClawImplementation;
      const known: ClawImplementation[] = [
        "openclaw", "goclaw", "zeroclaw", "picoclaw", "nanoclaw", "nanobot",
      ];
      return {
        implementation: known.includes(impl) ? impl : "unknown",
        confidence: 1.0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Analyze control-ui-config.json to distinguish OpenClaw from GoClaw.
 *
 * OpenClaw's config is feature-rich (>8 fields), while GoClaw's compat mode
 * returns a minimal subset (<6 fields, missing UI-specific keys).
 */
function analyzeConfig(config: ControlUiConfig): FingerprintResult {
  const knownFields = Object.keys(config);
  const fieldCount = knownFields.length;

  // GoClaw compat mode: minimal config, typically <6 fields
  // and missing OpenClaw-specific UI fields
  const uiFields = [
    "controlUi", "assistantUrl", "webSearchEnabled",
    "customInstructions", "tools",
  ];
  const hasUiFields = uiFields.some((f) => f in config);

  if (fieldCount < 6 && !hasUiFields) {
    return { implementation: "goclaw", confidence: 0.7 };
  }

  return { implementation: "openclaw", confidence: 0.8 };
}

/**
 * Probe /health to identify ZeroClaw or PicoClaw.
 *
 * ZeroClaw: /health returns JSON with "paired" + "runtime" fields
 * PicoClaw: /health + /ready both return 200 (K8s-style)
 */
async function probeHealth(
  host: string,
  port: number,
): Promise<FingerprintResult | null> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT),
    });
    if (!res.ok) return null;

    const text = await res.text();

    // ZeroClaw: JSON with "paired" field
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      if ("paired" in data) {
        return { implementation: "zeroclaw", confidence: 0.9 };
      }
    } catch {
      // Not JSON, continue checking
    }

    // PicoClaw: /health OK + /ready also OK
    const readyRes = await fetch(`http://${host}:${port}/ready`, {
      signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT),
    });
    if (readyRes.ok) {
      return { implementation: "picoclaw", confidence: 0.8 };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Detect implementation from a 404 error response body.
 * Auxiliary signal — low confidence, used as tiebreaker.
 *
 * Go net/http: "404 page not found\n" (plain text)
 * Fastify (Node.js): JSON {"message":"Route ... not found","error":"Not Found","statusCode":404}
 */
export function detect404Format(body: string): "go" | "fastify" | "unknown" {
  if (body.trim() === "404 page not found") return "go";
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    if (data.statusCode === 404 && typeof data.error === "string") return "fastify";
  } catch {
    // Not JSON
  }
  return "unknown";
}
