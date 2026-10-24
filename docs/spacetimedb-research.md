# SpacetimeDB research for EasyGrid

Research date: October 24, 2026. Design input for CAL-29; no implementation or
deployment is established by this document.

## Finding

SpacetimeDB can host EasyGrid's authoritative application logic, persistent
state and live synchronization together. The strongest application is a shared,
reactive project workflow: a negotiation changes validated project state, and
the map and agreement/payment screens receive the committed changes.

This recommendation follows the user-provided local inputs
`docs/tracks/spacetime.md` and `docs/overview.md` (currently untracked and left
untouched by this PR). The brief's strategic priorities are our
interpretation of the workshop, not a detailed official judging rubric.

## Research and version baseline

- Read the official documentation and release notes linked below, the installed
  `spacetimedb` package source, the existing service scaffold and provider
  adapters, and the CAL-27 contract/handoff code previously inspected for CAL-29.
- Re-ran `./.tools/spacetime-cli --version`: CLI/library `2.13.0`, commit
  `08e1aba133671f9c631c6e70133a82faa0e7b283`.
- Both `services/spacetimedb/package.json` and its installed SDK report `2.13.0`.
  Module dependencies and future generated clients should use this baseline.
- During research, PR #8 merged the map/contracts baseline into remote `main`
  at `ac9785cc595068f0df77f06ef25adda577f6b2e0`, including PR #7's history.
  The relevant API, policy and owner-handoff source is unchanged from the
  inspected PR #7 head. CAL-27 remains In Progress for remaining contract work.
- The current documentation is labeled `2.0.0`, representing the documentation
  family rather than proof that every example matches our patch version.
  Checked relevant APIs against the installed 2.13.0 SDK. Actual Maincloud host
  compatibility, module compilation and deployment still need verification.
- No SpacetimeDB-specific `SKILL.md` was found in the installed skill directories,
  despite the track brief expecting one. Official docs and installed source
  supplied the technical references. No new skill or dependency was installed.

The official [2.13.0 release](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.13.0)
adds reusable TypeScript submodules and CLI management for SpacetimeAuth, and
clarifies durability confirmation for HTTP calls. Older articles describing
these areas as unavailable should not determine this architecture.

## Capabilities and their relevance

| Capability | What it provides | EasyGrid use |
| --- | --- | --- |
| Application modules | Schema and server functions deployed together; TypeScript modules run on V8 | Host workflow rules beside the data |
| Transactional reducers | Atomic state changes with rollback on failure | Validate terms, invalidate approval, update progress and append an audit record together |
| Subscriptions and local caches | Initial query results followed by live changes | Keep map, operator and settlement screens synchronized |
| Caller-aware views | Read-only projections that can filter rows and columns by identity | Expose authorized session data without exposing contact records |
| Identities and SpacetimeAuth | OIDC authentication, including a managed identity provider | Identify operators, viewers and the provider worker; enforce roles separately |
| Schedule tables | Persistent scheduled invocation of reducers or procedures | Mark an overdue call for reconciliation or expire a worker lease |
| Procedures | Outbound HTTP and explicitly scoped database transactions | Option for bounded provider requests; not one atomic transaction across a phone/AI API |
| Event tables | Transient notifications delivered to current subscribers | Optional visual effects; regular tables remain the source for history and recovery |
| Type generation and UI SDKs | Generated clients and framework integrations | Typed domain adapter; use plain TypeScript for the current map |
| Submodules | Reusable scheduling, retry, rate-limit and crypto utilities | Evaluate rate limiting; retry only operations known to be safe |
| Module test utilities | Transaction, identity, clock, RNG and HTTP-test support | Exercise authorization, rollback and stale/duplicate commands |
| Managed or local hosting | Maincloud deployment and local development | Shared demo database plus a disposable integration-test database |

These are platform capabilities, not claims that EasyGrid implements them.

## Application execution

A module defines tables and server functions; a database is a running instance
of that module with its own data. TypeScript server code executes on V8. This
supports using the team's language without rewriting the domain in Rust, but
does not establish that a Node-targeted package can execute unchanged inside
the module. [Database/module model](https://spacetimedb.com/docs/databases/).

Reducers are the default write path. Their changes commit together or roll back
together, making them suitable for consequential workflow transitions. They
cannot perform external network I/O. A reducer accepting a change must load
and check current authoritative records, rather than trust a browser's
`approved` or `eligible` flag.
[Reducers](https://spacetimedb.com/docs/functions/reducers/).

Transactions do not automatically supply EasyGrid's business rules. We still
define session ownership, legal state transitions, version checks and unique
obligations. Database constraints support those rules, and failed writes must
leave all related records unchanged.
[Transactions](https://spacetimedb.com/docs/databases/transactions-atomicity/).

## Real-time reads and recovery

Subscriptions initially populate the SDK cache and then send matching changes.
The application should wait for subscription `onApplied` before treating that
cache as current. Explicitly select required views instead of subscribing to
everything. [Subscriptions](https://spacetimedb.com/docs/clients/subscriptions/).

Subscription updates from one transaction are applied together before row
callbacks execute. This supports displaying a consistent project update, but
the application should not depend on the order of individual row callbacks.
[Subscription semantics](https://spacetimedb.com/docs/clients/subscriptions/semantics/).

The installed TypeScript SDK has opt-in `.withAutomaticReconnect()`,
`.onAutomaticReconnect()` and `.withConfirmedReads(true)`. It retains
subscriptions during recovery; wait for their next `onApplied` before enabling
actions. Core SDK initial connection failures require application handling.
Persist the intended identity across page reloads. In-flight calls can have
unknown results after disconnect; resolve them through durable request records
before repeating work. [TypeScript SDK](https://spacetimedb.com/docs/clients/typescript/).

The 2.13.0 release states that confirmed HTTP calls wait for durability and can
return an unknown outcome on confirmation timeout. A timeout therefore cannot
be interpreted as a rolled-back mutation. This is a separate concern from an
external provider's timeout.
[Release notes](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.13.0).

## Security and data visibility

Authentication supplies an identity; it does not grant a manager or worker
role. Anonymous connections get identities too. Keep a module-owned membership
mapping and validate it for writes. SpacetimeAuth is available if the product
needs managed sign-in; it need not be added merely to use subscriptions.
[Authentication](https://spacetimedb.com/docs/core-concepts/authentication/).

Private tables plus caller-aware views can enforce both row and column
visibility. The view's `public` declaration means clients can invoke it, not
that it must return all private rows. An arbitrary session ID or a client SQL
filter is not authorization. Design indexes for membership and session lookups;
views cannot scan tables using `.iter()`.
[Access permissions](https://spacetimedb.com/docs/tables/access-permissions/),
[views](https://spacetimedb.com/docs/functions/views/).

Official guidance currently recommends views over experimental row-level
security. Use views for this project rather than add an unstable security
mechanism without a specific need. Administrators still have privileged access;
private application tables are not a claim of secrecy from the deployment
owner. [RLS guidance](https://spacetimedb.com/docs/how-to/rls/).

## Providers, schedules and reusable components

Procedures can call external APIs, using synchronous `ctx.http.fetch` in
TypeScript. Reads/writes require explicit `withTx` blocks, and HTTP must happen
outside an open transaction. A procedure may commit one transaction, call a
provider, then fail before another transaction: those earlier changes and the
external effect do not roll back together.
[Procedures](https://spacetimedb.com/docs/functions/procedures/).

Schedule tables can invoke reducers/procedures later. Use real time for lease
expiry and call deadlines, and a separate simulated calendar for demo rent.
Neither a scheduled invocation nor a retry helper proves exactly-once effects
at a third-party API. [Schedule tables](https://spacetimedb.com/docs/tables/schedule-tables/).

The published submodule catalog includes cron, retry, rate limiting, crypto and
Resend utilities. They are candidates for reuse, not requirements. In
particular, exponential backoff must not blindly redial a call whose first
submission may have succeeded. Verify each chosen package/version before adding
it. [Submodules](https://spacetimedb.com/submodules).

Database environment variables support declared server configuration/secrets
through `ctx.env`. These are distinct from a Node worker's environment. Keep
provider credentials in the runtime that actually calls that provider and
never return them from views or log them.
[Module environment](https://spacetimedb.com/docs/databases/environment-variables/).

Custom HTTP handlers exist, but are beta and do not automatically authenticate
their `Authorization` header as normal SpacetimeDB calls do. They could receive
webhooks after explicit signature verification; they are unnecessary for the
first worker-based integration. The current Cartesia adapter already fetches
call status. [HTTP handlers](https://spacetimedb.com/docs/functions/http-handlers/).

## Durability, artifacts and operations

Event-table rows disappear after their transaction; a newly connected client
cannot recover missed events by querying that table. Although the commitlog
records inserts, our application should persist audit history, job state and
payment outcomes in regular tables for queryable recovery.
[Event tables](https://spacetimedb.com/docs/tables/event-tables/).

Small agreement content can be stored inline with its immutable hash and
version. The file-storage guide also describes external storage patterns; do
not mistake inline byte storage for a dedicated object-storage service. Keep
large recordings out of the synchronized project snapshot.
[File storage](https://spacetimedb.com/docs/tables/file-storage/).

Compatible module updates can preserve existing data. Appending defaulted
columns differs from changing an existing column's type/order. Test migration
against a saved session and regenerate bindings; do not reset the shared demo
database to make a migration pass.
[Automatic migrations](https://spacetimedb.com/docs/databases/automatic-migrations/).

The SDK provides module testing with transactions, test identities, deterministic
clock/RNG and mocked HTTP. This is useful evidence for module logic, but
Maincloud persistence, network recovery and real provider behavior still need
separate integration checks.
[Module testing](https://spacetimedb.com/docs/how-to/unit-testing/).

## Recommended architectural direction

Use a TypeScript module as the workflow authority, direct authorized
subscriptions for the browser, and one Node provider worker subscribing as a
client. This reuses `services/cartesia/`, keeps long-running voice orchestration
in its existing runtime and makes job recovery visible in SpacetimeDB.

A procedure-only provider implementation is a valid alternative for short HTTP
operations. Choose it later if it demonstrably removes complexity; do not
maintain two executors for the same job. A worker is our integration choice,
not a claimed limitation that SpacetimeDB cannot call APIs.

See [the architecture proposal](spacetimedb-architecture.md) for data ownership,
command flow, security, recovery and the proposed judge demonstration.
