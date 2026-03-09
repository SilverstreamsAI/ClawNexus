import { describe, it, expect } from "vitest";
import { ADAPTERS, getAdapter, getAllAdapterPorts } from "../../src/adapter/index.js";

describe("adapter registry", () => {
  it("contains all adapters", () => {
    expect(ADAPTERS).toHaveLength(4);
    const names = ADAPTERS.map((a) => a.name);
    expect(names).toContain("openclaw");
    expect(names).toContain("nanoclaw");
    expect(names).toContain("nanobot");
    expect(names).toContain("openfang");
  });

  it("getAdapter returns adapter by name", () => {
    const openclaw = getAdapter("openclaw");
    expect(openclaw).toBeDefined();
    expect(openclaw!.name).toBe("openclaw");

    const nanoclaw = getAdapter("nanoclaw");
    expect(nanoclaw).toBeDefined();
    expect(nanoclaw!.name).toBe("nanoclaw");

    const nanobot = getAdapter("nanobot");
    expect(nanobot).toBeDefined();
    expect(nanobot!.name).toBe("nanobot");

    const openfang = getAdapter("openfang");
    expect(openfang).toBeDefined();
    expect(openfang!.name).toBe("openfang");
  });

  it("getAdapter returns undefined for unknown name", () => {
    expect(getAdapter("nonexistent")).toBeUndefined();
  });

  it("getAllAdapterPorts returns sorted unique ports", () => {
    const ports = getAllAdapterPorts();
    expect(ports).toEqual([4200, 8000, 8080, 18789, 18790]);
    // Verify sorted
    for (let i = 1; i < ports.length; i++) {
      expect(ports[i]).toBeGreaterThan(ports[i - 1]);
    }
  });
});
