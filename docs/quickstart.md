# Quick Start Guide

Get ClawNexus up and running in 5 minutes.

## 1. Install

```bash
npm install -g clawnexus
```

Requires Node.js 22 or later.

## 2. Start the Daemon

```bash
clawnexus start
```

The daemon runs in the background and listens on `http://localhost:17890`.

Check that it's running:

```bash
clawnexus status
```

## 3. Discover Instances

ClawNexus discovers OpenClaw instances via mDNS (automatic) and active network scanning.

Trigger a manual scan:

```bash
clawnexus scan
```

```
Scanning local network...
Found 2 instance(s).
NAME              ADDRESS            STATUS   SOURCE  LAST SEEN
alan-macbook      192.168.1.10:18789 online   mdns    3/3/2026, 10:30:00 AM
raspi-openclaw    192.168.1.20:18789 online   scan    3/3/2026, 10:30:01 AM
```

## 4. Assign Aliases

Give instances short, memorable names:

```bash
clawnexus alias alan-macbook home
clawnexus alias raspi-openclaw raspi
```

Now you can refer to them by alias:

```bash
clawnexus info home
```

```
Agent ID:      alan-macbook
Display Name:  Alan's MacBook
Assistant:     OpenClaw Assistant
Alias:         home
Address:       192.168.1.10:18789
Status:        online
Source:        mdns
```

## 5. Connect

Get the WebSocket URL for an instance:

```bash
clawnexus connect home
# ws://192.168.1.10:18789
```

Or open the WebChat UI directly in your browser:

```bash
clawnexus open home
```

## 6. Use the SDK (Optional)

For programmatic access, install the SDK:

```bash
npm install @clawnexus/clawlink-sdk
```

```typescript
import { ClawNexusClient } from "@clawnexus/clawlink-sdk";

const client = new ClawNexusClient();
const { instances } = await client.listInstances();

for (const inst of instances) {
  console.log(`${inst.alias ?? inst.agent_id} — ${inst.status}`);
}
```

## 7. Use as OpenClaw Skill (Optional)

Install the Skill package to query instances from within OpenClaw:

```bash
npm install clawnexus-skill
```

See the [clawnexus-skill README](../packages/skill/README.md) for action details.

## Next Steps

- [HTTP API Reference](./api.md) — full endpoint documentation
- [Architecture Overview](./architecture.md) — how the components fit together
