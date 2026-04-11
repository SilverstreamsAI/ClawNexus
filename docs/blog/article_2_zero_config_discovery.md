# Zero-Config Discovery: How ClawNexus Finds AI Agents on Your Network

**Excerpt**: A technical deep-dive into the four discovery chains ClawNexus uses to find OpenClaw instances on your network — without touching a single config file.

**Category**: Feature | **Tags**: clawnexus, networking, zero-config, discovery

---

You run OpenClaw on your laptop. You run another instance on a Raspberry Pi in the closet. Maybe a third on a home server. Each one starts the same way:

```bash
openclaw gateway --allow-unconfigured
```

They bind to `localhost:18789`. They don't know about each other. You're stuck tracking IPs, remembering ports, and mentally mapping which machine runs what.

ClawNexus fixes this. It discovers every OpenClaw instance on your network, assigns each one a readable name, and gives you a single `clawnexus list` to see them all. The important part: **OpenClaw doesn't need any configuration changes**. It stays on its default loopback binding. ClawNexus does all the work.

## The Box Rule

We call this the "Box Rule" — the product must work out of the box with zero configuration on the OpenClaw side. No `--bind lan`, no editing YAML files, no opening ports. Install ClawNexus, start the daemon, done.

This constraint shaped every design decision. It's why we built four separate discovery chains instead of one.

## Chain 1: LocalProbe

The simplest chain. On daemon startup, ClawNexus sends an HTTP request to `127.0.0.1:18789` — the default OpenClaw gateway address.

If something responds, it fetches `/__openclaw/control-ui-config.json` to grab metadata: the `agent_id`, `assistantName`, and other details. The instance gets tagged with `is_self: true` and `discovery_source: "local"`.

```
GET http://127.0.0.1:18789/__openclaw/control-ui-config.json
```

No network traversal, no broadcast, no config. If OpenClaw is running locally with defaults, LocalProbe finds it. This runs automatically on daemon startup and periodically afterward.

## Chain 2: CDP (Claw Discovery Protocol)

LocalProbe handles the local machine. CDP handles the subnet.

CDP is a custom UDP broadcast protocol running on port `17891`. When a ClawNexus daemon starts, it broadcasts a `claw_discover` message on the local subnet. Other daemons respond with `claw_announce`, sharing their registry of known instances.

The key insight: **CDP discovers daemons, not OpenClaw instances directly.** Each daemon already knows about its local OpenClaw instance (via LocalProbe). CDP lets daemons share that knowledge with each other.

If you've ever hosted a StarCraft LAN game over IPX, the pattern will feel familiar. Broadcast a "who's out there?", get responses, build a lobby. Same idea, different decade.

CDP requires zero OpenClaw configuration. The daemons handle everything over their own protocol on their own port.

## Chain 3: mDNS

This is the one chain that requires OpenClaw to opt in. When OpenClaw starts with `--bind lan`, it advertises itself via mDNS as `_openclaw-gw._tcp.local`.

ClawNexus listens for these announcements using the `@homebridge/ciao` library. When it picks one up, it extracts TXT records containing `agent_id`, `displayName`, `lanHost`, `gateway_port`, and `tls` status.

mDNS is passive — ClawNexus just listens. But it's the only chain that needs the OpenClaw operator to change their startup flags. For most users running default configs, Chains 1 and 2 cover everything. mDNS is there for environments where it's already enabled or where operators want explicit service advertisement.

## Chain 4: ActiveScanner

The brute-force option. ActiveScanner sweeps the local `/24` subnet, hitting port `18789` on every address and looking for `/__openclaw/control-ui-config.json` responses.

```bash
clawnexus scan
```

It runs with a 2-second timeout per host and 50 concurrent connections, so a full `/24` scan finishes in a few seconds. It also detects WireGuard VPN interfaces and scans peer IPs, which is useful for overlay networks where mDNS broadcasts don't cross.

ActiveScanner is the only chain triggered manually. It's for when you know there's an instance out there but CDP hasn't found it — maybe it's on a different subnet, behind a VPN, or the daemon on that machine isn't running ClawNexus yet.

## Comparison

| Chain | Mechanism | Port | Needs OpenClaw config? | Trigger |
|-------|-----------|------|----------------------|---------|
| LocalProbe | HTTP probe | 18789 | No | Auto on startup |
| CDP | UDP broadcast | 17891 | No | Auto (periodic) |
| mDNS | Service listener | 5353 | Yes (`--bind lan`) | Auto (passive) |
| ActiveScanner | HTTP scan | 18789 | Yes (reachable bind) | Manual (`clawnexus scan`) |

## How They Work Together

Here's the typical two-machine scenario.

Machine A runs OpenClaw (default config) and ClawNexus daemon. Machine B does the same.

1. On Machine A, LocalProbe detects the local OpenClaw instance. Same happens on Machine B.
2. Both daemons broadcast CDP `claw_discover` on the subnet.
3. Daemon A receives B's `claw_announce` and learns about B's OpenClaw instance. Vice versa.
4. Running `clawnexus list` on either machine now shows both instances.

No config files edited. No ports manually opened. No IPs memorized.

## Auto-Naming

Once an instance is discovered, ClawNexus assigns it an `auto_name` derived from the machine's hostname. A MacBook Pro becomes `macbook-pro`. A Raspberry Pi becomes `raspi-4`. A Windows box named `DESKTOP-ALLPAKD` becomes `desktop-allpakd`.

```bash
$ clawnexus list
NAME            ADDRESS           STATUS   SOURCE
macbook-pro     127.0.0.1:18789   online   local
raspi-4         192.168.1.42:18789  online   broadcast
```

You can also set a custom alias:

```bash
$ clawnexus alias raspi-4 homelab
```

From that point on, `homelab` works everywhere — CLI commands, API calls, the Skill inside OpenClaw. Names, not IPs.

## Why Four Chains?

Because no single mechanism works in every environment. LocalProbe covers the local machine. CDP covers the subnet without touching OpenClaw. mDNS catches instances that advertise themselves. ActiveScanner is the fallback for everything else.

The priority order means most users never think about discovery at all. Start the daemon, see your instances. That's the Box Rule in practice.

---

*Built by [StratCraftsAI](https://github.com/StratCraftsAI). For questions or collaboration: contact@stratcraft.ai*
