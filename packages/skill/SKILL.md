---
name: clawnexus
description: "Discover, name, and manage OpenClaw instances on your LAN. Scan for AI agents, check status, set aliases, resolve .claw names, and get connection URLs via the ClawNexus daemon."
version: 0.2.7
metadata: {"clawdbot": {"emoji": "🦞", "homepage": "https://github.com/SilverstreamsAI/ClawNexus", "requires": {"env": [], "bins": ["curl"]}}}
---

# ClawNexus Skill

**Identity registry for your OpenClaw instances — discover, name, and connect them automatically.**

Running multiple OpenClaw instances? They all report as `"main"` on `127.0.0.1:18789` — no names, no way to tell them apart, no way to talk to each other. ClawNexus fixes this.

Install the daemon, and it **automatically discovers** every OpenClaw instance on your network and gives each one a human-readable name (derived from hostname). No configuration needed on OpenClaw's side — it keeps its default loopback binding.

With this Skill installed, your AI agent can:

- **"List my instances"** — see all discovered OpenClaw instances with names and status
- **"Is raspi online?"** — check any instance by name
- **"Connect to home"** — get the WebSocket URL to reach another instance
- **"Scan the network"** — trigger LAN discovery on demand
- **"Set alias office for desktop-allpakd"** — assign friendly names

Works across networks too — instances can register `.claw` names (like `home.alan.id.claw`) and connect via encrypted relay from anywhere.

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
