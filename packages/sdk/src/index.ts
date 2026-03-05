// @clawnexus/clawlink-sdk — ClawLink Protocol SDK
// Discover and identify OpenClaw-compatible AI instances
// See: DESIGN_010_ecosystem_compatibility.md

export { ClawNexusClient, ClawNexusApiError } from './client.js';
export type { ClawNexusClientOptions } from './client.js';

// Re-export core types for SDK consumers
export type {
  ClawInstance,
  RegistryFile,
  ControlUiConfig,
  PolicyConfig,
  TaskSpec,
  TaskState,
  TaskDirection,
  TaskRecord,
  TaskStats,
  InboxItem,
} from './types.js';
