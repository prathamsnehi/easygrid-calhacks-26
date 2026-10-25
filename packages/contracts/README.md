# EasyGrid shared contracts — CAL-27

For the revised owner → voice → settlement workflow, start with the [owner handoff guide](../../docs/OWNER_HANDOFF.md) and [development examples](examples/owner-handoff.json). The additive owner-handoff contract links the existing map data to synthetic banking recipients and models 20% compensation, the exact completion balance and post-completion monthly fees. It is separate from the legacy API v1 transport below; it does not deploy a backend or execute calls/payments.

## Legacy API v1 compatibility

A shared, executable contract for Theo's routing, Pratham's Claude/voice adapter and Seohyun's easement/payment adapter. TypeScript types are inferred from the same strict Zod schemas used at runtime. This package is independent of the app framework so CAL-5 can import it into the shared SpacetimeDB backend without a competing database.

## Run

Use Node 22.18+ (also tested locally on Node 24).

```sh
cd packages/contracts
npm ci
npm run check
```

`check` runs type checks, behavior tests, generated-artifact drift checks and an ESM/declaration build. `npm run generate` refreshes OpenAPI and JSON fixtures after an intentional contract change. No credentials or external service calls are required.

## Use in each workstream

Build this package, then add `"@easygrid/contracts": "file:../contracts"` to an adjacent package's dependencies (adjust the relative path for the consuming app).

```ts
import { operations, createApiClient, type ApiRequest, type ContractApi } from '@easygrid/contracts';

const request: ApiRequest<'evaluateRoutes'> = {
  projectId: 'demo-cedar-valley', schemaVersion: 1,
  expectedRevision: 0, idempotencyKey: 'routes-01',
};
operations.evaluateRoutes.request.parse(request);
const api = createApiClient('http://localhost:3000', authenticatedFetch);
const response = await api.execute('evaluateRoutes', request);
```

`authenticatedFetch` is the application's fetch wrapper, supplied by the consumer. The client validates both directions, puts path IDs in the URL rather than duplicating them in the body, and performs **zero automatic retries**. `ContractApi` is the interface for the server adapter. There is no deployed `/api/v1` service or persistence implementation in CAL-6; the generated specification and client are ready for those adapters.

| File | Purpose |
|---|---|
| `src/owner-handoff.ts` | Revised owner packet, mock recipient binding, voice projection and guarded settlement plans |
| `src/owner-handoff-fixtures.ts` | Fresh deterministic development inputs, outcomes and rejected cases |
| `examples/owner-handoff.json` | Generated development pack for Theo, Pratham and Seohyun |
| `examples/owner-handoff.schema.json` | Generated JSON shapes; use runtime helpers for cross-record validation |
| `src/schemas.ts` | Entities, status enums, money, geometry, evidence and versions |
| `src/api.ts` | 13 operations, request/response schemas, errors, typed client/server boundary |
| `src/policy.ts` | Exact cents conversion, cost calculation, revision checks, replay/event helpers and approval/payment gates |
| `src/claude.ts` | Strict model-output parsing and safe pending/review fallback |
| `src/fixtures.ts` | Synthetic seed data and canonical request/response examples |
| `openapi.json` | Generated OpenAPI 3.1, 13 operations and entity schemas |
| `examples/api-v1.json` | One request and successful response for every operation |
| `examples/happy-path.json` | Coherent example of signed contracts, approval and mock settlement |
| `examples/edge-cases.json` | Refusal, no route, cap violation, timeout, malformed model output, duplicates, stale state, changed contract and rent mismatch |

## Rules the adapters must preserve

- Money is nonnegative safe-integer **USD cents**. Geometry is GeoJSON WGS84 `[longitude, latitude]`; distance is meters. Arbitrary coordinates cannot be recognized as accidentally reversed if both numbers are within their legal ranges.
- `schemaVersion` is 1. All material changes increase the project revision. Commands carry `expectedRevision` and `idempotencyKey`; project creation uses expected revision 0. Demo reset requires the current project revision and a new session/project identity; it does not rewind the old project's history.
- Return HTTP 409 for stale revision/version or a conflicting idempotency key, 422 for blocked state, and 503 for unavailable dependencies. Errors include `requestId`; every supplied error envelope defaults to `retryable: false`.
- **Replay before checking the revision.** Scope keys by authenticated actor, project/session and operation; fingerprint the entire validated command. Persist the key, fingerprint, original response, mutation and audit event in one atomic SpacetimeDB transaction. An in-memory map is not a durable idempotency solution. The same key/payload returns the original result/revision; different content returns 409. Event IDs also deduplicate and reject conflicting content.
- Authenticate and authorize every route. Only a trusted provider adapter or explicit operator can record negotiation results. Only a manager can approve; reset is demo-only. The pure helpers do not establish identity, authorization, locks or transaction isolation.
- Raw model text cannot choose entity IDs, revisions, approvals, evidence provenance or payment state. `normalizeClaudeOutput` uses server-owned context and independently verified consent/confirmation. A valid model proposal is still subject to deterministic terms/cost/approval policy. Malformed output yields `review_required`; timeout yields `pending`. Provider keys and real participant contacts stay server-side.
- Consent, preliminary regulatory screening, simulated signature, manager approval and settlement remain separate gates. A refusal blocks every route crossing that parcel. A route/terms/contract change must atomically invalidate existing approvals and stale pending actions.
- `assertApprovable` takes **current server-owned state**, checks one current signed contract per crossed parcel, accepted/evidenced terms, complete fixture screening, versions and recalculated costs. Never trust client `eligible`, `readyToApprove`, cap values or a stale snapshot. Production adapters must also enforce unique entity IDs and read current terms/contracts atomically.
- `paymentAmount` derives the amount from the current immutable contract and approval. A signed contract alone is insufficient. Check the command's contract version, resolve the current contract/approval in the same transaction, and use one ledger obligation key per contract version/kind/period even if a client changes its idempotency key. Unknown provider outcomes require reconciliation before any retry. `sourceMode` for payments is only `sandbox` or `mock`.

## Clarifications made executable in v1

1. `Approval.contractVersions` binds every signed contract version, in addition to route and terms versions. This prevents a newly revised contract from using an old approval.
2. `RouteCandidate.separateDepositTotalCents` makes separately charged deposits visible: total = construction + upfront compensation + evaluated rent + separate deposits. Credited deposits are already part of upfront compensation and are never added twice. A credited deposit cannot exceed upfront compensation.
3. The demo parcel `offerCapCents` applies to upfront compensation plus any separately charged deposit. The project budget additionally includes rent over the same explicit horizon for all candidates, capped at each contract's covered months. No discounting or global-optimum claim.
4. Rent examples use full calendar months, month-aligned starts and inclusive end dates, with no proration. The payment guard rejects periods outside that term. Production date/proration policy belongs to CAL-15.
5. Negotiation writes use `{ projectId, result: NegotiationResult, schemaVersion, expectedRevision, idempotencyKey }`. The result has its own stable ID. This resolves the earlier illustrative flat example.
6. OpenAPI describes wire structure. Closed rings, unique IDs, cross-field agreement and authoritative state gates also require the runtime validators; JSON Schema alone cannot establish these business facts.

## Fixtures and provenance

All owners, geometries, evidence, agreements and payment references here are **synthetic**. Geometry is illustrative and does not identify actual parcel boundaries. Distances are inherited demo estimates, not surveyed distances or geometry-derived measurements. The zero SHA-256 value is a fixture placeholder, not a computed document hash. A real adapter must compute the content hash from the exact immutable artifact.

Parcel IDs P1–P6, the `direct`/`north`/`south` route IDs, seed dollar amounts, exact cents conversion and request fingerprint semantics were adapted from the team's existing local Gridline `lib/domain.ts` and `convex/negotiations.ts`. No Convex server, UI, credentials or unrelated source was copied. Initial prices and offer caps are fictional. The new contract is the shared source of truth for integrations; legacy `/api/evaluate`, `/api/calls` and `/api/voice/terms` should map through explicit adapters rather than grow competing domain definitions.

Examples are **independent boundary samples**, not a complete sequential server replay. `happy-path.json` is a coherent snapshot in which all three crossed parcels have current demo-signed contracts. The refusal scenario is a separate branch. The `pass` screening fixture is expressly a simulated preliminary result, never a legal determination. No Claude call, phone call, signature, funds movement or deployed backend is performed by this package.

## Review and handoff

- Theo: confirm IDs, coordinate conventions, cost fields and route-version behavior.
- Pratham: implement `ContractApi` in the SpacetimeDB facade, durable atomic idempotency/auth, and Claude/voice normalization; keep unknown outcomes pending until resolved.
- Seohyun: implement immutable contracts/artifacts, simulated signing, contract/approval version binding, ledger obligations and reconciliation.

All three owners must review before freezing the revised interface or replacing mocks with integrations. Tests passing do not constitute teammate review. CAL-27 remains open for the broader workflow migration and review.

Linear: https://linear.app/easygrid-calhacks-2026/issue/CAL-27


## Short negotiation policy (CAL-34)

The additive `applyNegotiationCommand` transition uses the revised owner handoff,
fixed recommendation/cap, full-route budget reservations and one final offer.
It returns a reducer snapshot plus attempt/receipt for an atomic CAL-29 commit;
it is not a mutable store. `createNegotiationTools` binds CAL-33 tools to an
explicit authorized host port. `NegotiationSummary` and
`createNegotiationResultUpdate` provide redacted terminal reasons for the map.
`NEGOTIATION_VOICE_PROMPT` targets 30–45 seconds with no extra readback ceremony.
These additions do not change the legacy API v1 deposit-based normalization.
See [integration and verification](../../docs/CAL34_INTEGRATION.md).
