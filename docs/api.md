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
  "version": "0.1.0",
  "timestamp": "2026-03-03T10:00:00.000Z",
  "components": {
    "registry": { "instances": 3 },
    "mdns": "active",
    "health_checker": "active",
    "scanner": "idle"
  }
}
```

## Instances

### `GET /instances`

List all known instances.

**Response:**

```json
{
  "count": 2,
  "instances": [
    {
      "agent_id": "alan-macbook",
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

Get a single instance by `agent_id`, `alias`, `address`, or `lan_host`.

**Response:** A single `ClawInstance` object (same shape as above, without the wrapper).

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
{ "status": "ok", "agent_id": "alan-macbook", "alias": "home" }
```

**Errors:**

- `400` — `{ "error": "Missing alias" }` or invalid alias format
- `404` — `{ "error": "Instance not found" }`
- `409` — `{ "error": "Alias \"home\" is already in use by agent \"other-agent\"" }`

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

**Response:**

```json
{
  "status": "ok",
  "discovered": 2,
  "instances": [ ... ]
}
```

Scanning checks all hosts on the local `/24` subnet on port `18789`, with 2s timeout per host and 50 concurrent connections.

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

### `GET /relay/status`

Get current relay connection status and active rooms.

### `DELETE /relay/disconnect/:room_id`

Disconnect a specific relay room.

**Response:**

```json
{ "status": "disconnected", "room_id": "room-abc123" }
```
