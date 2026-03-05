import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { loadOrCreateKeys, sign, getPublicKeyString } from "../../src/crypto/keys.js";

describe("crypto/keys", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawnexus-keys-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("loadOrCreateKeys", () => {
    it("generates new keys on first run", async () => {
      const keys = await loadOrCreateKeys(tmpDir);

      expect(keys.privateKey).toBeDefined();
      expect(keys.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);

      // Files should exist
      expect(fs.existsSync(path.join(tmpDir, "identity.key"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "identity.pub"))).toBe(true);
    });

    it("loads existing keys on second run", async () => {
      const keys1 = await loadOrCreateKeys(tmpDir);
      const keys2 = await loadOrCreateKeys(tmpDir);

      expect(keys2.publicKeyHex).toBe(keys1.publicKeyHex);
    });

    it("sets chmod 600 on private key", async () => {
      await loadOrCreateKeys(tmpDir);
      const stat = await fs.promises.stat(path.join(tmpDir, "identity.key"));
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe("sign", () => {
    it("produces a valid Ed25519 signature", async () => {
      const keys = await loadOrCreateKeys(tmpDir);
      const payload = { claw_id: "test-agent" };
      const signature = sign(keys.privateKey, payload);

      // Signature should be base64
      expect(Buffer.from(signature, "base64").length).toBe(64);

      // Verify with Node.js crypto (matching Cloud-side verification logic)
      const pubkeyBuffer = Buffer.from(keys.publicKeyHex, "hex");
      const message = Buffer.from(JSON.stringify(payload), "utf-8");
      const sigBuffer = Buffer.from(signature, "base64");

      const keyObject = crypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"), // Ed25519 DER prefix
          pubkeyBuffer,
        ]),
        format: "der",
        type: "spki",
      });

      const valid = crypto.verify(null, message, keyObject, sigBuffer);
      expect(valid).toBe(true);
    });

    it("different payloads produce different signatures", async () => {
      const keys = await loadOrCreateKeys(tmpDir);
      const sig1 = sign(keys.privateKey, { a: 1 });
      const sig2 = sign(keys.privateKey, { a: 2 });
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("getPublicKeyString", () => {
    it("formats as ed25519:<hex>", () => {
      const hex = "aabb".repeat(16);
      expect(getPublicKeyString(hex)).toBe(`ed25519:${hex}`);
    });
  });
});
