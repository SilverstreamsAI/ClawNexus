import { describe, it, expect } from "vitest";
import { buildAgentCard } from "../../src/a2a/card.js";
import { makeInstance } from "../fixtures.js";

describe("buildAgentCard", () => {
  const VERSION = "0.2.8";

  it("uses alias as name when present", () => {
    const inst = makeInstance({ alias: "home", auto_name: "macbook-pro" });
    const card = buildAgentCard(inst, VERSION);
    expect(card.name).toBe("home");
  });

  it("falls back to auto_name when no alias", () => {
    const inst = makeInstance({ auto_name: "macbook-pro" });
    const card = buildAgentCard(inst, VERSION);
    expect(card.name).toBe("macbook-pro");
  });

  it("uses display_name as description", () => {
    const inst = makeInstance({ display_name: "My Bot", assistant_name: "Assistant" });
    const card = buildAgentCard(inst, VERSION);
    expect(card.description).toBe("My Bot");
  });

  it("falls back to assistant_name when display_name is empty", () => {
    const inst = makeInstance({ display_name: "", assistant_name: "Jarvis" });
    const card = buildAgentCard(inst, VERSION);
    expect(card.description).toBe("Jarvis");
  });

  it("sets url from instance address", () => {
    const inst = makeInstance({ address: "192.168.1.50" });
    const card = buildAgentCard(inst, VERSION);
    expect(card.url).toBe("http://192.168.1.50:17890");
  });

  it("includes daemon version", () => {
    const inst = makeInstance();
    const card = buildAgentCard(inst, "1.0.0");
    expect(card.version).toBe("1.0.0");
  });

  it("sets all capabilities to false", () => {
    const inst = makeInstance();
    const card = buildAgentCard(inst, VERSION);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    });
  });

  it("includes default skill when no skills passed", () => {
    const inst = makeInstance();
    const card = buildAgentCard(inst, VERSION);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("general-assistant");
    expect(card.skills[0].tags).toContain("general");
  });

  it("uses provided skills when passed", () => {
    const inst = makeInstance();
    const skills = [
      { id: "web_search", name: "Web Search", description: "Search the web", tags: ["web"] },
      { id: "code_run", name: "Code Run", description: "Execute code", tags: ["code"] },
    ];
    const card = buildAgentCard(inst, VERSION, skills);
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].id).toBe("web_search");
    expect(card.skills[1].id).toBe("code_run");
  });

  it("falls back to default skill when empty array passed", () => {
    const inst = makeInstance();
    const card = buildAgentCard(inst, VERSION, []);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("general-assistant");
  });

  it("sets text/plain for input/output modes", () => {
    const inst = makeInstance();
    const card = buildAgentCard(inst, VERSION);
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
  });

  it("sets provider to ClawNexus", () => {
    const inst = makeInstance();
    const card = buildAgentCard(inst, VERSION);
    expect(card.provider.name).toBe("ClawNexus");
  });

  describe("remote_card integration", () => {
    it("prefers remote_card.skills over skills param", () => {
      const inst = makeInstance({
        remote_card: {
          skills: [{ id: "remote_tool", name: "Remote Tool", description: "From remote", tags: [] }],
          card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      const localSkills = [
        { id: "local_tool", name: "Local Tool", description: "Local", tags: ["general"] },
      ];
      const card = buildAgentCard(inst, VERSION, localSkills);
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe("remote_tool");
    });

    it("falls back to skills param when remote_card.skills is empty", () => {
      const inst = makeInstance({
        remote_card: {
          skills: [],
          card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      const localSkills = [
        { id: "local_tool", name: "Local Tool", description: "Local", tags: ["general"] },
      ];
      const card = buildAgentCard(inst, VERSION, localSkills);
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe("local_tool");
    });

    it("falls back to DEFAULT_SKILL when remote_card.skills is empty and no param", () => {
      const inst = makeInstance({
        remote_card: {
          skills: [],
          card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      const card = buildAgentCard(inst, VERSION);
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe("general-assistant");
    });

    it("uses capabilities from remote_card", () => {
      const inst = makeInstance({
        remote_card: {
          skills: [{ id: "t", name: "T", description: "", tags: [] }],
          capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: false },
          card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      const card = buildAgentCard(inst, VERSION);
      expect(card.capabilities.streaming).toBe(true);
      expect(card.capabilities.pushNotifications).toBe(true);
      expect(card.capabilities.stateTransitionHistory).toBe(false);
    });

    it("treats missing capability fields in remote_card as false", () => {
      const inst = makeInstance({
        remote_card: {
          skills: [{ id: "t", name: "T", description: "", tags: [] }],
          capabilities: {},
          card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      const card = buildAgentCard(inst, VERSION);
      expect(card.capabilities).toEqual({
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      });
    });

    it("uses input/output modes from remote_card", () => {
      const inst = makeInstance({
        remote_card: {
          skills: [{ id: "t", name: "T", description: "", tags: [] }],
          input_modes: ["text/plain", "image/png"],
          output_modes: ["text/markdown"],
          card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      const card = buildAgentCard(inst, VERSION);
      expect(card.defaultInputModes).toEqual(["text/plain", "image/png"]);
      expect(card.defaultOutputModes).toEqual(["text/markdown"]);
    });

    it("defaults to text/plain when remote_card has no input/output modes", () => {
      const inst = makeInstance({
        remote_card: {
          skills: [{ id: "t", name: "T", description: "", tags: [] }],
          card_url: "http://192.168.1.10:17890/.well-known/agent-card.json",
          fetched_at: new Date().toISOString(),
        },
      });
      const card = buildAgentCard(inst, VERSION);
      expect(card.defaultInputModes).toEqual(["text/plain"]);
      expect(card.defaultOutputModes).toEqual(["text/plain"]);
    });
  });
});
