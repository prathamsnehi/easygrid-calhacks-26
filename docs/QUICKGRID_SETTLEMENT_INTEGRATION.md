# CAL-41 — EasyGrid representative contract demo

The current map demo presents **one representative landowner agreement**, its
signatures and its single 100% compensation action. It does not sign, pay or
claim settlement for every owner on the route. The earlier repeated-agreement
and deposit/completion journeys are outside this shortened demonstration.
Local simulation can demonstrate the selected owner's full payment; the current
live Nessie capability creates a sandbox transaction record only and does not
establish landowner settlement.

Run `npm ci --ignore-scripts --prefix packages/contracts`, then
`npm run dev --prefix apps/map-preview`. The map is at
http://127.0.0.1:4177/ by default. Set `EASYGRID_PREVIEW_PORT` to choose another
port. `/contracts.html` remains an independent fixture example using its normal
full-package workflow; the single-owner scope applies to the map demo.

In the map, register a fictional demo participant, place A/B and analyze an
eligible route. Click **Simulate refusal**. Once the new route is confirmed,
**Continue to contract & settlement** opens the representative agreement.
The excluded participant keeps the original role and is not selected as the
example owner. The faded previous route and bold updated route remain available
on the map. Route acceptance remains a fictional demo assumption.

Preparing the example still registers and validates the exact current route
with the local server. Public routing restrictions accompany the redacted
proposal; the server reconstructs geometry, original owners, amounts and
recipients from trusted fixtures and checks the complete binding. The browser
cannot override compensation or choose an arbitrary recipient. Route,
participant or context changes invalidate the previous workspace.

## One agreement, two signatures, one explicit action

The server chooses parcel `L017` when it belongs to the final route. Otherwise
it selects the first whole-dollar agreement, or the first agreement if none has
a whole-dollar amount. This selection does not round amounts or alter accepted
terms. Review the chosen owner's document and exact compensation, edit optional
draft details or export the document, then add the two simulated signatures.
There is no multiowner batch-signature action or payment-owner selector in this
shortened journey.

**Continue to payment** opens the selected agreement's payment review after its
current signatures are present. Opening the workspace, signing or opening
review makes no bank request. The final payment/record action remains a separate
explicit click. Review shows the exact amount, provider, current status and any
record reference; previous attempts, provider precision and setup can still
block final execution. Editing the draft invalidates its signatures.

## Scoped API and preserved evidence

The map calls `POST /api/contracts/approve-map` with
`{context, demoScope: 'single-owner'}`. The response adds `demoScope` and
`demoParcelId`; the canonical source, source key and package ID remain unchanged.
Subsequent scoped commands must carry matching `packageId`, `demoScope` and
`demoParcelId`. This is an explicit local demonstration scope, not approval to
settle the rest of the route or a change to the shared schema.

Execution exposes `paymentReady` for the representative agreement.
`agreementProgress` describes that one agreement, while `routeAgreementProgress`
retains full-route progress and `packageReady` retains its all-route meaning.
The example therefore does not manufacture signatures for omitted owners or
claim the entire package is complete. Construction is unavailable in this scope.
New local mock agreements use `contractTermsVersion: 2`; existing unversioned or
version-1 sources retain their exact terms and signature bindings.

The representative agreement reuses its existing business obligation and
payment evidence. An existing unknown or recorded attempt remains on the same
identity and cannot be resubmitted by entering this scope. If an excluded owner
already has payment-attempt or journal evidence, conversion is rejected and the
original package is preserved. Do not delete ledgers, change IDs or recreate a
source to force the example through.

With local simulation, the selected owner's approved full amount can be paid
once. With Nessie record-only capability, the explicit action creates a provider
record for that exact amount. Matching readback verifies the record; it does not
mark the obligation paid, post a payment journal or start construction. The
current API has no receiving-account field, so recipient metadata in a
description is not evidence of funds reaching that account. Payer/recipient
setup and contract binding remain prerequisites, not proof of settlement.

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
Creek agreement. The map representative example requires its own two current
signatures; the normal full-package workflow retains its all-route signature gate.

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
