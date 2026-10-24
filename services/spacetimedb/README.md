# SpacetimeDB service scaffold

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

## State module

The authoritative module lives in `module/`. It stores one demo session, the
private participant phone, the current tower route, and simulated contract
payments. It does not place phone calls. CAL-33 dials. CAL-34 owns the spoken
negotiation. This module checks the stored result.

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
