# CAL-41 — EasyGrid refusal to contracts

The current contract terms provide one 100% compensation payment per owner after
every final-route agreement has both signatures. The earlier deposit/completion
split is superseded. The local simulation can demonstrate that full payment;
the current live Nessie integration records a sandbox transaction only and does
not establish landowner settlement.

Run `npm ci --ignore-scripts --prefix packages/contracts`, then `npm run dev --prefix apps/map-preview`. The map is at http://127.0.0.1:4177/ by default. Set EASYGRID_PREVIEW_PORT to choose another port. /contracts.html remains the independent fixture example.

In the map, register a fictional demo participant, place A/B and analyze an eligible route. Click **Simulate refusal**. Once the new route is confirmed, **Continue to contract & settlement** in either the map overview or analysis panel opens the full contract workspace. The excluded participant keeps the original role but is not included in the contract/payment parcels. The earlier faded route and bold updated route stay available on the map.

Preparing contracts registers the exact current proposal with the local server. Public routing restrictions accompany the redacted proposal; the server rebuilds the constrained geometry, original owners, amounts and recipients from trusted fixtures and checks the complete binding. No browser-supplied compensation overrides it. Duplicate clicks are blocked while preparing. Route, participant or context changes abort pending preparation and invalidate the previous workspace.

The route demo assumes fictional owner acceptance only. Every final-route
contract still requires both current simulated signatures before the explicit
full-amount action. Opening the workspace or signing an agreement triggers no
payment or provider record. There is no deposit, completion balance or monthly
payment control.

With the default local simulation, each approved full amount can be paid once;
optional construction starts only after all full payments are confirmed.
With the configured Nessie record-only capability, one explicit action creates
a provider record for the whole approved amount. Exact readback verifies the
record; it does not mark the obligation paid, post a payment journal, or start
construction. The current API has no receiving-account field, so recipient
metadata in a description cannot be treated as evidence of money reaching that
account. Payer/recipient setup and contract binding remain prerequisites, not
proof of settlement.

The provider exposes `paymentSemantics: 'record-only'` and
`amountIncrementCents: 100` in configuration, execution and map-approval results.
Successful readback projects the terminal `recorded` status and verified provider
reference. The default local provider instead uses `simulated-transfer` with a
one-cent increment. Hosts must preserve this distinction rather than treating
every successful provider result as paid compensation.

The deployed provider was observed truncating a fractional-dollar amount. The
record-only adapter therefore blocks approved amounts with cents before POST;
it never rounds or edits the contract to fit the provider. Existing whole-dollar
examples include Amelia's $1,144 map agreement and the standalone $12,000 Willow
Creek agreement. All route signatures are still required when using the map.

Existing unknown or pending attempts retain their evidence and cannot be
resubmitted by switching capability, creating a new draft, or changing the route.
Use status/reconciliation and preserve the private ledgers and locks. Do not
delete records or change IDs to make a retry possible. See
[Nessie setup](NESSIE_SETUP.md) and the [preview runbook](../apps/map-preview/PREVIEW.md).

The host retains setContractNegotiation, setContractAgreement, setConstructionHandler, reportConstructionComplete and closeContracts on window.easygridDemo. Live calls, canonical SpacetimeDB registration, authenticated roles and the actual construction animation remain separate integration work.

Historical validation: the original staged-payment integration initially passed
151/152 local tests before its obsolete summary assertion was updated. That
evidence does not establish the current record-only workflow. Current live
setup verified all 26 fictional recipient mappings; the provider's minimal
create/readback schema has been observed, including its fractional-amount
truncation and absent payer/payee fields. A successful API record must be reported
separately from a payment. See the current PR and CAL-37 for exact-commit tests
and the completed versus pending browser demonstration.
