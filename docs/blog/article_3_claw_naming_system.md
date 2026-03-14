# The .claw Naming System: DNS for AI Agents

**Excerpt**: How ClawNexus solves AI agent identity with a three-tier naming system and a public .claw registry backed by Ed25519 cryptography.

**Category**: Feature | **Tags**: clawnexus, naming, identity, dns

---

## The Naming Problem

OpenClaw instances don't have names. Every instance gets the default `agent_id` of `"main"`. Run three instances on three machines and they're all called "main". You end up referring to them by IP address, which works fine when you have one box in your apartment. It falls apart the moment you have a second.

The real issue: `agent_id` was never designed to be unique. It's a local label, not an identity. ClawNexus treats it as read-only metadata, not an identifier. Instead, it builds a naming system on top.

## Three Naming Tiers

ClawNexus assigns names at three levels. Each tier adds more specificity and user control.

### Tier 1: auto_name (automatic)

When ClawNexus discovers an instance, it generates a name from the machine's hostname. A MacBook becomes `macbook-pro`. A Raspberry Pi becomes `raspi-4`. A Windows desktop becomes `desktop-allpakd`.

No user action required. The name is guaranteed unique within your local registry. If two machines have the same hostname, ClawNexus appends a suffix (`macbook-pro-2`).

This is the zero-config layer. You run `clawnexus list` and see real names immediately, not IPs.

### Tier 2: alias (user-set)

Auto-names are functional but not always memorable. Aliases let you assign short names that mean something to you:

```bash
clawnexus alias macbook-pro home
clawnexus alias raspi-4 lab
clawnexus alias desktop-allpakd office
```

Aliases are limited to 32 characters and must be unique. Setting an alias that already exists returns a `409 Conflict`. Aliases take highest priority in name resolution, so once you set one, that's the name you use everywhere.

### Tier 3: .claw name (registered)

For instances that need to be reachable across the internet, ClawNexus provides `.claw` names through a public registry.

Free tier assigns a name automatically: `macbook-pro.a1b2c3.id.claw`. The middle segment is derived from your public key, making the name globally unique without coordination.

Paid tier (planned) will allow short, memorable names like `myagent.claw` -- similar to domain registration, but for AI agent identity.

## The resolve() Chain

Every name lookup in ClawNexus -- CLI, HTTP API, SDK, Skill -- passes through the same resolution function. It checks names in this order:

```
alias -> auto_name -> display_name -> agent_id -> address
```

First match wins. This means:

```bash
clawnexus connect home          # matches alias "home"
clawnexus connect macbook-pro   # matches auto_name
clawnexus connect 192.168.1.20  # matches address (last resort)
```

The Skill layer uses the same chain. An AI agent can say "check if home is online" and the Skill resolves `home` to the correct instance without the user providing an IP or any technical identifier.

The resolution order is deliberate. Alias wins over auto_name so users can override machine-generated names. Address is last because it's what we're trying to get away from.

## Cryptographic Identity

Each ClawNexus daemon generates an Ed25519 keypair on first start. The keypair is stored at `~/.clawnexus/identity.json` and never leaves the machine.

The public key is the daemon's root identity. It's used for:

- **Registry registration**: proving you own a .claw name
- **Relay authentication**: authenticating to the relay server for cross-network communication
- **Ownership proof**: signing challenges to prove control of a name

When you register a .claw name, the registry binds it to your public key. Transferring the name requires a signed message from the current owner. The model is similar to ENS binding names to Ethereum addresses, but using Ed25519 signatures instead of a blockchain.

No wallet, no gas fees, no browser extension. Just a keypair on disk.

## The Public Registry

The ClawNexus Registry is a server-side service that maps .claw names to instance metadata.

On startup, the daemon attempts to register with the public registry. This is non-fatal -- if the registry is unreachable, everything else still works. Local discovery, naming, and the HTTP API all function without it.

When registration succeeds, the daemon gets a free `*.id.claw` name. Other daemons can then resolve that name to discover the instance across the internet, even if they're on different networks.

The registry stores more than just an address:

- Public key (identity)
- .claw name
- Last seen timestamp
- Capabilities (what the agent can do)

This is where it diverges from DNS.

## Why Not Just DNS?

DNS solves a different problem. It maps static names to static addresses. AI agents are not static. They start, stop, move between networks, and change capabilities.

DNS records don't carry metadata. You can't look up a DNS record and learn that the agent behind it supports code generation, was last online 30 seconds ago, and has a trust score of 87. A `.claw` resolution returns all of that.

DNS doesn't have cryptographic ownership built in. DNSSEC exists but it's about integrity, not identity. With `.claw`, the name owner is provably the holder of a specific Ed25519 private key.

And practically: you can't register DNS records from within a daemon automatically. `.claw` registration is a single HTTP call with a signed payload.

## What's Next

Paid `.claw` names are planned for v0.3, with a registrar API in v0.5 that allows third-party resellers. The trust layer (v0.6) will add capability verification and credit scoring to `.claw` identities, turning the naming system into a full identity and reputation layer for AI agents.

For now, every ClawNexus daemon gets a free `.claw` name on startup. Install it, run `clawnexus start`, and your agent has an identity.

```bash
npm install -g clawnexus
clawnexus start
clawnexus list
```

Three commands. No configuration files. No manual name assignment. That's the point.

---

*Built by [SilverstreamsAI](https://github.com/SilverstreamsAI). For questions or collaboration: contact@silverstream.tech*
