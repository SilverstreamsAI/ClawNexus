# @clawnexus/mcp-server

MCP (Model Context Protocol) server for [ClawNexus](https://github.com/StratCraftsAI/ClawNexus). Lets AI agents like Claude and GPT manage OpenClaw instances through the ClawNexus daemon.

## Quick Start

Make sure the ClawNexus daemon is running (`clawnexus start`), then add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "clawnexus": {
      "command": "npx",
      "args": ["-y", "@clawnexus/mcp-server"]
    }
  }
}
```

Or run directly:

```bash
npx @clawnexus/mcp-server
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CLAWNEXUS_API_URL` | `http://localhost:17890` | Daemon HTTP API base URL |

## Tools

### Discovery & Instances

| Tool | Description |
|---|---|
| `clawnexus_list_instances` | List all known OpenClaw instances |
| `clawnexus_get_instance` | Get instance details by name/alias/address |
| `clawnexus_set_alias` | Set a human-readable alias |
| `clawnexus_remove_instance` | Remove instance from registry |
| `clawnexus_scan` | Trigger LAN scan for OpenClaw instances |

### Registry

| Tool | Description |
|---|---|
| `clawnexus_resolve` | Resolve a .claw name via public Registry |
| `clawnexus_register` | Register local instance to Registry |
| `clawnexus_whoami` | Show local identity and .claw name |

### Relay

| Tool | Description |
|---|---|
| `clawnexus_relay_connect` | Connect to remote instance via relay |
| `clawnexus_relay_status` | Show relay connection status |
| `clawnexus_relay_disconnect` | Disconnect from a relay room |

### Agent (Layer B)

| Tool | Description |
|---|---|
| `clawnexus_agent_policy` | View agent policy configuration |
| `clawnexus_agent_tasks` | List agent tasks |
| `clawnexus_agent_propose` | Send task proposal to a peer |
| `clawnexus_agent_inbox` | View pending inbound proposals |
| `clawnexus_agent_approve` | Approve an inbound proposal |

### Diagnostics

| Tool | Description |
|---|---|
| `clawnexus_health` | Daemon health check |
| `clawnexus_diagnostics` | Full diagnostic info |

## Resources

| URI | Description |
|---|---|
| `clawnexus://instances` | Live instance registry snapshot |
| `clawnexus://agent-card` | Local A2A Agent Card |

## License

MIT
