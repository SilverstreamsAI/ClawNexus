# Introducing ClawNexus: Identity Registry for AI Agents

**Excerpt**: ClawNexus discovers, names, and connects AI agent instances across your network — zero configuration required.

**Category**: Open Source | **Tags**: clawnexus, ai-agents, typescript, open-source

---

## The problem with running multiple AI agents

If you run OpenClaw on your laptop, your Raspberry Pi, and a cloud server, you have three independent instances that know nothing about each other. There's no discovery, no naming, no registry. You end up copy-pasting WebSocket URLs and IP addresses between machines.

OpenClaw has no built-in concept of instance identity. Every instance starts with `agent_id: "main"`. There's no multi-instance management. No way for two instances on the same LAN to even know the other exists.

ClawNexus fills that gap.

## What ClawNexus does

ClawNexus is an identity registry for AI agent instances. It runs as a daemon on each machine, discovers local and remote OpenClaw instances, assigns human-readable names, and exposes an API for querying and connecting to them.

```bash
npm install -g clawnexus
clawnexus start
clawnexus list
```

That's it. No config files. No flags. The daemon starts, discovers your local OpenClaw instance, gives it a name based on your hostname (e.g. `macbook-pro`), and makes it queryable.

Run the same on a second machine. The two daemons find each other via UDP broadcast. Now `clawnexus list` shows both instances with names, not IPs.

## Four discovery chains

ClawNexus uses four independent discovery mechanisms. Each covers a different scenario, and they all feed into the same local registry.

| Chain | Mechanism | When it's used |
|-------|-----------|---------------|
| **LocalProbe** | HTTP probe to `127.0.0.1:18789` | Detects the OpenClaw instance on the same machine. Zero config — OpenClaw's default loopback binding works. |
| **CDP** | UDP broadcast on port 17891 | Two ClawNexus daemons on the same subnet find each other automatically. Inspired by StarCraft's IPX discovery. |
| **mDNS** | Listens for `_openclaw-gw._tcp.local` | Picks up OpenClaw instances that advertise via mDNS (requires `--bind lan`). |
| **ActiveScanner** | HTTP scan for `control-ui-config.json` | Manual or subnet-wide scan. `clawnexus scan --target 192.168.1.0/24`. |

The key design principle: **OpenClaw doesn't need any configuration changes.** It keeps its default loopback binding. ClawNexus does all the discovery work.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ClawNexus Daemon                         │
│                                                                 │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ LocalProbe │ │    CDP     │ │  mDNS    │ │   Active     │  │
│  │ 127.0.0.1  │ │ UDP :17891 │ │ Listener │ │  Scanner     │  │
│  │  :18789    │ │ broadcast  │ │          │ │  HTTP probe  │  │
│  └─────┬──────┘ └─────┬──────┘ └────┬─────┘ └──────┬───────┘  │
│        │              │             │               │           │
│        ▼              ▼             ▼               ▼           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Registry Store                         │   │
│  │              (~/.clawnexus/registry.json)                 │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐   │
│  │                  HTTP API (:17890)                        │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐   │
│  │              Relay Connector (WSS)                        │   │
│  │          cross-network encrypted tunnels                  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        ▲                                      ▲
        │                                      │
   ┌────┴─────┐                         ┌──────┴──────┐
   │   CLI    │                         │  SDK/Skill  │
   │clawnexus │                         │  (client)   │
   └──────────┘                         └─────────────┘
```

The daemon is the core. It runs discovery, maintains the registry, and exposes a Fastify HTTP API on port 17890. The CLI and SDK are thin clients that talk to that API.

The project ships as a pnpm monorepo with three packages:

- **`clawnexus`** — daemon + CLI (the main package, `npm install -g`)
- **`clawnexus-skill`** — OpenClaw Skill for natural-language agent interaction
- **`@clawnexus/clawlink-sdk`** — programmatic client SDK

## Three layers of naming

Instance identity in ClawNexus has three tiers:

1. **`auto_name`** — Generated automatically from the machine's hostname. You get this for free the moment an instance is discovered. Example: `macbook-pro`, `raspi-4`.

2. **`alias`** — User-assigned, short name. Set it with `clawnexus alias macbook-pro home`. Must be unique across your registry.

3. **`.claw` name** — Registered with the public ClawNexus Registry. Globally unique, like a domain name. Format: `myagent.id.claw`. Backed by Ed25519 key ownership.

When you reference an instance by name — in the CLI, the API, or the Skill — `resolve()` walks the chain: `alias > auto_name > display_name > agent_id > address`. You always use names, not IPs.

## Encrypted relay for cross-network connections

LAN discovery covers the common case. But what about connecting to an instance on a different network?

ClawNexus includes an encrypted relay. The key exchange uses ECDH with X25519, and all relay traffic is encrypted with AES-256-GCM. Identity is tied to Ed25519 keypairs, generated and stored locally in `~/.clawnexus/`.

The crypto stack uses Node.js built-in `crypto` module exclusively. Zero external crypto dependencies.

```bash
# Connect to a remote instance via relay
clawnexus connect myagent.id.claw
```

## Agent-to-agent interaction

Beyond discovery and naming, ClawNexus v1.0 ships with Layer B — autonomous agent-to-agent interaction.

Three components handle this:

- **PolicyEngine** — Controls what agents are allowed to do autonomously. Three modes: `auto` (agents act freely), `queue` (human approval required), `hybrid` (auto for trusted agents, queue for unknown).
- **TaskManager** — Tracks task lifecycle. Agents can propose, accept, delegate, and complete tasks.
- **AgentRouter** — Routes messages between agents, handles capability matching.

This isn't hypothetical. The full pipeline is implemented and tested. An agent on your laptop can delegate a task to an agent on your server, with policy controls governing what's allowed.

## Current state

| Metric | Value |
|--------|-------|
| Version | 0.4.0 |
| Tests | 655 passing |
| Language | TypeScript, strict mode |
| Runtime | Node.js >= 22 |
| License | MIT |
| Published | npm, since March 2026 |

The test suite covers discovery, naming, registry, relay encryption, agent interaction, and CLI. 42 test files, 655 assertions.

## Quick start

```bash
# Install globally
npm install -g clawnexus

# Start the daemon
clawnexus start

# See discovered instances
clawnexus list

# Give an instance a friendly name
clawnexus alias macbook-pro home

# Get connection details
clawnexus connect home

# Open the WebChat UI in your browser
clawnexus open home
```

The daemon runs in the background. It discovers instances continuously — new OpenClaw instances that come online will appear in `clawnexus list` without restarting anything.

## What's next

The roadmap includes a public registry for `.claw` name registration, a trust and reputation layer for agent capability verification, and A2A protocol bridging for interoperability with Google's Agent-to-Agent spec.

But the core use case works today: install it, start it, and your AI agents have names.

## Links

- **GitHub**: [github.com/SilverstreamsAI/ClawNexus](https://github.com/SilverstreamsAI/ClawNexus)
- **npm**: [npmjs.com/package/clawnexus](https://www.npmjs.com/package/clawnexus)

---

*Built by [SilverstreamsAI](https://github.com/SilverstreamsAI). For questions or collaboration: contact@silverstream.tech*
