# CAL-37: Nessie fictional-account setup

This CLI prepares Capital One Nessie sandbox accounts for EasyGrid's optional
future provider connection. The current contract flow pays full compensation
once after every final-route agreement has both signatures. Setup itself never
creates a transfer.
Balances and account holders are fictional. A provider connection does not turn
the development click signatures into authenticated signatures.

## Private configuration

Keep credentials only in `apps/map-preview/.env.nessie`, with file mode `0600`.
The repository ignores `.env.*`. Never use `.env.example` for actual credentials,
put credentials in browser source, or paste key-bearing URLs in a ticket or log.
The default private file is resolved relative to the setup module, independent
of the shell working directory. An explicit `--env-file=path` is also supported.

The file initially needs `NESSIE_API_KEY` and
`NESSIE_API_ORIGIN=https://prod-api.nessieisreal.com`. It can retain
`EASYGRID_PAYMENT_PROVIDER=simulation` and
`NESSIE_ALLOW_SANDBOX_TRANSFERS=no` until setup finishes. The CLI reads the file
directly; inherited shell variables do not override its private setup input.

## Commands

Run from `apps/map-preview`:

```sh
node server/nessie-setup.mjs --check
node server/nessie-setup.mjs --create-demo-accounts
node server/nessie-setup.mjs --create-demo-accounts --enable-transfers
```

- No argument or `--check` performs GET requests only and changes no files.
- `--create-demo-accounts` creates missing synthetic customers/accounts, saves
  validated mappings, selects the Nessie provider only after setup completes,
  and leaves payment writes disabled.
- Adding `--enable-transfers` permits the application's separately gated sandbox
  transfers after full setup. This flag does not send a transfer itself.

The printed result separates provider account readiness (`accountsReady`) from
saved mapping completeness (`configured`); `ready` requires both and no unresolved
creation. It also contains counts and transfer-enabled status. It
contains no key, provider account/customer identifiers, request URL or raw response.

## Account plan and rerun behavior

New payer records use customer `EasyGrid / Payer Sandbox` and account nickname
`EasyGrid Payer Sandbox`. The initial simulated balance is **$10,000,000**,
set only when creating that account. Reruns never top up or overwrite a balance.
Each recipient uses `EasyGrid / <ownerId> Sandbox`, nickname
`EasyGrid <ownerId> Sandbox`, and starts at $0. All accounts use `Checking` and
zero rewards. Their address is the explicit fictional fixture `100 Demo Lane,
San Francisco, CA 94123`.

Coverage comes directly from `createWorld().owners` plus the standalone contract
example. The current map has `O001` through `O024`. The separate contract example
uses `OWNER-DEMO-004` and `OWNER-DEMO-009`; these are distinct IDs and recipients,
not aliases for map owners. Current total: **one payer plus 26 recipient accounts**.

Before each creation the CLI lists existing customers or customer accounts and
matches the stable names/nicknames. It refuses duplicate matches, a changed
synthetic identity, or replacement of an existing payout mapping. It verifies
created records through a subsequent GET, rather than treating the creation
acknowledgement as sufficient evidence.

The opaque payer key remains `CAL-POWER` for checkpoint compatibility. Existing
legacy payer names (`Cal Power Sandbox` / `EasyGrid Cal Power Sandbox`) are
recognized only to reuse the same provider records; setup does not rename them,
replace their IDs or create a second payer to reflect a branding change. If both
legacy and current names match different records, setup stops for ambiguity.

The private file holds `NESSIE_PAYER_ACCOUNT_ID`, `NESSIE_OWNER_RECIPIENTS` and a
`NESSIE_SETUP_STATE` checkpoint. Each confirmed account mapping is saved through
an atomic mode-0600 replacement. Before every POST, a pending operation is saved.
A lost response or unreadable result stops the run. On a later run a unique
matching provider record can resolve that pending operation without another POST.
If no matching record is visible, setup stays blocked for review; it never blindly
retries account creation. Do not delete the checkpoint merely to make a retry work.

Create mode uses a private `.env.nessie.setup.lock` file to prevent concurrent CLI
runs. If a process is killed, inspect the pending checkpoint and provider records
before removing a stale lock. The lock contains no credentials.

## Start the preview after setup

```sh
node build.mjs
node --env-file=.env.nessie serve.mjs
```

Set `EASYGRID_PREVIEW_PORT` in that private file when using a port other than
4177. `npm run dev` does not automatically load `.env.nessie`. A running process
does not pick up a changed environment file until restarted.

The shipped `serve.mjs` acquires `.local/nessie-server.lock` before loading either
Nessie ledger. A second process using that directory stops before handling
payments. Normal exit and startup failure release ownership. An abrupt stop
leaves a fail-closed lock: inspect the prior process and pending bank operations
before manually removing it. Do not run separate copies against the same payer
and obligations. Custom callers of `createContractAPI` must enforce exclusive
ownership themselves; this local lock is not a distributed payment store.

Before loading the new standalone full-payment ledger, Nessie startup checks
the old `nessie-contract-ledger.json`. An attempted or uncertain staged payment,
any journal evidence, or an unreadable old ledger stops startup for review.
Creating a fresh full ledger cannot bypass this guard. Preserve the old file;
do not delete evidence to make the new payment run. Unattempted holds can remain
archived, but a full payment requires new signatures on the full-payment terms.
Map packages retain their existing registry and similarly block earlier attempts.

Setup is only account preparation. Demonstrate payments through the approved
contract workflow: all required signatures, one explicit full-payment request
per owner, then provider reconciliation. There is no construction gate or second
payout. Check the current map-service integration before claiming that a
standalone fixture transfer also proves the selected-map path.

## Validation and historical live evidence

Before the EasyGrid/full-payment revision, the authenticated official Nessie
documentation UI on October 24, 2026 returned HTTP 200 for customer listing and
HTTP 201 for a synthetic customer under the former utility display name
and Checking account. The local execution environment could not resolve the
Nessie API hostname, so CLI setup and a live transfer have **not** been verified.
The current Swagger Transfers section did not expose transfer creation; the
adapter's account-transfer list/create routes still need live compatibility
verification. Do not interpret mocked adapter tests as a successful bank payment.

The map and standalone workflows use separate provider ledgers and bind saved
state to the API origin and payer. All route signatures and approval must match
before a full-payment request is accepted. Signing does not send money: the
operator submits the full payment separately. Only matching completed bank
evidence marks the exact full-compensation obligation paid. Unknown outcomes
require reconciliation; a failed or rejected transfer requires review. No new
provider connection or transfer was tested for this simplification. All
signatures and balances remain
demonstration data; SpacetimeDB/authenticated signer integration is separate.

```sh
node --test tests/nessie-setup.test.mjs
```

Tests use an injected provider and private persistence callback to verify rerun
reuse, partial failure recovery, ambiguous matches, mapping protection and
read-only checks. They do not establish live provider connectivity. A successful
live `--check`, provider records and later transaction reconciliation must be
verified separately. Network restrictions may block the CLI even when the
provider works in an authenticated browser.
