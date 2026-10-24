# Claude post-call review adapter

This package implements the provider-neutral `NegotiationReviewer` interface and
`createClaudeNegotiationReviewer`. It sends only approved offer history and
provider transcript turns to Anthropic, validates the returned candidate, and
never records acceptance itself. `reviewCompletedNegotiation` connects a durable
CAL-29 review claim and commit; it is not a standalone daemon or database.

From the repository root:

```sh
npm ci --ignore-scripts --prefix packages/contracts
npm run build --prefix packages/contracts
npm ci --ignore-scripts --prefix services/claude-api
npm run typecheck --prefix services/claude-api
npm test --prefix services/claude-api
npm run build --prefix services/claude-api
```

Tests use synthetic transcripts and injected HTTP responses; no API key is needed.
The host loads its private env file and passes `apiKey` and `model` explicitly.
Default API version: `2026-10-21`; override with the constructor's `apiVersion`.
Requests have a 10-second timeout and are never automatically retried. Missing
transcripts, invalid JSON, non-success responses and timeouts remain review-required.
No credentials, raw provider errors or transcripts are logged by this package.

See [CAL-34 integration](../../docs/CAL34_INTEGRATION.md) for evidence validation,
public result delivery and the remaining CAL-29/CAL-33 runtime requirements.

## Existing credential and access smoke-test instructions

Use the team's **Node.js 24** baseline for later backend work. This smoke test
uses your shell and `curl`.

## Configure your local credential

From the repository root:

```sh
cd services/claude-api
if [ ! -e .env ]; then
  cp .env.example .env
fi
```

Edit `.env` and replace the placeholder with your own `ANTHROPIC_API_KEY`.
Existing `.env` files are preserved by the command above. Keep the actual key
in this ignored local file; never commit or paste it into issues, logs, or PRs.
The template contains only the credential variable. Select the model explicitly
in each request or in runtime code, rather than adding a model environment
variable.

## Verify provider access

Run this from `services/claude-api`. The subshell loads your local credential
without leaving the exported value in your parent shell:

```sh
(
  set -a
  source .env
  set +a

  curl --fail-with-body https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2026-10-21" \
    -H "content-type: application/json" \
    -d '{
      "model": "claude-sonnet-5-5",
      "max_tokens": 32,
      "messages": [
        {"role": "user", "content": "Reply with READY."}
      ]
    }'
)
```

Pratham successfully ran this exact request on **October 24, 2026**. The model
and API-version values above record that observed request; they are examples
for this smoke test, not centralized model configuration or a compatibility
guarantee for future integrations. This makes a live, billable API request.

Expect a JSON response whose `content` includes a text block containing
`READY`. That verifies this credential can access the provider and requested
model. It does not verify a running backend, transcript analysis, or the
integrated negotiation adapter.

If the request fails, retain the error for diagnosis without sharing the key.
A failed analysis must leave the real outcome pending/review-required; a
simulation must be explicitly selected and labeled. See the
[shared provider-unavailable policy](../../docs/shared-setup.md#provider-unavailable-behavior)
for the implementation requirements owned by CAL-29/CAL-33/CAL-34.
