import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClose, mockHandle, mockStartDaemon } = vi.hoisted(() => {
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockHandle = { app: { close: mockClose } } as any;
  const mockStartDaemon = vi.fn().mockResolvedValue(mockHandle);
  return { mockClose, mockHandle, mockStartDaemon };
});

vi.mock("clawnexus", () => ({
  startDaemon: mockStartDaemon,
}));

import { DaemonAdapter } from "../src/adapter.js";

describe("DaemonAdapter", () => {
  beforeEach(() => {
    mockStartDaemon.mockClear();
    mockClose.mockClear();
    mockStartDaemon.mockResolvedValue(mockHandle);
    mockClose.mockResolvedValue(undefined);
  });

  it("starts in embedded mode when no existing daemon", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: true });
    await adapter.start();

    const state = adapter.getState();
    expect(state.mode).toBe("embedded");
    expect(state.handle).toBe(mockHandle);
    expect(mockStartDaemon).toHaveBeenCalledWith({ port: 17890, host: "127.0.0.1" });
  });

  it("enters external mode when existing daemon responds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: true });
    await adapter.start();

    const state = adapter.getState();
    expect(state.mode).toBe("external");
    expect(state.handle).toBeNull();
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it("falls back to external mode on EADDRINUSE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const addrErr = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    mockStartDaemon.mockRejectedValue(addrErr);

    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: true });
    await adapter.start();

    const state = adapter.getState();
    expect(state.mode).toBe("external");
    expect(state.error).toContain("Port in use");
  });

  it("stays stopped when autoStart is false", async () => {
    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: false });
    await adapter.start();

    expect(adapter.getState().mode).toBe("stopped");
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it("calls app.close() on stop in embedded mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: true });
    await adapter.start();
    await adapter.stop();

    expect(mockClose).toHaveBeenCalled();
    expect(adapter.getState().mode).toBe("stopped");
  });

  it("stop in external mode is a no-op", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: true });
    await adapter.start();
    await adapter.stop();

    expect(mockClose).not.toHaveBeenCalled();
    expect(adapter.getState().mode).toBe("stopped");
  });

  it("probeExisting returns true when health endpoint responds OK", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: true });
    expect(await adapter.probeExisting()).toBe(true);
  });

  it("probeExisting returns false when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const adapter = new DaemonAdapter({ port: 17890, host: "127.0.0.1", autoStart: true });
    expect(await adapter.probeExisting()).toBe(false);
  });
});
