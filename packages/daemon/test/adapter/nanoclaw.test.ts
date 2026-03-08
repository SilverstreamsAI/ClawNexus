import { describe, it, expect, vi, afterEach } from "vitest";
import { NanoClawAdapter } from "../../src/adapter/nanoclaw.js";

describe("NanoClawAdapter", () => {
  const adapter = new NanoClawAdapter();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct name and default ports", () => {
    expect(adapter.name).toBe("nanoclaw");
    expect(adapter.defaultPorts).toEqual([3100, 3101]);
  });

  it("detects nanoclaw from /health endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ framework: "nanoclaw", version: "0.1.0", name: "My NanoClaw" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.50", 3100);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nanoclaw");
    expect(result!.version).toBe("0.1.0");
    expect(result!.display_name).toBe("My NanoClaw");
  });

  it("detects nanoclaw from /api/info fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/api/info")) {
        return {
          ok: true,
          json: async () => ({ framework: "nanoclaw", version: "0.2.0" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.50", 3100);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nanoclaw");
    expect(result!.version).toBe("0.2.0");
  });

  it("returns null when /health has no framework field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok" }),
        };
      }
      if (url.includes("/api/info")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.50", 3100);
    expect(result).toBeNull();
  });

  it("returns null when /health has different framework", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ framework: "express", status: "ok" }),
        };
      }
      if (url.includes("/api/info")) {
        return { ok: false, status: 404 };
      }
      throw new Error("Not found");
    }));

    const result = await adapter.probe("192.168.1.50", 3100);
    expect(result).toBeNull();
  });

  it("returns null on connection timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await adapter.probe("192.168.1.50", 3100);
    expect(result).toBeNull();
  });

  it("toClawInstance produces correct partial instance", () => {
    const probe = { name: "nanoclaw", version: "0.1.0", display_name: "My Agent" };
    const partial = adapter.toClawInstance("192.168.1.50", 3100, probe);

    expect(partial.agent_id).toBe("nanoclaw@192.168.1.50");
    expect(partial.display_name).toBe("My Agent");
    expect(partial.assistant_name).toBe("My Agent");
    expect(partial.gateway_port).toBe(3100);
    expect(partial.implementation).toBe("nanoclaw");
    expect(partial.address).toBe("192.168.1.50");
    expect(partial.discovery_source).toBe("scan");
  });

  it("toClawInstance uses fallback display_name when not provided", () => {
    const probe = { name: "nanoclaw" };
    const partial = adapter.toClawInstance("10.0.0.1", 3101, probe);

    expect(partial.display_name).toBe("nanoclaw");
    expect(partial.assistant_name).toBe("");
  });
});
