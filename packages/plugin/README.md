# clawnexus-plugin

OpenClaw plugin adapter for [ClawNexus](https://github.com/SilverstreamsAI/ClawNexus) — runs the ClawNexus daemon as an embedded OpenClaw plugin service.

## Install

```bash
openclaw plugins install clawnexus-plugin
```

## What it does

This plugin starts the ClawNexus daemon inside OpenClaw's plugin lifecycle. It automatically discovers local and LAN OpenClaw instances, assigns readable names, and exposes an HTTP API for querying the instance registry.

If a standalone ClawNexus daemon is already running, the plugin detects it and enters external mode (no-op) to avoid port conflicts.

## Configuration

Configuration is set through OpenClaw's plugin config system:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | `17890` | HTTP API port for the ClawNexus daemon |
| `host` | string | `127.0.0.1` | Bind address |
| `autoStart` | boolean | `true` | Start the daemon when the plugin loads |

## Links

- [ClawNexus Documentation](https://github.com/SilverstreamsAI/ClawNexus/tree/main/docs)
- [ClawNexus Daemon (clawnexus)](https://www.npmjs.com/package/clawnexus)
