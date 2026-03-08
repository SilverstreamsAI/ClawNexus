import { describe, it, expect } from "vitest";
import { ADAPTERS, getAdapter, getAllAdapterPorts } from "../../src/adapter/index.js";

describe("adapter registry", () => {
  it("contains both adapters", () => {
    expect(ADAPTERS).toHaveLength(2);
    const names = ADAPTERS.map((a) => a.name);
    expect(names).toContain("nanoclaw");
    expect(names).toContain("nanobot");
  });

  it("getAdapter returns adapter by name", () => {
    const nanoclaw = getAdapter("nanoclaw");
    expect(nanoclaw).toBeDefined();
    expect(nanoclaw!.name).toBe("nanoclaw");

    const nanobot = getAdapter("nanobot");
    expect(nanobot).toBeDefined();
    expect(nanobot!.name).toBe("nanobot");
  });

  it("getAdapter returns undefined for unknown name", () => {
    expect(getAdapter("nonexistent")).toBeUndefined();
  });

  it("getAllAdapterPorts returns sorted unique ports", () => {
    const ports = getAllAdapterPorts();
    expect(ports).toEqual([3100, 3101, 8000, 8080, 18790]);
    // Verify sorted
    for (let i = 1; i < ports.length; i++) {
      expect(ports[i]).toBeGreaterThan(ports[i - 1]);
    }
  });
});
