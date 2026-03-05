import * as crypto from "node:crypto";

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/**
 * Generate an X25519 key pair for ECDH key exchange.
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }),
  };
}

/**
 * Derive a shared secret using X25519 ECDH.
 * Returns a 32-byte AES-256 key derived via HKDF.
 */
export function deriveSessionKey(
  localPrivateKey: Buffer,
  remotePubKey: Buffer,
): Buffer {
  const privKey = crypto.createPrivateKey({
    key: localPrivateKey,
    format: "der",
    type: "pkcs8",
  });
  const pubKey = crypto.createPublicKey({
    key: remotePubKey,
    format: "der",
    type: "spki",
  });

  const sharedSecret = crypto.diffieHellman({
    privateKey: privKey,
    publicKey: pubKey,
  });

  // Derive AES-256 key using HKDF
  return Buffer.from(
    crypto.hkdfSync("sha256", sharedSecret, "", "clawnexus-relay-e2e", 32),
  );
}

/**
 * Encrypt a plaintext message using AES-256-GCM.
 * Returns base64-encoded string: iv (12 bytes) + authTag (16 bytes) + ciphertext.
 */
export function encrypt(sessionKey: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt a base64-encoded ciphertext using AES-256-GCM.
 * Expects format: iv (12 bytes) + authTag (16 bytes) + ciphertext.
 */
export function decrypt(sessionKey: Buffer, encoded: string): string {
  const data = Buffer.from(encoded, "base64");

  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
