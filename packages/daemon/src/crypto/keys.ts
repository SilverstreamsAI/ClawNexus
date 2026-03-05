// Ed25519 identity key management for ClawNexus public registry
// Keys are stored in ~/.clawnexus/keys/ (identity.key = PKCS8 DER, identity.pub = hex text)

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const KEYS_DIR = path.join(os.homedir(), ".clawnexus", "keys");
const PRIVATE_KEY_FILE = "identity.key";
const PUBLIC_KEY_FILE = "identity.pub";

export interface IdentityKeys {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
}

/**
 * Load existing keys or generate a new Ed25519 keypair.
 * Private key is persisted as PKCS8 DER with chmod 600.
 * Public key is persisted as hex text.
 */
export async function loadOrCreateKeys(keysDir?: string): Promise<IdentityKeys> {
  const dir = keysDir ?? KEYS_DIR;
  const privPath = path.join(dir, PRIVATE_KEY_FILE);
  const pubPath = path.join(dir, PUBLIC_KEY_FILE);

  await fs.promises.mkdir(dir, { recursive: true });

  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    // Load existing
    const privDer = await fs.promises.readFile(privPath);
    const privateKey = crypto.createPrivateKey({
      key: privDer,
      format: "der",
      type: "pkcs8",
    });
    const publicKeyHex = (await fs.promises.readFile(pubPath, "utf-8")).trim();
    return { privateKey, publicKeyHex };
  }

  // Generate new keypair
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

  // Export private key as PKCS8 DER
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  await fs.promises.writeFile(privPath, privDer);
  await fs.promises.chmod(privPath, 0o600);

  // Export public key as raw 32 bytes → hex
  const pubRaw = publicKey.export({ type: "spki", format: "der" });
  // SPKI DER for Ed25519 has 12-byte prefix, raw key starts at offset 12
  const publicKeyHex = pubRaw.subarray(12).toString("hex");
  await fs.promises.writeFile(pubPath, publicKeyHex, "utf-8");

  return { privateKey, publicKeyHex };
}

/**
 * Sign a payload object with Ed25519.
 * Matches Cloud-side verification: Buffer.from(JSON.stringify(payload)) → Ed25519 verify.
 * Returns base64-encoded signature.
 */
export function sign(privateKey: crypto.KeyObject, payload: unknown): string {
  const message = Buffer.from(JSON.stringify(payload), "utf-8");
  const signature = crypto.sign(null, message, privateKey);
  return signature.toString("base64");
}

/**
 * Format public key as "ed25519:<hex>" for the registry API.
 */
export function getPublicKeyString(hex: string): string {
  return `ed25519:${hex}`;
}
