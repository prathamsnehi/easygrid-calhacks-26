# Approval-gated settlement button

CAL-37 / CAL-41. The map's **Land & compensation** panel contains one **Settle** button labeled **Simulated**. It stays disabled until the host supplies approval for the displayed proposal and connects the settlement handler. A matching approval enables the green button. The map does not create owner consent, signatures, manager approval, bank transfers or paid receipts.

## Host integration

Use the existing `window.easygridDemo` interface. After the user approves the current signed agreement package through Seohyun's authoritative workflow, bind that approved package to the map:

```js
const map = window.easygridDemo;

map.setSettlementHandler(async ({handoff, approval, stage, requestKey, signal}) => {
  // Implement this host adapter against the shared authoritative service.
  const result = await host.requestSimulatedSettlement({
    handoff, approval, stage, requestKey, signal,
  });
  return {
    status: 'submitted',
    approvalId: approval.approvalId,
    requestKey,
    requestId: result.requestId,
  };
});

map.setSettlementApproval({
  approvalId: approvedPackage.approvalId,
  packageHash: approvedPackage.packageHash, // sha256:<64 lowercase hex digits>
  simulated: true,
  mapBinding: map.getSettlementBinding(),
});

// Revocation or lost authoritative state:
map.setSettlementApproval(null);
// Lost settlement connection:
map.setSettlementHandler(null);
```

`host.requestSimulatedSettlement` is an integration placeholder, not a supplied service. The callback receives no private participant name or number. `stage` is always `contract_tranche`: this button requests the first 20% simulated settlement, not completion balances or future monthly fees.

`mapBinding` contains the map session, route ID/version and an exact serialized `proposalKey` covering the public snapshot, owner terms/banking references, coordinate transform and cost model. Treat it as an opaque equality key, not a cryptographic signature or authorization. The host must verify that the displayed proposal corresponds to the signed approved package before projecting approval. Do not copy an approval from another route or fabricate accepted terms in the map handoff, which remains a proposed-terms snapshot.

## Authoritative approval and execution

Seohyun's CAL-37 implementation provides `approveCal37Authoritatively` and `settleCal37Authoritatively` behind an injected authoritative store. It must still check all accepted terms, simulated signatures, current contracts, owner-linked recipients, approval, amounts and stable business obligations. The browser button is only a presentation gate.

The current CAL-37 settlement command does not accept an expected approval ID/package hash directly. The integrating host must compare the requested approval ID/hash with its authoritative record inside the transactional load/compare-and-swap path. It must not silently settle a newer package than the user saw. Canonical session/route/revision mappings are host-owned; local map IDs are not server authority.

The map clears approval and aborts pending UI work after route changes, participant edits/reset/page departure or approval revocation. It rejects mismatched approvals and ignores late callbacks. Repeated identical approval notifications are harmless. Handler changes abort in-flight requests without revoking an otherwise matching approval. An abort does not establish whether the server committed a request.

## Submission and uncertain results

A click disables the button while submitting. Only a callback response with `status: 'submitted'`, matching `approvalId` and `requestKey`, and a valid `requestId` displays **Request sent**. It never displays **Paid**. The UI suppresses another request for the same approval; the authoritative service must enforce durable business-obligation deduplication across refreshes and clients.

Errors, missing acknowledgements and interrupted requests remain blocked for host reconciliation. After querying authoritative state, use:

```js
map.resolveSettlementAttempt({
  approvalId,
  packageHash,
  requestKey,
  status: 'submitted', // or 'not-submitted' only when confirmed by the host
});
```

`not-submitted` permits an explicit retry using the same request key. Never infer it from a timeout. Route changes require a new approval, and old callbacks cannot enable the new route's button.

The standalone page has no connected approval/settlement backend and correctly starts disabled. Actual SpacetimeDB persistence, authenticated approver/operator roles and simulated execution remain CAL-29/CAL-37/CAL-41 integration work. This UI does not establish that only one named teammate can operate it.
