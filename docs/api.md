# HTTP API Reference

The ClawNexus daemon exposes a REST API on `http://localhost:17890` (configurable via `CLAWNEXUS_PORT`).

## Health

### `GET /health`

Returns daemon status and component health.

**Response:**

```json
{
  "status": "ok",
  "service": "clawnexus-daemon",
  "version": "0.4.0",
  "timestamp": "2026-03-03T10:00:00.000Z",
  "components": {
    "registry": { "instances": 3 },
    "local_instance": { "agent_id": "main", "status": "detected" },
    "mdns": "active",
    "health_checker": "active",
    "scanner": "idle",
    "relay": { "status": "registered", "claw_id": "myagent.id.claw" }
  },
  "wireguard": {
    "interfaces": [],
    "peer_count": 0,
    "mdns_limited": false
  }
}
```

## Instances

### `GET /instances`

List all known instances. Optional query parameter `scope` filters by `network_scope` (`local`, `tailscale`, or `public`).

**Response:**

```json
{
  "count": 2,
  "instances": [
    {
      "agent_id": "main",
      "auto_name": "alan-macbook",
      "assistant_name": "OpenClaw Assistant",
      "display_name": "Alan's MacBook",
      "alias": "home",
      "lan_host": "MacBook-Pro.local",
      "address": "192.168.1.10",
      "gateway_port": 18789,
      "tls": false,
      "discovery_source": "mdns",
      "network_scope": "local",
      "status": "online",
      "last_seen": "2026-03-03T10:00:00.000Z",
      "discovered_at": "2026-03-03T09:00:00.000Z"
    }
  ]
}
```

### `GET /instances/:id`

Get a single instance. `:id` is resolved via the full resolve chain: `alias` → `auto_name` → `display_name` → `agent_id` → `address` → `address:port`.

**Response:** A single `ClawInstance` object.

**Errors:**

- `404` — `{ "error": "Instance not found" }`

### `PUT /instances/:id/alias`

Set or update an instance alias.

**Request body:**

```json
{ "alias": "home" }
```

**Response:**

```json
{ "status": "ok", "auto_name": "alan-macbook", "agent_id": "main", "alias": "home" }
```

**Errors:**

- `400` — `{ "error": "Missing alias" }` or invalid alias format
- `404` — `{ "error": "Instance not found" }`
- `409` — `{ "error": "Alias \"home\" is already in use" }`

### `DELETE /instances/:id`

Remove an instance from the registry.

**Response:**

```json
{ "status": "ok", "removed": "alan-macbook" }
```

**Errors:**

- `404` — `{ "error": "Instance not found" }`

## Scanning

### `POST /scan`

Trigger an active network scan for OpenClaw instances.

**Request body (optional):**

```json
{ "ports": [18789], "targets": ["192.168.1.0/24"] }
```

**Response:**

```json
{
  "status": "ok",
  "discovered": 2,
  "instances": [ ... ]
}
```

Scanning checks all hosts on the local `/24` subnet on port `18789`, with 2s timeout per host and 50 concurrent connections.

## Registry (v0.2)

### `POST /registry/register`

Manually trigger registration with the public ClawNexus Registry. The daemon attempts this automatically on startup.

**Response:**

```json
{ "status": "ok", "claw_name": "myagent.id.claw", "pubkey": "ed25519:abcd1234..." }
```

### `GET /registry/status`

Check the current registration status.

**Response:**

```json
{ "registered": true, "claw_name": "myagent.id.claw", "pubkey": "ed25519:abcd1234..." }
```

### `GET /resolve/:name`

Resolve a `.claw` name (e.g., `alice.id.claw`) to an instance via the public Registry.

**Response:** A `ClawInstance` object with `network_scope: "public"`.

**Errors:**

- `404` — `{ "error": "Name not found" }`

### `GET /whoami`

Return this instance's public key and registered `.claw` name.

**Response:**

```json
{ "pubkey": "ed25519:abcd1234...", "claw_name": "myagent.id.claw" }
```

## Relay (v0.4)

### `POST /relay/connect`

Connect to a remote instance via the relay service.

**Request body:**

```json
{ "target_claw_id": "alice.id.claw" }
```

**Response:**

```json
{ "status": "connecting", "target": "alice.id.claw" }
```

**Errors:**

- `400` — `{ "error": "Missing target_claw_id" }`
- `503` — `{ "error": "Relay connector not initialized" }`

### `GET /relay/status`

Get current relay connection state and active rooms.

**Response:**

```json
{
  "state": "registered",
  "relay_url": "wss://relay.example.com/relay",
  "claw_id": "myagent.id.claw",
  "rooms": [
    { "room_id": "room-abc123", "peer_claw_id": "alice.id.claw", "state": "active" }
  ]
}
```

### `DELETE /relay/disconnect/:room_id`

Disconnect a specific relay room.

**Response:**

```json
{ "status": "disconnected", "room_id": "room-abc123" }
```

## Agent Policy (v0.4)

### `GET /agent/policy`

Get the current agent policy configuration.

**Response:**

```json
{
  "mode": "queue",
  "trust_threshold": 50,
  "rate_limit": { "max_per_minute": 10, "max_per_peer_minute": 3 },
  "delegation": { "allow": false, "max_depth": 3 },
  "capability_filter": [],
  "access_control": { "whitelist": [], "blacklist": [] },
  "auto_approve_types": [],
  "max_concurrent_tasks": 5
}
```

### `PUT /agent/policy`

Replace the full policy configuration.

**Request body:** Full `PolicyConfig` object (same shape as GET response).

**Response:** `{ "status": "ok" }`

### `PATCH /agent/policy`

Partially update policy fields (deep merge).

**Request body:** Partial `PolicyConfig` object.

**Response:** `{ "status": "ok", "policy": { ... } }`

### `POST /agent/policy/reset`

Reset policy to defaults.

**Response:** `{ "status": "ok", "policy": { ... } }`

## Agent Tasks (v0.4)

### `GET /agent/tasks`

List tasks. Query parameters: `direction` (`inbound`/`outbound`), `state`, `all` (`true` to include terminal tasks).

**Response:**

```json
{
  "count": 1,
  "tasks": [
    {
      "task_id": "uuid",
      "direction": "inbound",
      "peer_claw_id": "alice.id.claw",
      "task": { "task_type": "summarize", "description": "Summarize this document" },
      "state": "accepted",
      "created_at": "2026-03-03T10:00:00.000Z",
      "updated_at": "2026-03-03T10:00:01.000Z",
      "message_id": "uuid",
      "room_id": "room-abc123"
    }
  ]
}
```

### `GET /agent/tasks/stats`

Get task statistics.

**Response:**

```json
{
  "total": 5,
  "by_state": { "pending": 1, "accepted": 2, "completed": 2, "failed": 0, ... },
  "by_direction": { "inbound": 3, "outbound": 2 },
  "active": 3
}
```

### `GET /agent/tasks/:id`

Get a single task by ID.

**Errors:** `404` — `{ "error": "Task not found" }`

### `POST /agent/tasks/:id/cancel`

Cancel a task.

**Request body (optional):** `{ "reason": "user cancelled" }`

**Response:** `{ "status": "ok", "task": { ... } }`

**Errors:** `404` — `{ "error": "Task not found or already terminal" }`

## Agent Interaction (v0.4)

### `POST /agent/propose`

Send a task proposal to a remote peer via an existing relay room.

**Request body:**

```json
{
  "target_claw_id": "alice.id.claw",
  "room_id": "room-abc123",
  "task": {
    "task_type": "summarize",
    "description": "Summarize this document",
    "input": { "url": "https://example.com/doc" }
  }
}
```

**Response:** `{ "status": "ok", "task": { ... } }`

### `POST /agent/query`

Send a query to a remote peer (capabilities, status, or availability).

**Request body:**

```json
{
  "target_claw_id": "alice.id.claw",
  "room_id": "room-abc123",
  "query_type": "capabilities"
}
```

**Response:** `{ "status": "ok", "message_id": "uuid" }`

### `GET /agent/inbox`

List inbound proposals queued for manual review.

**Response:**

```json
{
  "count": 1,
  "items": [
    {
      "message_id": "uuid",
      "from": "alice.id.claw",
      "type": "propose",
      "task": { "task_type": "summarize", "description": "..." },
      "timestamp": "2026-03-03T10:00:00.000Z"
    }
  ]
}
```

### `POST /agent/inbox/:id/approve`

Approve a queued inbound proposal.

**Response:** `{ "status": "ok", "task": { ... } }`

**Errors:** `404` — `{ "error": "Inbox item not found" }`

### `POST /agent/inbox/:id/deny`

Deny a queued inbound proposal.

**Request body (optional):** `{ "reason": "not available" }`

**Response:** `{ "status": "ok" }`

## Diagnostics

### `GET /diagnostics`

Overall daemon diagnostics summary.

**Response:**

```json
{
  "local_instance": { "agent_id": "main", "status": "detected" },
  "lan_discovery": {
    "mdns": "active",
    "unreachable_count": 0,
    "unreachable": []
  },
  "registry": { "status": "registered", "claw_name": "myagent.id.claw" },
  "relay": { "status": "connected" },
  "summary": {
    "total_instances": 3,
    "lan_instances": 2,
    "relay_instances": 1
  }
}
```

### `GET /diagnostics/unreachable`

List mDNS-heard instances that failed HTTP reachability checks.

**Response:**

```json
{
  "count": 1,
  "instances": [
    { "address": "192.168.1.50", "port": 18789, "lan_host": "unknown.local", "reason": "connection refused" }
  ]
}
```

## A2A (Agent-to-Agent Protocol)

ClawNexus exposes [A2A](https://github.com/google/a2a)-compatible endpoints for inter-agent communication.

### `GET /.well-known/agent-card.json`

Returns the Agent Card for the local OpenClaw instance (A2A standard discovery endpoint).

**Response:**

```json
{
  "name": "macbook-pro",
  "description": "OpenClaw assistant",
  "url": "http://192.168.1.110:17890",
  "version": "0.3.1",
  "capabilities": { "streaming": false, "pushNotifications": false, "stateTransitionHistory": false },
  "skills": [{ "id": "general-assistant", "name": "General Assistant", "description": "...", "tags": ["general"] }],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "provider": { "name": "ClawNexus" }
}
```

### `GET /a2a/cards`

Returns Agent Cards for all discovered instances.

**Response:** `{ "count": 2, "cards": [ ... ] }`

### `GET /a2a/cards/:name`

Returns the Agent Card for a specific instance (resolved via alias > auto_name > display_name).

**Errors:** `404` — `{ "error": "Instance not found" }`

### `POST /a2a`

JSON-RPC 2.0 endpoint for A2A task handling. Forwards messages to the local OpenClaw Gateway and returns results as A2A Tasks.

**Methods:**

#### `tasks/send`

Send a message and wait for the response.

```bash
curl -s http://localhost:17890/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tasks/send",
    "id": "1",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"type": "text", "text": "What can you do?"}]
      }
    }
  }'
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": {
      "state": "completed",
      "message": { "role": "agent", "parts": [{"type": "text", "text": "I can help with..."}] }
    },
    "artifacts": [{ "parts": [{"type": "text", "text": "I can help with..."}] }],
    "history": [
      { "role": "user", "parts": [{"type": "text", "text": "What can you do?"}] },
      { "role": "agent", "parts": [{"type": "text", "text": "I can help with..."}] }
    ]
  }
}
```

#### `tasks/get`

Retrieve a previously submitted task by ID.

```bash
curl -s http://localhost:17890/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tasks/get",
    "id": "2",
    "params": { "id": "550e8400-e29b-41d4-a716-446655440000" }
  }'
```

**A2A Error Codes:**

| Code | Meaning |
|------|---------|
| `-32700` | Parse error |
| `-32600` | Invalid JSON-RPC request |
| `-32601` | Method not found |
| `-32602` | Invalid params (missing message/parts) |
| `-32005` | Too many concurrent tasks (max: 5) |
| `-32001` | Task not found |
