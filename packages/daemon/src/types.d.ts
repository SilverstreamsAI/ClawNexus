export interface ClawInstance {
    agent_id: string;
    assistant_name: string;
    display_name: string;
    alias?: string;
    lan_host: string;
    address: string;
    gateway_port: number;
    tls: boolean;
    tls_fingerprint?: string;
    discovery_source: "mdns" | "scan" | "manual";
    network_scope: "local" | "tailscale" | "public";
    status: "online" | "offline" | "unknown";
    last_seen: string;
    discovered_at: string;
    labels?: Record<string, string>;
}
export interface RegistryFile {
    schema_version: "2";
    updated_at: string;
    instances: ClawInstance[];
}
export interface ControlUiConfig {
    assistantAgentId: string;
    assistantName: string;
    displayName?: string;
    [key: string]: unknown;
}
//# sourceMappingURL=types.d.ts.map