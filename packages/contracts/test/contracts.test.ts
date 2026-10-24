import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as c from '../src/index.ts';

const errorCode = (code: string) => (e: unknown) => e instanceof c.ContractError && e.code === code;
const copy = <T>(v: T): T => structuredClone(v);
const terms = { parcelId: 'P2', upfrontCents: 2800000, depositCents: 200000,
  depositCreditPolicy: 'credited_to_upfront' as const, monthlyRentCents: 10000, termMonths: 12 };

test('all 13 operations have request and response examples that validate', () => {
  c.validateFixtures();
  assert.deepEqual([...new Set(c.apiExamples.map(e => e.operation))].sort(), Object.keys(c.operations).sort());
});
test('JSON fixtures validate after serialization, and contain no real contacts or provider keys', async () => {
  const api = JSON.parse(await readFile(new URL('../examples/api-v1.json', import.meta.url), 'utf8')) as c.Example[];
  for (const e of api) { c.operations[e.operation].request.parse(e.request); c.operations[e.operation].response.parse(e.response); }
  const happy = JSON.parse(await readFile(new URL('../examples/happy-path.json', import.meta.url), 'utf8'));
  c.Snapshot.parse(happy);
  assert.equal(/"(?:phone|email|apiKey|token)"/.test(JSON.stringify(happy)), false);
  assert.ok(happy.owners.every((o: { synthetic: boolean }) => o.synthetic));
});
test('integer cents and coordinate bounds reject silent rounding and malformed GeoJSON', () => {
  for (const n of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(c.Cents.safeParse(n).success, false);
  assert.equal(c.Position.safeParse([30, 200]).success, false);
  assert.equal(c.Position.safeParse([-97, 30, 0]).success, false);
  const p = copy(c.parcels[0]!); p.geometry.coordinates[0]!.pop();
  assert.equal(c.Parcel.safeParse(p).success, false);
});
test('duplicate parcel IDs and unknown fields are rejected', () => {
  assert.equal(c.RouteCandidate.safeParse({ ...c.routes[0], parcelIds: ['P2','P2'] }).success, false);
  assert.equal(c.Project.safeParse({ ...c.project, approved: true }).success, false);
  assert.equal(c.NegotiationResult.safeParse({ ...c.refusal, phone: '+10000000000' }).success, false);
});
test('legacy dollar conversion matches seeds and rejects sub-cent/unsafe values', () => {
  assert.equal(c.dollarsToCents(28000), 2800000);
  assert.equal(c.dollarsToCents(0.29), 29);
  for (const v of [0.001, -1, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => c.dollarsToCents(v), errorCode('INVALID_INPUT'));
});
test('same parcel is counted once, credited deposit is not added twice, horizon caps rent', () => {
  const result = c.calculateCost(16000000, [terms, terms], 24);
  assert.equal(result.totalCostCents, 18920000);
  assert.equal(result.recurringRentTotalCents, 120000);
  assert.equal(result.separateDepositTotalCents, 0);
  assert.equal(c.calculateCost(16000000, [{ ...terms, depositCreditPolicy: 'separate_charge' }], 6).totalCostCents, 19060000);
});
test('cost validation rejects conflicting duplicates, excessive credited deposit and overflow', () => {
  assert.throws(() => c.calculateCost(0, [terms, { ...terms, upfrontCents: 1 }], 12));
  assert.throws(() => c.calculateCost(0, [{ ...terms, depositCents: 2800001 }], 12));
  assert.throws(() => c.calculateCost(Number.MAX_SAFE_INTEGER, [terms], 12));
  assert.throws(() => c.calculateCost(0, [{ ...terms, monthlyRentCents: Number.MAX_SAFE_INTEGER }], 12));
});
test('stale project and object versions return documented 409 errors', () => {
  for (const fn of [() => c.assertRevision(9,8), () => c.assertVersion(2,1)]) {
    assert.throws(fn, (e: unknown) => e instanceof c.ContractError && e.status === 409 && !e.envelope('request-01').error.retryable);
  }
});
test('idempotency replays original result even after state advances; payload conflicts return 409', () => {
  const input = c.apiExamples.find(v => v.operation === 'createPayment')!.request;
  const payment = c.happyPath.payments[0]!;
  const record = { fingerprint: c.canonicalJson(input), response: { data: payment, projectRevision: 7, requestId: 'original-request' } };
  const replayed = c.replay(record, input)!;
  assert.equal(replayed.data.id, payment.id);
  assert.equal(replayed.projectRevision, 7); // do not re-run revision/payment mutation on replay
  assert.throws(() => c.replay(record, { ...input as object, expectedRevision: 99 }), errorCode('IDEMPOTENCY_CONFLICT'));
  replayed.data.actualCents = 0;
  assert.equal(record.response.data.actualCents, 200000);
  assert.equal(c.canonicalJson({ b: 1, a: 2 }), c.canonicalJson({ a: 2, b: 1 }));
});
test('duplicate events deduplicate, but conflicting reuse of an event ID fails', () => {
  const e = c.happyPath.events[0]!;
  assert.equal(c.deduplicateEvents([e,e]).length, 1);
  assert.throws(() => c.deduplicateEvents([e, { ...e, revision: 99 }]), errorCode('IDEMPOTENCY_CONFLICT'));
});
test('accepted terms cannot fabricate consent, confirmation, evidence or exceed cap', () => {
  const accepted = c.happyPath.negotiations[1]!;
  for (const patch of [{ accessConsent: 'unknown' }, { explicitConfirmation: false }, { evidenceRefs: [] }, { upfrontCents: 6000000 }])
    assert.throws(() => c.validateNegotiation({ ...accepted, ...patch }, 5500000), errorCode('BLOCKED_STATE'));
  assert.equal(c.validateNegotiation(accepted, 5500000).outcome, 'accepted');
  assert.throws(() => c.validateNegotiation({ ...c.refusal, accessConsent: 'allowed' }, 5500000), errorCode('INVALID_INPUT'));
});
function checkApproval(snapshot = c.happyPath) {
  c.assertApprovable(snapshot.project, snapshot.routes[0]!, snapshot.easements, snapshot.negotiations, snapshot.parcels);
}
test('synthetic happy path meets distinct consent, signature, screening and approval gates', () => {
  checkApproval();
  const snapshot = copy(c.happyPath);
  snapshot.easements[0]!.status = 'draft';
  assert.throws(() => checkApproval(snapshot), errorCode('BLOCKED_STATE'));
});
test('unknown regulatory evidence, missing contracts or unagreed terms block approval', () => {
  for (const change of [
    (v: c.Snapshot) => { v.routes[0]!.regulatoryChecks[0]!.outcome = 'unknown'; },
    (v: c.Snapshot) => { v.easements.pop(); },
    (v: c.Snapshot) => { v.negotiations[0]!.outcome = 'pending'; },
    (v: c.Snapshot) => { v.routes[0]!.totalCostCents += 1; },
  ]) { const snapshot = copy(c.happyPath); change(snapshot); assert.throws(() => checkApproval(snapshot)); }
});
test('changed route/terms cannot retain the old contract approval', () => {
  const v = copy(c.happyPath); v.easements[0]!.termsVersion = 2;
  assert.throws(() => checkApproval(v), errorCode('BLOCKED_STATE'));
  const current = c.happyPath.easements[1]!, approval = c.happyPath.approvals[0]!;
  for (const patch of [{ contractVersion: 2 }, { routeVersion: 2 }, { termsVersion: 2 }, { status: 'draft' }])
    assert.throws(() => c.paymentAmount({ ...current, ...patch } as c.Easement, approval, 'deposit'), errorCode('BLOCKED_STATE'));
  assert.throws(() => c.paymentAmount(current, { ...approval, valid: false }, 'deposit'), errorCode('BLOCKED_STATE'));
});
test('payment amount comes from the contract and rent is limited to covered calendar months', () => {
  const contract = c.happyPath.easements[1]!, approval = c.happyPath.approvals[0]!;
  assert.equal(c.paymentAmount(contract, approval, 'deposit'), 200000);
  assert.equal(c.paymentAmount(contract, approval, 'rent', '2026-11'), 10000);
  for (const period of [undefined, '2026-13', '2026-10', '2027-11']) assert.throws(() => c.paymentAmount(contract, approval, 'rent', period));
  assert.throws(() => c.paymentAmount(contract, approval, 'deposit', '2026-11'));
  assert.equal(c.operations.createPayment.request.safeParse({ ...(c.apiExamples.find(e => e.operation === 'createPayment')!.request as object), amount: 1 }).success, false);
  assert.equal(c.Payment.safeParse({ ...c.happyPath.payments[0], sourceMode: 'live' }).success, false);
});
test('refusal fixture removes Central/Northern and keeps Southern only as a candidate', () => {
  assert.deepEqual(c.refusedRoutes.filter(r => r.eligible).map(r => r.id), ['south']);
  assert.equal(c.refusedRoutes.some(r => r.readyToApprove), false);
  assert.equal(c.edgeCases.noRoute.recommendation, null);
  assert.equal(c.edgeCases.refusal.invalidatedApprovalIds[0], c.happyPath.approvals[0]!.id);
});
test('Claude malformed output and timeout yield safe review/pending with no fabricated consent', () => {
  const bad = c.edgeCases.modelMalformed.output, timeout = c.edgeCases.modelTimeout.output;
  assert.equal(bad.result.outcome, 'review_required'); assert.equal(timeout.result.outcome, 'pending');
  for (const fallback of [bad, timeout]) {
    assert.equal(fallback.fallback, true); assert.equal(fallback.result.explicitConfirmation, false);
    assert.equal(fallback.result.accessConsent, 'unknown');
  }
});
test('Claude cannot overwrite IDs/state and acceptance needs independent evidence verification', () => {
  const base = c.happyPath.negotiations[1]!;
  const raw = { upfrontCents: base.upfrontCents, depositCents: base.depositCents, depositCreditPolicy: base.depositCreditPolicy,
    monthlyRentCents: base.monthlyRentCents, termMonths: 12, outcome: 'accepted', accessConsent: 'allowed', explicitConfirmation: true, conditions: [] };
  const context = { base, offerCapCents: 5500000, confirmationVerified: false, accessConsentVerified: 'unknown' as const };
  assert.equal(c.normalizeClaudeOutput(raw,context).result.outcome, 'review_required');
  assert.equal(c.normalizeClaudeOutput({ ...raw, approved: true },context).reason, 'MALFORMED_MODEL_OUTPUT');
  const checked = c.normalizeClaudeOutput(raw,{ ...context, confirmationVerified: true, accessConsentVerified: 'allowed' });
  assert.equal(checked.result.outcome, 'accepted'); assert.equal(checked.result.projectId, base.projectId);
});
test('typed API client sends path parameters once and validates responses, without retries', async () => {
  const example = c.apiExamples.find(e => e.operation === 'evaluateRoutes')!;
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://example.invalid/api/v1/projects/demo-cedar-valley/routes');
    assert.equal(init?.method, 'POST');
    assert.equal('projectId' in JSON.parse(String(init?.body)), false);
    return new Response(JSON.stringify(example.response), { status: 200 });
  };
  const client = c.createApiClient('https://example.invalid', fetcher);
  const result = await client.execute('evaluateRoutes', example.request as c.ApiRequest<'evaluateRoutes'>);
  assert.equal(result.data.recommendation, 'direct'); assert.equal(calls,1);
  const fail = c.createApiClient('https://example.invalid', async () => { calls++; return new Response(JSON.stringify(new c.ContractError('DEPENDENCY_UNAVAILABLE','Provider status unknown').envelope('request-02')), { status: 503 }); });
  await assert.rejects(() => fail.execute('evaluateRoutes', example.request as c.ApiRequest<'evaluateRoutes'>), errorCode('DEPENDENCY_UNAVAILABLE'));
  assert.equal(calls,2);
});
test('client rejects malformed server responses', async () => {
  const client = c.createApiClient('https://example.invalid', async () => new Response('{}', { status: 200 }));
  await assert.rejects(() => client.execute('getProject', { projectId: c.project.id }), errorCode('INVALID_RESPONSE'));
});
test('negotiation request rejects a mismatched project, and rent commands require a period', () => {
  const negotiation = c.apiExamples.find(e => e.operation === 'recordNegotiation')!.request as c.ApiRequest<'recordNegotiation'>;
  assert.equal(c.operations.recordNegotiation.request.safeParse({ ...negotiation, projectId: 'another-project' }).success, false);
  const payment = c.apiExamples.find(e => e.operation === 'createPayment')!.request as c.ApiRequest<'createPayment'>;
  assert.equal(c.operations.createPayment.request.safeParse({ ...payment, kind: 'rent' }).success, false);
  assert.equal(c.operations.createPayment.request.safeParse({ ...payment, installmentPeriod: '2026-11' }).success, false);
});
test('over-cap Claude counteroffer requires operator review even without an acceptance claim', () => {
  const base = c.happyPath.negotiations[1]!;
  const raw = { upfrontCents: 6000000, depositCents: 200000, depositCreditPolicy: 'credited_to_upfront',
    monthlyRentCents: 10000, termMonths: 12, outcome: 'counteroffer', accessConsent: 'allowed', explicitConfirmation: false, conditions: [] };
  const result = c.normalizeClaudeOutput(raw, { base, offerCapCents: 5500000, confirmationVerified: false, accessConsentVerified: 'unknown' });
  assert.equal(result.result.outcome, 'review_required'); assert.equal(result.reason, 'OFFER_CAP_EXCEEDED');
});
test('client maps a non-JSON response to the documented invalid-response error', async () => {
  const client = c.createApiClient('https://example.invalid', async () => new Response('<html>Unavailable</html>', { status: 503 }));
  await assert.rejects(() => client.execute('getProject', { projectId: c.project.id }), errorCode('INVALID_RESPONSE'));
});
