# Initial payment, construction and completion balance — CAL-38

The current demo ends after two explicit compensation payments. Monthly rent,
monthly accrual, recurring transfers and a demo clock are outside this scope.
Existing shared rent fields/helpers remain compatible for other consumers; the
contract workspace and downloaded document do not offer monthly payments.

## Payment journey

1. Every final-route contract requires simulated utility approval and a separate
   simulated landowner signature bound to the exact document. Utility approval
   binds both amounts and the recipient, without executing either payment.
2. **Pay initial 20% · simulated** requests the selected parcel's initial payment.
   The amount is one fifth of approved compensation, rounded down to cents.
3. Construction starts once all affected parcels' initial payments are confirmed
   by matching transaction evidence. Pending, uncertain, held and mismatched
   transactions do not count. The backend creates one persistent construction run
   bound to the session, route/version and paid document package.
4. THEO owns the animation. Its explicit completion signal records completion for
   that exact run. A fulfilled animation-handler promise does not mark completion.
5. **Pay completion balance · simulated** becomes available. The user explicitly
   requests the approved compensation minus its initial tranche, per parcel.
   Completion itself never executes this payment.

The server checks these gates independently of button state. Each parcel has one
stable initial obligation and one stable balance obligation per session. Duplicate
clicks and regenerated document IDs cannot create another payment. Unknown bank
outcomes require evidence reconciliation; they never cause a blind resend.

## THEO's animation adapter

Register the handler on the map's existing public integration object:

```js
window.easygridDemo.setConstructionHandler(({construction, signal, onComplete}) => {
  window.easygridDemo.closeContracts(); // Show the map while the animation plays.
  // THEO supplies this function. It must respect the abort signal and resume
  // the same constructionId after a reload, rather than creating another run.
  return theoAnimation.start({
    constructionId: construction.constructionId,
    routeId: construction.routeId,
    routeVersion: construction.routeVersion,
    signal,
    onFinished: async () => {
      if (!signal.aborted) await onComplete();
    },
  });
});
```

`theoAnimation` is an integration placeholder, not an included animation.
`onComplete()` submits the captured construction ID, package hash, session and
route/version with a stable completion event ID. The server rejects mismatched
bindings and unauthorized roles. Replaying completion preserves its original
timestamp and does not transfer funds. The host can also submit the captured
binding using `window.easygridDemo.reportConstructionComplete(construction)`.

Registration may occur before the workspace is opened. A run is notified once per
handler attachment; a restored in-progress run is supplied again after reload.
Route/source invalidation or removing the handler aborts the supplied signal.
Obsolete callbacks cannot enable the current package's balance button. The host
must report errors and retry an unconfirmed completion signal; closing the
workspace does not cancel a valid construction run.

The fixture preview exposes the same adapter through
`window.easygridContractDemo`. Its clearly labeled **Preview only: report
construction complete** control is visible only for local simulation; it is a
manual test substitute for THEO's future callback, not construction evidence.
There is no animation timer that automatically unlocks payment.

## Development and integration boundary

Run `npm run dev --prefix apps/map-preview` and open `/contracts.html`. The
default bank is local simulation. Set `EASYGRID_PREVIEW_PORT` to use another
loopback port (default 4177). All browser actions use synthetic fixture parties.

`server/contract-workflow.mjs` implements the development ledger and
`server/contract-api.mjs` persists it to ignored `.local/` files. Simulated roles
are assigned on the local server. This is not production authentication or an
atomic multi-process SpacetimeDB implementation. The service still uses its
explicit `createContractExample()` fixture, not live negotiation results.

For CAL-29/CAL-41, replace the injected UI API boundary with the authoritative
shared service and preserve all gates, recipient bindings and stable obligations
in atomic transactions. Do not send these tranches as extra legacy deposits.
THEO's real animation, real shared-state persistence, live-negotiation handoff and
live Nessie sandbox behavior require separate integration evidence. No real money
moves in the default simulation.

Validation: `npm ci --ignore-scripts --prefix packages/contracts`, then
`npm test --prefix apps/map-preview`. Workflow and HTTP restart tests exercise
ordering, exact cents, signature/package gates, stale completion, duplicate
requests and unknown bank outcomes. DOM tests exercise the completion callback
and locked/unlocked button; actual browser screenshots verify layout separately.
