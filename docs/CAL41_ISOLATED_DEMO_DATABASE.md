# Isolated demo databases

Each independently tested voice deployment should use its own private Maincloud
database. Keep its name, identity, account dashboard and application-worker token
in private operator configuration, outside the repository.

The private `apps/map-preview/.env.voice` pins both
`SPACETIMEDB_DATABASE` and `SPACETIMEDB_EXPECTED_DATABASE` to the same dedicated name.
If a copied environment points at another database, the voice service stops
before provider verification, database connection, or outbound calling.
There is no fallback to a collaborator's database.
Other developers keep their own configuration and database unchanged.

## Runtime status

The operator has published the matching application module to a fresh private
database. Its dashboard reports 12 tables and 16 reducers. The preparation run
has saved a separate application identity and reached provider provisioning.
Both scoped Cartesia tools and the agent were subsequently created, and the
agent response matched the intended prompt, model, voice and tool IDs.
The production host is still simulation-only; this setup is not an end-to-end
phone-call verification.

Run `npm run voice:prepare --prefix apps/map-preview` from the repository root
after filling the private `.env.voice`. This builds the services, obtains or
restores a separate application identity, saves it privately, confirms the
caller-authorized voice views, and provisions/verifies the existing two-tool
Cartesia agent configuration. It preserves the identity across partial failures
and refuses a different database pin. It never reads administrative CLI
credentials, invokes a reducer, dials a phone, or enables the live host.

This voice store binds each reservation to its creating application identity;
the separate legacy negotiation worker-registration flow is not required by
the voice reservation reducers. Never copy a collaborator's worker token or use
an administrative deployment token. Keep `EASYGRID_VOICE_ENABLED=no` until the
actual authenticated host and callback endpoints have been deployed and verified.

The current Cloudflare Pages deployment uses its existing D1 simulation ledger.
It does not connect to any SpacetimeDB database. Changing the private voice
environment alone does not enable hosted live calls or migrate the ledger.
Database isolation itself leaves Cloudflare and payment-provider settings alone.
The separate explicit preparation command may create Cartesia tools and an agent;
it checkpoints those resources and never places a call.

Cartesia tool schemas use optional integer fields for amounts rather than
`nullable` properties. A refusal omits accepted compensation; approval still
requires an exact transcript-supported amount. A definitive validation or
authentication rejection clears the failed tool intent. A lost response or
server failure remains pending and must be reconciled before another creation.

## Publish only to the dedicated database

From this checkout, using an authenticated CLI 2.13.0 session owned by the
dedicated database owner, replace the placeholder with the private target:

```sh
./.tools/spacetime-cli publish YOUR_DEDICATED_DATABASE \
  --server maincloud \
  --module-path services/spacetimedb/module \
  --delete-data=never
```

Do not use the legacy shared-database publish command in the service README for
this demo. Verify the database identity against the private configuration and the published voice tables and
reducers before enabling the host. No data or credentials from the shared
database are needed for a fresh independent test.
