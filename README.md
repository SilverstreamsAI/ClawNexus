# ClawNexus

[![npm](https://img.shields.io/npm/v/clawnexus)](https://www.npmjs.com/package/clawnexus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-365%20passing-brightgreen)](#)

**Identity registry for AI agents** — discover, name, and connect OpenClaw instances across networks.

ClawNexus fills the "naming layer" gap in the OpenClaw ecosystem: instance naming, multi-instance management, and instance-to-instance communication.

## What It Does

- **Discovers** OpenClaw instances on your LAN via mDNS and active scanning
- **Names** each instance with a human-readable alias (e.g. `home`, `raspi`, `office`)
- **Persists** a local registry of known instances with health status
- **Exposes** an HTTP API and CLI for querying and managing instances
- **Connects** instances across the internet via relay (v0.4+)

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  ClawNexus Daemon                 │
│                                                  │
│  ┌─────────┐  ┌──────────┐  ┌────────────────┐  │
│  │  mDNS   │  │  Active   │  │    Health      │  │
│  │Listener │  │ Scanner   │  │   Checker      │  │
│  └────┬────┘  └─────┬─────┘  └───────┬────────┘  │
│       │             │                │            │
│       ▼             ▼                ▼            │
│  ┌──────────────────────────────────────────┐    │
│  │           Registry Store                  │    │
│  │       (~/.clawnexus/registry.json)        │    │
│  └──────────────────┬───────────────────────┘    │
│                     │                             │
│  ┌──────────────────▼───────────────────────┐    │
│  │          HTTP API (:17890)                │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
       ▲                           ▲
       │                           │
  ┌────┴─────┐              ┌──────┴──────┐
  │   CLI    │              │  SDK/Skill  │
  │clawnexus │              │  (client)   │
  └──────────┘              └─────────────┘
```

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

## Development

```bash
# Clone and install
git clone https://github.com/SilverstreamsAI/ClawNexus.git
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
| v1.0 | Layer B — autonomous agent-to-agent interaction | ✅ Done |

## License

MIT
