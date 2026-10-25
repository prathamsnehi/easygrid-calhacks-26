# CAL-41: handoff for the next implementation agent

Prepared October 24, 2026 (America/Los_Angeles). Read the latest Linear issue and
PR before acting; the references below are the verified handoff checkpoint.

## Start here

- Issue: [CAL-41 — connect map, negotiation and settlement through shared state](https://linear.app/easygrid-calhacks-2026/issue/CAL-41), **In Progress**.
- Existing draft: [PR #24](https://github.com/prathamsnehi/easygrid-calhacks-26/pull/24), targeting `main`.
- Continue branch `prath/cal-41-shared-state-integration`; do not create another PR.
- Implementation head: `b54840986633104c789f1ddb5b048e63076c0d67`.
- Implementation base: `main` at `22b5508c62c456cfa986eea63e81683a3a713082`.
- Isolated checkout: `/Users/prath/.codex/worktrees/cal-41-shared-state/easygrid-calhacks-26`.
- Original checkout `/Users/prath/code/hackathons/easygrid-calhacks-26` was on
  `prath/cal-33-live-negotiation-call`. Preserve that checkout and ongoing CAL-33 work.
- At handoff preparation, the isolated implementation checkout was clean and
  matched the pushed head. This handoff adds documentation only afterward.

The user authorized implementation after initially requesting branch/PR setup
only. Their latest request is to prepare this handoff; no further product code is
being changed in this handoff turn. No merge, shared database publication, live
call, real transcript request or deployment has been authorized/performed here.

The immediate next CAL-41 work is **connect the saved-state foundation to the
running app and restore progress after refresh**. This has no separate CAL number.
It can proceed while CAL-33 develops live calling.

## What is already implemented

Read [CAL41_STATE_HANDOFF.md](CAL41_STATE_HANDOFF.md) for the detailed interface.
Do not rebuild these pieces or mistake them for an already connected application:

| File | Implemented responsibility |
| --- | --- |
| `services/spacetimedb/module/src/negotiation-state.ts` | Worker-only map binding, shared CAL-34 commands inside reducer transactions, receipts/reservations, private append-only provider evidence, review leases, close-session operation, authorized projections and all-parcel agreement readiness |
| `services/spacetimedb/module/src/tables.ts` | New private negotiation snapshot, result and review-lease tables; legacy tables retained |
| `services/spacetimedb/module/src/index.ts` | Exported reducers/views listed below |
| `services/spacetimedb/module/src/logic.ts` | Prevent legacy route/outcome reducers from bypassing imported CAL-41 sessions |
| `services/spacetimedb/negotiation-host.ts` | `createSavedNegotiationHost`, exported through `@easygrid/spacetimedb/negotiation`, for CAL-33 tools and post-call review |
| `services/spacetimedb/module/test/negotiation-state.test.ts` | Thirteen new transaction-backed tests, including backend adapter integration |
| `.github/workflows/services.yml` | Build shared contracts before backend consumers and check the state module in CI |

Both SpacetimeDB packages now depend on the existing shared-contract package;
their lockfiles are updated. No map UI or CAL-33 provider files were changed.

New reducers:
`bind_negotiation`, `execute_negotiation`, `record_negotiation_transcript`,
`claim_negotiation_review`, `commit_negotiation_review`, `close_negotiation`.

New views:
`negotiation_results`, `negotiation_worker_state`, `negotiation_review_state`,
`negotiation_agreements`.

`NegotiationBackend` is still an interface. Its concrete generated-client
transport, HTTP/browser connection and actual-service restoration are **not**
implemented. Unit tests use the SDK datastore/transaction harness with injected
caller identities, not a live deployed database or authenticated provider.

## Recommended next implementation sequence

1. Re-read CAL-41, CAL-33 and their current branch/PR state. Reuse this checkout;
   coordinate interface changes through the documented boundary. Do not overwrite
   the parallel voice implementation. Do not message another chat without the
   user's authorization.
2. Implement `NegotiationBackend` using matching generated reducers and
   worker-authorized views. Mutation acknowledgements must mean committed writes;
   reads must be fresh/subscription-ready. Do not replace this with a second
   mutable Node store. The new schema is compiled but unpublished; existing
   deployed CAL-29 bindings cannot be assumed to expose these operations.
3. Connect trusted map reconstruction and registration to `bind_negotiation`.
   Reuse the existing map proposal reconstruction/binding checks and shared
   `OwnerHandoff` validation. The backend must resolve the consenting participant
   privately and import the complete fixed map recommendation, not accept an
   arbitrary browser/model packet as authority.
4. Connect authorized saved-result delivery to the existing
   `window.easygridDemo.setNegotiationResultSource` hook. Deliver initial saved
   rows before declaring the subscription ready. Restore the active canonical
   session and its exact local map binding after refresh/reconnect; restoring
   facility endpoints alone does not restore a registered authoritative demo.
5. Feed the canonical all-parcel agreement package into an authenticated contract
   registry/signature/approval/full-payment path. The current local simulation
   registry and payment ledger are not SpacetimeDB-backed. Do not relabel the
   canonical packet `local-fixture` to sneak it through simulated approval.
6. Once CAL-33 is ready, verify a consented live call, authenticated provider
   evidence, one post-call review and saved result through the actual service.
   Include refusal, uncertainty, unavailable-provider fallback and refresh.
7. Complete combined browser/failure verification with CAL-42 and session reset
   integration with CAL-40. Keep unfinished items unchecked in Linear.

Prepare implementation and reviewable checks before requesting any deployment
approval. There is no standing authorization to publish the updated database
module, merge PR #24 or make a live call.

## Boundaries and invariants to preserve

- CAL-33 owns calling, HTTPS/tool authentication, trusted call-to-attempt mapping,
  provider lifecycle/deadlines, transcript normalization and invoking the reviewer.
  CAL-41 owns durable state, canonical IDs and downstream agreement readiness.
- CAL-40 owns complete New Demo lifecycle and active-session replacement. Use the
  existing close hook to block old callbacks; do not conflate that hook with an
  already completed CAL-40 flow. CAL-42 is final QA, not a prerequisite for coding.
- CAL-36/CAL-37 components are marked Done, but connecting them to authoritative
  state is still CAL-41 work. CAL-29/CAL-34 are merged components, not proof the
  entire live workflow is connected.
- Current compensation scope is **one full simulated payment after the required
  signatures**. Historical 20%/80%, rent-payment and construction-payment gates
  are superseded. Fixed monthly negotiation terms still participate in shared
  budget/evidence validation; do not remove them merely because rent payouts are
  excluded. Construction is a separate compatibility hook.
- CAL-34 preserves the original roleplay participant, permits one final offer,
  and stops on refusal/uncertainty/failure. No automatic redial, participant
  reassignment or automatic reroute in this integrated path.
- Every current affected parcel must accept before route-wide agreements.
  The separate one-landowner simulation UI does not authorize the rest of a
  route or satisfy that gate. Keep any explicitly scoped example separate.
- Contact details and secrets stay server-private and out of Git, logs, exports,
  public snapshots, URLs and Linear. New tests use non-dialable synthetic
  sentinels, not participant phone numbers. Call consent is not land-access consent.
- Preserve original fictional owner/parcel/mock-recipient associations and exact
  cents. Geometry/costs are synthetic estimates, not surveyed land.
- Review claims use a 30-second database-time lease and fresh unique claim IDs.
  Save provider turns before invoking the reviewer. Review commits use the stable
  `post-call-review` request ID and must match saved evidence exactly. Expired
  workers cannot commit; changed delivery keys cannot reset offer/payment limits.

## Verified checks and useful commands

Evidence on implementation head `b54840986633104c789f1ddb5b048e63076c0d67`:

- [x] 19/19 module tests: 13 new tests plus 6 retained legacy tests.
- [x] 252/252 map-preview tests.
- [x] Module/backend typechecks and backend build.
- [x] Local module compilation with SpacetimeDB CLI 2.13.0.
- [x] `git diff --check`.
- [x] [Service CI run 40152284079](https://github.com/prathamsnehi/easygrid-calhacks-26/actions/runs/40152284079) passed on the exact implementation head.
- [ ] No new real-browser/GPU verification, live-provider evidence, actual-service
  refresh/restart demonstration or shared database publication.

From the isolated checkout, using Node 24:

```sh
npm ci --ignore-scripts --prefix packages/contracts
npm run build --prefix packages/contracts
npm ci --ignore-scripts --prefix services/spacetimedb
npm run typecheck --prefix services/spacetimedb
npm run build --prefix services/spacetimedb
npm ci --ignore-scripts --prefix services/spacetimedb/module
npm run typecheck --prefix services/spacetimedb/module
npm test --prefix services/spacetimedb/module
npm test --prefix apps/map-preview
git diff --check
```

The CLI binary is installed only in the original checkout's ignored `.tools/`
directory. This local compilation command succeeded without publishing:

```sh
/Users/prath/code/hackathons/easygrid-calhacks-26/.tools/spacetime-cli build \
  --module-path services/spacetimedb/module
```

The compiler reported Zod circular-dependency and TypeScript-configuration
warnings but exited successfully. Build output is ignored. The map suite took
about 95 seconds; it includes VM/UI checks, not real-browser layout evidence.
Do not rerun unrelated suites merely for a documentation-only update.

Harness pitfall: inside `withReducerTx`, use the callback's `ctx.db`. Calling
top-level harness `.db` accessors from inside the transaction can create a nested
datastore operation and panic its portable WASM runtime (`RuntimeError:
unreachable`). Read helper values before entering the callback when necessary.

Linear's advertised `get_agent_context` and `record_agent_learning` endpoints
returned tool-not-found errors. Issue reads/updates, comments and PR tools work;
the handoff and issue description preserve the verified context instead.

## Completion discipline

Follow repository `AGENTS.md`. Keep PR #24 draft and CAL-41 In Progress while
actual-service/browser/provider/payment acceptance remains unverified. Update
checked acceptance items with commit and real validation evidence; do not leave
finished work only in narrative notes. Publish changes to this branch and link
the PR back to Linear. Do not merge or deploy unless the user explicitly asks.
