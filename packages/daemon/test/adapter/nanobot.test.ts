import { describe, it, expect, vi, afterEach } from "vitest";
import { NanoBotAdapter } from "../../src/adapter/nanobot.js";

describe("NanoBotAdapter", () => {
  const adapter = new NanoBotAdapter();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct name and default ports", () => {
    expect(adapter.name).toBe("nanobot");
    expect(adapter.defaultPorts).toEqual([8000, 8080]);
  });

  it("detects nanobot from /health with framework field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ framework: "nanobot", version: "1.0.0", name: "My Bot" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.60", 8000);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nanobot");
    expect(result!.version).toBe("1.0.0");
    expect(result!.display_name).toBe("My Bot");
  });

  it("detects nanobot from /health with app field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ app: "nanobot", version: "0.5.0" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.60", 8000);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nanobot");
    expect(result!.version).toBe("0.5.0");
  });

  it("detects nanobot via python_version heuristic on expected port", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", python_version: "3.12.1" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.60", 8000);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nanobot");
    expect(result!.metadata).toEqual({ python_version: "3.12.1" });
  });

  it("ignores python_version heuristic on unexpected port", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", python_version: "3.12.1" }),
        };
      }
      if (url.includes("/api/health")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Not found");
    }));

    // Port 9999 is not a default nanobot port — heuristic should not trigger
    const result = await adapter.probe("192.168.1.60", 9999);
    expect(result).toBeNull();
  });

  it("detects nanobot from /api/health fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/health")) {
        return {
          ok: true,
          json: async () => ({ app: "nanobot", version: "0.3.0", name: "Fallback Bot" }),
        };
      }
      // /health (non-api) returns no nanobot indicators
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.60", 8080);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nanobot");
    expect(result!.display_name).toBe("Fallback Bot");
  });

  it("returns null when /health has no matching fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", uptime: 12345 }),
        };
      }
      if (url.includes("/api/health")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.60", 8000);
    expect(result).toBeNull();
  });

  it("returns null on connection timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await adapter.probe("192.168.1.60", 8000);
    expect(result).toBeNull();
  });

  it("toClawInstance produces correct partial instance", () => {
    const probe = { name: "nanobot", version: "1.0.0", display_name: "Python Bot" };
    const partial = adapter.toClawInstance("192.168.1.60", 8000, probe);

    expect(partial.agent_id).toBe("nanobot@192.168.1.60");
    expect(partial.display_name).toBe("Python Bot");
    expect(partial.assistant_name).toBe("Python Bot");
    expect(partial.gateway_port).toBe(8000);
    expect(partial.implementation).toBe("nanobot");
    expect(partial.address).toBe("192.168.1.60");
    expect(partial.discovery_source).toBe("scan");
  });

  it("toClawInstance uses fallback display_name when not provided", () => {
    const probe = { name: "nanobot" };
    const partial = adapter.toClawInstance("10.0.0.1", 8080, probe);

    expect(partial.display_name).toBe("nanobot");
    expect(partial.assistant_name).toBe("");
  });
});
