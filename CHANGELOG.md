# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-03-14

### Added
- A2A (Agent-to-Agent) JSON-RPC endpoint (`POST /a2a`) for task handling
- Persistent gateway connection with task store and concurrency limit
- Remote Agent Card fetching from discovered instances
- Registry metadata and agent card summary sent on register/renew
- Embedded Web UI dashboard for daemon
- Cross-network E2E relay validation script

### Fixed
- Concurrent `flushNow()` race condition in A2ATaskStore
- CardFetcher double-start prevention
- Relay error handling and debug logging

## [0.3.1] - 2026-03-10

### Fixed
- Auto-register falls back to `auto_name` when agentId-based names are exhausted
- Agent request timeout, task timeout basis, rate cleanup, and NaN expiry
- Executor `scheduleReconnect` now triggers when tasks are queued but not executing
- Task state transitions, token refresh, and error handling

### Changed
- Bumped all packages to 0.3.1

## [0.3.0] - 2026-03-09

### Added
- Agent Card generation and `/.well-known/agent-card.json` endpoint
- TaskExecutor for inbound task execution
- SkillsRegistry and Gateway v3 protocol support
- Relay connector hot-swap

### Changed
- Refactored OpenClaw/OpenFang adapters; made core components adapter-aware
- Bumped all packages to 0.3.0

## [0.2.8] - 2026-03-08

### Added
- Fingerprint identification for 6 OpenClaw variants (openclaw, goclaw, zeroclaw, picoclaw, nanoclaw, nanobot)
- Framework adapter system for NanoClaw and NanoBot discovery
- ClawLink Protocol support (`/.well-known/claw-identity.json`)
- Adapter default port scanning (3100, 3101, 8000, 8080)

## [0.2.7] - 2026-03-07

### Added
- OpenClaw plugin adapter package (`clawnexus-plugin`)

### Fixed
- Align manifest id with package name

## [0.2.6] - 2026-03-06

### Fixed
- Scanner: resolve `lan_host` from registry for multi-NIC deduplication

### Changed
- Bumped all packages to v0.2.6

## [0.2.5] - 2026-03-04

### Changed
- Added `resolve` action documentation to Skill package
- Bumped version to 0.2.5

## [0.2.4] - 2026-03-03

### Fixed
- Store: resolve instance by `address:port` format

### Added
- Comprehensive instance identifier resolution tests
- Local instance and scan API resolve tests

## [0.2.3] - 2026-03-02

### Added
- Multi-NIC deduplication in registry
- ClawHub skill submission

### Changed
- Updated GitHub URLs to SilverstreamsAI org
- Updated API, architecture, and README docs for v0.2 registry and v0.4 agent features

## [0.2.2] - 2026-02-28

### Fixed
- Windows: daemon start hang and flashing console window

### Changed
- Renamed SDK package to `@clawnexus/sdk`

## [0.1.0] - 2026-02-25

### Added
- Initial open-source release
- LAN discovery: LocalProbe, CDP broadcast, mDNS listener, ActiveScanner
- Instance registry with alias management
- HTTP API (Fastify, port 17890)
- CLI commands: start, stop, list, scan, alias, info, connect, open
- OpenClaw Skill package
- SDK (`@clawnexus/sdk`) for programmatic access
- Health checker with dual-channel connectivity detection
- Registry client for public registry integration
- Relay connector for cross-network communication
- Layer B agent interaction (PolicyEngine, TaskManager, AgentRouter)
- Ed25519 identity key management
