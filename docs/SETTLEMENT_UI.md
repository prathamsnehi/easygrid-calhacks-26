# Approval-gated settlement button

CAL-37 / CAL-41. **Continue to contract & settlement** is available in EasyGrid's parcel panel and, after a reroute, in the overview. The manual **Simulate refusal** demo enables agreement preparation after the other fictional owners' scripted acceptances. Continuing opens the review journey; it does not itself sign or pay. Both simulated roles must sign every final-route agreement before an explicit payment can send each owner's full compensation once. In host-connected mode, matching approval and a settlement handler remain necessary. Connecting a negotiation source removes the manual approval shortcut.

## Host integration

Use the existing `window.easygridDemo` interface. After the user approves the current signed agreement package through Seohyun's authoritative workflow, bind that approved package to the map:

```js
const map = window.easygridDemo;

map.setSettlementHandler(async ({handoff, approval, stage, paymentSchedule, requestKey, signal}) => {
  // Implement this host adapter against the shared authoritative service.
  const result = await host.requestSimulatedSettlement({
    handoff, approval, stage, paymentSchedule, requestKey, signal,
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

`host.requestSimulatedSettlement` is an integration placeholder, not a supplied service. The callback receives no private participant name or number. `stage` is always `full` and `paymentSchedule` is `full-after-signatures`. The host must derive 100% of each owner's approved compensation and enforce all current signatures before submitting the single payment. There is no deposit, completion balance or construction payment gate.

`mapBinding` contains the map session, route ID/version and an exact serialized `proposalKey` covering the public snapshot, owner terms/banking references, coordinate transform and cost model. Treat it as an opaque equality key, not a cryptographic signature or authorization. The host must verify that the displayed proposal corresponds to the signed approved package before projecting approval. Do not copy an approval from another route or fabricate accepted terms in the map handoff, which remains a proposed-terms snapshot.

## Authoritative approval and execution

The current local contract workflow provides the full-payment API behind `createContractWorkspace({api})`. It checks all accepted terms, simulated signatures, current contracts, owner-linked recipients, approval, amounts and stable business obligations. The browser button is only a presentation gate.

The shared CAL-37 `approveCal37Authoritatively` / `settleCal37Authoritatively` APIs retain their legacy schema for compatibility. They must not receive the new callback as an unchanged legacy tranche request. A future host adapter must implement the full-payment schedule, compare requested approval ID/hash with the authoritative record inside its transaction and preserve stable business obligations. It must not silently settle a newer package than the user saw. Canonical session/route/revision mappings are host-owned; local map IDs are not server authority.

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

The local development server supplies fictional agreement approval, signatures and simulated full payments. The standalone HTML cannot perform these server actions by itself. Actual SpacetimeDB persistence, authenticated approver/operator roles and a future Capital One provider connection remain separate integration work. This UI does not establish that only one named teammate can operate it.

