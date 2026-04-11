# ClawNexus

[![npm](https://img.shields.io/npm/v/clawnexus)](https://www.npmjs.com/package/clawnexus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/StratCraftsAI/ClawNexus/actions/workflows/ci.yml/badge.svg)](https://github.com/StratCraftsAI/ClawNexus/actions/workflows/ci.yml)

**Identity registry for AI agents** — discover, name, and connect OpenClaw instances across networks.

[Website](https://stratcraft.ai/clawnexus) · [npm](https://www.npmjs.com/package/clawnexus) · [Documentation](./docs/quickstart.md)

> **The original ClawNexus** — [on npm since March 1, 2026](https://www.npmjs.com/package/clawnexus)

ClawNexus is an identity registry for OpenClaw instances. It discovers AI agent instances on the network, gives each one a persistent name, and tracks capabilities, trust scores, and online status.

## What It Does

- **Discovers** OpenClaw instances automatically — zero configuration required
- **Names** each instance with a human-readable alias (e.g. `home`, `raspi`, `office`)
- **Persists** a local registry of known instances with health status
- **Exposes** an HTTP API and CLI for querying and managing instances
- **Connects** instances across the internet via encrypted relay

## Architecture

Four discovery chains feed into a unified registry — no OpenClaw configuration needed:

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
│  │         end-to-end encrypted relay (WSS)                  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        ▲                                      ▲
        │                                      │
   ┌────┴─────┐                         ┌──────┴──────┐
   │   CLI    │                         │  SDK/Skill  │
   │clawnexus │                         │  (client)   │
   └──────────┘                         └─────────────┘
```

| Chain | Mechanism | Needs OpenClaw config? | Use case |
|-------|-----------|----------------------|----------|
| **LocalProbe** | HTTP probe `127.0.0.1:18789` | No | Discovers local instance |
| **CDP** | UDP broadcast on port 17891 | No | Two daemons find each other on the same subnet |
| **mDNS** | Listens for `_openclaw-gw._tcp.local` ([RFC 6762](https://www.rfc-editor.org/rfc/rfc6762)) | Yes (`--bind lan`) | Discovers mDNS-advertising instances |
| **ActiveScanner** | HTTP scan for control-ui-config | Yes (reachable bind) | `clawnexus scan --target <ip>` |

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`clawnexus`](./packages/daemon) | [![npm](https://img.shields.io/npm/v/clawnexus)](https://www.npmjs.com/package/clawnexus) | Daemon + CLI |
| [`clawnexus-skill`](./packages/skill) | [![npm](https://img.shields.io/npm/v/clawnexus-skill)](https://www.npmjs.com/package/clawnexus-skill) | OpenClaw Skill |
| [`@clawnexus/sdk`](./packages/sdk) | [![npm](https://img.shields.io/npm/v/@clawnexus/sdk)](https://www.npmjs.com/package/@clawnexus/sdk) | ClawNexus SDK |

## Quick Start

```bash
# Install
npm install -g clawnexus

# Start the daemon
clawnexus start

# Scan for OpenClaw instances on your network
clawnexus scan

# List discovered instances
clawnexus list

# Give an instance a friendly name
clawnexus alias my-agent-id home

# Get connection details
clawnexus connect home
```

See [docs/quickstart.md](./docs/quickstart.md) for a complete walkthrough.

## Requirements

- Node.js >= 22
- OpenClaw instance(s) running on your network

## Documentation

- [Quick Start Guide](./docs/quickstart.md)
- [HTTP API Reference](./docs/api.md)
- [Architecture Overview](./docs/architecture.md)

## FAQ

**What is ClawNexus?**
An identity registry for OpenClaw instances — it discovers instances on your network, gives each one a persistent name, and tracks capabilities, trust scores, and online status.

**How does discovery work?**
Four methods run in parallel: LocalProbe checks localhost, CDP broadcasts on the subnet, [mDNS](https://www.rfc-editor.org/rfc/rfc6762) listens for advertising instances, and ActiveScanner does HTTP probes. No OpenClaw configuration needed for the first two.

**Does it work across networks?**
Yes. Instances get `.claw` domains (e.g. `home.alan.id.claw`) and communicate through an end-to-end encrypted relay using X25519 key exchange and AES-256-GCM. The relay cannot read your data.

**How is this different from Tailscale?**
Tailscale gives you network connectivity. ClawNexus gives you instance identity — who's running, what they can do, whether they're online. They're complementary: Tailscale handles the pipe, ClawNexus handles the registry.

**Does it work with Google A2A?**
ClawNexus can generate A2A Agent Cards from registry data, making your OpenClaw instances discoverable via the [Agent-to-Agent protocol](https://github.com/google/A2A).

## Comparison

| | ClawNexus | Manual Config | Tailscale | mDNS only |
|---|-----------|--------------|-----------|-----------|
| Zero-config LAN discovery | ✅ | ❌ | ❌ | ✅ |
| Cross-network | ✅ (.claw domains) | ✅ (manual) | ✅ | ❌ |
| Identity and naming | ✅ | ❌ | ❌ | ❌ |
| E2E encryption | ✅ | ❌ | ✅ | ❌ |
| Capability tracking | ✅ | ❌ | ❌ | ❌ |

## Development

```bash
# Clone and install
git clone https://github.com/StratCraftsAI/ClawNexus.git
cd ClawNexus
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Start daemon in dev mode
cd packages/daemon && pnpm dev
```

## Roadmap

| Version | Feature | Status |
|---------|---------|--------|
| v0.1 (MVP) | LAN discovery + alias naming | ✅ Done |
| v0.2 | Public registry + `*.id.claw` names | ✅ Done |
| v0.3 | Paid `.claw` alias registration + SDK | ✅ Done |
| v0.4 | Relay service for cross-network connections | ✅ Done |
| v0.5 | Registrar API (reseller layer) | Planned |
| v0.6 | Trust layer (reputation + capability verification) | Planned |
| v1.0 | Layer B — autonomous agent-to-agent interaction | Planned |

## License

MIT — [stratcraft.ai](https://stratcraft.ai)
