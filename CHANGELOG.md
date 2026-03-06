# Changelog

All notable changes to this project will be documented in this file.

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
