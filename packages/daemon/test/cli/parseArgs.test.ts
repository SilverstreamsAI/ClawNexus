import { describe, it, expect, vi } from "vitest";

// The CLI module runs main() on import. We need to mock process.argv
// and prevent exit calls, then dynamically import.
// Actually, the module calls main() at module scope. We need to isolate parseArgs.
// Since parseArgs is now exported, we can use vi.mock to prevent side effects.

// Mock the main execution by intercepting process.argv
vi.mock("node:child_process", () => ({
  fork: vi.fn(),
  exec: vi.fn(),
}));

// Stub fetch to prevent actual network calls
vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));

// Import the module — main() will execute but will hit the default case (help text)
// since process.argv won't have a known command
const { parseArgs } = await import("../../src/cli/index.js");

describe("parseArgs", () => {
  it("parses command from first positional arg", () => {
    const args = parseArgs(["list"]);
    expect(args.command).toBe("list");
    expect(args.positional).toEqual([]);
  });

  it("parses command with positional arguments", () => {
    const args = parseArgs(["alias", "my-agent", "home"]);
    expect(args.command).toBe("alias");
    expect(args.positional).toEqual(["my-agent", "home"]);
  });

  it("parses --json flag", () => {
    const args = parseArgs(["list", "--json"]);
    expect(args.json).toBe(true);
  });

  it("parses --timeout", () => {
    const args = parseArgs(["list", "--timeout", "10000"]);
    expect(args.timeout).toBe(10000);
  });

  it("parses --api", () => {
    const args = parseArgs(["list", "--api", "http://remote:17890"]);
    expect(args.api).toBe("http://remote:17890");
  });

  it("parses --all flag", () => {
    const args = parseArgs(["tasks", "--all"]);
    expect(args.all).toBe(true);
  });

  it("parses --direction", () => {
    const args = parseArgs(["tasks", "--direction", "inbound"]);
    expect(args.direction).toBe("inbound");
  });

  it("parses --peer", () => {
    const args = parseArgs(["interactions", "--peer", "alice.id.claw"]);
    expect(args.peer).toBe("alice.id.claw");
  });

  it("parses --input key=value pairs", () => {
    const args = parseArgs(["propose", "peer", "task", "--input", "lang=en", "--input", "format=json"]);
    expect(args.input).toEqual({ lang: "en", format: "json" });
  });

  it("defaults to empty command when no args", () => {
    const args = parseArgs([]);
    expect(args.command).toBe("");
    expect(args.positional).toEqual([]);
  });

  it("defaults json to false", () => {
    const args = parseArgs(["list"]);
    expect(args.json).toBe(false);
  });

  it("defaults timeout to 5000", () => {
    const args = parseArgs(["list"]);
    expect(args.timeout).toBe(5000);
  });

  it("handles mixed flags and positional args", () => {
    const args = parseArgs(["alias", "my-agent", "--json", "home", "--timeout", "3000"]);
    expect(args.command).toBe("alias");
    expect(args.positional).toEqual(["my-agent", "home"]);
    expect(args.json).toBe(true);
    expect(args.timeout).toBe(3000);
  });

  it("parses open-ui command", () => {
    const args = parseArgs(["open-ui"]);
    expect(args.command).toBe("open-ui");
    expect(args.positional).toEqual([]);
  });

  it("parses open-ui with --api override", () => {
    const args = parseArgs(["open-ui", "--api", "http://remote:17890"]);
    expect(args.command).toBe("open-ui");
    expect(args.api).toBe("http://remote:17890");
  });

  it("parses --scope flag", () => {
    const args = parseArgs(["list", "--scope", "vpn"]);
    expect(args.command).toBe("list");
    expect(args.scope).toBe("vpn");
  });

  it("parses --target flag (repeatable)", () => {
    const args = parseArgs(["scan", "--target", "192.168.1.1:18789", "--target", "10.0.0.1:18789"]);
    expect(args.command).toBe("scan");
    expect(args.targets).toEqual(["192.168.1.1:18789", "10.0.0.1:18789"]);
  });

  it("parses --ports flag (comma-separated)", () => {
    const args = parseArgs(["scan", "--ports", "18789,18790"]);
    expect(args.command).toBe("scan");
    expect(args.ports).toEqual([18789, 18790]);
  });
});
