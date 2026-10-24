import assert from "node:assert/strict";
import { test } from "node:test";
import Cartesia from "@cartesia/cartesia-js";
import { CARTESIA_VERSION, createCartesiaService } from "../client.js";

interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

function mockService(body: unknown, status = 200) {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get("authorization"), "Bearer test-key");
    assert.equal(request.headers.get("cartesia-version"), CARTESIA_VERSION);
    assert.equal(new URL(request.url).origin, "https://api.cartesia.ai");
    const text = await request.text();
    requests.push({
      method: request.method,
      url: request.url,
      body: text ? JSON.parse(text) : undefined,
    });
    return Response.json(body, { status });
  };
  return {
    service: createCartesiaService({ apiKey: "test-key", fetch }),
    requests,
  };
}

const agentOptions = {
  prompt: "Ask how their day is going, thank them, and end the call.",
  voiceId: "test-voice-id",
  modelId: "test-model-id",
};

const callOptions = {
  agentId: "test-agent-id",
  fromNumberId: "test-number-id",
  toNumber: "+14155550123",
};

test("construction makes no requests and needs an explicit API key", () => {
  const { service, requests } = mockService({});
  assert.deepEqual(Object.keys(service).sort(), [
    "call", "createAgent", "getCall", "updateAgentPrompt",
  ]);
  assert.equal(requests.length, 0);
  assert.throws(() => createCartesiaService({ apiKey: " " }), /API key is required/);
});

test("creates an English Managed Agent with the supplied prompt and hangup tool", async () => {
  const providerAgent = { id: "agent_123", name: "Phone assistant", extra: true };
  const { service, requests } = mockService(providerAgent);
  assert.deepEqual(await service.createAgent(agentOptions), providerAgent);
  assert.deepEqual(requests, [{
    method: "POST",
    url: "https://api.cartesia.ai/v1/agents",
    body: {
      name: "Phone assistant",
      config: {
        instructions: agentOptions.prompt,
        initial_message: "Hi! I'm an AI assistant calling for a quick conversation.",
        model: { id: agentOptions.modelId },
        language: { primary: "en" },
        audio: { output: { voice_id: agentOptions.voiceId } },
        system_tools: { end_call: {} },
      },
    },
  }]);
});

test("supports a custom name and greeting or a null greeting", async () => {
  for (const initialMessage of ["Hello there!", null]) {
    const { service, requests } = mockService({ id: "agent_123" });
    await service.createAgent({ ...agentOptions, name: "Demo", initialMessage });
    const body = requests[0]?.body as { name: string; config: { initial_message: unknown } };
    assert.equal(body.name, "Demo");
    assert.equal(body.config.initial_message, initialMessage);
  }
});

test("updates only the prompt using the Managed Agents endpoint", async () => {
  const response = { id: "agent_123", config: { instructions: "New prompt" } };
  const { service, requests } = mockService(response);
  assert.deepEqual(await service.updateAgentPrompt("agent/id", "New prompt"), response);
  assert.deepEqual(requests, [{
    method: "PATCH",
    url: "https://api.cartesia.ai/v1/agents/agent%2Fid",
    body: { config: { instructions: "New prompt" } },
  }]);
});

test("places one outbound call without creating an agent and preserves provider fields", async () => {
  const result = {
    number: callOptions.toNumber,
    agent_call_id: "ac_123",
    extra: { accepted: true },
  };
  const { service, requests } = mockService({ calls: [result] });
  assert.deepEqual(await service.call(callOptions), { ...result, id: "ac_123" });
  assert.deepEqual(requests, [{
    method: "POST",
    url: "https://api.cartesia.ai/agents/calls",
    body: {
      agent_id: callOptions.agentId,
      from_number_id: callOptions.fromNumberId,
      outbound_calls: [{ to_number: callOptions.toNumber }],
    },
  }]);
});

test("rejects per-destination errors in HTTP 200 responses", async () => {
  for (const error of ["Concurrency limit reached", { code: "concurrency_limit" }]) {
    const { service, requests } = mockService({
      calls: [{ number: callOptions.toNumber, error }],
    });
    await assert.rejects(service.call(callOptions), (caught: unknown) => {
      assert.ok(caught instanceof Error);
      assert.match(caught.message, /could not start the call/);
      assert.deepEqual(caught.cause, error);
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test("does not report an accepted call without a call ID", async () => {
  for (const calls of [[], [{ number: callOptions.toNumber }]]) {
    const { service } = mockService({ calls });
    await assert.rejects(service.call(callOptions), /did not return a call ID/);
  }
});

test("retrieves the current call record with transcript and extra fields intact", async () => {
  const record = {
    id: "ac_123",
    agent_id: "agent_123",
    status: "completed",
    end_reason: "agent_hangup",
    transcript: [{
      role: "assistant",
      text: "Thank you!",
      start_timestamp: 1,
      end_timestamp: 2,
      tool_calls: [{ name: "end_call", arguments: {} }],
    }],
    dynamic_variables: { example: "value" },
  };
  const { service, requests } = mockService(record);
  assert.deepEqual(await service.getCall("call/id"), record);
  assert.deepEqual(requests, [{
    method: "GET",
    url: "https://api.cartesia.ai/agents/calls/call%2Fid",
    body: undefined,
  }]);
});

test("preserves active, failed, and future statuses and unavailable transcripts", async () => {
  for (const status of ["created", "started", "failed", "future_status"]) {
    const record = { id: "ac_123", agent_id: "agent_123", status, transcript: null };
    const { service } = mockService(record);
    assert.deepEqual(await service.getCall("ac_123"), record);
  }
});

test("surfaces structured SDK API errors without retrying a failed call", async () => {
  const error = {
    error_code: "quota_exceeded",
    title: "Insufficient balance",
    message: "Add credits before calling.",
    request_id: "test-request-id",
  };
  const { service, requests } = mockService(error, 500);
  await assert.rejects(service.call(callOptions), (caught: unknown) => {
    assert.ok(caught instanceof Cartesia.APIError);
    assert.equal(caught.status, 500);
    assert.deepEqual(caught.error, error);
    return true;
  });
  assert.equal(requests.length, 1);
});

test("surfaces authentication errors from agent creation, updates, and retrieval", async () => {
  const { service, requests } = mockService({ message: "Invalid key" }, 401);
  for (const operation of [
    () => service.createAgent(agentOptions),
    () => service.updateAgentPrompt("agent_123", "New prompt"),
    () => service.getCall("ac_123"),
  ]) {
    await assert.rejects(operation(), Cartesia.AuthenticationError);
  }
  assert.equal(requests.length, 3);
});

test("does not retry call creation after a connection failure", async () => {
  let attempts = 0;
  const service = createCartesiaService({
    apiKey: "test-key",
    fetch: async () => {
      attempts++;
      throw new TypeError("Connection lost");
    },
  });
  await assert.rejects(service.call(callOptions), Cartesia.APIConnectionError);
  assert.equal(attempts, 1);
});
