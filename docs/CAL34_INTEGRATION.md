# CAL-34 integration and verification

This implements the approved short demo negotiation, not the original economic
bypass/rerouting scope. See [scope](cal-34-negotiation-policy.md) and
[CAL-34](https://linear.app/easygrid-calhacks-2026/issue/CAL-34).

## Implemented components

- `@easygrid/contracts`: `applyNegotiationCommand`, exact full-route budget checks,
  fixed recommendation/120% cap, one final offer, transcript corroboration,
  separate call disposition/access consent, factual summaries, agreement gate,
  authenticated tool adapter, short voice prompt and public result projection.
- `@easygrid/claude-api`: `NegotiationReviewer`, explicit-model Anthropic adapter
  and post-call review orchestration. One request, default 10-second timeout,
  no automatic retries, no raw errors or contact data in results/logs.
- `@easygrid/cartesia`: per-call dynamic variables, provisioned tool IDs,
  active-call cancellation and an explicit connected-deadline check.
- Map: an opt-in saved-result subscription displaying negotiation, confirming,
  Successful / Unsuccessful / Needs review and detailed explanations. It never
  calls the existing CAL-35 rerouting controller. Simulations cannot replace
  live results, stale session callbacks are ignored, and terminal results block
  further calls. The configured source factory survives New Demo; its old
  subscription and old result do not.

Existing API v1/deposit helpers remain unchanged. Use the revised handoff terms
for CAL-34, not `normalizeClaudeOutput`'s legacy `upfrontCents/depositCents`
normalization. A price rejection has `outcome: refused` but **unknown** land-access
consent; it must not be passed to the legacy validator that requires every
refusal to mean refused land access. The public CAL-34 projection is distinct
from `createMapNegotiationUpdate` and does not invoke that rerouting adapter.

## Required CAL-29 atomic reducer integration

CAL-29 is merged in main via PR #12 (`6ef469f`). Its state module provides
`start_session`, `register_worker`, `publish_route`, `record_outcome` and views.
Its README records the published `easygrid-demo` database; this review did not
query or redeploy it. The merged module is not yet the CAL-34 negotiation API.
It lacks full-route construction/rent-horizon accounting, per-attempt offer
reservations, trusted evidence and durable review claims required below.

Do not connect CAL-34 by forwarding to `record_outcome` alone. The current module
simulates acceptance for other tower owners, excludes refusals and permits a new
live-owner role on a subsequent route. CAL-34 instead stops on failure, preserves
the original participant role and requires every affected parcel's current terms
to be accepted. CAL-41 must reconcile those policies at the actual state boundary.
No production in-memory store is supplied.
`NegotiationState` is the reducer's snapshot/return shape; it is not persistence.

The authorized reducer must:

1. Resolve actor/session/call binding from server-owned records; authorize every
   command, including replays. Never trust IDs, roles or policy in model input.
2. Load current handoff, current route policy/terms, attempts and scoped receipts.
   Policies come from the canonical import of Theo's map, not a counteroffer.
   Initial state has `active: true`, `workflow: negotiating`, existing lockout,
   canonical `referenceBinding`, and every route parcel's fixed `offerPolicies`.
3. Call `applyNegotiationCommand(snapshot, command, trustedProviderTurns)`.
   Write **all** returned domain changes, reservations, terms/revision changes,
   attempt and receipt in the same transaction. Roll back on validation failure.
   Serialize conflicting budget updates in SpacetimeDB, not a Node cache.
4. Emit authorized public projections only after commit. Never enqueue rerouting
   or another dial when `workflow` is `stopped`. Invalidate obsolete agreements
   through the existing CAL-29 workflow when terms change.
5. Gate agreement creation with `negotiationAgreementPacket(currentState)` and
   all current affected owners, not just the live participant's success.

Commands carry `attemptId`, `requestId`, `routeVersion`, `termsVersion`, plus:

| kind | Additional arguments |
| --- | --- |
| `prepare` | `parcelId`, `mode: live` or `simulated` |
| `counteroffer` | `requestedCents` or null for a nonspecific price objection |
| `response` | `response: agree / price_rejected / unclear / conditions`, optional `turnId` |
| `refusal` | `reason: ACCESS_REFUSED / DO_NOT_CALL`, optional `turnId` |
| `finalize` | validated extraction `candidate` |
| `failure` | normalized technical failure `reason` |

Amounts are integer cents. Preparation freezes displayed monthly amounts as
exact fixed demo terms and recomputes comparison rent for **all** parcels. If
this changes eligibility, the opening offer is blocked before dialing. Other
parcels reserve the greater of current compensation and original recommendation;
accepted/active offers therefore consume headroom before another parcel can
increase. The recommendation and cap never rebase on a counteroffer.

Same operation identity/content replays before stale-version checks; conflicting
content is rejected. The final-offer slot is independent of delivery identity,
so changing request keys cannot buy another increase. A parcel cannot start
another attempt in that session; a stopped/closed demo cannot start another call.

## CAL-33 live tool and lifecycle integration

Wrap the already provisioned HTTPS tools with `createNegotiationTools(host)`.
Implement `host.authorize(credential, callReference)` using configured webhook
credentials and the server-owned call record. It returns the current attempt,
canonical session and route/terms versions. `host.execute(binding, command)`
submits to the authorized CAL-29 reducer above, never a second mutable store.
The adapter does not implement HTTP routing or validate bearer tokens itself.
Authorization must corroborate the call reference from authenticated provider
context or an attempt-scoped credential; a shared token plus an arbitrary
model-supplied call ID is insufficient. Dynamic variables are not authority.

The model's tool arguments contain **no owner/session/policy selectors**.
`turnId` is optional: supply a provider-authenticated owner turn only when the
host already has it. Otherwise the authenticated tool response is a candidate,
not confirmation. The completed transcript establishes final evidence. A live
refusal candidate immediately stops/locks calling while its evidence is reviewed.
Never invent provider turn references to make a tool delivery pass validation.

Prepare/commit before calling, then use `NEGOTIATION_VOICE_PROMPT` and
`negotiationCallVariables(attempt)` as per-call context. Create an agent with
its explicit model/voice and provisioned `toolIds`. Use the existing private
registration path to resolve the consenting participant's dial target. Do not
patch shared instructions per session or send banking/contact records to tools.
Tool IDs must refer to public HTTPS webhooks with authentication configured by
CAL-33; this package does not deploy those endpoints.

Persist `connectedAtMs` and schedule `enforceConnectedCallDeadline` through
CAL-29/CAL-33. Default connected limit is 60 seconds; 30–45 seconds is a speech
prompt goal, not an acceptance timer. Only a started call is cancellable.
`unknown` cancellation means the call may still be running; reconcile the same
provider ID rather than redial. Starting/retrieving a call never establishes
owner acceptance. Dial retries remain disabled.

CAL-33 normalizes provider call failures to NO_ANSWER, BUSY, DISCONNECTED,
SERVICE_UNAVAILABLE or CONNECTION_UNKNOWN from actual provider facts; unknown
provider codes must not be guessed into a specific business refusal.

## Post-call evidence review

Normalize provider turns into `{id, role: agent|owner, text, startMs, endMs}` with
stable opaque IDs, monotonic timestamps, and actual speaker attribution. These
come from the provider adapter, not model tool arguments. Earlier turns cannot
be rewritten or duplicated in a later snapshot.

`reviewCompletedNegotiation(host, reviewer, attemptId)` requires a durable
`host.claimReview` operation and atomic `host.commit`. A duplicate claim returns
null; leases/worker recovery belong to CAL-29. A worker crash or lost commit is
reconciled through the same attempt and `post-call-review` receipt, not a new
phone call. No process-local claim registry is used here.

Construct `createClaudeNegotiationReviewer` with the privately loaded API key,
explicit model and optional API version/timeout. The approved destination is
`https://api.anthropic.com/v1/messages`. Only approved offer history and transcript
turns are sent; no contacts/banking/credentials are put in the prompt. Private
transcripts remain worker-authorized and never enter public projections.

The reviewer returns a candidate, never an authoritative accepted result.
Validation binds the recorded agree candidate to an actual short affirmative
response to the latest exact stated offer. No additional readback is needed.
Exact numeric and common spoken-word dollar amounts are supported; ambiguous
money, conditional language, unrelated questions, missing turns, contradictions,
missing transcript and model errors remain Needs review. Transcript normalization
should preserve exact money and speaker/turn ordering. A brief agent goodbye
is allowed after owner agreement.

Every summary is generated from controlled templates. Requested amounts appear
only if corroborated in owner transcript turns; "final offer" is used only if
that final offer was spoken. No unchecked model-authored narrative is published.

## Map result subscription

The host binds canonical attempts back to the exact imported local map proposal.
After a committed event, use `createNegotiationResultUpdate` with its attempt,
event ID/revision, retained local `mapBinding` and local parcel ID. This helper
only projects a known commit; calling it does not make data saved or authorized.

```js
window.easygridDemo.setNegotiationResultSource(({mapBinding, signal, onUpdate, onReady, onUnavailable}) => {
  // Implemented by the CAL-29 host: authorized subscription + initial saved snapshot.
  return host.subscribeNegotiationResults({mapBinding, signal, onUpdate, onReady, onUnavailable});
});
```

`host.subscribeNegotiationResults` must be implemented against the actual
CAL-29 public view. It is not an export from this PR. It must deliver saved
initial rows on refresh and map local/canonical IDs through trusted import
records. Browser navigation/session restoration also remains CAL-29/CAL-41 work.
`getNegotiationResult()` inspects the redacted display state; it cannot approve
an agreement or change the authoritative outcome.

A projection has `kind: easygrid-negotiation-result`, `schemaVersion: 1`, exact
`mapBinding`, `eventId`, monotonic committed `revision`, `saved: true`,
`localParcelId`, `mode`, `phase`, and terminal shared `summary` or null.
The initial unfinished phases are negotiating and confirming. Do not send
`saved: true` for a standalone production fixture. An unavailable subscription
blocks actions; the last saved explanation remains visible with an offline note.

The old CAL-35 refusal/rerouting fixture remains available when no CAL-34 source
is installed. Installing CAL-34 hides that demonstration and disconnects the
legacy source; do not route CAL-34 failures through the old result adapter.
The separate contract approval simulation is disabled while a CAL-34 source or
saved result exists. Result updates revoke previously prepared contract packages;
one parcel's success does not approve every other parcel.

## Checks and remaining completion evidence

Run `npm run check --prefix packages/contracts`, map tests, Cartesia tests/typecheck/
build, and Claude tests/typecheck/build. Service CI now includes the Claude adapter.
The integration test is explicitly a synthetic transaction/HTTP harness, **not**
proof of Maincloud persistence, authentication deployment or a telephone call.

Real-browser result check after building the map (Playwright + Chrome installed):

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
BROWSER_EXECUTABLE='/path/to/chrome' \
node apps/map-preview/scripts/check-negotiation-browser.mjs
```

It uses a synthetic saved-result subscription for layout/UI verification, places
no call, and writes a screenshot to `/private/tmp/cal34-browser-result.png` by
default. `BROWSER_SCREENSHOT` overrides that path. This is browser/WebGL evidence,
not live data integration.

Pratham approved closing CAL-34 as component complete after review. The following
integration acceptance items remain unchecked under CAL-33/CAL-41; they are not
satisfied by the component closeout:

- [ ] CAL-41: adapt the merged CAL-29 module to these atomic transitions, durable
  receipts/claims and authorized views; verify saved-result restoration after
  refresh/reconnect through the actual service.
- [ ] CAL-33: provisioned/authenticated tools, real consented call, provider transcript
  normalization and scheduled deadline/cancellation lifecycle.
- [ ] CAL-33/CAL-41: live 30–45-second successful negotiation, saved result after refresh, measured
  connected/review latency, and sanitized tested-commit evidence in Linear.

No deployment, live call or real transcript request was made by this change.

### Local implementation evidence

- [x] 141 shared contract tests; typecheck, six generated-artifact consistency
  checks and build pass. Includes bounded money decisions, transcript evidence,
  detailed failure reasons, replay/stale rejection and all-owner agreement gating.
- [x] 252 map tests pass, including saved-result display, duplicate/stale delivery,
  simulation isolation, New Demo and offline preservation of the last saved reason.
- [x] 16 mocked Cartesia tests plus typecheck/build pass.
- [x] 9 Claude/synthetic integration tests plus typecheck/build pass; real timeout
  cancellation is tested without a provider request.
- [x] Actual headless Chrome/WebGL check passes with a synthetic subscription:
  visible detailed explanation, disabled call button, no route change and no
  uncaught page errors. This verifies UI rendering, not persistence or live calling.

### Review against current main

The review incorporates CAL-29 plus the newer contract/payment workflow from
`7d30137`, including the single-owner approval demo from PR #23. It preserves
both build entries and all contract UI checks. Added
regressions cover an agreement candidate followed by a refusal, negated or
conditional spoken offers, price objections versus access refusal, friendly
"no problem" replies, and model-invented technical failure codes. The current
map regression also checks that contract simulation cannot replace a call result.
CAL-29 module tests and typecheck pass locally; no module changes were made.

The second main reconciliation also retains direct simulated approval/contract
navigation. Those controls remain available in the standalone demo and are
hidden and disabled while CAL-34 owns the call result. Installing a CAL-34 source
cancels pending simulated approval navigation and revokes its contract package.
