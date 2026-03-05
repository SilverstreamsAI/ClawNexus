import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RegistryClient, RegistryError } from "../../src/registry/client.js";
import { loadOrCreateKeys } from "../../src/crypto/keys.js";
import type { IdentityKeys } from "../../src/crypto/keys.js";

describe("RegistryClient", () => {
  let tmpDir: string;
  let keys: IdentityKeys;
  let client: RegistryClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-client-test-"));
    keys = await loadOrCreateKeys(tmpDir);
    client = new RegistryClient(keys, "http://mock-registry:3000", 5000);

    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("register", () => {
    it("sends POST /register with signed payload", async () => {
      const record = {
        id: 1,
        name: "test-agent.id.claw",
        clawId: "test-agent",
        ownerPubkey: `ed25519:${keys.publicKeyHex}`,
        tier: "free",
        capabilities: [],
        relayHint: null,
        visibility: "public",
        registeredAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ action: "registered", record }),
      });

      const result = await client.register({ claw_id: "test-agent" });

      expect(result.action).toBe("registered");
      expect(result.record.name).toBe("test-agent.id.claw");

      // Verify fetch was called with correct URL and method
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://mock-registry:3000/register");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.payload.claw_id).toBe("test-agent");
      expect(body.pubkey).toMatch(/^ed25519:[0-9a-f]{64}$/);
      expect(body.signature).toBeTruthy();
    });

    it("retries on 5xx errors", async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: "Internal Server Error" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            action: "registered",
            record: { name: "test.id.claw" },
          }),
        });

      const result = await client.register({ claw_id: "test" });
      expect(result.action).toBe("registered");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does not retry on 4xx errors", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "Name already registered" }),
      });

      await expect(client.register({ claw_id: "taken" })).rejects.toThrow(RegistryError);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });

  describe("resolve", () => {
    it("sends GET /resolve/:name", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          record: { name: "test.id.claw", clawId: "test" },
        }),
      });

      const result = await client.resolve("test.id.claw");
      expect(result.record.name).toBe("test.id.claw");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://mock-registry:3000/resolve/test.id.claw");
    });

    it("throws RegistryError on 404", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "Name not found" }),
      });

      await expect(client.resolve("nonexistent.id.claw")).rejects.toThrow(RegistryError);
    });
  });

  describe("getToken", () => {
    it("sends POST /token with signed claw_id payload", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          token: "jwt-token-here",
          expires_in: 300,
          relay_hint: "relay-us-west.silverstream.tech",
        }),
      });

      const result = await client.getToken("test-agent");
      expect(result.token).toBe("jwt-token-here");
      expect(result.expires_in).toBe(300);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.payload.claw_id).toBe("test-agent");
    });
  });

  describe("checkName", () => {
    it("sends GET /names/check/:alias", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ name: "my-alias.id.claw", available: true }),
      });

      const result = await client.checkName("my-alias");
      expect(result.available).toBe(true);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://mock-registry:3000/names/check/my-alias");
    });
  });
});
