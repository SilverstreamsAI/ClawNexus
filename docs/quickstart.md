# Quick Start Guide

Get ClawNexus up and running in 5 minutes.

## Prerequisites

- Node.js 22 or later
- OpenClaw running on at least one machine (no special configuration needed — default settings work out of the box)

## 1. Install

```bash
npm install -g clawnexus
```

## 2. Start the Daemon

```bash
clawnexus start
```

Verify it's running:

```bash
clawnexus status
```

```
Daemon running. PID: 12345. API: http://localhost:17890
```

If OpenClaw is running on the same machine, ClawNexus detects it automatically — no scan needed.

## 3. Discover Instances

ClawNexus discovers OpenClaw instances via mDNS automatically. To also scan the local network:

```bash
clawnexus scan
```

Then list all known instances:

```bash
clawnexus list
```

```
NAME              ADDRESS              STATUS   SOURCE  LAST SEEN
olivia            192.168.1.10:18789   online   local   3/3/2026, 10:30:00 AM
alan-macbook      192.168.1.20:18789   online   mdns    3/3/2026, 10:30:01 AM
raspi-openclaw    192.168.1.30:18789   online   scan    3/3/2026, 10:30:02 AM
```

The `NAME` column shows the `auto_name` assigned by ClawNexus based on each machine's hostname. You can use these names directly without setting an alias.

## 4. Assign Aliases (Optional)

Give an instance a shorter, custom name:

```bash
clawnexus alias alan-macbook home
clawnexus alias raspi-openclaw raspi
```

Now you can use the alias anywhere:

```bash
clawnexus info home
```

```
Auto Name:     alan-macbook
Display Name:  Alan's MacBook
Assistant:     OpenClaw Assistant
Alias:         home
Address:       192.168.1.20:18789
Status:        online
Source:        mdns
```

## 5. Connect

Get the WebSocket URL for an instance:

```bash
clawnexus connect home
# ws://192.168.1.20:18789
```

Or open the WebChat UI directly in your browser:

```bash
clawnexus open home
```

## 6. Use the SDK (Optional)

For programmatic access, install the SDK:

```bash
npm install @clawnexus/sdk
```

```typescript
import { ClawNexusClient } from "@clawnexus/sdk";

const client = new ClawNexusClient();
const { instances } = await client.listInstances();

for (const inst of instances) {
  console.log(`${inst.alias ?? inst.auto_name} — ${inst.status}`);
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
