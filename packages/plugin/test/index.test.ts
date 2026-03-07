import { describe, it, expect, vi } from "vitest";

const { mockStartDaemon } = vi.hoisted(() => {
  const mockStartDaemon = vi.fn().mockResolvedValue({ app: { close: vi.fn() } });
  return { mockStartDaemon };
});

vi.mock("clawnexus", () => ({
  startDaemon: mockStartDaemon,
}));

import clawnexusPlugin from "../src/index.js";

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  return {
    pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerService: vi.fn(),
  };
}

describe("clawnexusPlugin", () => {
  it("calls registerService with correct service shape", () => {
    const api = createMockApi({ port: 18000, host: "0.0.0.0", autoStart: false });

    clawnexusPlugin(api);

    expect(api.registerService).toHaveBeenCalledOnce();
    const service = api.registerService.mock.calls[0][0];
    expect(service.id).toBe("clawnexus-daemon");
    expect(typeof service.start).toBe("function");
    expect(typeof service.stop).toBe("function");
  });

  it("uses default config values when pluginConfig is empty", () => {
    const api = createMockApi();

    clawnexusPlugin(api);

    expect(api.registerService).toHaveBeenCalledOnce();
  });

  it("handles undefined pluginConfig", () => {
    const api = {
      pluginConfig: undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerService: vi.fn(),
    };

    clawnexusPlugin(api);

    expect(api.registerService).toHaveBeenCalledOnce();
  });
});
