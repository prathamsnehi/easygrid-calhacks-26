# CAL-37: Nessie fictional-account setup

This CLI prepares Capital One Nessie sandbox accounts for EasyGrid's provider
demo. Contract terms specify one full compensation payment after every
final-route agreement has both signatures. The current Nessie capability is
**record-only**: it creates and verifies a sandbox record, not a confirmed payment
to the landowner. Setup itself never creates a transaction record.
Balances and account holders are fictional. A provider connection does not turn
the development click signatures into authenticated signatures.

## Current provider behavior — October 25, 2026

Live setup verified one payer and all 26 fictional recipient accounts. The
account-scoped list endpoint represents an empty result with HTTP 404 and the
exact JSON string `No transfers found for this account`. The adapter accepts
only that response after verifying both account identities; other errors stay
errors.

The deployed create endpoint accepts `transaction_date`, `status`, `amount` and
`description`; the tested status is `pending`. It rejects the historical SDK's
`medium` and `payee_id` fields. Creation acknowledges `objectCreated._id`, while
the subsequent record contains `id`, date, status, amount and description. No
payer/payee field establishes a receiving account. A destination in description
metadata is not bank confirmation that the destination was credited.

A live schema check sent $0.01 and read back amount 0. Because the provider
truncates fractional dollars, the application permits only approved whole-dollar
amounts in record-only mode and checks the exact amount on readback. It never
rounds compensation or changes signed terms. Existing suitable examples are
Amelia's $1,144 map agreement and the standalone $12,000 Willow Creek agreement.
The map still requires signatures on every current route agreement.

The API advertises `paymentSemantics: 'record-only'` and
`amountIncrementCents: 100`. A matched provider readback produces `recorded`,
with a provider reference; it cannot produce `paid`, a paid journal entry or
construction readiness. This remains true if the provider later labels the
record completed. The default local simulation is a separate capability and
can demonstrate simulated full settlement with exact cents.

Previously pending, processing or unknown attempts stay locked. Check their
recorded state and reconcile existing evidence; never clear a ledger, replace
an obligation ID or resend merely because the capability changed. Successful
record creation is not evidence of account-to-account settlement.

## Verified contract-to-record flow

On October 25, the main-map flow was exercised in the browser: simulated refusal,
confirmed replacement route, all eight agreements signed, then one explicit
registration for Amelia Shaw's full $1,144. The API generated a record ID; GET
readback matched the ID and exact 114400 cents, and the payer list contained
exactly one matching obligation record. The UI displayed `Recorded in Nessie`
and disabled repeat registration. The provider status remained `pending`;
the payer and recipient retained their seeded balances, no paid journal was
posted, and construction remained absent. Three earlier uncertain compatibility
attempts were preserved without replacement requests. No private identifiers
or credentials are included in this evidence.

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
  and leaves sandbox record writes disabled.
- Adding `--enable-transfers` permits the application's separately gated sandbox
  record creation after full setup. The existing flag name is retained for
  compatibility; it does not grant the provider a recipient-transfer capability
  or create a record itself.

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

Setup is only account preparation. Demonstrate the Nessie record through the
approved contract workflow: all required signatures, one explicit full-amount
record request per owner, then exact provider readback. A verified record has no
construction gate or second payout and never unlocks construction itself. Check
the map integration separately; a standalone fixture record does not prove the
selected-map path.

## Validation and historical live evidence

The following is historical evidence, superseded by the October 25 observations
above where they differ. Before the EasyGrid/full-payment revision, the
authenticated official Nessie
documentation UI on October 24, 2026 returned HTTP 200 for customer listing and
HTTP 201 for a synthetic customer under the former utility display name
and Checking account. At that time, the local execution environment could not
resolve the Nessie API hostname, so CLI setup and a live transfer were unverified.
The Swagger Transfers section did not expose transfer creation, and the adapter's
account-transfer list/create routes still needed live compatibility verification.
The later record observations above do not verify recipient settlement. Do not
interpret mocked adapter tests as a successful bank payment.

The map and standalone workflows use separate provider ledgers and bind saved
state to the API origin and payer. All route signatures and approval must match
before the operator can request a record for the full approved amount. Signing
creates no record. Matching record evidence establishes only `recorded`, never
paid compensation. Unknown outcomes require reconciliation; a failed or
rejected outcome requires review. Signatures and balances remain demonstration
data; SpacetimeDB/authenticated signer integration is separate.

```sh
node --test tests/nessie-setup.test.mjs
```

Tests use an injected provider and private persistence callback to verify rerun
reuse, partial failure recovery, ambiguous matches, mapping protection and
read-only checks. They do not establish live provider connectivity. A successful
live `--check`, provider records and later transaction reconciliation must be
verified separately. Network restrictions may block the CLI even when the
provider works in an authenticated browser.

Record-only startup also refuses any existing paid obligation or settlement journal. Preserve that ledger for controller review; do not erase it to re-enable registration.
