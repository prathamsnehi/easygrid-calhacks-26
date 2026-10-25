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

The dedicated database exists and is private. The matching application module
has not been published there, and its application-worker token is not set.
An independent worker identity must be registered on this database; do not
copy a collaborator's worker token or use an administrative deployment token.
Keep `EASYGRID_VOICE_ENABLED=no` until that setup and Cartesia checks pass.

The current Cloudflare Pages deployment uses its existing D1 simulation ledger.
It does not connect to any SpacetimeDB database. Changing the private voice
environment alone does not enable hosted live calls or migrate the ledger.
This change leaves Cloudflare, Cartesia, and payment-provider settings alone.

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
