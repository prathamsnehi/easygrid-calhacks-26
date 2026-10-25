# SpacetimeDB service scaffold

## CAL-41 integration workstream

The new worker-only negotiation reducers and authorized views integrate CAL-34
commands atomically while preserving the legacy module described below. Use
[`CAL41_STATE_HANDOFF.md`](../../docs/CAL41_STATE_HANDOFF.md) for the current
state/voice boundary, `@easygrid/spacetimedb/negotiation` backend adapter, review
leases and remaining integration acceptance. Build `packages/contracts` before
typechecking/building this package or its module. The new module has not been
published by this change. Legacy rerouting/20% behavior below is not the CAL-41
workflow; imported CAL-41 sessions cannot invoke it.

Backend configuration and connection setup for the shared Maincloud development
database. Requires Node.js 22+. The SDK is pinned to `2.13.0`, matching the
verified repo-local CLI baseline.

## Setup

From this directory:

```sh
npm ci
cp -n .env.example .env
```

Fill in `SPACETIMEDB_DATABASE` with the actual published database name. The default
URI is Maincloud. `SPACETIMEDB_TOKEN` is optional: use an application client token
only when restoring the intended client identity. Leave it empty for a new
identity. A new identity does not automatically have permission to mutate data;
CAL-29 implements authorization. Never use a CLI deployment token here.

The root `.gitignore` excludes `.env`. Loading the file is the backend's job;
this package never reads it automatically. Node can load it at process startup:

```sh
node --env-file=.env path/to/your-backend-entrypoint.js
```

Replace the entrypoint with your backend's actual entrypoint; this scaffold does
not provide a running backend or a database module.

## Build and consume

```sh
npm run typecheck
npm run build
```

Like the Cartesia package, this package exports compiled ESM and TypeScript
declarations. Build before installing/using it from another backend package:

```sh
npm install /absolute/path/to/easygrid-calhacks-26/services/spacetimedb
```

Once CAL-29 has published the module and generated its TypeScript bindings,
configure their builder from your backend:

```ts
import {
  createSpacetimeDBService,
  readSpacetimeDBConfig,
} from '@easygrid/spacetimedb';
import { DbConnection } from './module_bindings/index.js';

const service = createSpacetimeDBService(readSpacetimeDBConfig(process.env));
const connection = service.configureConnection(DbConnection.builder())
  .onConnect((_connection, _identity, token) => {
    // Persist token in backend-private storage if this identity should be reused.
    // Never log it or send it to the browser.
  })
  .onConnectError((_context, error) => {
    // Handle connection failure in the backend's lifecycle/error handling.
  })
  .build();

// Use generated tables, reducers and explicit subscriptions for your schema.
// Call connection.disconnect() when the backend shuts down.
```

The builder remains schema-specific after configuration. Creating the service
or configuring the builder makes no network requests; `.build()` starts the
connection. Subscriptions and reducer calls belong to the backend integration.
Client tokens, contact information and private records must stay server-side.

## Durable voice attempts

The `./voice` export supplies `createVoiceStore({ uri, databaseName, token })`
for the Node call host. It requires a stable application identity token; do not
use an administrative CLI/deployment token. It connects using generated module
bindings, requests confirmed durable subscription reads, subscribes to caller-authorized views, and waits for committed state
before returning mutation results. The host keeps the token and all private
attempt data on the server.

The checked-in `voice-bindings/` files were generated from this local module by
the official CLI 2.13.0. Regenerate after changing reducers or views, using the
repo-local CLI installation described in [shared setup](../../docs/shared-setup.md):

```sh
npm run generate:voice --prefix services/spacetimedb
npm run typecheck --prefix services/spacetimedb
npm run build --prefix services/spacetimedb
```

Generation runs a deterministic normalization script: it adds `.js` to local
imports for Node ESM and explicit return-type annotations for TypeScript 7
declaration output. It does not alter the generated schema. This client package
uses Bundler module resolution for the SDK's extensionless declaration exports;
`exactOptionalPropertyTypes` is disabled because the SDK 2.13 table constraint
types do not support it. Strict type checking remains enabled. Build requires
the generated voice schema and imports the actual compiled bindings and store
without opening a network connection, so missing bindings or invalid Node ESM
imports fail the build.

The new `voice_attempt` and `voice_provider_call` tables are private. Only the
identity that reserves an attempt can read its worker view or mutate it. The
call host reconstructs the original map and registers one attempt per session,
with explicit dated call consent, original parcel, exact offer/cap, a private
contact, and a hash of the attempt's callback credential. A second request key,
attempt ID, changed amount, or changed original parcel cannot reserve a second
call for the same session. Sessions use unpredictable server-owned identifiers.

The state sequence is `reserved` → `dispatching` → provider status →
`accepted`, `refused`, or `review_required`. Claiming must commit **before**
the provider POST. Once dispatching, restart or timeout never makes the attempt
dialable again. Recover by inspecting the saved provider ID and existing call;
an unresolved write remains unknown. An atomic database claim cannot make a
third-party API effect part of the same transaction.

Managed-agent callbacks use `recordTool({ id, claimId, requestId, kind, payload })`.
Each request ID has an immutable private receipt. A `counteroffer` payload has
`requestedCents` (integer cents, or `null` for an unspecified price objection).
Its first final offer is clamped to the saved `maxOfferCents`, which cannot exceed
the parcel cap or fall below the initial offer. Later request IDs cannot create
another increase. A `response` receipt is provisional and cannot itself open a
contract. Receipts may arrive while the outbound POST is still returning its
provider ID; the call host must authenticate the attempt-scoped callback first.

The server saves normalized provider turns before the response candidate. Owner
and agent evidence quotes must refer to the saved turns; acceptance must retain
the exact saved authorized offer in integer cents under the immutable cap. A conditional
candidate only becomes accepted after the authenticated host verifies the
requested edge relocation within the original parcel, records the geometry
hash and matching condition/bindings, and preserves the agreed amount. The
module checks this evidence binding; it does not independently run geometry
validation or infer consent from speech. A completed call alone never counts
as acceptance.

Terminal outcomes are immutable. Their event ID is
`voice-${attempt.id}-${attempt.revision}` and their timestamp comes from
`updatedAtMicros`, not the time a reader opens the page. `voice_results` omits
contact data, callback credentials, provider IDs, and transcript text. The
worker-only view contains the private evidence needed for recovery. Normal
provider polling cannot overwrite terminal results or change the provider ID.

This path explicitly uses `full-after-signatures`; it creates no legacy payment
obligation and never calls `record_outcome`. The existing contract service owns
signatures and the eventual one-time 100% compensation payment. Neither the
new module nor generated bindings establish that a live call, Maincloud
deployment, or end-to-end subscription was tested.

## Legacy state module

The following original module behavior is retained for compatibility. It is
**not** the current voice integration and must not receive its accepted result.

The authoritative module lives in `module/`. It stores one demo session, the
private participant phone, the current tower route, and simulated contract
payments. CAL-33 adds a private call attempt, a private transcript, and one
public redacted summary. `start_call` dials Cartesia. A scheduled `check_call`
reads the transcript after hangup and asks Claude to review it. The module
checks that review against the stored opening price and the one final price.
It does not use `record_outcome`, so this call does not mark the other owners
agreed. That all-parcel gate stays with CAL-41.

Cartesia and Anthropic keys are declared module environment variables. Publish
them from the process environment. They are not written into the module, git,
or a public table. `CARTESIA_NEGOTIATION_AGENT_ID` is optional and is separate
from the existing `CARTESIA_AGENT_ID`. `CARTESIA_FALLBACK_TO_NUMBER` is used
only when the map registration has no usable phone.

For the hackathon, one phone number roleplays one tower-parcel owner at a time.
The other tower parcels on that route are recorded as agreed without a call.
A refusal excludes that parcel. The next published route binds the same phone
number to one new tower owner: most towers, then the longest crossing, then the
lowest parcel id. A clear yes opens one 20% contract tranche per tower parcel.
A second request key cannot create that tranche again. Corridor parcels are
ignored. Needs review leaves the route in place and blocks payment.

Published database: `easygrid-demo`.
Identity: `c200a6a781f8d5d17fb3f77d114184a7c758df84eaab7ca069606d32a88fe17f`.
Dashboard: https://spacetimedb.com/easygrid-demo.
SDK and CLI: 2.13.0. Collaborator access for Theo and Stella is not configured yet.

```sh
npm test --prefix services/spacetimedb/module
./.tools/spacetime-cli publish easygrid-demo \
  --server maincloud \
  --module-path services/spacetimedb/module
```

Generate client bindings from the published module before the map or the call
worker imports them. The connection helper in this package still only applies
the host, database name, and token.

For the repo-local CLI, login and Maincloud deployment workflow, see
[shared setup](../../docs/shared-setup.md).

Reference: [official Node.js quickstart](https://spacetimedb.com/docs/quickstarts/nodejs/).
