# Contract authoring, click signatures and initial settlement

CAL-36 / CAL-37. This implementation starts from temporary fictional negotiation examples. Pratham and Theo will agree the authoritative SpacetimeDB handoff separately; this patch does not freeze or replace their schema.

## Run locally

Use the repository's Node 24 baseline:

```sh
cd apps/map-preview
node build.mjs
node serve.mjs
```

Set `EASYGRID_PREVIEW_PORT` to use another local port when needed. Open `http://127.0.0.1:4177/contracts.html` for the development example. The normal map remains at `/`. The offline `dist/contracts.html` supports authoring and HTML download, but click signatures and submission require the local server.

1. Switch the example negotiation to Pending or Refused to verify that **Proceed to contract** is disabled.
2. Choose Approved, then **Proceed to contract**. Two fictional landowner agreements are available in the parcel selector.
3. Review the generated document. Compensation and recipient ownership come from the approved source. Developer name, document date, draft access description and reviewer notes are editable. The original approved access terms remain visible and cannot be overwritten by editing a description.
4. Save the draft in this browser or download a self-contained HTML copy. It can be printed to PDF using the browser's normal print action.
5. Click **Power utility** and **Landowner**. Each simulated signature is recorded against the exact server-computed document hash and revision. Changing a field invalidates the current signatures. The utility signature approves the precise initial 20% amount and the configured recipient binding.
6. Both signatures are required for every parcel on the approved final route before the initial-payment submission is enabled. Submission triggers the server's accounts-payable worker; it rechecks both signatures, distinct actor identities, approved amount, current destination, existing bank evidence and available balance.
7. A normal local simulation posts one matching transaction and a balanced demonstration journal. Retries and concurrent submissions reuse the same business obligation and cannot pay it twice. A new draft ID cannot bypass this guard.

No legally executed signatures or real funds are involved. The draft includes the agreed 20% and completion-balance terms, but this patch executes only the initial tranche. Monthly-rent fields and functionality are excluded. The construction and balance journey is supplied by the CAL-38 prerequisite; see `CONSTRUCTION_PAYMENTS.md`. No recurring-payment functionality is included.

## Judge scenarios and answer key

The development page exposes a **Planted finance scenario** selector. It is hidden for a configured Nessie provider.

| Scenario | Correct result | Evidence |
| --- | --- | --- |
| Normal payment | Exact 20% completes once in local simulation | Matching transaction, stable obligation, balanced journal |
| Payout destination changed | Hold before any transfer; controller review | `approved-recipient-binding` audit reason |
| Bank amount differs by $1 | Escalate to review; never send a replacement | Expected and observed cents in audit, no completed-payment journal |
| Insufficient balance | Hold before transfer | `sufficient-balance` rule |
| One signature missing | Submission rejected | Server validation, disabled UI action |
| Edited signed draft | Both new signatures required | Hash/revision validation |
| Double click or new draft ID | No second payment | One obligation and journal entry |
| Unknown bank outcome | Block retry and query evidence only | Reconciliation never sends a replacement transfer |

An unattempted hold can be retried after the simulated underlying issue is corrected by choosing Normal. An independent utility-controller role can reject an unattempted held request. Unknown, pending or mismatched evidence cannot be converted to success by a browser button.

## Temporary input and future host boundary

`src/contract-fixtures.js` defines the examples; `src/contract-authoring.js` validates and normalizes them. The normalization allowlist excludes transcripts, participant contact and bank data. It requires an approved negotiation and accepted, versioned terms for every final-route parcel.

The shared map now connects selected routes through **Simulate approved negotiation** and **Proceed to contract**. See [the CAL-41 bridge](MAP_CONTRACT_HANDOFF.md) for the full journey and server reconstruction. A development host can also project a matching fixture approval:

```js
window.easygridDemo.setContractNegotiation({
  input: temporaryApprovedFixture,
  mapBinding: window.easygridDemo.getContractBinding(),
});
```

The host must verify that its fixture corresponds to the exact displayed proposal before providing this value. Route/participant/context changes revoke readiness. This is a presentation boundary, not authenticated authorization. The HTTP service retains the fixed standalone example and now separately registers validated local map packages. Its development approval endpoint reconstructs proposals from trusted geometry and owner fixtures; it is not a live negotiation or property-consent service.

`createContractWorkspace({api})` accepts an injected operation adapter. The current adapter uses same-origin `/api/contracts/*`; replace it with the agreed shared service when canonical session/route/owner/terms mapping is ready.

## State and roles

- Browser localStorage stores editable fictional drafts, separately for each session/route/parcel. Saved sources that no longer match are discarded rather than silently reused.
- `apps/map-preview/.local/contract-ledger.json` stores simulated signatures, obligations, audit evidence and journals. Writes use an atomic replacement and mutations are serialized within one process. This is development persistence, not a multi-process database or SpacetimeDB integration.
- A pre-transfer state is persisted before a bank write. A process failure or uncertain provider result leaves the obligation blocked until reconciliation; no POST retry is automatic.
- Simulation and Nessie use separate ledger files. A local simulated receipt is never proof of a Nessie transfer.
- The demo supplies distinct utility-controller, landowner and accounts-payable identities from the server. Role checks and separation of duties are tested, but the UI intentionally lets one operator play both click-signature roles. Production login and identity authorization remain open.

## Validation

The repository map test command includes the new domain, workflow, UI-controller, local-API persistence and mocked Nessie tests:

```sh
npm test --prefix apps/map-preview
```

UI-controller/VM tests verify behavior, not actual browser layout, WebGL or visual rendering. See `FINANCE_TRACKS.md` for sponsor evidence and remaining live verification.
