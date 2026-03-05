// ClawNexus Daemon — entry point
export type { ClawInstance, RegistryFile, ControlUiConfig, Connectivity, UnreachableInstance } from './types.js';
export { RegistryStore, AliasError, AliasConflictError, NotFoundError } from './registry/store.js';
export { MdnsListener } from './mdns/listener.js';
export type { MdnsFactory, MdnsInstance } from './mdns/listener.js';
export { HealthChecker } from './health/checker.js';
export { LocalProbe } from './local/probe.js';
export { ActiveScanner } from './scanner/active.js';
export type { ScanOptions } from './scanner/active.js';
export { BroadcastDiscovery } from './discovery/broadcast.js';
export { registerRelayRoutes, registerInstanceRoutes, registerAgentRoutes, registerDiagnosticsRoutes, registerRegistryRoutes, startDaemon } from './api/server.js';
export type { DaemonOptions, DaemonHandle, AgentDeps, DiagnosticsDeps, RegistryDeps } from './api/server.js';
export { loadOrCreateKeys, sign, getPublicKeyString } from './crypto/keys.js';
export type { IdentityKeys } from './crypto/keys.js';
export { RegistryClient, RegistryError } from './registry/client.js';
export type { RegistryRecord, RegisterResult, ResolveResult, TokenResult, CheckNameResult, RegisterParams } from './registry/client.js';
export { AutoRegister } from './registry/auto-register.js';
export { RemoteDiscovery } from './registry/discovery.js';
export { RelayConnector } from './relay/connector.js';
export type { RelayConnectorOptions } from './relay/connector.js';
export type { RelayStatus } from './relay/types.js';

// Layer B — Agent Interaction
export { PolicyEngine } from './agent/engine.js';
export { TaskManager } from './agent/tasks.js';
export { AgentRouter } from './agent/router.js';
export type { AgentRouterOptions } from './agent/router.js';
export { createEnvelope, parseEnvelope, validatePayload, isExpired, ProtocolError } from './agent/protocol.js';
export type { EnvelopeOptions } from './agent/protocol.js';
export type {
  LayerBEnvelope,
  LayerBMessageType,
  LayerBPayload,
  QueryPayload,
  ProposePayload,
  AcceptPayload,
  RejectPayload,
  DelegatePayload,
  ReportPayload,
  CancelPayload,
  CapabilityPayload,
  HeartbeatPayload,
  TaskSpec,
  RejectReason,
  PolicyConfig,
  PolicyDecision,
  PolicyDecisionResult,
  TaskRecord,
  TaskState,
  TaskDirection,
  ActiveTasksFile,
  TaskStats,
  ServiceCapability,
  WantedService,
  ServicesFile,
} from './agent/types.js';
