import Cartesia from "@cartesia/cartesia-js";
import { createAgentsService } from "./agents.service.js";
import { createCallsService } from "./calls.service.js";

export type { Agent, CreateAgentOptions } from "./agents.service.js";
export type {
  CallOptions,
  CallRecord,
  StartedCall,
  TranscriptTurn,
} from "./calls.service.js";

export const CARTESIA_VERSION = "2026-08-14";

export interface CartesiaServiceOptions {
  apiKey: string;
  /** Override the HTTP transport for testing. */
  fetch?: typeof globalThis.fetch;
}

/** Create a server-side service. Construction does not make API requests. */
export function createCartesiaService(options: CartesiaServiceOptions) {
  if (!options.apiKey?.trim()) {
    throw new Error("A Cartesia API key is required.");
  }

  const client = new Cartesia({
    apiKey: options.apiKey,
    baseURL: "https://api.cartesia.ai",
    defaultHeaders: { "Cartesia-Version": CARTESIA_VERSION },
    maxRetries: 0,
    timeout: 30_000,
    logLevel: "off",
    fetch: options.fetch,
  });

  return {
    ...createAgentsService(client),
    ...createCallsService(client),
  };
}

export type CartesiaService = ReturnType<typeof createCartesiaService>;

export { enforceConnectedCallDeadline } from './calls.service.js';
export { EASYGRID_VOICE_PROMPT, buildEasyGridVoiceVariables, normalizeCartesiaTranscript, validateEasyGridVoiceCandidate, reviewEasyGridToolResponse, createEasyGridVoiceRuntime } from './easygrid-voice.js';
export type { VoiceTurn, VoiceCondition, VoiceCandidate, VoiceReviewInput, EasyGridVoiceReviewer } from './easygrid-voice.js';
export { easyGridVoiceToolDefinitions, provisionEasyGridVoiceTools } from './easygrid-tools.js';
