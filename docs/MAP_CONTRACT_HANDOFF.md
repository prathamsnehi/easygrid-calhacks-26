# CAL-41: selected map route to contracts and payments

The existing map and agreement workspace now form one local development journey.
Run `npm run dev --prefix apps/map-preview` and open `/`, starting with participant
registration. Place both facilities, calculate a route, and choose **Analyze
affected parcels**. **Simulate approved negotiation** explicitly accepts the
displayed fictional owner terms; it does not place a call or infer property
consent from call consent. **Proceed to contract** then opens agreements for those
exact parcels, original fictional owners and amounts. The standalone
`/contracts.html` example remains independent.

Sign both simulated roles for every affected parcel. Pay each initial 20%; after
all are confirmed the package enters construction. Until THEO publishes the
animation, the explicitly labeled **Preview only: report construction complete**
control supplies the completion event. Each exact remaining balance requires a
separate payment action. There is no automatic completion, automatic payout or
monthly-payment implementation.

## Public proposal and server validation

`mapContractRequest()` sends only session/route/version, the fictional participant
parcel, facility coordinates and the public proposal binding. It never sends the
entered participant name, phone, transcript or call-consent record. The server
reconstructs placement, routing, affected owners, costs and recipient references
from the team's trusted local fixtures. It compares the complete public binding
before approving; browser-provided amounts or owners cannot override it.

`POST /api/contracts/approve-map` returns `{packageId, input, agreement,
mapBinding, simulated:true}`. Existing `/api/contracts/*` operations accept the
packageId and dispatch to an isolated workflow for that approved package. Omitting
packageId continues to address the original standalone example. Approval is
available only in local simulation mode; this bridge cannot send Nessie transfers.

Repeated approval reuses the same package and source timestamp. A newer route
version may supersede an unpaid package, after which old commands are rejected.
A package with an attempted payment cannot be replaced through this approval
endpoint. Reconcile its existing obligations rather than using a route change to
create another payout. UI route, participant or context changes immediately revoke
readiness and abort pending approval; late responses cannot reopen an old package.

`apps/map-preview/.local/map-contracts.json` contains only fixture agreements,
signatures, obligations and journals. Its replacement writes and mutation queue
are single-process development persistence. It is not authenticated consent,
multi-process transaction isolation or the shared SpacetimeDB integration. A new
page session starts a separate development proposal; a browser reload restores
validated endpoints but still requires fresh participant registration.

## THEO and Pratham integration boundaries

`contractSourceFromAgreement()` consumes the published `easygrid-simulated-agreement`
envelope shape and its accepted `easygrid-owner-handoff` packet. The envelope must
include matching `mapBinding` and negotiation metadata:
`{negotiationId, negotiationVersion, approvedAt}`. The packet must contain all
current route parcels, their original owner and recipient associations, explicit
accepted terms, and confirmations within each original offer cap. Refused,
incomplete, mismatched and stale packages remain blocked.

`window.easygridDemo.setContractAgreement({agreement, packageId, simulated})`
projects such an agreement into the current map workspace. This presentation hook
alone does not register a server package or grant payment authority. Pratham's
service must provide the agreed package registry and canonical negotiation IDs,
authorization and atomic state transitions, then replace the injected
`createContractWorkspace({api})` boundary. The existing
`setContractNegotiation({input,mapBinding})` hook remains compatible for authoring.

THEO's construction host uses the existing `setConstructionHandler` and explicit
completion callback documented in [CONSTRUCTION_PAYMENTS.md](CONSTRUCTION_PAYMENTS.md).
Displaying towers or resolving a start callback never establishes completion.
The animation implementation and live voice/DB adapters remain separate open work.

## Validation

`tests/map-contracts.test.mjs` checks reconstruction and tampering, accepted owner
mapping, contact exclusion, isolated packages, stale versions, all signatures,
both tranches, explicit completion, restart recovery and duplicate protection.
The compiled UI regression exercises the async approval export and late-response
invalidation. Browser verification separately covers onboarding, GPU-rendered
placement and routing, the six-owner contract workspace and both payment stages.
