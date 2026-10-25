# Cloudflare demo deployment

This public deployment uses Pages advanced mode and D1. It preserves the exact
100% payment after required signatures, with simulated payments only. Live
Cartesia calls and SpacetimeDB are not enabled by this deployment adapter.

Build from the repository root after installing the existing Cartesia and
shared-contract development dependencies:

```sh
node scripts/build-cloudflare-preview.mjs
```

Upload only `deploy/cloudflare/dist` through Pages Direct Upload. It contains an
advanced-mode `_worker.js`, routing configuration and an index asset. Never
upload the repository root, environment files, local ledgers or participant data.
Use compatibility date `2026-10-24` with Node compatibility enabled. Create a new
D1 database, execute `deploy/cloudflare/schema.sql` once, and bind it as `DB`
in production before redeploying. Request handlers never create tables.

The first HTTPS document GET creates a random 256-bit HttpOnly, Secure,
SameSite=Strict host-only cookie. The cookie is a browser session capability,
not an authenticated person's identity. D1 keys use its SHA-256 digest. API
requests ignore client-supplied platform identity headers and require the
cookie; mutations additionally require an exact same origin and JSON marker.
Clearing the cookie starts a new demo ledger; there is no account recovery or
cross-device sharing. Do not use this deployment for real participant data.

Every ledger update uses the existing revision-based compare-and-swap adapter.
It responds successfully only after D1 confirms the commit. Replayed requests
cannot produce an extra simulated payment. Synthetic signatures are not legal
signatures or evidence of real landowner consent.

Before connecting easygrid.us, verify the deployed Pages URL: map rendering,
simulated approval/refusal, both signature gates, exact compensation, refresh,
and duplicate submission. Then add easygrid.us as a Pages custom domain and
use the assigned Cloudflare nameservers in Porkbun. Preserve existing DNS
records. Report DNS propagation or certificate issuance as pending until
HTTPS and the actual application are verified.

Cloudflare's free CPU limit can be too low for server-side route verification.
Check runtime errors and CPU usage with the real map flow; do not claim that a
static page load validates the backend. A paid Workers plan requires separate
user authorization and is not enabled by these files.
