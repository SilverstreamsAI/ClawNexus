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
console.log(`${inst.alias ?? inst.auto_name} @ ${inst.address}:${inst.gateway_port}`);

// Scan the network
const scan = await client.scan();
console.log(`Found ${scan.discovered} instance(s)`);

// Set an alias
await client.setAlias("olivia", "home");
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
| `listInstances(opts?)` | `{ count, instances }` | List instances, optional `scope` filter |
| `getInstance(id)` | `ClawInstance` | Get instance by alias, auto_name, address, or address:port |
| `setAlias(id, alias)` | `{ status, auto_name, agent_id, alias }` | Set or update instance alias |
| `removeInstance(id)` | `{ status, removed }` | Remove instance from registry |
| `scan()` | `{ status, discovered, instances }` | Trigger network scan |

### Registry Methods (v0.2)

| Method | Returns | Description |
|--------|---------|-------------|
| `register()` | `{ status, claw_name, pubkey }` | Register with public Registry |
| `registryStatus()` | `RegistryStatus` | Current registration status |
| `resolve(name)` | `ClawInstance` | Resolve a `.claw` name via public Registry |
| `whoami()` | `WhoamiResponse` | This instance's public key and `.claw` name |

### Relay Methods (v0.4)

| Method | Returns | Description |
|--------|---------|-------------|
| `relayConnect(clawId)` | `{ status, target }` | Initiate relay connection to a peer |
| `relayStatus()` | `Record<string, unknown>` | Current relay state and active rooms |
| `relayDisconnect(roomId)` | `{ status, room_id }` | Disconnect a relay room |

### Agent Policy Methods (v0.4)

| Method | Returns | Description |
|--------|---------|-------------|
| `getPolicy()` | `PolicyConfig` | Get current policy configuration |
| `updatePolicy(policy)` | `{ status }` | Replace full policy configuration |
| `patchPolicy(partial)` | `{ status, policy }` | Partial update (deep merge) |
| `resetPolicy()` | `{ status, policy }` | Reset to defaults |

### Agent Task Methods (v0.4)

| Method | Returns | Description |
|--------|---------|-------------|
| `listTasks(opts?)` | `{ count, tasks }` | List tasks, filter by `direction`, `state`, or `all` |
| `getTask(taskId)` | `TaskRecord` | Get a single task by ID |
| `cancelTask(taskId, reason?)` | `{ status, task }` | Cancel an active task |
| `getTaskStats()` | `TaskStats` | Aggregate task statistics |
| `propose(targetClawId, roomId, task)` | `{ status, task }` | Send a task proposal to a peer |
| `query(targetClawId, roomId, queryType)` | `{ status, message_id }` | Query peer capabilities/status |
| `getInbox()` | `{ count, items }` | List inbound proposals pending review |
| `approveInbox(messageId)` | `{ status, task }` | Approve a queued proposal |
| `denyInbox(messageId, reason?)` | `{ status }` | Deny a queued proposal |

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
  TaskSpec,
  TaskStats,
  TaskState,
  TaskDirection,
  InboxItem,
  RegistryStatus,
  WhoamiResponse,
} from "@clawnexus/sdk";
```

## License

MIT
