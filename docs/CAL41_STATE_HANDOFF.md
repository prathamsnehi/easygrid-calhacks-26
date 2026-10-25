# CAL-41 shared negotiation state: handoff to CAL-33

This branch implements the CAL-41 saved-state boundary and the local map
connection that imports a reconstructed fixture and restores that binding after
refresh. CAL-33 can implement voice orchestration against the documented
interface concurrently. This is not a deployed module, a published-service
refresh, or evidence of a live call.

## Ownership and compatibility

- CAL-41 owns map/session binding, atomic negotiation snapshots and receipts,
  trusted transcript storage, review leases, authorized saved-result views and
  the all-parcel agreement gate.
- CAL-33 owns private registration/contact resolution, authenticated call/provider
  binding, tools/HTTPS endpoints, provider lifecycle and deadlines, transcript
  normalization, and invoking the post-call reviewer. A completed call is not
  acceptance. Model/tool IDs never authorize their own mutations.
- CAL-40 owns the new active-session lifecycle. It can call `close_negotiation`
  before switching sessions; old saved results remain available but every late
  command/review commit, including receipt replay, is rejected for the old run.
- The existing local contract/payment UI and all CAL-29 legacy exports remain.
  Sessions imported with `bind_negotiation` cannot use legacy `publish_route` or
  `record_outcome` to bypass CAL-34's stop/no-redial/original-participant rules.
  Existing legacy sessions require deliberate migration; none is automatic.

Do not change CAL-33's provider files to consume this branch. Add the generated
module transport behind the adapter below after coordinating its tested commit.

## Bootstrap and trusted import

1. A trusted backend operator creates the CAL-29 session and explicitly registers
   its intended backend worker identity through `register_worker`. Keep operator
   and worker credentials off the browser. The operator is a trusted demo manager,
   not the roleplay participant; call consent is not property consent.
2. Reconstruct the current map from the repository's synthetic world/fixtures on
   the backend. Preserve original fictional owner, parcel and mock-recipient IDs.
   Validate the public proposal binding against that reconstruction. Resolve the
   participant's actual contact privately; the owner packet contains only an
   opaque reference and explicit consent. Never forward an arbitrary submitted
   owner packet, bank record or counteroffer as authoritative map policy.
3. As the registered worker, call `bind_negotiation` with:

   | Field | Meaning |
   | --- | --- |
   | `sessionId` | Existing authoritative session |
   | `expectedRevision` | Current CAL-29 session revision |
   | `requestKey` | Stable import request ID |
   | `handoffJson` | Shared `OwnerHandoff`, canonical binding, matching session/revision/budget, all parcels pending at the original recommendation |
   | `mapBindingJson` | Exact local `{sessionId, routeId, routeVersion, proposalKey}` corresponding to that reconstructed map |

   Every parcel needs its fixed 120% offer policy. The original participant must
   be on the affected route with registered call consent; all other owners remain
   simulated. The map's monthly estimate is frozen to exact demo terms by CAL-34
   before preparation. Geometry/costs remain fixture estimates, not surveyed land.
   Local and canonical session/route identifiers may differ. Parcel/owner IDs are
   preserved, so `localParcelId` in result updates is the original parcel ID.
4. Identical import retries replay without a revision change. A different import,
   participant reassignment or implicit legacy-session migration is rejected.
   The new bound revision is `expectedRevision + 1`.

The backend fixture reconstruction and private registration HTTP path are still
integration work; this branch provides the worker-only import boundary, not a
public endpoint accepting arbitrary browser proposals.

## Reducers

All new reducers authenticate the current registered worker before processing
commands/replays or private evidence. Private snapshots, transcripts and receipts
are written in the same SpacetimeDB reducer transaction as their public result.
JSON fields use shared runtime validation and bounded payload sizes. Sender errors
contain controlled messages, without raw submitted JSON or transcripts.

| Reducer | Arguments | Behavior |
| --- | --- | --- |
| `execute_negotiation` | `sessionId, commandJson, providerTurnsJson` | Execute shared `NegotiationCommand`; trusted provider turns are optional `[]`. `finalize` requires the review reducer below. |
| `record_negotiation_transcript` | `sessionId, attemptId, requestId, providerTurnsJson` | Persist normalized completed-provider turns before review. Prefixes are immutable, IDs unique and timestamps ordered. Sets the attempt to confirming, without asserting agreement. |
| `claim_negotiation_review` | `sessionId, attemptId, claimId` | Acquire a 30-second lease on a confirming attempt, using database time. A competing/finished claim is unchanged. |
| `commit_negotiation_review` | `sessionId, claimId, commandJson, providerTurnsJson` | Require the current unexpired claim and stable `post-call-review` request ID; commit either `finalize` or a review failure atomically. Completed identical commits replay. |
| `close_negotiation` | `sessionId` | Close the old run, retaining results and blocking late mutations. It does not create the next session. |

Generate a fresh opaque `claimId` for every acquisition attempt. Read the claim
view after the reducer commits: only the matching, incomplete claim owns the
review. If a worker crashes, a new claim can acquire after expiry; the expired
token cannot commit. Evidence is frozen during the active lease. Provider
timeouts/refusal failures can use the normal failure/refusal command; do not
invent a successful response because no tool event arrived.

CAL-34 reserves construction, fixed comparison rent and all other parcels before
increasing one offer. New delivery keys cannot reset its single-final-offer slot.
No automatic reroute, new live-owner assignment or dial retry is scheduled here.

## Backend adapter

Build shared contracts before this package. Import the adapter through
`@easygrid/spacetimedb/negotiation`:

```ts
const stateHost = createSavedNegotiationHost({
  backend, // NegotiationBackend implemented with generated reducers + views
  sessionId: canonicalSessionId,
  newClaimId: () => crypto.randomUUID(),
});

const tools = createNegotiationTools({
  authorize: authenticateAndResolveCurrentCall, // CAL-33, not model-selected IDs
  execute: stateHost.execute,
});

// After completed provider evidence has been normalized and authenticated:
await stateHost.recordTranscript(attemptId, providerEventId, normalizedTurns);
await reviewCompletedNegotiation(stateHost, reviewer, attemptId);
```

`NegotiationBackend` names match camel-cased generated reducers. `workerState`
parses the `stateJson` returned by `negotiation_worker_state`; `reviewState`
reads `negotiation_review_state`. Mutation promises must acknowledge actual
commit; reads must reflect committed/subscription-ready state. Do not replace
these operations with an in-memory snapshot or read stale subscription rows.
The adapter resolves exact saved command receipts after commit, including a
retried earlier command whose attempt has since advanced. Its local claim-token
map only remembers tokens it acquired; exclusion/expiry is enforced in the DB.

`createGeneratedNegotiationClient` adapts generated reducer callbacks and view
subscriptions. Its mutation promises resolve only after a matching callback
reports `committed`. View reads go through `subscribeView`, which must resolve
from an applied subscription rather than an older cache. The previously published
CAL-29 database does not expose these reducers; do not point this client at it
until an explicitly authorized module publication generates matching bindings.

`importReconstructedNegotiation` rebuilds the map with `reconstructMapProposal`,
registers only the privately resolved consenting participant, and calls
`bind_negotiation`. A browser owner packet is rejected. `createSavedNegotiationResultSource`
delivers saved rows through `setNegotiationResultSource` before `onReady`.
`restoreRegisteredDemo` reattaches the saved local session, route and parcel.
Restored facility endpoints without that record stay an unregistered local demo.

Provider-to-attempt mapping, the CAL-33 process lifecycle, and a live published
module remain to be connected and verified.

## Views and browser handoff

| View | Access | Output |
| --- | --- | --- |
| `negotiation_results(sessionId)` | Session operator or registered worker | Saved CAL-34 result updates with bound local map IDs and committed revisions; no transcript or contact references |
| `negotiation_worker_state(sessionId)` | Registered worker only | Private state/receipts/turns and trusted map binding |
| `negotiation_review_state(sessionId, attemptId)` | Registered worker only | Claim token, expiry and completion |
| `negotiation_agreements(sessionId)` | Session operator or registered worker | Empty until every current parcel accepts; then the complete current packet with all contact references/consent removed |

These tables are private; `public: true` on a view means the view is callable,
not unrestricted row access. The new view functions filter/check the caller.
The host must authorize browser access and project only current public updates.
Never place worker/operator tokens in browser code. On subscription readiness,
deliver initial saved rows through `setNegotiationResultSource` before reporting
ready; ongoing events reuse the exact imported `mapBinding`. The local map can
reattach that binding after refresh. A deployed subscription still has to be
connected before refresh works against the published service.

The agreement packet is canonical. Do not relabel it `local-fixture` or send it
through the current simulation approval action: that would bypass authoritative
approval. The authenticated contract registry, signature/approval mutations and
simulated payment ledger must still be connected to the same state service.
Current payment scope is one full compensation payment after all required
signatures. Construction animation is separate and never unlocks another payment.

## Verification and remaining acceptance

Run from the repository root:

```sh
npm ci --ignore-scripts --prefix packages/contracts
npm run build --prefix packages/contracts
npm ci --ignore-scripts --prefix services/spacetimedb
npm run typecheck --prefix services/spacetimedb
npm test --prefix services/spacetimedb
npm run build --prefix services/spacetimedb
npm ci --ignore-scripts --prefix services/spacetimedb/module
npm run typecheck --prefix services/spacetimedb/module
npm test --prefix services/spacetimedb/module
npm test --prefix apps/map-preview
```

Module tests use the SpacetimeDB SDK datastore/transaction harness with injected
caller identities, not a live database or provider. They check actual reducer
rollback, receipt replay, global reservations, privacy views, role lockout,
all-parcel agreement readiness, review lease contention/recovery and the backend
adapter through the same transactions. Test contacts are explicitly non-dialable
synthetic sentinels. Existing legacy behavior remains covered separately.

- [x] Implement/test the atomic negotiation, evidence, claim and projection boundary.
- [x] Provide the tested CAL-33 backend adapter and preserve legacy APIs.
- [x] Add the commit-aware generated-client adapter, trusted fixture import and local refresh restoration. Module tests (21/21), negotiation-client tests (2/2) and map-preview tests (253/253, including refresh restoration) cover this path. They do not publish a module or reconnect to a deployed database.
- [x] Local browser check on the built preview: both facilities placed, the route reached `ok`, refresh kept the facilities with an empty onboarding form, and `restoreRegisteredDemo` marked the demo `pending`. A restore record carrying a phone was rejected, and the saved plan did not contain the map session id. The post-onboarding `restored` flag was confirmed in the map VM test; the browser pass did not submit the onboarding form a second time.
- [ ] Publish an explicitly authorized module update and generate matching bindings.
- [ ] Connect the concrete live transport to that published module and private registration endpoint.
- [ ] Verify actual-service refresh/reconnect and new active-session restoration.
- [ ] Connect canonical agreement/signature/approval/full-payment persistence.
- [ ] With CAL-33, demonstrate a consented live call and saved/reviewed result.
- [ ] Verify the full browser journey and failure/fallback cases under CAL-42.

Keep CAL-41 In Progress. Local tests and the local browser restore check do
not satisfy actual-service refresh, payment persistence, live-call or CAL-42
acceptance. No deployment is part of this change.
