# Simple Cartesia calling services

Create an agent, change its prompt, call a number, and fetch the call record from
any TypeScript/Node.js backend. No callback server or database is required.

## Install and build

Requires Node.js 22 or newer. From this folder:

```sh
npm ci
npm run build
```

To use it from another Node project, install this folder as a local dependency:

```sh
npm install /absolute/path/to/easygrid-calhacks-26/services/cartesia
```

Then import `createCartesiaService` from `@easygrid/cartesia`. The package exports
compiled ESM and TypeScript declarations. Rebuild it after changing the services.

## Set up Cartesia once

1. Create a standard API key at [Cartesia Keys](https://play.cartesia.ai/keys).
   Keep it in your backend's secret configuration.
2. In the Cartesia Playground, open **Phone Numbers → Add Number → Cartesia
   Number**. Save the resulting phone-number resource ID as
   `CARTESIA_FROM_NUMBER_ID`; this is an ID, not the numeric phone number.
   Cartesia-provided numbers support outbound calls to US destinations. Ensure
   your account has sufficient agent/telephony balance.
3. Choose a voice in the Playground's voice library and copy its ID. Choose an
   available Managed Agents LLM and its model ID; this is separate from a Sonic
   speech model. The model catalog is also available through
   [`GET /v1/agents/models`](https://docs.cartesia.ai/agents/models).
4. Choose your own destination phone number in international format (`+1…`).

The example creates a Managed Agent through the API. Save the returned agent ID
to reuse it on later calls. You can also supply an existing Managed Agent ID.

## Use from your backend

Supply real account values in place of these variables:

```ts
import { createCartesiaService } from "@easygrid/cartesia";

const cartesia = createCartesiaService({ apiKey });

// Create once; save agent.id in your application's configuration.
const agent = await cartesia.createAgent({
  prompt: "Ask how their day is going, thank them, and end the call.",
  voiceId,
  modelId,
});

const call = await cartesia.call({
  agentId: agent.id,
  fromNumberId,
  toNumber,
});

// Applies to future calls. Existing calls retain their starting configuration.
await cartesia.updateAgentPrompt(agent.id, "Your new instructions");

// Fetch again later for the finished call's status and transcript.
const result = await cartesia.getCall(call.id);
console.log(result.status, result.transcript);
```

`createAgent` also accepts an optional `name` and `initialMessage`. The default
greeting is “Hi! I'm an AI assistant calling for a quick conversation.” Supply
your own greeting, or `null` to wait for the person to speak first. Agents use
English and have the built-in `end_call` tool enabled.

`call` returns when Cartesia accepts the call, before the person answers. Its `id`
is an alias for the returned `agent_call_id`; other provider fields are preserved.
`getCall` returns the provider record, including technical status and any available
transcript. A transcript can be absent or null while unavailable or redacted.
Call completion does not imply any business outcome.

The service uses the official SDK, HTTPS, bearer authentication, API version
`2026-08-14`, and a 30-second request timeout. Requests are not automatically
retried: after a network failure the provider may already have accepted a call.
SDK HTTP/connection errors propagate unchanged. A rejected destination inside an
HTTP 200 response throws a standard `Error` with the provider rejection as `cause`.

The SDK's typed agent methods use the older API, so these wrappers use its
low-level request methods for the documented Managed Agents endpoints.

## Run a real example

From this folder, copy `.env.example` to `.env` and fill in the values. Running
this command creates an agent if `CARTESIA_AGENT_ID` is empty and places one real
call to `CARTESIA_TO_NUMBER`:

```sh
node --env-file=.env --import tsx examples/call.ts
```

The example prints the agent ID for reuse and the call ID for later retrieval.
Change the example prompt before creating an agent, or call `updateAgentPrompt`
for an existing agent. Importing the package or creating the service makes no
network requests. Environment loading happens only in your app or this example.

## Verify locally

```sh
npm test
npm run typecheck
npm run build
```

Tests use mocked HTTP responses and never make real calls. For a live check,
call your own phone, finish the sample conversation, then use `getCall` with the
printed call ID to inspect the completed record.

References: [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions),
[agent configuration](https://docs.cartesia.ai/agents/configuration),
[Managed Agents creation](https://docs.cartesia.ai/agents/migrate-from-line-sdk),
[outbound calling](https://docs.cartesia.ai/line/integrations/telephony/outbound-dialing),
[call records](https://docs.cartesia.ai/api-reference/agents/calls/get-call),
[Cartesia numbers](https://docs.cartesia.ai/line/integrations/telephony/cartesia-numbers).


## CAL-34 decision tools and short calls

`createAgent` accepts optional `toolIds` for provisioned authenticated webhook
resources and maps them to `config.tools: [{id}]`. `call` accepts optional
`dynamicVariables`; these are per-call data and do not change a shared prompt.
Use shared `NEGOTIATION_VOICE_PROMPT` and `negotiationCallVariables(attempt)` after
CAL-29 prepares/reserves the opening offer. Tool context is never authorization.

`cancelCall(id)` requests provider cancellation, which is supported only for
`started` calls. `enforceConnectedCallDeadline` checks a persisted connected
 timestamp against a default 60-second limit; CAL-29/CAL-33 must schedule it.
It does not install a background timer. Failed cancellation is `unknown`, not
proof the telephone call ended. The 30–45-second prompt target is separate.

Verified provider contracts: [configuration](https://docs.cartesia.ai/agents/configuration),
[dynamic variables](https://docs.cartesia.ai/agents/dynamic-variables),
[webhook authentication](https://docs.cartesia.ai/agents/webhook-tools), and
[cancellation](https://docs.cartesia.ai/api-reference/agents/calls/cancel-call).

## Integrated full-compensation voice runtime

`createEasyGridVoiceRuntime` adds the current single-compensation flow without
changing the older CAL-34 component interface. Supply the existing Cartesia
service, a reviewer, agent ID and
originating-number ID. Its `start` makes one provider request; `inspect` reads
that same provider call and reviews a completed transcript. Persistence,
authorization, scheduling, duplicate-action protection and geometry verification
belong to the host. An `unknown` result never authorizes another dial.

For the two-provider demo, the reviewer can load its saved, authenticated
Cartesia response and return `reviewEasyGridToolResponse(response, input)`.
This matches the full quote to actual provider transcript turns and corroborates
the spoken approved offer without a second model account. The runtime validates
the result again. `createEasyGridClaudeReviewer` is an optional alternative
extractor; it is not required to use Cartesia and SpacetimeDB together.

Use `EASYGRID_VOICE_PROMPT` when provisioning the agent. The current prompt
states only the approved full compensation and does not add monthly rent.
`start` receives the destination, exact opening/maximum cents and a private
attempt-scoped credential. The credential is passed as a dynamic header value,
never interpolated into speech. Keep the entire provider call record and its
dynamic variables server-private; public projections must omit them.

`easyGridVoiceToolDefinitions(publicHttpsOrigin)` creates pure definitions for
`evaluate_counteroffer` and `record_owner_response`. `provisionEasyGridVoiceTools`
is an explicit setup operation with a required durable `onCreated` checkpoint.
Resume with saved IDs; an uncertain creation must be reconciled before any retry.
Tools call `/api/voice/tools/counteroffer` and `/api/voice/tools/response`, using
an attempt-scoped `Authorization` value and Cartesia's own call ID in the
`X-EasyGrid-Call` header. The host must check both against its persisted attempt.
Tool/model arguments are candidate evidence, never authorization or acceptance.

`normalizeCartesiaTranscript` consumes the documented GET-call transcript array,
excludes summaries/tool arguments, and generates stable opaque evidence IDs.
The documented timestamp unit is unspecified, so it preserves provider ordering
without inventing millisecond timings. Unknown speaking roles, redacted records
and missing transcripts remain for review.

The runtime independently validates the extractor's complete owner/offer quotes,
speaker order, exact cents, final response and approved offer history. A simple
explicit yes-if agreement to place towers at one cardinal edge of the original parcel can return
`conditional`. This does not establish geometric feasibility: the host must
verify the requested edge is actually reached within the original parcel before
acceptance. This scope does not prove an entire line corridor lies along that edge;
whole-line/route requests and generic "it" remain for review. Location requests without agreement, extra demands and ambiguous
conditions remain for review. No second phone call is scheduled automatically.

These paths are covered by synthetic provider/transcript tests. No live call,
public webhook deployment or account configuration is implied by their presence.
