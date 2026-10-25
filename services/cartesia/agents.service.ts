import type Cartesia from "@cartesia/cartesia-js";

export interface CreateAgentOptions {
  prompt: string;
  voiceId: string;
  modelId: string;
  name?: string;
  /** Already provisioned authenticated webhook/client tools, maximum 64. */
  toolIds?: string[];
  /** Set null to wait for the other person to speak first. */
  initialMessage?: string | null;
}

/** Managed Agent response; additional provider fields are returned unchanged. */
export interface Agent {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export function createAgentsService(client: Cartesia) {
  return {
    async createAgent(options: CreateAgentOptions): Promise<Agent> {
      if (options.toolIds && (options.toolIds.length > 64 || new Set(options.toolIds).size !== options.toolIds.length || options.toolIds.some(id => !id.trim()))) {
        throw new Error("Tool IDs must be nonempty, unique, and at most 64.");
      }
      // The SDK's typed agents resource targets the older /agents API.
      // Managed Agent configuration uses /v1/agents instead.
      return client.post<Agent>("/v1/agents", {
        body: {
          name: options.name ?? "Phone assistant",
          config: {
            instructions: options.prompt,
            initial_message:
              options.initialMessage === undefined
                ? "Hi! I'm an AI assistant calling for a quick conversation."
                : options.initialMessage,
            model: { id: options.modelId },
            language: { primary: "en" },
            audio: { output: { voice_id: options.voiceId } },
            system_tools: { end_call: {} },
          ...(options.toolIds ? { tools: options.toolIds.map(id => ({ id })) } : {}),
          },
        },
      });
    },

    /** Changes future calls; calls already in progress keep their configuration. */
    async updateAgentPrompt(agentId: string, prompt: string): Promise<Agent> {
      return client.patch<Agent>(`/v1/agents/${encodeURIComponent(agentId)}`, {
        body: { config: { instructions: prompt } },
      });
    },
  };
}
