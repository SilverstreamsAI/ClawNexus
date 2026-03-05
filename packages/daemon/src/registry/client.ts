// RegistryClient — HTTP client for ClawNexus-Cloud public registry
// Handles register, resolve, getToken, checkName with signature and retry logic

import type { IdentityKeys } from "../crypto/keys.js";
import { sign, getPublicKeyString } from "../crypto/keys.js";

const DEFAULT_REGISTRY_URL = "https://clawnexus-registry.silvonastream.com";
const DEFAULT_TIMEOUT = 10_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface RegistryRecord {
  id: number;
  name: string;
  clawId: string;
  ownerPubkey: string;
  tier: string;
  capabilities: string[];
  relayHint: string | null;
  visibility: "public" | "unlisted";
  registeredAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface RegisterResult {
  action: "registered" | "renewed";
  record: RegistryRecord;
}

export interface ResolveResult {
  record: RegistryRecord;
}

export interface TokenResult {
  token: string;
  expires_in: number;
  relay_hint: string;
}

export interface CheckNameResult {
  name: string;
  available: boolean;
}

export interface RegisterParams {
  claw_id: string;
  capabilities?: string[];
  relay_hint?: string;
  visibility?: "public" | "unlisted";
}

export class RegistryClient {
  private readonly registryUrl: string;
  private readonly timeout: number;

  constructor(
    private readonly keys: IdentityKeys,
    registryUrl?: string,
    timeout?: number,
  ) {
    this.registryUrl = registryUrl
      ?? process.env.CLAWNEXUS_REGISTRY_URL
      ?? DEFAULT_REGISTRY_URL;
    this.timeout = timeout ?? DEFAULT_TIMEOUT;
  }

  async register(params: RegisterParams): Promise<RegisterResult> {
    const payload = {
      claw_id: params.claw_id,
      ...(params.capabilities && { capabilities: params.capabilities }),
      ...(params.relay_hint && { relay_hint: params.relay_hint }),
      ...(params.visibility && { visibility: params.visibility }),
    };

    const body = {
      payload,
      pubkey: getPublicKeyString(this.keys.publicKeyHex),
      signature: sign(this.keys.privateKey, payload),
    };

    return this.requestWithRetry<RegisterResult>("POST", "/register", body);
  }

  async resolve(name: string): Promise<ResolveResult> {
    return this.request<ResolveResult>("GET", `/resolve/${encodeURIComponent(name)}`);
  }

  async getToken(clawId: string): Promise<TokenResult> {
    const payload = { claw_id: clawId };

    const body = {
      payload,
      pubkey: getPublicKeyString(this.keys.publicKeyHex),
      signature: sign(this.keys.privateKey, payload),
    };

    return this.requestWithRetry<TokenResult>("POST", "/token", body);
  }

  async checkName(alias: string): Promise<CheckNameResult> {
    return this.request<CheckNameResult>("GET", `/names/check/${encodeURIComponent(alias)}`);
  }

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.registryUrl}${urlPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new RegistryError(msg, res.status, data);
    }

    return data as T;
  }

  private async requestWithRetry<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.request<T>(method, urlPath, body);
      } catch (err) {
        lastError = err;
        // Don't retry client errors (4xx)
        if (err instanceof RegistryError && err.statusCode >= 400 && err.statusCode < 500) {
          throw err;
        }
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }
}
