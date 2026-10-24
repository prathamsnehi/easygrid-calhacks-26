# Post-call route updates

CAL-35 consumes the outcome of CAL-33/34. CAL-29 owns persistent state and CAL-41 owns the combined application. Read [the voice handoff](PRATHAM_HANDOFF.md) and [settlement integration](SETTLEMENT_UI.md) for the adjacent boundaries.

## Demo journey

The standalone preview has a **Simulate refusal** action. It uses the same public result consumer as the host adapter, with an explicitly `mock` result. No phone is called.

1. The participant refuses their original parcel.
2. The parcel stays excluded from every subsequent calculation in that page session. The participant keeps the same historical owner/parcel and live calling is locked.
3. The router finds one eligible alternative under the existing budget, cost model and rent horizon. The UI compares the previous and replacement route, affected parcels and cost.
4. Other owners on the replacement route accept one fixed simulated offer each. Every final parcel receives its own `mock` negotiation record. The original participant is never simulated as a different owner.
5. The map shows **Route confirmed · simulated owners**. The agreement-preparation packet is available to the host; signatures, operator approval and settlement remain separate steps. For the manual demo, **Continue to contract & settlement** becomes enabled and opens a local preparation summary. This is not host authorization or a payment request.

The scripted acceptance uses the new route's recommendation and fixed 120% limit. Rounded monthly estimates become explicitly chosen exact *simulated* monthly amounts; the full horizon is recalculated and checked against the budget before finalization. No old-route acceptance is carried forward automatically. No eligible route, unpriced corridor-only impact or over-budget exact terms stops the scenario for review.

This deterministic acceptance scenario is intentionally bounded to one offer per fictional owner. It does not implement CAL-34's full autonomous counteroffer/economic-bypass loop.

## Browser integration

```js
const map = window.easygridDemo;
const mapBinding = map.getNegotiationBinding();

map.applyNegotiationUpdate(publicUpdate);
map.getNegotiationState();
map.getNegotiatedHandoff(); // null until all simulated final-route owners accept
map.runRefusalDemo();      // same behavior as Simulate refusal
```

`mapBinding` identifies the exact current public proposal, including its session, route version, owner terms, coordinate transform and cost model. Its `proposalKey` is an equality key, not a signature or server authorization. Capture it before the relevant call; never stamp an old call result with a new map binding.

For continuous delivery, register an adapter:

```js
map.setNegotiationSource(({ mapBinding, onUpdate, onReady, onUnavailable, signal }) => {
  // Implement this adapter using the authenticated CAL-29 public API.
  // This example names a host interface, not an existing SpacetimeDB table or reducer.
  return host.subscribeMapNegotiations({
    mapBinding, signal,
    onReady,
    onUnavailable,
    onResult: projection => onUpdate(projection),
  }); // return unsubscribe (or a Promise resolving to it)
});
```

The source is rebound when the displayed route changes and aborted on invalidation/reset. Old callbacks are ignored. Call `onReady` only after the initial authorized subscription snapshot has been applied. Use `onUnavailable` on disconnect; it revokes local settlement readiness. The host must restore a persisted current snapshot and cumulative exclusions before considering a reconnect current. A transient event callback is not a durable queue.

While a source is configured, the local refusal injection is disabled. Remove it with `setNegotiationSource(null)`. The source must return redacted projections, never raw transcripts, participant phone numbers, provider tokens or private database records.

## Map canonical results explicitly

`packages/contracts/src/map-negotiation.ts` exports `createMapNegotiationUpdate`. Run it in the backend after authenticating the provider event, loading its trusted call record, validating the shared `NegotiationResult`, and corroborating owner confirmation. Map IDs are local fixture IDs; they are not automatically the canonical server IDs.

```ts
const update = createMapNegotiationUpdate({
  handoff: importedMapProposal,
  result: savedNegotiationResult,
  binding: {
    projectId: currentCall.projectId,
    callSessionId: currentCall.sessionId,
    parcelId: currentCall.parcelId,
    routeVersion: currentCall.routeVersion,
    termsVersion: currentCall.termsVersion,
    localParcelId: importedMapParcelId,
  },
  confirmationVerified: corroboratedOwnerConfirmation,
  spatialConditionsVerified: corroboratedSpatialInterpretation,
});
// Deliver update through the authenticated public subscription/API adapter.
```

The helper compares canonical IDs/versions to the trusted binding, checks the map parcel and fixed cap, and returns a small `easygrid-map-negotiation` projection. It does not authenticate a caller, write SpacetimeDB, create evidence or authorize an agreement. The binding and verification flags must come from trusted application state, not model output or webhook arguments. Evidence references must be opaque, sanitized identifiers.

A completed or failed call is not a business outcome. Unconfirmed refusal, silence, ambiguous terms and unsupported model output cannot permanently exclude land or create acceptance. Confirmed refusal requires refused access plus corroborated explicit confirmation and evidence. Duplicate event delivery replays before checking the now-changed route; conflicting reuse of an event ID is rejected. This browser deduplication is not durable backend idempotency.

## Conditional outcomes

The existing shared contract has `counteroffer` and `review_required`, not a separate conditional-acceptance enum.

- Monetary counteroffers and unresolved condition text remain for review; they do not automatically change geometry or finalize a route.
- A verified `exclusionGeometry` can trigger rerouting. The host must establish what the owner meant and verify all remaining conditions; “move to the other side” alone does not specify coordinates.
- The map converts that WGS84 polygon using the packet's exact synthetic coordinate transform. The router accepts one simple closed ring inside the named parcel, rejects malformed/out-of-bounds/self-intersecting shapes, and excludes both wire corridors and tower foundations touching it. Holes and arbitrary alternate coordinate systems are unsupported.
- The pure router additionally supports `blockedTowerParcelIds` for tower-only prohibitions, but the existing negotiation schema does not encode that distinction. An authoritative adapter must explicitly resolve it before using that engine option; generic refusal must not be reinterpreted as tower-only permission.

Pure engine entry points are reusable in a Node worker: `computeTransmissionRoutes(world, placements, { blockedParcelIds, blockedTowerParcelIds, exclusionZones })`. Restrictions are cumulative for the demo session and never mutate fixture ownership. Unsupported or contradictory conditions stop for review.

## Agreement and settlement handoff

`getNegotiatedHandoff()` returns a detached `easygrid-simulated-agreement` wrapper containing the original map binding, current `ownerHandoff`, one mock `NegotiationResult` per final parcel, and reconciled exact totals. The owner packet retains `referenceBinding: 'local-fixture'`; its historical user role remains linked to the original synthetic owner and banking profile. Excluded owners are absent from active parcel obligations.

The host must import/map and persist this explicitly simulated package, preserve the current route/terms/banking association, validate the authoritative current state, and run Seohyun's agreement/signature/approval workflow. Do not change `referenceBinding` to `canonical` without performing that mapping. Do not present the packet as real owner acceptance or a payment receipt. Displayed route confirmation is the demo negotiation milestone, not manager approval.

Route, participant or terms changes revoke the previous settlement receipt and clear the local finalized packet. If a payment has already been submitted or settled, the backend must block incompatible route changes or use an explicit adjustment workflow. UI cancellation cannot undo a transaction.

## Remaining live integration

This change supplies the deterministic post-call computation, map consumer, public mapping helper and scripted scenario. It does not provision a SpacetimeDB module or invent generated table/reducer names. CAL-29/33/34/41 still must:

- Persist authenticated outcomes, original-role lockout, cumulative constraints and jobs atomically with revision/idempotency checks.
- Consume durable replan jobs, reuse the pure route engine, and commit the new route, costs and affected approval/term invalidations coherently.
- Deliver authorized public projections and restore the same session after refresh/restart.
- Validate conditional evidence and real provider callbacks, and connect the final simulated package to Seohyun's authoritative workflow.

The standalone preview computes locally and clears its state on page exit. Refresh persistence and a real Maincloud subscription require that host implementation.

## Checks

Run `npm test --prefix apps/map-preview` and `npm run check --prefix packages/contracts`. Tests cover exclusion geometry, original-role retention, structured-result mapping, duplicate/stale delivery, source cleanup, refusal-to-simulated-acceptance, exact cents, budget blocking and settlement remaining gated. UI tests use the built script with a VM renderer; they do not establish browser layout, GPU rendering or live provider execution.


### Manual demo continuation and reviewed UI (CAL-35)

The user-approved offline demo places `Simulate refusal` directly below `Agent call`. An eligible bypass assumes acceptance by the other fictional owners and enables `Continue to contract & settlement`. This opens a local preparation summary; it does not create manager approval, signatures or payments, or invoke the settlement handler. The manual shortcut is bound to the current proposal and cleared by route/participant changes or connection of a host result source. Host-driven settlement still requires its matching approval and handler.

The prior network remains at 20% opacity. Comparison overlays follow the sampled center conductor: muted brown previous path, opaque green new path. Reroute results and the continuation action appear above detailed costs, including on the overview after parcel analysis closes. Confirmed totals use exact agreed monthly terms.

The product display name is QuickGrid. Repository names, package namespaces and public integration identifiers remain compatible. Actual call callbacks and database persistence/subscriptions are still integration work.
