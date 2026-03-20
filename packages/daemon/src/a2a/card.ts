// A2A Agent Card generation — maps ClawInstance to A2A v0.3.0 Agent Card

import type { ClawInstance } from "../types.js";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  provider: {
    name: string;
    url?: string;
  };
}

const DEFAULT_SKILL: AgentSkill = {
  id: "general-assistant",
  name: "General Assistant",
  description: "General-purpose AI assistant",
  tags: ["general"],
};

export function buildAgentCard(
  instance: ClawInstance,
  daemonVersion: string,
  skills?: AgentSkill[],
): AgentCard {
  // Skill priority: remote_card.skills (remote) > skills param (local) > DEFAULT_SKILL
  const resolvedSkills = instance.remote_card?.skills?.length
    ? instance.remote_card.skills
    : skills && skills.length > 0
      ? skills
      : [DEFAULT_SKILL];

  const remoteCapabilities = instance.remote_card?.capabilities;

  return {
    name: instance.alias ?? instance.auto_name,
    description: instance.display_name || instance.assistant_name,
    url: `http://${instance.address}:17890`,
    version: daemonVersion,
    capabilities: {
      streaming: remoteCapabilities?.streaming ?? false,
      pushNotifications: remoteCapabilities?.pushNotifications ?? false,
      stateTransitionHistory: remoteCapabilities?.stateTransitionHistory ?? false,
    },
    skills: resolvedSkills,
    defaultInputModes: instance.remote_card?.input_modes ?? ["text/plain"],
    defaultOutputModes: instance.remote_card?.output_modes ?? ["text/plain"],
    provider: {
      name: "ClawNexus",
      url: "https://github.com/SilverstreamsAI/ClawNexus",
    },
  };
}
