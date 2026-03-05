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
| `POST` | `/relay/connect` | Connect via relay (v0.4) |
| `GET` | `/relay/status` | Relay connection status |
| `DELETE` | `/relay/disconnect/:room_id` | Disconnect relay room |

See [docs/api.md](../../docs/api.md) for full request/response examples.

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `CLAWNEXUS_PORT` | Daemon API port | `17890` |
| `CLAWNEXUS_HOST` | Daemon bind address | `127.0.0.1` |
| `CLAWNEXUS_API` | CLI target API URL | `http://localhost:17890` |

Data is stored in `~/.clawnexus/`:

```
~/.clawnexus/
├── registry.json    # Instance registry
├── daemon.pid       # PID file
└── policy.json      # Agent policy (v1.0)
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
