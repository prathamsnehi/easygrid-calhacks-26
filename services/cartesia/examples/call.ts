import { createCartesiaService } from "../client.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running this example.`);
  return value;
}

// Validate the destination and originating number before creating any resources.
const fromNumberId = required("CARTESIA_FROM_NUMBER_ID");
const toNumber = required("CARTESIA_TO_NUMBER");
const cartesia = createCartesiaService({ apiKey: required("CARTESIA_API_KEY") });

let agentId = process.env.CARTESIA_AGENT_ID?.trim();
if (!agentId) {
  const agent = await cartesia.createAgent({
    prompt:
      "Have a brief, friendly conversation. Ask how their day is going. " +
      "After their answer, thank them, say goodbye, and use end_call. " +
      "If they ask to stop, say goodbye and use end_call immediately.",
    voiceId: required("CARTESIA_VOICE_ID"),
    modelId: required("CARTESIA_MODEL_ID"),
  });
  agentId = agent.id;
  console.log(`Created agent. Set CARTESIA_AGENT_ID=${agentId} to reuse it.`);
}

const call = await cartesia.call({ agentId, fromNumberId, toNumber });
console.log(`Call accepted: ${call.id}`);
console.log("Current status:", (await cartesia.getCall(call.id)).status);
