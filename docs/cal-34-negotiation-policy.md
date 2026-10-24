# CAL-34: negotiation policy and outcome validation

Preparation snapshot: October 24, 2026. This document seeds the dedicated draft
PR; negotiation policy, provider review and state integration are not implemented
by this change. Acceptance criteria remain open in
[CAL-34](https://linear.app/easygrid-calhacks-2026/issue/CAL-34).

## Goal and architecture

Negotiate exact compensation and monthly fees within parcel and project limits,
using the best eligible alternative route to decide when to stop and replan.
Only explicit, corroborated confirmation of the current exact terms can produce
an accepted outcome. Silence, a model recommendation and call completion cannot.

Follow the hybrid architecture recorded in
[CAL-33](https://linear.app/easygrid-calhacks-2026/issue/CAL-33):

- Cartesia's managed model handles ordinary conversation and invokes backend
  tools at decision boundaries.
- CAL-34 supplies deterministic counteroffer, budget, round-limit and outcome
  validation rules consumed by those tools.
- A provider-neutral AI interface, initially using `services/claude-api`, extracts
  and reviews outcome candidates after the call. Do not add an external model
  request to every conversational turn. Keep model selection in runtime code.
- [CAL-29](https://linear.app/easygrid-calhacks-2026/issue/CAL-29) owns authoritative
  state, authorization and atomic mutations. CAL-34 must not create another
  independently mutable negotiation store.

## Shared inputs and dependency boundary

Reuse [CAL-27](https://linear.app/easygrid-calhacks-2026/issue/CAL-27)'s shared
schemas, `OwnerHandoff.parse`, bank-free `createVoiceHandoff` and confirmation
rules. Its current implementation reference is
[PR #7](https://github.com/prathamsnehi/easygrid-calhacks-26/pull/7), including
`packages/contracts/src/claude.ts`, `policy.ts` and `docs/OWNER_HANDOFF.md`.
The existing pure normalizer is a starting point, not a running negotiation loop.
The compatibility API v1 deposit/rent model is not the revised compensation model.

Consume construction costs, parcel terms, configured caps and the best eligible
alternative from [CAL-30](https://linear.app/easygrid-calhacks-2026/issue/CAL-30).
Its pricing reference is [PR #8](https://github.com/prathamsnehi/easygrid-calhacks-26/pull/8).
Do not reproduce routing or assume a fixed budget, rent horizon or round limit.

This branch starts from `main` at
`6eadc1e8cf61532fa7fb69e4cfdd54409d8c9df1`, containing the merged CAL-28 service
scaffolds. Shared contracts/map files referenced above are absent from that
baseline. Resolve their dependency chain before importing or changing them;
this preparation PR does not pull their unmerged changes into its diff.
CAL-29 is being developed separately and supplies the eventual state interface.

## Required decision rules

- Validate session/project/route/owner/parcel identity, current route and terms
  revisions, exact integer-cent amounts, allowed terms and evidence references
  against trusted state. Model arguments cannot authorize themselves.
- Compare `construction + one-time compensation + monthly fees * horizon` for
  every evaluated route using one configured horizon. The 20% contract tranche
  and remaining completion balance divide compensation; never count an extra
  deposit or add both tranches on top of compensation.
- Check parcel caps and total project budget, accounting for all affected parcels.
  Only permit offers within those limits. Stop at the configured round bound or
  when an eligible bypass is more economical, and request replanning.
- Preserve accepted, refused, counteroffer, pending and review-required outcomes.
  Malformed, unknown, approximate or contradictory results cannot become accepted.
- Require evidence for explicit confirmation/readback of the current exact terms,
  including land-access consent where required. Reconcile post-call extraction
  against live events; missing transcript/model or conflicting evidence remains
  pending/review-required and blocks agreement readiness.
- A clear refusal locks out further live calls in that demo and requests replanning.
  Preserve the original participant role; other owners use labeled simulations.
- Recheck identity, authorization, revisions, caps and round state inside CAL-29's
  atomic mutation. Persist terms, outcome, evidence and round updates together.
  Duplicate tool deliveries return the prior result without advancing twice.
- Keep private contacts, raw transcripts, banking records and provider credentials
  out of public projections and model inputs that do not require them.

CAL-33 owns tool authentication, call lifecycle and provider connectivity.
CAL-34's intended tool consumers are `evaluate_counteroffer`,
`record_owner_response` and `record_refusal`; align their fields with CAL-27
and CAL-29 before implementation. These are design names, not existing exports.

## Verification to implement

Cover under-cap and over-budget counteroffers, total-budget exhaustion, recurring
fees on a common horizon, an economical bypass, bounded rounds, explicit versus
ambiguous confirmation, stale route/terms versions, wrong owner/session,
contradictory evidence, duplicate deliveries, refusal lockout and unavailable
transcript/model. Check authoritative atomic persistence separately from pure
policy tests. Label all fixture negotiations as simulated.

[CAL-41](https://linear.app/easygrid-calhacks-2026/issue/CAL-41) owns end-to-end
integration; CAL-34 unblocks replanning (CAL-35) and session/result handling
(CAL-40). Record actual tested commits and check results in CAL-34 before claiming
completion. No provider call, deployed state mutation or end-to-end workflow is
verified by this documentation change.

## Source context

- [Approved English plan](https://linear.app/easygrid-calhacks-2026/document/easygrid-project-overview-and-execution-plan-v1-english-54a9d9f9b23a)
- Linear issues CAL-34, CAL-33 (hybrid implementation decision), CAL-29, CAL-27
  and CAL-30, read October 24, 2026. CAL-34 had no comments at preparation time.
- Local `docs/shared-setup.md`, `services/spacetimedb/README.md` and
  `services/claude-api/README.md`. The latter is credential/access-test guidance,
  not a running AI service.
