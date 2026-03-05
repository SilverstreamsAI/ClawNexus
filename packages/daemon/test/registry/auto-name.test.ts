import { describe, it, expect } from "vitest";
import { normalize, generateAutoName, ensureUnique } from "../../src/registry/auto-name.js";

describe("normalize", () => {
  it("lowercases input", () => {
    expect(normalize("MacBook-Pro")).toBe("macbook-pro");
  });

  it("replaces non-alphanumeric chars with hyphens", () => {
    expect(normalize("My Server!")).toBe("my-server");
  });

  it("collapses consecutive hyphens", () => {
    expect(normalize("a---b")).toBe("a-b");
  });

  it("trims leading and trailing hyphens", () => {
    expect(normalize("-hello-")).toBe("hello");
  });

  it("truncates to 32 characters", () => {
    const long = "a".repeat(40);
    expect(normalize(long).length).toBeLessThanOrEqual(32);
  });

  it("removes trailing hyphen after truncation", () => {
    const input = "a".repeat(31) + "-b";
    const result = normalize(input);
    expect(result.endsWith("-")).toBe(false);
  });

  it("returns 'instance' for empty string", () => {
    expect(normalize("")).toBe("instance");
  });

  it("returns 'instance' for all-invalid characters", () => {
    expect(normalize("!!!")).toBe("instance");
  });
});

describe("generateAutoName", () => {
  it("uses lanHost stripped of .local", () => {
    expect(generateAutoName("MacBook-Pro.local", "Display", "10.0.0.1")).toBe("macbook-pro");
  });

  it("skips lanHost if it equals address", () => {
    expect(generateAutoName("10.0.0.1", "My Server", "10.0.0.1")).toBe("my-server");
  });

  it("skips lanHost 127.0.0.1", () => {
    expect(generateAutoName("127.0.0.1", "My Server", "127.0.0.1")).toBe("my-server");
  });

  it("falls back to displayName when lanHost is empty", () => {
    expect(generateAutoName("", "Cool Agent", "10.0.0.1")).toBe("cool-agent");
  });

  it("falls back to address when both are empty", () => {
    expect(generateAutoName("", "", "192.168.1.5")).toBe("192-168-1-5");
  });
});

describe("ensureUnique", () => {
  it("returns base name if not taken", () => {
    expect(ensureUnique("server", new Set())).toBe("server");
  });

  it("appends -2 on first conflict", () => {
    expect(ensureUnique("server", new Set(["server"]))).toBe("server-2");
  });

  it("appends -3 when -2 is also taken", () => {
    expect(ensureUnique("server", new Set(["server", "server-2"]))).toBe("server-3");
  });

  it("handles large sets", () => {
    const existing = new Set(["s", "s-2", "s-3", "s-4"]);
    expect(ensureUnique("s", existing)).toBe("s-5");
  });
});
