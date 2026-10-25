# Contract authoring, click signatures and full payment

CAL-36 / CAL-37. This implementation starts from temporary fictional negotiation examples. Pratham and Theo will agree the authoritative SpacetimeDB handoff separately; this patch does not freeze or replace their schema.

## Run locally

Use the repository's Node 24 baseline:

```sh
cd apps/map-preview
node build.mjs
node serve.mjs
```

Set `EASYGRID_PREVIEW_PORT` to use another local port when needed. Open `http://127.0.0.1:4177/contracts.html` for the development example. The normal map remains at `/`. The example page fetches approved fixture terms from `GET /api/contracts/example`, which returns the same source the local workflow validates. It opens the first agreement automatically. The local server is required to load the example and to sign or submit; exported HTML remains self-contained.

1. Expand **Example data** and switch to Pending or Refused to verify that **Review agreements** is disabled.
2. Choose Approved to reopen the document. Two fictional landowner agreements are available in the parcel selector. Willow Creek Orchard / P-004 shows $12,000 total, payable in one $12,000 payment after every final-route agreement has both signatures.
3. Review the generated document. Compensation and recipient ownership come from the approved source. Expand **Edit draft details** for optional changes to developer display name, document date, draft access description and reviewer notes. The original approved access terms remain visible and cannot be overwritten by editing a description.
4. Save the draft in this browser or download a self-contained HTML copy. It can be printed to PDF using the browser's normal print action.
5. Click **Developer** and **Landowner** in the signing panel. Each simulated signature is recorded against the exact server-computed document hash and revision. Changing a field invalidates the current signatures. The utility signature approves the full compensation amount, single-payment schedule and configured recipient binding.
6. Both signatures are required for every parcel on the approved final route before full-payment submission is enabled. Submission triggers the server's accounts-payable worker; it rechecks both signatures, distinct actor identities, approved amount, current destination, existing bank evidence and available balance.
7. A normal local simulation posts one matching transaction and a balanced demonstration journal. Retries and concurrent submissions reuse the same business obligation and cannot pay it twice. A new draft ID cannot bypass this guard.

No legally executed signatures or real funds are involved in the default local simulation. Each agreement specifies one payment of 100% of the approved compensation after all final-route agreements are signed. There is no deposit, completion balance, construction gate or recurring payment. The existing Capital One Nessie adapter is retained for a later connection; this change does not establish a live bank integration.

## Judge scenarios and answer key

Expand **Demo settings & activity** to find the **Payment scenario** selector and the audit trail. It is hidden for a configured Nessie provider.

| Scenario | Correct result | Evidence |
| --- | --- | --- |
| Normal payment | Exact full compensation completes once in local simulation | Matching transaction, stable obligation, balanced journal |
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

The integrated EasyGrid map connects confirmed refusal reroutes through **Continue to contract & settlement**, followed by **Review agreements**. See [the CAL-41 bridge](MAP_CONTRACT_HANDOFF.md) for the full journey and server reconstruction. A development host can also project a matching fixture approval:

```js
window.easygridDemo.setContractNegotiation({
  input: temporaryApprovedFixture,
  mapBinding: window.easygridDemo.getContractBinding(),
});
```

The host must verify that its fixture corresponds to the exact displayed proposal before providing this value. Route/participant/context changes revoke readiness. This is a presentation boundary, not authenticated authorization. The HTTP service retains the fixed standalone example and now separately registers validated local map packages. Its development approval endpoint reconstructs proposals from trusted geometry and owner fixtures; it is not a live negotiation or property-consent service.

`createContractWorkspace({api})` accepts an injected operation adapter. The current adapter uses same-origin `/api/contracts/*`; replace it with the agreed shared service when canonical session/route/owner/terms mapping is ready.

`contractDocument` exposes `totalCents`, `paymentCents` equal to the full total, and `paymentSchedule: 'full-after-signatures'`. The payment API accepts `stage: 'full'`; old staged requests are rejected. These local workflow fields are separate from the unchanged legacy shared-package deposit/tranche schemas. Any existing attempted staged payment must be reconciled before migrating its obligation; a new full-payment request cannot be used to bypass it.

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

## Review layout

The main document shows EasyGrid and the landowner, parcel, date, approved access terms, total compensation, the single full-payment condition and signature status. Identical draft/approved access descriptions are shown once; reviewer notes appear only when present. Source IDs and versions remain available under **Approval reference & versions**.

The right column prioritizes confirmed compensation and two simulated signatures. The payment panel appears after both selected-contract signatures; execution still requires every final-route contract to be signed. A single full-payment action completes each owner's compensation. Construction controls are outside this payment journey.

## Named sample signatures

The approved local example uses **EasyGrid**, represented by fictional **Ethan Cole**; **Olivia Bennett** represents Willow Creek Orchard and **Daniel Brooks** represents Meadow Ridge Farm. The integrated map also uses EasyGrid / Ethan Cole and retains each original synthetic owner alias. Optional `project.signerName` and `parcels[].signerName` values are validated, allowlisted and bound to the source key and document hash. Changing a representative invalidates the prior draft and signatures. Sources without representative names retain their existing canonical shape.

Handwritten-style names appear only after the service records each simulated signature. The document and standalone HTML export include the signer name, organization, date and simulation label. Unsigned agreements retain an empty signature line. This example has a separate session ID so previous demo signatures and payment records are not reused.
