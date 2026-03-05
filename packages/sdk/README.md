# @clawnexus/sdk

ClawLink Protocol SDK — programmatic client for the ClawNexus daemon API.

Discover and manage OpenClaw-compatible AI instances from your Node.js applications.

## Installation

```bash
npm install @clawnexus/sdk
```

Requires Node.js >= 22 and a running `clawnexus` daemon.

## Quick Start

```typescript
import { ClawNexusClient } from "@clawnexus/sdk";

const client = new ClawNexusClient();

// List all discovered instances
const { instances } = await client.listInstances();
console.log(instances);

// Get a specific instance by name or alias
const inst = await client.getInstance("home");
console.log(`${inst.alias} @ ${inst.address}:${inst.gateway_port}`);

// Scan the network
const scan = await client.scan();
console.log(`Found ${scan.discovered} instance(s)`);

// Set an alias
await client.setAlias("my-agent-id", "office");
```

## API Reference

### Constructor

```typescript
const client = new ClawNexusClient({
  apiUrl: "http://localhost:17890",  // default
  timeout: 5000,                     // default, in ms
});
```

### Instance Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `health()` | `Record<string, unknown>` | Daemon health status |
| `listInstances()` | `{ count, instances }` | List all known instances |
| `getInstance(id)` | `ClawInstance` | Get instance by ID, alias, or address |
| `setAlias(id, alias)` | `{ status, agent_id, alias }` | Set or update instance alias |
| `removeInstance(id)` | `{ status, removed }` | Remove instance from registry |
| `scan()` | `{ status, discovered, instances }` | Trigger network scan |
| `relayConnect(clawId)` | `{ status, target }` | Connect via relay |
| `relayStatus()` | `Record<string, unknown>` | Relay connection status |
| `relayDisconnect(roomId)` | `{ status, room_id }` | Disconnect relay room |

### Error Handling

```typescript
import { ClawNexusClient, ClawNexusApiError } from "@clawnexus/sdk";

const client = new ClawNexusClient();

try {
  const inst = await client.getInstance("unknown");
} catch (err) {
  if (err instanceof ClawNexusApiError) {
    console.log(err.statusCode);  // 404
    console.log(err.message);     // "Instance not found"
  }
}
```

### Types

The SDK re-exports all core types:

```typescript
import type {
  ClawInstance,
  PolicyConfig,
  TaskRecord,
  TaskStats,
  InboxItem,
} from "@clawnexus/sdk";
```

## License

MIT
