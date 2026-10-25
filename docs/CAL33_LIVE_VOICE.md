# CAL-33: local map and live voice integration

This integration builds on PR #25's exact agreed-compensation flow: **one 100%
payment after the required signatures**. A call never signs an agreement or sends
money. The map and landowners remain fictional; the participant explicitly
consents to an English roleplay call.

## Setup

Use Node.js 24. From the repository root, install dependencies and build the local
services before starting the map server:

```sh
npm ci --ignore-scripts --prefix packages/contracts
npm ci --ignore-scripts --prefix services/cartesia
npm ci --ignore-scripts --prefix services/spacetimedb
npm run build --prefix packages/contracts
npm run build --prefix services/cartesia
npm run build --prefix services/spacetimedb
npm run build --prefix apps/map-preview
cd apps/map-preview
cp .env.voice.example .env.voice
chmod 600 .env.voice
```

Replace the placeholders locally. `SPACETIMEDB_TOKEN` must be a stable application
identity token authorized for the matching published module, not a CLI admin
token. `EASYGRID_VOICE_SECRET` must be a securely generated secret of at least
32 characters. Keep these credentials out of source, browser code and logs.

The hosted database must separately receive the matching module changes in
`services/spacetimedb/module`. Building this repository does **not** publish that
module. See [the SpacetimeDB setup](../services/spacetimedb/README.md).

Configure an HTTPS proxy that exposes **only**:

- `/api/voice/tools/counteroffer`
- `/api/voice/tools/response`

Keep the browser, contract, payment, call-start and event endpoints on localhost.
Set `EASYGRID_VOICE_PUBLIC_URL` to that HTTPS tool-proxy origin. The tools use
authenticated requests; a public URL alone does not authorize a call outcome.

From `apps/map-preview`, provision or check the configured Cartesia resources:

```sh
node --env-file=.env.voice server/voice-setup.mjs --provision
node --env-file=.env.voice server/voice-setup.mjs --check
```

Provisioning requires `CARTESIA_VOICE_ID`, `CARTESIA_MODEL_ID`, the public URL and
the API key. It creates the authenticated tools and configured agent, uses a
checkpoint, and prints the non-secret agent ID. Put that ID in
`CARTESIA_AGENT_ID`; preserve the checkpoint if a response is uncertain. `--check`
reads the configured agent and verifies its instructions and tool IDs. Neither
command places a call or deploys the database module.

After the module and agent are ready, set `EASYGRID_VOICE_ENABLED=yes` and start:

```sh
node --env-file=.env.voice serve.mjs
```

Open the localhost URL printed by the server. Voice readiness requires the
enabled flag, complete configuration and a successful read-only startup check
of the configured agent instructions and tool IDs. Failed verification leaves
calling unavailable. Restart after changing the private environment file.
A readiness check is not proof of a completed live call.

## User flow

### Separate database-procedure demo

The earlier consented-call demo is retained as an explicit alternative for a
database that already publishes `start_call`. It uses Cartesia managed speech,
one Claude transcript review after hangup, and redacted summary polling. Its
opening/final compensation and monthly fee are demonstration terms. It does not
authorize the newer contract/payment path or perform its conditional rerouting.

Start this mode with `EASYGRID_VOICE_ENABLED=yes`,
`EASYGRID_VOICE_MODE=database-procedure`, `SPACETIMEDB_URI` set to the HTTPS
database origin, and both `SPACETIMEDB_DATABASE` and
`SPACETIMEDB_EXPECTED_DATABASE` set to the same explicitly chosen published
database. Then run `npm run dev --prefix apps/map-preview` from the repository
root. Provider keys stay in that database's private environment. The server
returns only its non-secret origin/database configuration to the local browser.
There is no automatic fallback from a disabled or misconfigured server adapter
to this mode. Hosted simulation keeps voice disabled.

This legacy procedure uses `call_attempt`, `call_turn`, `voice_agent`,
`call_check`, and `negotiation_summary`; its redacted view is named `call_result`
to avoid the separate CAL-41 `negotiation_result` table. It retains one attempt
per session. An uncertain submission still needs reconciliation; do not start a
new demo merely to retry an unknown call.

### Configured server adapter

1. Enter the roleplay participant details and consent, place both facilities, and
   select the route. **Agent call** is the explicit call-start action.
2. A verified acceptance saves the exact agreed integer cents and opens that
   participant's contract. The contract service resolves saved approval evidence;
   browser-supplied amounts cannot authorize the agreement or payment.
3. A verified refusal uses the existing refusal reroute. Replacement owners stay
   explicitly labeled simulated; their responses are not attributed to live calls.
4. Conditional acceptance supports an explicit tower-placement request at the
   north, south, east or west edge of the **original parcel**. The backend must
   prove the condition, engineering feasibility and unchanged outside impact.
   It then installs the verified route and accepts the saved amount without a
   second call. A line/corridor move, ambiguous request, unsupported condition or
   changed neighboring impact stays in review.

The agent speaks English and introduces no deposit, completion payment or new
monthly obligation. The backend may end a connected call at its 60-second
deadline; an unresolved result remains for review. Pending, unavailable or ambiguous results never imply
acceptance. Reconnection reads saved results; duplicate and stale events cannot
repeat a call, reroute or automatic contract opening. Participant contact data
goes only in the private call-start POST body, never event URLs or public exports.
On refresh, the server's active session is restored only before a new demo starts
and only when both saved facility coordinates match. The participant still
registers again before the map unlocks. Restoring a session never places a call,
loads private contact into the page, or replaces edited facilities.

## Validation and current limits

```sh
npm test --prefix services/cartesia
npm run test:voice --prefix services/spacetimedb
npm test --prefix services/spacetimedb/module
npm test --prefix apps/map-preview
```

Tests use mocked provider responses, synthetic geometry and a controlled UI
renderer. They cover exact accepted amounts, acceptance/refusal/review behavior,
private request transport, reconnects, duplicate/stale events and payment gates.
They do not establish browser layout, real phone delivery or live provider state.

Local verification on this implementation:

- Cartesia: 33 tests; typecheck and build passed.
- Optional Claude reviewer: 11 tests; typecheck and build passed.
- SpacetimeDB client: 12 tests; module: 33 tests; typechecks passed.
- The module suite includes a real SDK transaction test through the coordinator,
  transcript validator, contract signatures and full simulated payment. Restart
  preserves one call, one exact payment and one ledger entry.
- Full map suite: 319 of 320 passed. The remaining existing HTTP restart test
  could not open a localhost socket (`listen EPERM`) in the execution sandbox.
  The final focused voice/API/setup suite passed all 33 checks. Later refresh UI
  changes also passed their targeted checks. Real browser/GPU checks remain open.

No actual call or hosted database publication has been performed for this
integration. Publishing the matching module, provisioning/checking the live
agent and tools, verifying the HTTPS proxy, and a separately authorized consented
call remain integration steps. A tool candidate alone is not a final acceptance;
the backend verifies provider evidence and persists the outcome first.
