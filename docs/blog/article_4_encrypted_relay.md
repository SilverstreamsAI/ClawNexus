# End-to-End Encrypted Relay: Connecting AI Agents Across Networks

**Excerpt**: How ClawNexus connects AI agent instances across NAT boundaries using an E2E encrypted WebSocket relay with zero external crypto dependencies.

**Category**: Feature | **Tags**: clawnexus, encryption, relay, security

---

## The Problem

ClawNexus discovers local AI agent instances automatically -- LocalProbe finds the one on your machine, CDP broadcast finds others on the same subnet. No configuration needed. But the moment you want your home server's agent to talk to your cloud instance, you hit the wall every networked application eventually hits: NAT traversal, firewalls, dynamic IPs, and the general impossibility of two machines behind consumer routers establishing a direct connection.

You could punch holes in your firewall, set up port forwarding, configure a VPN. But that violates ClawNexus's core design principle: zero configuration. If the user has to touch router settings, we've already failed.

The solution is a relay server. But a relay server that can read your agent-to-agent traffic is a non-starter. So the relay needs to be a dumb pipe -- authenticated enough to prevent abuse, blind enough that it can't inspect what it's forwarding.

## The Relay Architecture

The ClawNexus Relay is a WebSocket server that acts as a rendezvous point. Here's how two daemons establish a connection:

1. Both daemons connect to the relay server over WebSocket and authenticate with a JWT issued by the ClawNexus Registry.
2. Daemon A sends a `JOIN` request naming the target `.claw` identity it wants to reach.
3. The relay notifies Daemon B of the incoming connection request.
4. Daemon B accepts, and the relay creates a "room" -- a logical channel between the two participants.
5. Both daemons perform an ECDH key exchange through the room.
6. From that point on, every message is AES-256-GCM encrypted. The relay forwards opaque blobs.

The relay handles room lifecycle, heartbeats (25-second ping interval), and automatic reconnection (3-second backoff). If the WebSocket drops, the daemon reconnects and re-registers without user intervention.

## The Cryptographic Stack

Everything here uses Node.js's built-in `crypto` module. No external cryptography libraries.

### Identity Layer: Ed25519

Each ClawNexus daemon generates a persistent Ed25519 keypair on first start. The private key is stored as PKCS8 DER in `~/.clawnexus/keys/identity.key` with `chmod 600` permissions. The public key is stored as hex in `identity.pub`.

```javascript
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
```

This keypair serves as the daemon's long-term identity. It's used for signing registration requests to the ClawNexus Registry, which verifies ownership and issues JWT tokens. The public key, formatted as `ed25519:<hex>`, is the daemon's identity on the network.

### Key Exchange: X25519 (ECDH)

When two daemons join a relay room, they need a shared secret that the relay doesn't know. They achieve this with Elliptic Curve Diffie-Hellman using X25519.

Each daemon generates an **ephemeral** X25519 keypair per relay connection -- not per room, but per connection session. When a room is established, both sides exchange their X25519 public keys (sent as plaintext through the relay -- this is safe, ECDH public keys are designed to be public). Each side then derives the shared secret:

```javascript
const sharedSecret = crypto.diffieHellman({
  privateKey: localPrivateKey,
  publicKey: remotePubKey,
});
```

The raw shared secret is then run through HKDF (SHA-256) with the info string `clawnexus-relay-e2e` to derive a 32-byte AES key:

```javascript
crypto.hkdfSync("sha256", sharedSecret, "", "clawnexus-relay-e2e", 32);
```

Because the X25519 keypairs are ephemeral (regenerated each time the connector is instantiated), you get forward secrecy. Compromising a session key doesn't help decrypt past sessions.

### Encryption: AES-256-GCM

With the derived session key, every message is encrypted using AES-256-GCM. Each message gets a fresh 12-byte random nonce:

```javascript
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey, iv);
```

The wire format is simple: `iv (12 bytes) || authTag (16 bytes) || ciphertext`, base64-encoded. GCM provides authenticated encryption, meaning any tampering with the ciphertext, IV, or auth tag causes decryption to fail. There's no silent corruption.

### The Full Flow

```
Daemon A                    Relay                    Daemon B
   |                          |                          |
   |-- JOIN room ----------->|                          |
   |                          |<--------- ACCEPT --------|
   |                          |                          |
   |-- X25519 pubkey ------->|--- X25519 pubkey ------->|
   |<-- X25519 pubkey -------|<-- X25519 pubkey ---------|
   |                          |                          |
   |  [ECDH shared secret]   |    [ECDH shared secret]  |
   |  [HKDF -> AES-256 key]  |    [HKDF -> AES-256 key] |
   |                          |                          |
   |-- AES-GCM(message) ---->|--- AES-GCM(message) ---->|
   |<-- AES-GCM(message) ----|<-- AES-GCM(message) -----|
```

## Zero External Crypto Dependencies

This is a deliberate design choice. The entire cryptographic stack uses only `node:crypto`, which is backed by OpenSSL. No libsodium. No tweetnacl. No noble-curves.

- Ed25519 keypair generation: `crypto.generateKeyPairSync('ed25519')`
- Ed25519 signing: `crypto.sign(null, message, privateKey)`
- X25519 ECDH: `crypto.diffieHellman({ privateKey, publicKey })`
- HKDF key derivation: `crypto.hkdfSync('sha256', secret, salt, info, length)`
- AES-256-GCM: `crypto.createCipheriv('aes-256-gcm', key, nonce)`

Fewer dependencies means a smaller attack surface. No supply chain risk from third-party crypto packages. No native addon compilation issues across platforms. Node.js 22+ supports all of these operations natively with good performance.

## Authentication Flow

The authentication chain works like this:

1. Daemon starts and loads (or generates) its Ed25519 identity from `~/.clawnexus/keys/`.
2. Daemon registers with the ClawNexus Registry, proving key ownership via Ed25519 signature. The Registry issues a JWT.
3. Daemon connects to the Relay over WebSocket, sending a `REGISTER` message with the JWT.
4. The Relay validates the JWT and maps the WebSocket connection to a `.claw` identity.
5. JWTs are refreshed periodically (every 55 minutes) to handle reconnection scenarios.
6. When connecting to a remote instance, the ECDH handshake establishes the encrypted channel within the authenticated room.

## What the Relay Cannot Do

The relay is deliberately limited in what it can observe or influence:

- **Cannot read messages.** All application data is AES-256-GCM encrypted with keys the relay never sees. It forwards base64 blobs.
- **Cannot forge identities.** Daemon identity is tied to Ed25519 keypairs. The relay authenticates via JWT but doesn't hold private keys.
- **Cannot replay old sessions.** X25519 keypairs are ephemeral per connection. A new connector instance means new keys, new shared secret, new session.
- **Can see metadata.** The relay knows which `.claw` identities are connected, which rooms exist, and the size of encrypted payloads. This is an inherent property of any relay architecture.

## Usage

```bash
# Connect to a remote instance via relay
clawnexus connect myagent.id.claw

# Check relay connection status
clawnexus relay status
```

The relay connection is established automatically when you target a `.claw` address that isn't reachable on the local network. No manual relay configuration required -- the daemon handles JWT acquisition, WebSocket connection, room creation, key exchange, and encryption transparently.

---

*Built by [SilverstreamsAI](https://github.com/SilverstreamsAI). For questions or collaboration: contact@silverstream.tech*
