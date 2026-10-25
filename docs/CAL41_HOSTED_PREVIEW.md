# Private hosted simulation

The Cartesia/SpacetimeDB implementation is separate from this optional deployment adapter. The adapter preserves the existing map, contract, signature, and exact one-time 100% compensation workflow with simulated payments. It never starts a telephone call or invokes a banking provider.

`apps/map-preview/server/hosted-preview.mjs` adapts native Fetch requests to the contract service. Sites supplies the authenticated user ID, and each user's complete ledger is stored in one D1 row. Each request runs against an isolated snapshot and commits using revision-based compare-and-swap before responding. Concurrent signatures merge after retry; repeated payment requests retain one transfer. Storage failure never returns a successful mutation response.

## Build

After installing the existing Cartesia and shared-contract development dependencies:

```sh
node scripts/build-hosted-preview.mjs /absolute/site/worker/index.js
```

This generates a self-contained Worker source file for the Sites Worker ESM starter. It embeds the normal map build, the contract page, and redacted fixture JSON. It includes no local ledgers, contacts or credentials. The generated Worker requires Node compatibility for `node:crypto` and `node:buffer`; filesystem access is disabled and the server always injects durable storage.

The private Site's `.openai/hosting.json` must declare `"d1": "DB"`. Add a bounded schema migration through the Site's normal migration workflow:

```sql
CREATE TABLE worker_state (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
```

Keep the source `drizzle` directory and its migration journal with the Site. The Sites packaging helper includes it at `dist/.openai/drizzle`. Do not create tables during requests. Publish with the Sites source workflow and verify deployment before reporting a live URL.

## Verification and limits

The hosted regression suite covers exact compensation after both signatures, restart persistence, concurrent signatures, repeated payment, identity isolation, bounded conflict retries, failed commits, request limits and disabled live calls. Existing filesystem contract/map tests remain applicable and unchanged.

The hosted preview is deliberately a simulation: it is not a deployed SpacetimeDB service and does not prove a live Cartesia call. Actual voice setup and provider checks are documented in `CAL33_LIVE_VOICE.md`. Preserve owner-private access and never accept a browser-supplied user ID as authenticated identity outside the Sites request boundary.
