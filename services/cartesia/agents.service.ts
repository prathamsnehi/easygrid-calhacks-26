import type Cartesia from "@cartesia/cartesia-js";

export interface CreateAgentOptions {
  prompt: string;
  voiceId: string;
  modelId: string;
  name?: string;
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
