import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenFangAdapter } from "../../src/adapter/openfang.js";

describe("OpenFangAdapter", () => {
  const adapter = new OpenFangAdapter();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct name and default ports", () => {
    expect(adapter.name).toBe("openfang");
    expect(adapter.defaultPorts).toEqual([4200]);
  });

  it("detects OpenFang from /api/health with framework field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", framework: "openfang", version: "1.2.0" }),
        };
      }
      if (url.includes("/.well-known/agent.json")) {
        return {
          ok: true,
          json: async () => ({ name: "My Fang", agent_id: "fang-1", display_name: "Fang Display" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.20", 4200);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("openfang");
    expect(result!.version).toBe("1.2.0");
    expect(result!.display_name).toBe("Fang Display");
    expect(result!.metadata).toEqual({ agent_id: "fang-1", agent_name: "My Fang" });
  });

  it("detects OpenFang from /api/health with status ok (heuristic)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok" }),
        };
      }
      // No agent.json
      return { ok: false, status: 404 };
    }));

    const result = await adapter.probe("192.168.1.20", 4200);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("openfang");
  });

  it("returns null when /api/health has no matching fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/health")) {
        return {
          ok: true,
          json: async () => ({ running: true }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.20", 4200);
    expect(result).toBeNull();
  });

  it("returns null on non-ok /api/health response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await adapter.probe("192.168.1.20", 4200);
    expect(result).toBeNull();
  });

  it("returns null on connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await adapter.probe("192.168.1.20", 4200);
    expect(result).toBeNull();
  });

  it("toClawInstance produces correct partial instance", () => {
    const probe = {
      name: "openfang",
      version: "1.2.0",
      display_name: "Fang Display",
      metadata: { agent_id: "fang-1", agent_name: "My Fang" },
    };
    const partial = adapter.toClawInstance("192.168.1.20", 4200, probe);

    expect(partial.agent_id).toBe("fang-1");
    expect(partial.assistant_name).toBe("My Fang");
    expect(partial.display_name).toBe("Fang Display");
    expect(partial.gateway_port).toBe(4200);
    expect(partial.implementation).toBe("openfang");
  });

  it("toClawInstance uses fallback when metadata missing", () => {
    const probe = { name: "openfang" };
    const partial = adapter.toClawInstance("10.0.0.1", 4200, probe);

    expect(partial.agent_id).toBe("openfang@10.0.0.1");
    expect(partial.display_name).toBe("openfang");
  });

  it("healthCheck returns true on ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    }));

    const result = await adapter.healthCheck("192.168.1.20", 4200);
    expect(result).toBe(true);
  });

  it("healthCheck returns false when status is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "degraded" }),
    }));

    const result = await adapter.healthCheck("192.168.1.20", 4200);
    expect(result).toBe(false);
  });

  it("healthCheck returns false on non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await adapter.healthCheck("192.168.1.20", 4200);
    expect(result).toBe(false);
  });

  it("healthCheck returns false on connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await adapter.healthCheck("192.168.1.20", 4200);
    expect(result).toBe(false);
  });
});
