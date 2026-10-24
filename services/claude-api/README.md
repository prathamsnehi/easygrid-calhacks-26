# Claude access setup

This directory currently contains a credential template and access-test
instructions. It does not run a service or require a dependency install. The
reusable AI adapter will be implemented in CAL-33/CAL-34.

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
future reusable adapter.

If the request fails, retain the error for diagnosis without sharing the key.
A failed analysis must leave the real outcome pending/review-required; a
simulation must be explicitly selected and labeled. See the
[shared provider-unavailable policy](../../docs/shared-setup.md#provider-unavailable-behavior)
for the implementation requirements owned by CAL-29/CAL-33/CAL-34.
