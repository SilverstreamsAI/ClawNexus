import { describe, it, expect } from "vitest";
import { generateKeyPair, deriveSessionKey, encrypt, decrypt } from "../../src/relay/crypto.js";

describe("relay/crypto", () => {
  describe("generateKeyPair", () => {
    it("returns public and private key buffers", () => {
      const kp = generateKeyPair();
      expect(kp.publicKey).toBeInstanceOf(Buffer);
      expect(kp.privateKey).toBeInstanceOf(Buffer);
      expect(kp.publicKey.length).toBeGreaterThan(0);
      expect(kp.privateKey.length).toBeGreaterThan(0);
    });

    it("generates different key pairs each time", () => {
      const a = generateKeyPair();
      const b = generateKeyPair();
      expect(a.publicKey.equals(b.publicKey)).toBe(false);
    });
  });

  describe("deriveSessionKey", () => {
    it("two key pairs derive the same session key from both directions", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();

      const keyAB = deriveSessionKey(alice.privateKey, bob.publicKey);
      const keyBA = deriveSessionKey(bob.privateKey, alice.publicKey);

      expect(keyAB).toBeInstanceOf(Buffer);
      expect(keyAB.length).toBe(32);
      expect(keyAB.equals(keyBA)).toBe(true);
    });
  });

  describe("encrypt + decrypt", () => {
    it("round-trips plaintext", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const sessionKey = deriveSessionKey(alice.privateKey, bob.publicKey);

      const plaintext = "hello from ClawNexus";
      const ciphertext = encrypt(sessionKey, plaintext);
      const decrypted = decrypt(sessionKey, ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext each time (random IV)", () => {
      const kp = generateKeyPair();
      const sessionKey = deriveSessionKey(kp.privateKey, kp.publicKey);
      // Self-derive just for deterministic key

      const a = encrypt(sessionKey, "test");
      const b = encrypt(sessionKey, "test");
      expect(a).not.toBe(b);
    });

    it("decrypt with wrong key throws", () => {
      const alice = generateKeyPair();
      const bob = generateKeyPair();
      const eve = generateKeyPair();

      const sessionKey = deriveSessionKey(alice.privateKey, bob.publicKey);
      const wrongKey = deriveSessionKey(eve.privateKey, bob.publicKey);

      const ciphertext = encrypt(sessionKey, "secret");
      expect(() => decrypt(wrongKey, ciphertext)).toThrow();
    });

    it("decrypt with corrupted ciphertext throws", () => {
      const kp = generateKeyPair();
      const sessionKey = deriveSessionKey(kp.privateKey, kp.publicKey);

      const ciphertext = encrypt(sessionKey, "test");
      const corrupted = ciphertext.slice(0, -4) + "XXXX";
      expect(() => decrypt(sessionKey, corrupted)).toThrow();
    });
  });
});
