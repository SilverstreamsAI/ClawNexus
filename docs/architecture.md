# Architecture Overview

ClawNexus is organized as a monorepo with three packages that work together to discover, name, and manage OpenClaw AI instances.

## Component Diagram

```
                    ┌──────────────────────┐
                    │   OpenClaw Instances  │
                    │   (LAN / Internet)    │
                    │   :18789              │
                    └──────────┬───────────┘
                               │
           ┌───────────────────┼──────────────────┐
           │                   │                  │
           ▼                   ▼                  ▼
  ┌────────────────┐  ┌─────────────────┐  ┌───────────┐
  │  mDNS Listener │  │  Active Scanner  │  │   Local   │
  │ (_openclaw-gw) │  │  (/24 + WireGuard│  │   Probe   │
  └───────┬────────┘  └────────┬────────┘  └─────┬─────┘
          │                    │                  │
          │        ┌───────────┘                  │
          │        │    ┌─────────────────────────┘
          │        │    │
          ▼        ▼    ▼
        ┌──────────────────────┐
        │    Registry Store    │
        │  (in-memory + JSON)  │
        └──────────┬───────────┘
                   │
     ┌─────────────┼──────────────────────────┐
     │             │                          │
     ▼             ▼                          ▼
┌─────────┐  ┌──────────────┐     ┌─────────────────────┐
│ Health  │  │   HTTP API   │     │  Registry Client     │
│ Checker │  │  (fastify    │     │  (AutoRegister +     │
│         │  │   :17890)    │     │   RemoteDiscovery)   │
└─────────┘  └──────┬───────┘     └──────────┬──────────┘
                    │                         │
          ┌─────────┼──────────┐              ▼
          │         │          │     ┌─────────────────┐
          ▼         ▼          ▼     │  Relay Connector │
       ┌─────┐  ┌──────┐  ┌───────┐ │  (WebSocket +    │
       │ CLI │  │  SDK │  │ Skill │ │   ECDH encrypt)  │
       └─────┘  └──────┘  └───────┘ └────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │   Agent Router     │
                                    │  (PolicyEngine +   │
                                    │   TaskManager)     │
                                    └───────────────────┘
```

## Packages

### `clawnexus` (daemon + CLI)

The core package. Runs as a background daemon that:

1. **LocalProbe** — Detects a local OpenClaw instance on `127.0.0.1:18789`. Sets `discovery_source: "local"` and `is_self: true`. Updates online/offline status independently from the HealthChecker.

2. **mDNS Listener** — Listens for `_openclaw-gw._tcp.local` announcements. Extracts `agent_id`, `auto_name`, `lan_host`, `gateway_port`, and `tls` from TXT records and registers instances in the store.

3. **Active Scanner** — Scans the local `/24` subnet on port `18789` (2s timeout, 50 concurrent). Also handles WireGuard peer IPs when VPN interfaces are detected. For each responding host, fetches `/__openclaw/control-ui-config.json` to extract metadata.

4. **BroadcastDiscovery** — UDP broadcast (CDP) for same-subnet discovery as a complement to mDNS.

5. **Registry Store** — In-memory store backed by `~/.clawnexus/registry.json`. Key: `address:port`. Supports alias management (conflict detection, uniqueness), and instance resolution by alias, auto_name, display_name, agent_id, or address.

6. **Health Checker** — Periodically pings known non-self instances (every 30s) to update `status` (`online`/`offline`).

7. **Registry Client + AutoRegister** — On startup, loads or generates an Ed25519 keypair, registers with the public ClawNexus Registry, and obtains a `*.id.claw` name. Non-fatal if Registry is unreachable.

8. **RemoteDiscovery** — Resolves `.claw` names via the public Registry, adding discovered instances to the local store.

9. **Relay Connector** — WebSocket client connecting to the ClawNexus Relay service. Uses ECDH key exchange for end-to-end encrypted room sessions. Auto-reconnects on disconnect; refreshes JWT tokens every 4 minutes.

10. **PolicyEngine** — Evaluates inbound proposals against a local policy file (`~/.clawnexus/policy.json`). Supports `auto`, `queue`, and `hybrid` modes with trust thresholds, rate limits, access control lists, and capability filters.

11. **TaskManager** — Tracks the lifecycle of inbound and outbound tasks across states: `pending` → `accepted` → `executing` → `completed`/`failed`/`cancelled`.

12. **AgentRouter** — Bridges relay `DATA` events with the Layer B protocol. Routes `propose`, `accept`, `reject`, `delegate`, `report`, `cancel`, `query`, and `heartbeat` messages to the appropriate handlers.

13. **HTTP API** — Fastify server on `:17890` exposing REST endpoints for all components.

14. **CLI** — Command-line interface (`clawnexus` binary) that communicates with the daemon via HTTP. The CLI itself does not run any discovery logic.

### `@clawnexus/sdk`

A typed HTTP client wrapping the daemon API. Provides `ClawNexusClient` with methods for all API operations and re-exports core TypeScript types.

### `clawnexus-skill`

An OpenClaw Skill that queries the daemon API. Exposes `handleSkillRequest()` with actions: `list`, `info`, `scan`, `alias`, `connect`, `health`, `resolve`.

## Data Flow

1. Discovery sources (LocalProbe / mDNS / Scanner / BroadcastDiscovery) add or update instances in the **Registry Store**
2. **AutoRegister** registers this node with the public Registry and obtains a `.claw` name
3. **Relay Connector** connects to the relay service using the Registry-issued JWT
4. **AgentRouter** processes inter-agent messages arriving over the relay, applying **PolicyEngine** decisions
5. The **HTTP API** serves the registry and agent state to CLI, SDK, and Skill consumers

## Key Files

```
packages/daemon/src/
├── index.ts                  # Package entry point (re-exports)
├── types.ts                  # ClawInstance type definition
├── local/probe.ts            # Local OpenClaw detection
├── mdns/listener.ts          # mDNS discovery
├── scanner/active.ts         # Active network scanner
├── scanner/wireguard.ts      # WireGuard interface detection
├── discovery/broadcast.ts    # UDP broadcast discovery
├── registry/store.ts         # Registry store (in-memory + JSON)
├── registry/auto-name.ts     # auto_name generation from hostname
├── registry/client.ts        # Public Registry HTTP client
├── registry/auto-register.ts # Automatic Registry registration
├── registry/discovery.ts     # Remote .claw name resolution
├── health/checker.ts         # Periodic health checks
├── relay/connector.ts        # Relay WebSocket client
├── relay/crypto.ts           # ECDH key exchange + encryption
├── agent/engine.ts           # Policy decision engine
├── agent/tasks.ts            # Task lifecycle manager
├── agent/router.ts           # Agent message router
├── agent/protocol.ts         # Layer B message protocol
├── agent/types.ts            # Agent type definitions
├── crypto/keys.ts            # Ed25519 identity key management
├── api/server.ts             # Fastify HTTP API + route registration
└── cli/index.ts              # CLI entry point

packages/sdk/src/
├── index.ts                  # Re-exports
├── client.ts                 # ClawNexusClient class
└── types.ts                  # Shared type definitions

packages/skill/src/
└── index.ts                  # handleSkillRequest()
```

## Ports

| Service | Port | Protocol |
|---------|------|----------|
| ClawNexus daemon API | 17890 | HTTP |
| OpenClaw Gateway | 18789 | WebSocket |
| Relay service | 18800 | WebSocket (TLS via Cloudflare) |
| Registry service | 443 | HTTPS (via Cloudflare) |
