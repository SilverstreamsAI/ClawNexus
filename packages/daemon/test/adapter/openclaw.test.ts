import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenClawAdapter } from "../../src/adapter/openclaw.js";

describe("OpenClawAdapter", () => {
  const adapter = new OpenClawAdapter();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct name and default ports", () => {
    expect(adapter.name).toBe("openclaw");
    expect(adapter.defaultPorts).toEqual([18789]);
  });

  it("detects OpenClaw from config endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assistantAgentId: "my-agent",
        assistantName: "My Assistant",
        displayName: "My Display",
      }),
    }));

    const result = await adapter.probe("192.168.1.10", 18789);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("openclaw");
    expect(result!.display_name).toBe("My Display");
    expect(result!.metadata).toEqual({
      assistantAgentId: "my-agent",
      assistantName: "My Assistant",
      displayName: "My Display",
    });
  });

  it("returns null when config has no assistantAgentId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ assistantName: "No ID" }),
    }));

    const result = await adapter.probe("192.168.1.10", 18789);
    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await adapter.probe("192.168.1.10", 18789);
    expect(result).toBeNull();
  });

  it("returns null on connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await adapter.probe("192.168.1.10", 18789);
    expect(result).toBeNull();
  });

  it("toClawInstance produces correct partial instance", () => {
    const probe = {
      name: "openclaw",
      display_name: "My Display",
      metadata: {
        assistantAgentId: "my-agent",
        assistantName: "My Assistant",
        displayName: "My Display",
      },
    };
    const partial = adapter.toClawInstance("192.168.1.10", 18789, probe);

    expect(partial.agent_id).toBe("my-agent");
    expect(partial.assistant_name).toBe("My Assistant");
    expect(partial.display_name).toBe("My Display");
    expect(partial.gateway_port).toBe(18789);
    expect(partial.implementation).toBe("openclaw");
  });

  it("toClawInstance uses fallback agent_id when metadata missing", () => {
    const probe = { name: "openclaw" };
    const partial = adapter.toClawInstance("10.0.0.1", 18789, probe);

    expect(partial.agent_id).toBe("openclaw@10.0.0.1");
    expect(partial.assistant_name).toBe("");
  });

  it("healthCheck returns true on ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const result = await adapter.healthCheck("192.168.1.10", 18789);
    expect(result).toBe(true);
  });

  it("healthCheck returns false on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await adapter.healthCheck("192.168.1.10", 18789);
    expect(result).toBe(false);
  });

  it("healthCheck returns false on connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await adapter.healthCheck("192.168.1.10", 18789);
    expect(result).toBe(false);
  });
});
