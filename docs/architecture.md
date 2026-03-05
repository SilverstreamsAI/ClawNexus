# Architecture Overview

ClawNexus is organized as a monorepo with three packages that work together to discover, name, and manage OpenClaw AI instances.

## Component Diagram

```
                    ┌─────────────────────┐
                    │    OpenClaw          │
                    │  Instances (LAN)     │
                    │  :18789              │
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │   mDNS     │  │   Active   │  │  Manual    │
     │  Listener  │  │  Scanner   │  │  Entry     │
     └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
           │               │               │
           └───────────────┼───────────────┘
                           ▼
                  ┌─────────────────┐
                  │  Registry Store │
                  │  (in-memory +   │
                  │   JSON file)    │
                  └────────┬────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
     ┌──────────────┐ ┌─────────┐ ┌──────────┐
     │  HTTP API    │ │ Health  │ │  Relay   │
     │  (fastify    │ │ Checker │ │ Connector│
     │   :17890)    │ │         │ │  (v0.4)  │
     └──────┬───────┘ └─────────┘ └──────────┘
            │
     ┌──────┼──────────────┐
     │      │              │
     ▼      ▼              ▼
  ┌─────┐ ┌──────────┐ ┌──────────────┐
  │ CLI │ │   SDK    │ │ OpenClaw     │
  │     │ │ (client) │ │ Skill        │
  └─────┘ └──────────┘ └──────────────┘
```

## Packages

### `clawnexus` (daemon + CLI)

The core package. Runs as a background daemon that:

1. **mDNS Listener** — Listens for `_openclaw-gw._tcp.local` mDNS service announcements using `@homebridge/ciao`. When an OpenClaw instance broadcasts its presence, the listener extracts identity and network information from TXT records and registers it in the store.

2. **Active Scanner** — Scans the local `/24` subnet on port `18789`. For each host that responds, fetches `/__openclaw/control-ui-config.json` to extract `assistantAgentId`, `assistantName`, and other metadata.

3. **Registry Store** — In-memory store backed by `~/.clawnexus/registry.json`. Supports CRUD operations, alias management (with conflict detection), and instance resolution by multiple identifiers.

4. **Health Checker** — Periodically pings known instances (every 30s) to update their `status` field (`online` / `offline`).

5. **HTTP API** — Fastify server on `:17890` exposing REST endpoints for instance management, scanning, and relay operations.

6. **CLI** — Command-line interface (`clawnexus` binary) that communicates with the daemon via HTTP. The CLI itself does not run any discovery logic — it delegates to the daemon.

### `@clawnexus/sdk` (SDK)

A typed HTTP client wrapping the daemon API. Provides `ClawNexusClient` with methods for all API operations and re-exports core TypeScript types (`ClawInstance`, `PolicyConfig`, etc.).

### `clawnexus-skill` (OpenClaw Skill)

An OpenClaw Skill that queries the daemon API. Exposes `handleSkillRequest()` with actions: `list`, `info`, `scan`, `alias`, `connect`, `health`.

## Data Flow

1. Discovery sources (mDNS / Scanner / Manual) add or update instances in the **Registry Store**
2. The **Health Checker** periodically verifies each instance is still reachable
3. The **HTTP API** serves the registry to CLI, SDK, and Skill consumers
4. **CLI** provides human-friendly commands; **SDK** provides programmatic access; **Skill** enables in-OpenClaw queries

## Key Files

```
packages/daemon/src/
├── index.ts              # Package entry point (re-exports)
├── types.ts              # ClawInstance type definition
├── mdns/listener.ts      # mDNS discovery
├── scanner/active.ts     # Active network scanner
├── registry/store.ts     # Registry store (in-memory + JSON)
├── health/checker.ts     # Periodic health checks
├── api/server.ts         # Fastify HTTP API + route registration
├── relay/connector.ts    # Relay client (v0.4)
├── agent/engine.ts       # Policy engine (v1.0)
├── agent/tasks.ts        # Task manager (v1.0)
├── agent/router.ts       # Agent message router (v1.0)
└── cli/index.ts          # CLI entry point

packages/sdk/src/
├── index.ts              # Re-exports
├── client.ts             # ClawNexusClient class
└── types.ts              # Shared type definitions

packages/skill/src/
├── index.ts              # handleSkillRequest()
└── SKILL.md              # Skill documentation
```

## Ports

| Service | Port | Protocol |
|---------|------|----------|
| ClawNexus daemon API | 17890 | HTTP |
| OpenClaw Gateway | 18789 | WebSocket |
| Relay service (v0.4) | 18800 | WebSocket |
