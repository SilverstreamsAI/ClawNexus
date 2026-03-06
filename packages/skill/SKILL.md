---
name: clawnexus
description: "Discover, name, and manage OpenClaw instances on your LAN. Scan for AI agents, check status, set aliases, resolve .claw names, and get connection URLs via the ClawNexus daemon."
version: 0.2.6
metadata: {"clawdbot": {"emoji": "🦞", "homepage": "https://github.com/SilverstreamsAI/ClawNexus", "requires": {"env": [], "bins": ["curl"]}}}
---

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
| `resolve` | Resolve a `.claw` name to an instance | `name` |

> **Note:** `id` and `name` parameters accept any identifier in the resolve chain: alias, auto\_name, display\_name, agent\_id, IP address, or `address:port`.

## Example Usage

```json
{ "action": "list" }
{ "action": "info", "params": { "name": "home" } }
{ "action": "scan" }
{ "action": "alias", "params": { "id": "olivia", "alias": "home" } }
{ "action": "connect", "params": { "name": "home" } }
{ "action": "resolve", "params": { "name": "myagent.id.claw" } }
```
