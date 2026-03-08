import { describe, it, expect, vi, afterEach } from "vitest";
import { identifyImplementation, detect404Format } from "../../src/scanner/fingerprint.js";

describe("identifyImplementation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns openclaw for ClawLink identity endpoint with implementation field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/.well-known/claw-identity.json")) {
        return {
          ok: true,
          json: async () => ({ implementation: "openclaw", version: "1.0.0" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await identifyImplementation("192.168.1.1", 18789, null);
    expect(result.implementation).toBe("openclaw");
    expect(result.confidence).toBe(1.0);
  });

  it("returns goclaw from ClawLink identity endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/.well-known/claw-identity.json")) {
        return {
          ok: true,
          json: async () => ({ implementation: "GoClaw", version: "0.5.0" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await identifyImplementation("192.168.1.1", 18789, null);
    expect(result.implementation).toBe("goclaw");
    expect(result.confidence).toBe(1.0);
  });

  it("returns unknown for unrecognized implementation in ClawLink", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/.well-known/claw-identity.json")) {
        return {
          ok: true,
          json: async () => ({ implementation: "some-unknown-thing" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await identifyImplementation("192.168.1.1", 18789, null);
    expect(result.implementation).toBe("unknown");
    expect(result.confidence).toBe(1.0);
  });

  it("returns openclaw for rich config (>= 6 fields with UI fields)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Not found")));

    const config = {
      assistantAgentId: "main",
      assistantName: "My Assistant",
      displayName: "Test",
      controlUi: { basePath: "/" },
      webSearchEnabled: true,
      customInstructions: "",
      tools: [],
      theme: "dark",
      language: "en",
    };

    const result = await identifyImplementation("192.168.1.1", 18789, config);
    expect(result.implementation).toBe("openclaw");
    expect(result.confidence).toBe(0.8);
  });

  it("returns goclaw for minimal config (< 6 fields, no UI fields)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Not found")));

    const config = {
      assistantAgentId: "main",
      assistantName: "GoClaw Agent",
      displayName: "GoClaw",
    };

    const result = await identifyImplementation("192.168.1.1", 18789, config);
    expect(result.implementation).toBe("goclaw");
    expect(result.confidence).toBe(0.7);
  });

  it("returns zeroclaw when /health returns JSON with paired field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/.well-known/claw-identity.json")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/health")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ status: "ok", paired: true, runtime: "tokio" }),
        };
      }
      throw new Error("Not found");
    }));

    const result = await identifyImplementation("192.168.1.1", 42617, null);
    expect(result.implementation).toBe("zeroclaw");
    expect(result.confidence).toBe(0.9);
  });

  it("returns picoclaw when /health and /ready both return 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/.well-known/claw-identity.json")) {
        return { ok: false, status: 404 };
      }
      if (url.includes("/health")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ status: "ok" }),
        };
      }
      if (url.includes("/ready")) {
        return { ok: true };
      }
      throw new Error("Not found");
    }));

    const result = await identifyImplementation("192.168.1.1", 18790, null);
    expect(result.implementation).toBe("picoclaw");
    expect(result.confidence).toBe(0.8);
  });

  it("returns unknown when no endpoints match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

    const result = await identifyImplementation("192.168.1.1", 12345, null);
    expect(result.implementation).toBe("unknown");
    expect(result.confidence).toBe(0.1);
  });

  it("ClawLink takes priority over config analysis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/.well-known/claw-identity.json")) {
        return {
          ok: true,
          json: async () => ({ implementation: "goclaw" }),
        };
      }
      throw new Error("Not found");
    }));

    // Even with a rich config that would suggest openclaw,
    // ClawLink identity should take priority
    const config = {
      assistantAgentId: "main",
      assistantName: "Test",
      controlUi: {},
      webSearchEnabled: true,
      tools: [],
      customInstructions: "",
      theme: "dark",
      language: "en",
    };

    const result = await identifyImplementation("192.168.1.1", 18789, config);
    expect(result.implementation).toBe("goclaw");
    expect(result.confidence).toBe(1.0);
  });
});

describe("detect404Format", () => {
  it("detects Go default 404", () => {
    expect(detect404Format("404 page not found\n")).toBe("go");
    expect(detect404Format("404 page not found")).toBe("go");
  });

  it("detects Fastify JSON 404", () => {
    const body = JSON.stringify({
      message: "Route GET:/nonexistent not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(detect404Format(body)).toBe("fastify");
  });

  it("returns unknown for other formats", () => {
    expect(detect404Format("Not Found")).toBe("unknown");
    expect(detect404Format("<html>404</html>")).toBe("unknown");
  });
});
