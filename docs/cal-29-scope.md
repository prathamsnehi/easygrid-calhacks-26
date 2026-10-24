# CAL-29: authoritative SpacetimeDB state service

Planning only, October 24, 2026. No runtime implementation or deployment is
included. All CAL-29 runtime acceptance criteria remain pending.

Issue: [CAL-29](https://linear.app/easygrid-calhacks-2026/issue/CAL-29).
Owner: Pratham. Priority: P0, required for the demo.

## TL;DR

Build the shared backend that remembers the entire demo and enforces its rules.
The map, voice/Claude adapters and agreement/settlement adapters must all use
this authoritative service. Persist sessions, world/facility selections,
routes and terms, owner-role/consent bindings, call attempts and negotiations,
agreements/signatures, approvals, completion and the simulated ledger.

Validate every mutation against current server-owned state and authorized
identity/session/version bindings. Prevent duplicate simulated payments even
when a retry uses a different request key. Restore the same session after
refresh, reconnect or backend restart. Keep real contacts and provider secrets
out of public state and logs.

## Verified starting point

- `main` at `6eadc1e8cf61532fa7fb69e4cfdd54409d8c9df1` contains merged
  CAL-28 PR [#5](https://github.com/prathamsnehi/easygrid-calhacks-26/pull/5).
- Reuse `services/spacetimedb/client.ts`, its README and `docs/shared-setup.md`.
  The package pins SDK `2.13.0`. Its configuration reader and connection-builder
  helper do not connect by themselves or implement tables, reducers,
  subscriptions, persistence, authorization or domain operations.
- Setup records repo-local CLI/library `2.13.0` and Pratham's confirmed CLI
  login. A database name is still proposed; no published database or verified
  collaborator access is established by those setup records.
- At initial branch creation, CAL-27 PR
  [#7](https://github.com/prathamsnehi/easygrid-calhacks-26/pull/7) was draft/open,
  stacked on #3/#1. Inspected head: `2fd3c65a666145dec1ba2cc9b2ef8ee712bf9ab4`.
  During subsequent research, PR
  [#8](https://github.com/prathamsnehi/easygrid-calhacks-26/pull/8) merged that
  history into main at `ac9785cc595068f0df77f06ef25adda577f6b2e0`.
  The relevant contract/helper files are unchanged. This documentation branch
  still starts from the earlier setup main; refresh its baseline before
  implementation rather than copying schemas into a competing model.
- Relevant CAL-27 files inspected: `packages/contracts/src/api.ts`,
  `policy.ts`, `owner-handoff.ts`, `packages/contracts/README.md`,
  `docs/OWNER_HANDOFF.md` and `apps/map-preview/src/handoff.js`.
  They provide shared validation, API/client types, revision/replay helpers,
  owner handoffs and pure settlement planning. They do not supply a runtime
  state service. CAL-27's full command migration and teammate review remain open.

## Required implementation outcomes

1. Implement and publish the authoritative module, generate compatible bindings
   and connect the backend through the existing SpacetimeDB package. Own the
   connection lifecycle, subscription readiness, identity and reconnect behavior.
2. Expose the revised shared API. Authenticate/authorize commands and validate
   current session, owner, route/terms/contract revisions and allowed transitions
   inside each atomic mutation. Route/terms/contract changes invalidate affected
   approvals; callbacks from an old demo cannot mutate a new session.
3. Persist replay records with each state change. Check request replay before
   stale revisions, reject conflicting payloads, and uniquely enforce stable
   business obligations as well as request keys. CAL-27's revised obligation
   helper keys by session, parcel, stage and optional rental period; regenerating
   a contract or changing a request key must not create a second payment.
4. Preserve the approved settlement sequence: 20% of compensation at the
   contract stage, exact remaining balance after simulated completion, then
   separate monthly fees. Use USD integer cents and the shared rounding helpers.
   The legacy API v1 deposit/rent endpoint has not migrated to this workflow;
   do not feed the new owner-handoff packet directly into that endpoint.
5. Restore current state after refresh/reconnect/restart. Keep participant contact
   records private and separate from public snapshots; maintain the original
   fictional owner's mock payout identity when a participant plays that role.
6. If SpacetimeDB is unavailable, show shared state unavailable and block
   mutations. Clearly label any standalone fixture demonstration as not persisted.

## Completion evidence to collect later

- Actual Maincloud database name/identity/dashboard URL, deployed module commit,
  SDK/bindings versions and verified Theo/Stella collaborator access.
- A saved session restored through the actual service after backend restart and
  browser refresh/reconnect.
- An actual-service stale mutation rejection and atomic duplicate-obligation
  rejection, including a retry with a different request key.
- Evidence for authorization/session isolation and public/private data boundaries.
- Relevant PR, tested commit and actual check results linked to CAL-29. Package
  compilation or fake-store tests alone do not establish runtime persistence.

Live calls must be distinguished from simulated negotiations, signatures and
payments. CAL-29 supplies authoritative state for those workstreams; their
provider execution and end-to-end assembly remain separate issues.

## Sources and validation for this planning PR

Read CAL-29, its empty comment thread, CAL-27, the
[approved English plan](https://linear.app/easygrid-calhacks-2026/document/easygrid-project-overview-and-execution-plan-v1-english-54a9d9f9b23a),
current setup/scaffold files and the CAL-27 branch files listed above. Linear's
shared agent-context tool returned unavailable; no additional notes were read.
This PR changes only this document. No runtime tests, service calls, dependency
installation, database publication or implementation were performed.
