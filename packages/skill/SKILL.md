# ClawNexus Skill

Query and manage OpenClaw instances discovered by the ClawNexus daemon.

## Prerequisites

The `clawnexus` daemon must be running on `localhost:17890`.

```bash
clawnexus start
```

## Actions

| Action | Description | Parameters |
|--------|-------------|------------|
| `list` | List all known instances | — |
| `info` | Get instance details | `name` |
| `scan` | Scan local network | — |
| `alias` | Set instance alias | `id`, `alias` |
| `connect` | Get WebSocket URL | `name` |
| `health` | Check daemon status | — |

## Example Usage

```json
{ "action": "list" }
{ "action": "info", "params": { "name": "home" } }
{ "action": "scan" }
{ "action": "alias", "params": { "id": "my-agent", "alias": "home" } }
{ "action": "connect", "params": { "name": "home" } }
```
