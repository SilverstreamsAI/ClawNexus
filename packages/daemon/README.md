# clawnexus

ClawNexus daemon and CLI — AI instance registry for OpenClaw.

Discovers OpenClaw instances on your local network, assigns human-readable aliases, and exposes an HTTP API for querying and managing them.

## Installation

```bash
npm install -g clawnexus
```

Requires Node.js >= 22.

## CLI Usage

### Daemon Management

```bash
clawnexus start      # Start the daemon (background process)
clawnexus stop       # Stop the daemon
clawnexus restart    # Restart the daemon
clawnexus status     # Show daemon status
```

### Instance Discovery

```bash
clawnexus scan       # Scan local network for OpenClaw instances
clawnexus list       # List all known instances
clawnexus list --json  # Machine-readable JSON output
```

### Instance Management

```bash
clawnexus alias <id|address> <name>   # Set a friendly alias
clawnexus info <name|address>         # Show instance details
clawnexus forget <name|address>       # Remove from registry
```

### Connection

```bash
clawnexus connect <name>       # Output ws:// address for an instance
clawnexus open <name>          # Open WebChat UI in browser
clawnexus relay status         # Show relay connection status
clawnexus connect <name.claw>  # Connect via relay (v0.4)
```

### Global Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--json` | Machine-readable JSON output | `false` |
| `--timeout <ms>` | Request timeout | `5000` |
| `--api <url>` | Daemon API URL | `http://localhost:17890` |

## Daemon HTTP API

The daemon listens on `http://localhost:17890` by default.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Daemon health status |
| `GET` | `/instances` | List all instances |
| `GET` | `/instances/:id` | Get a single instance |
| `PUT` | `/instances/:id/alias` | Set/update alias |
| `DELETE` | `/instances/:id` | Remove instance |
| `POST` | `/scan` | Trigger network scan |
| `POST` | `/registry/register` | Register with public Registry (v0.2) |
| `GET` | `/registry/status` | Registration status (v0.2) |
| `GET` | `/resolve/:name` | Resolve a `.claw` name (v0.2) |
| `GET` | `/whoami` | This instance's identity (v0.2) |
| `POST` | `/relay/connect` | Connect via relay (v0.4) |
| `GET` | `/relay/status` | Relay connection status (v0.4) |
| `DELETE` | `/relay/disconnect/:room_id` | Disconnect relay room (v0.4) |
| `GET` | `/agent/policy` | Get agent policy (v0.4) |
| `PUT` | `/agent/policy` | Replace agent policy (v0.4) |
| `PATCH` | `/agent/policy` | Partial policy update (v0.4) |
| `POST` | `/agent/policy/reset` | Reset policy to defaults (v0.4) |
| `GET` | `/agent/tasks` | List tasks (v0.4) |
| `GET` | `/agent/tasks/stats` | Task statistics (v0.4) |
| `GET` | `/agent/tasks/:id` | Get a single task (v0.4) |
| `POST` | `/agent/tasks/:id/cancel` | Cancel a task (v0.4) |
| `POST` | `/agent/propose` | Send task proposal to peer (v0.4) |
| `POST` | `/agent/query` | Query peer capabilities (v0.4) |
| `GET` | `/agent/inbox` | List queued inbound proposals (v0.4) |
| `POST` | `/agent/inbox/:id/approve` | Approve queued proposal (v0.4) |
| `POST` | `/agent/inbox/:id/deny` | Deny queued proposal (v0.4) |
| `GET` | `/diagnostics` | Full diagnostics summary |
| `GET` | `/diagnostics/unreachable` | mDNS-heard but unreachable instances |

See [docs/api.md](../../docs/api.md) for full request/response examples.

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `CLAWNEXUS_PORT` | Daemon API port | `17890` |
| `CLAWNEXUS_HOST` | Daemon bind address | `127.0.0.1` |
| `CLAWNEXUS_API` | CLI target API URL | `http://localhost:17890` |
| `CLAWNEXUS_RELAY_URL` | Override relay WebSocket URL | _(from Registry token)_ |

Data is stored in `~/.clawnexus/`:

```
~/.clawnexus/
├── registry.json    # Instance registry
├── daemon.pid       # PID file
├── identity.json    # Ed25519 identity keys (v0.2)
└── policy.json      # Agent policy configuration (v0.4)
```

## Programmatic Usage

```typescript
import { startDaemon } from "clawnexus";

const handle = await startDaemon({ port: 17890, host: "127.0.0.1" });

// Access components
console.log(handle.store.getAll());  // List instances
await handle.app.close();            // Graceful shutdown
```

## License

MIT
