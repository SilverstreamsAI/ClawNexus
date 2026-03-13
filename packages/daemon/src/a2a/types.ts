// A2A JSON-RPC 2.0 types and Task model (spec v0.2.1)

// --- JSON-RPC 2.0 ---

export interface A2ARequest {
  jsonrpc: "2.0";
  method: string;
  id: string | number;
  params?: unknown;
}

export interface A2AResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: A2AError;
}

export interface A2AError {
  code: number;
  message: string;
  data?: unknown;
}

// --- A2A Task Model ---

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
}

export interface A2ATaskStatus {
  state: "submitted" | "working" | "completed" | "failed" | "canceled";
  message?: A2AMessage;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2APart[];
}

export type A2APart = { type: "text"; text: string };

export interface A2AArtifact {
  name?: string;
  parts: A2APart[];
}

// --- JSON-RPC Error Codes ---

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
