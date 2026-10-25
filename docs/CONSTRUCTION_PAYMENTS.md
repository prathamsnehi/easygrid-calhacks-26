# Full payment after signatures

The EasyGrid demo pays each final-route landowner's approved compensation once,
in full. The earlier CAL-38 deposit/construction/balance journey is superseded.
Construction completion is not a payment condition, and the contract workspace
does not ask the operator to run an animation or request a second payout.

## Payment journey

1. Approve the final route and exact fictional landowner terms.
2. Sign both simulated roles on every agreement in that route. Each signature
   binds the document, full amount, single-payment schedule and recipient.
3. Explicitly request the selected landowner's full payment. The server derives
   the amount from approved compensation and uses `stage: 'full'` with
   `paymentSchedule: 'full-after-signatures'`.
4. Confirm the matching payment evidence. Only confirmed completion marks that
   owner's compensation paid. Repeat for the other owners; each receives one
   full payment, without a deposit, balance or recurring-rent payment.

The server enforces the all-agreement signature gate independently of the UI.
One stable business obligation per owner prevents duplicate clicks or regenerated
document IDs from producing another payment. Pending, unknown or mismatched bank
results require reconciliation; they never trigger a blind resend. Previously
attempted staged payments require review before migration and cannot be bypassed
with a fresh full-payment request.

## Construction and legacy integration boundary

The map's `setConstructionHandler` / `reportConstructionComplete` integration
hooks remain a separate compatibility surface for THEO's future animation.
Their presence does not add a payment gate, unlock another payment or establish
real construction. The simplified contract UI does not expose the former manual
completion step. Hosts must preserve exact session, route and package bindings
if they use these hooks independently.

Shared package deposit, tranche and rent schemas are retained for existing
consumers. They describe legacy examples, not the current contract workflow.
Do not translate the new full payment into an extra legacy deposit or tranche.

## Development and validation

Run `npm run dev --prefix apps/map-preview` and open `/` for the integrated map
or `/contracts.html` for the independent fictional contract example. The default
provider is local simulation. The existing Capital One Nessie adapter is retained
for a later provider connection; no live transfer is established by this change.

`server/contract-workflow.mjs` and `server/contract-api.mjs` provide a local ledger
with atomic file replacement and serialized mutations. This is development
persistence with simulated roles; authenticated identities and atomic shared
SpacetimeDB integration remain separate work.

Run `npm test --prefix apps/map-preview` for exact amounts, signature gates,
restart recovery, duplicate protection and uncertain-outcome behavior. Mocked
provider and DOM tests do not establish live bank connectivity or browser layout.
