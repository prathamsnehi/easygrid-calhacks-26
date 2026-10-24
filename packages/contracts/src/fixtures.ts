import * as s from './schemas.ts';
import { calculateCost } from './policy.ts';
import { operations, type OperationName } from './api.ts';
import { normalizeClaudeOutput } from './claude.ts';

/** Entirely synthetic; IDs and cost seeds adapted from the existing Gridline domain.ts. */
const meta = { schemaVersion: 1 as const, sourceMode: 'fixture' as const, evidenceRefs: ['fixture:cedar-valley-v1'] };
const projectId = 'demo-cedar-valley';
const at = '2026-10-24T19:00:00Z';
const seeds = [
  ['P1', 'Walnuts', 24, 24000, 42000], ['P2', 'Pears', 18, 28000, 55000],
  ['P3', 'Wheat', 32, 22000, 38000], ['P4', 'Sunflowers', 26, 26000, 45000],
  ['P5', 'Hay', 38, 35000, 52000], ['P6', 'Corn', 29, 24000, 44000],
] as const;
export const owners = seeds.map(([id]) => s.Owner.parse({ ...meta, id: `owner-${id}`, alias: `Synthetic owner ${id}`, synthetic: true }));
export const parcels = seeds.map(([id, landUse, acres, , cap], index) => {
  const x = -97.5 + (index % 3) * 0.01, y = 30.3 + Math.floor(index / 3) * 0.01;
  return s.Parcel.parse({ ...meta, id, projectId, geometry: { type: 'Polygon', coordinates: [
    [[x,y], [x+0.008,y], [x+0.008,y+0.008], [x,y+0.008], [x,y]],
  ] }, ownerId: `owner-${id}`, ownerAlias: `Synthetic owner ${id}`, synthetic: true,
  landUse, areaSqM: acres * 4046.8564224, offerCapCents: cap * 100,
  accessConsent: 'unknown', negotiationStatus: 'pending' });
});
export const project = s.Project.parse({ ...meta, id: projectId, revision: 0,
  endpointA: { type: 'Point', coordinates: [-97.505, 30.305] },
  endpointB: { type: 'Point', coordinates: [-97.465, 30.305] }, budgetCents: 28000000,
  rentHorizonMonths: 12, selectedRouteId: null, approvedRouteVersion: null, status: 'draft' });
function term(parcelId: string) {
  const seed = seeds.find(v => v[0] === parcelId)!;
  return { parcelId, upfrontCents: seed[3] * 100, depositCents: 200000,
    depositCreditPolicy: 'credited_to_upfront' as const, monthlyRentCents: 10000, termMonths: 12 };
}
const routesSeed = [
  ['direct', ['P4','P2','P6'], 2400, 16000000],
  ['north', ['P1','P2','P3'], 3100, 17800000],
  ['south', ['P4','P5','P6'], 2900, 16200000],
] as const;
export const routes = routesSeed.map(([id, ids, lengthMeters, construction]) => s.RouteCandidate.parse({
  ...meta, id, projectId, version: 1, geometry: { type: 'LineString', coordinates: [
    project.endpointA.coordinates, [-97.485, id === 'north' ? 30.325 : id === 'south' ? 30.295 : 30.305], project.endpointB.coordinates,
  ] }, parcelIds: [...ids], lengthMeters, ...calculateCost(construction, ids.map(term), 12),
  eligible: true, readyToApprove: false, reasons: ['Synthetic estimated terms; explicit consent and screening are pending.'],
  regulatoryChecks: [{ ...meta, id: 'screen-01', jurisdiction: 'DEMO ONLY', ruleCitation: 'fixture:screening-placeholder',
    ruleVersion: 'fixture-v1', checkedAt: at, outcome: 'unknown', missingEvidence: ['Actual rule and source verification'], preliminary: true }],
}));
const accepted = routes[0]!.parcelIds.map(parcelId => {
  const { parcelId: _, ...amounts } = term(parcelId);
  return s.NegotiationResult.parse({ ...meta, ...amounts, id: `terms-${parcelId}`, projectId, parcelId,
    routeVersion: 1, termsVersion: 1, sessionId: `demo-call-${parcelId}`, outcome: 'accepted', accessConsent: 'allowed',
    conditions: ['Synthetic agreement for a controlled demo only.'], explicitConfirmation: true });
});
const contracts = accepted.map(n => s.Easement.parse({ ...meta, ...term(n.parcelId), id: `contract-${n.parcelId}`,
  contractVersion: 1, projectId, routeId: 'direct', routeVersion: 1, termsVersion: 1,
  templateVersion: 'demo-v1', contentHash: `sha256:${'0'.repeat(64)}`,
  effectiveStartDate: '2026-11-01', effectiveEndDate: '2027-10-31', status: 'demo_signed',
  signatureMode: 'simulated', signedAt: at, artifactRef: `fixture:easement-${n.parcelId}` }));
const approval = s.Approval.parse({ ...meta, id: 'approval-01', projectId, routeId: 'direct', routeVersion: 1,
  contractIds: contracts.map(c => c.id), termsVersions: Object.fromEntries(accepted.map(n => [n.parcelId, n.termsVersion])),
  contractVersions: Object.fromEntries(contracts.map(c => [c.id, c.contractVersion])),
  approvedBy: 'demo-manager', approvedAt: at, valid: true });
const payment = s.Payment.parse({ ...meta, sourceMode: 'mock', id: 'payment-deposit-P2', contractId: 'contract-P2',
  contractVersion: 1, approvalId: approval.id, kind: 'deposit', expectedCents: 200000, actualCents: 200000,
  currency: 'USD', status: 'settled', providerReference: 'mock-receipt-01', idempotencyKey: 'deposit-P2-v1' });
const rent = s.Payment.parse({ ...payment, id: 'payment-rent-P2-2026-11', kind: 'rent', installmentPeriod: '2026-11',
  expectedCents: 10000, actualCents: 10000, providerReference: 'mock-receipt-02', idempotencyKey: 'rent-P2-2026-11-v1' });
const reconciliation = s.ReconciliationEntry.parse({ ...meta, id: 'recon-01', contractId: 'contract-P2', paymentId: rent.id,
  installmentPeriod: '2026-11', expectedCents: 10000, observedCents: 10000, result: 'matched', checkedAt: at });
const approvedRoute = s.RouteCandidate.parse({ ...routes[0], readyToApprove: true, reasons: ['Fixture checks only; no actual regulatory approval.'],
  regulatoryChecks: routes[0]!.regulatoryChecks.map(c => ({ ...c, outcome: 'pass', missingEvidence: [] })) });
// The completed demo month includes every crossed parcel, not only the example P2 payment.
const settledPayments = contracts.flatMap(contract => [
  s.Payment.parse({ ...payment, id: `payment-deposit-${contract.parcelId}`, contractId: contract.id,
    expectedCents: contract.depositCents, actualCents: contract.depositCents,
    providerReference: `mock-deposit-${contract.parcelId}`, idempotencyKey: `deposit-${contract.parcelId}-v1` }),
  s.Payment.parse({ ...rent, id: `payment-rent-${contract.parcelId}-2026-11`, contractId: contract.id,
    expectedCents: contract.monthlyRentCents, actualCents: contract.monthlyRentCents,
    providerReference: `mock-rent-${contract.parcelId}-2026-11`, idempotencyKey: `rent-${contract.parcelId}-2026-11-v1` }),
]);
const matchedEntries = contracts.map(contract => s.ReconciliationEntry.parse({ ...reconciliation,
  id: `recon-${contract.parcelId}-2026-11`, contractId: contract.id, paymentId: `payment-rent-${contract.parcelId}-2026-11`,
  expectedCents: contract.monthlyRentCents, observedCents: contract.monthlyRentCents,
}));
export const happyPath = s.Snapshot.parse({
  project: { ...project, revision: 8, selectedRouteId: 'direct', approvedRouteVersion: 1, status: 'demo_settled' }, owners,
  parcels: parcels.map(p => approvedRoute.parcelIds.includes(p.id) ? { ...p, accessConsent: 'allowed', negotiationStatus: 'accepted' } : p),
  routes: [approvedRoute, ...routes.slice(1)], negotiations: accepted, easements: contracts,
  approvals: [approval], payments: settledPayments, reconciliations: matchedEntries,
  events: [{ ...meta, eventId: 'event-reconciliation-01', projectId, revision: 8, type: 'reconciliation.completed',
    occurredAt: at, actor: 'demo-operator', payload: { reconciliationIds: matchedEntries.map(e => e.id) } }],
});
export const refusal = s.NegotiationResult.parse({ ...accepted[1], id: 'terms-P2-refusal', termsVersion: 2,
  outcome: 'refused', accessConsent: 'refused', upfrontCents: 5000000, depositCents: 0,
  monthlyRentCents: 0, conditions: ['No access through the pear orchard.'], evidenceRefs: ['fixture:refusal-01'] });
export const refusedRoutes = routes.map(r => ({ ...r, version: 2,
  eligible: !r.parcelIds.includes('P2'), readyToApprove: false,
  reasons: r.parcelIds.includes('P2') ? ['P2 owner refused access.'] : ['Bypass candidate; current agreements and screening still required.'] }));
export const call = s.CallSession.parse({ ...meta, sessionId: 'demo-call-P2', projectId, parcelId: 'P2', routeVersion: 1,
  status: 'completed', events: [{ eventId: 'call-event-01', occurredAt: at, type: 'fixture.completed', summary: 'Synthetic participant; no call placed.' }] });
const command = (revision: number, key: string) => ({ schemaVersion: 1, expectedRevision: revision, idempotencyKey: key });
const envelope = (data: unknown, projectRevision: number) => ({ data, projectRevision, requestId: `fixture-request-${projectRevision}` });
export type Example = { operation: OperationName; request: unknown; response: unknown };
export const apiExamples: Example[] = [
  { operation: 'createProject', request: { ...command(0,'create-demo-01'), endpointA: project.endpointA, endpointB: project.endpointB,
    budgetCents: project.budgetCents, rentHorizonMonths: 12, sourceMode: 'fixture' }, response: envelope(project,0) },
  { operation: 'getProject', request: { projectId }, response: envelope(happyPath,8) },
  { operation: 'evaluateRoutes', request: { projectId, ...command(0,'routes-01') },
    response: envelope({ candidates: routes, recommendation: 'direct', reasons: ['Minimum cost among these three synthetic candidates.'] },1) },
  { operation: 'createCallSession', request: { projectId, parcelId: 'P2', routeVersion: 1, participantContactRef: 'consented-demo-participant',
    participantConsent: true, ...command(1,'call-P2-01') }, response: envelope({ ...call, status: 'creating', events: [] },2) },
  { operation: 'getCallSession', request: { sessionId: call.sessionId }, response: envelope(call,2) },
  { operation: 'recordNegotiation', request: { projectId, ...command(2,'terms-P2-01'), result: accepted[1] },
    response: envelope({ result: accepted[1], rerouteNeeded: false },3) },
  { operation: 'replan', request: { projectId, negotiationResultId: refusal.id, ...command(5,'replan-refusal-01') },
    response: envelope({ priorCandidates: routes, candidates: refusedRoutes, recommendation: 'south',
      costDeltaCents: routes[2]!.totalCostCents - routes[0]!.totalCostCents, changedParcelIds: ['P2'],
      invalidatedApprovalIds: [approval.id], reasons: ['Old approval invalidated; southern candidate requires new agreements.'] },6) },
  { operation: 'createEasement', request: { projectId, routeId: 'direct', routeVersion: 1, parcelId: 'P2', termsVersion: 1, ...command(3,'contract-P2-01') },
    response: envelope({ easement: { ...contracts[1], status: 'draft', signedAt: undefined }, missingFields: [] },4) },
  { operation: 'demoSign', request: { contractId: 'contract-P2', contractVersion: 1, signerAlias: 'Synthetic owner P2', ...command(4,'sign-P2-01') },
    response: envelope({ easement: contracts[1], simulation: true },5) },
  { operation: 'approveProject', request: { projectId, routeId: 'direct', routeVersion: 1, termsVersions: approval.termsVersions,
    contractIds: approval.contractIds, ...command(5,'approve-01') }, response: envelope(approval,6) },
  { operation: 'createPayment', request: { contractId: 'contract-P2', contractVersion: 1, approvalId: approval.id, kind: 'deposit', ...command(6,'deposit-P2-v1') },
    response: envelope(payment,7) },
  { operation: 'reconcile', request: { projectId, asOfDemoDate: '2026-11-30', ...command(7,'recon-01') }, response: envelope({ entries: matchedEntries },8) },
  { operation: 'resetDemo', request: { projectId, newSessionId: 'demo-session-02', ...command(8,'reset-demo-02') },
    response: envelope({ sessionId: 'demo-session-02', project: { ...project, id: 'demo-session-02-project' } },0) },
].map(example => JSON.parse(JSON.stringify(example)) as Example);

const context = { base: accepted[1]!, offerCapCents: 5500000, confirmationVerified: false, accessConsentVerified: 'unknown' as const };
export const edgeCases = {
  refusal: { result: refusal, candidates: refusedRoutes, recommendation: 'south', invalidatedApprovalIds: [approval.id] },
  noRoute: { candidates: refusedRoutes.map(r => ({ ...r, eligible: false, reasons: ['All candidates blocked.'] })), recommendation: null, status: 'review_required' },
  counteroffer: { ...accepted[1], id: 'terms-P2-over-cap', upfrontCents: 6000000, outcome: 'review_required', explicitConfirmation: false },
  modelMalformed: { input: { outcome: 'accepted', upfrontCents: '5000', approved: true },
    output: normalizeClaudeOutput({ outcome: 'accepted', upfrontCents: '5000', approved: true }, context) },
  modelTimeout: { input: null, output: normalizeClaudeOutput(null, context, 'timeout') },
  callUnknown: { ...call, status: 'unknown', events: [] },
  paymentUnknown: { ...payment, status: 'unknown', actualCents: undefined, providerReference: undefined },
  duplicateEvent: { input: [happyPath.events[0], happyPath.events[0]], expectedEventCount: 1 },
  duplicatePayment: { input: apiExamples.find(v => v.operation === 'createPayment')!.request, expectedPaymentId: payment.id, expectedPaymentCount: 1 },
  staleRevision: { currentRevision: 9, expectedRevision: 8, status: 409, code: 'STALE_REVISION' },
  changedContract: { contract: { ...contracts[1], contractVersion: 2 }, approval, status: 422, code: 'BLOCKED_STATE' },
  rentMismatch: { ...reconciliation, observedCents: 9000, result: 'amount_mismatch' },
};
export function validateFixtures(): void {
  for (const example of apiExamples) {
    operations[example.operation].request.parse(example.request);
    operations[example.operation].response.parse(example.response);
  }
  s.Snapshot.parse(happyPath);
  for (const result of [refusal, edgeCases.counteroffer, edgeCases.modelMalformed.output.result, edgeCases.modelTimeout.output.result])
    s.NegotiationResult.parse(result);
}
