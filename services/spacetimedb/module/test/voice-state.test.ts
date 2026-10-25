import assert from 'node:assert/strict';
import test from 'node:test';
import { Identity } from 'spacetimedb';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import * as module from '../src/index.ts';
import type { Db } from '../src/logic.ts';
import {
  reserveVoiceAttempt, claimVoiceAttempt, markVoiceAttempt, saveVoiceCandidate, saveVoiceOutcome,
  voiceWorkerAttempts, voiceResults, recordVoiceTool,
} from '../src/voice-state.ts';

const WORKER = new Identity(101n), STRANGER = new Identity(102n);
const harness = () => createModuleTestHarness(module.default, module);
type Harness = ReturnType<typeof harness>;
const tx = <T>(db: Harness, sender: Identity, body: (ctx: Db) => T) => db.withReducerTx(TestAuth.internal(), ctx =>
  body({ ...ctx, db: ctx.db, timestamp: ctx.timestamp, sender } as Db));
const expectCode = (fn: () => unknown, code: string) => assert.throws(fn, e => e instanceof Error && e.message.startsWith(`${code}:`));
const binding = { sessionId: 'map-one', routeId: 'route-one', routeVersion: 1, proposalKey: 'public-route-proposal' };
const input = (suffix = 'one') => ({
  id: `voice-${suffix}`, sessionId: `session-${suffix}`, requestKey: 'original-request', parcelId: 'L001',
  mapBinding: binding, canonicalJson: JSON.stringify({ route: 'original-synthetic-route' }),
  privateContact: { name: 'Private roleplay participant', phone: 'synthetic-non-dialable' },
  consent: true, consentAt: '2026-10-25T00:00:00Z', bearerTokenHash: 'a'.repeat(64), offerCents: 100_001, capCents: 118_735,
});
const candidate = (decision = 'accepted') => ({ decision, acceptedCompensationCents: decision === 'refused' ? null : 100_001,
  condition: decision === 'conditional' ? { direction: 'north', target: 'edge' } : null,
  offerTurnId: 'agent-turn-one', offerQuote: 'Synthetic private offer.',
  evidenceTurnId: 'owner-turn-one', evidenceQuote: 'Synthetic private transcript evidence.', reason: 'Explicit roleplay reply.' });
const providerEvidence = { turns: [
  { id: 'agent-turn-one', role: 'agent', text: 'Synthetic private offer.', startMs: 0, endMs: 1000 },
  { id: 'owner-turn-one', role: 'owner', text: 'Synthetic private transcript evidence.', startMs: 1100, endMs: 1500 },
] };
function fixture(suffix = 'one') {
  const db = harness(), original = input(suffix);
  tx(db, WORKER, ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify(original) }));
  const get = () => JSON.parse(db.db.voiceAttempt.id.find(original.id)!.attemptJson);
  const claim = (claimId = 'dispatch-claim') => tx(db, WORKER, ctx => claimVoiceAttempt(ctx, { id: original.id, claimId }));
  const mark = (status = 'completed', providerCallId = `provider-${suffix}`, evidence: any = providerEvidence) => tx(db, WORKER, ctx => markVoiceAttempt(ctx,
    { id: original.id, claimId: 'dispatch-claim', status, providerCallId, evidenceJson: JSON.stringify(evidence) }));
  const save = (value = candidate()) => tx(db, WORKER, ctx => saveVoiceCandidate(ctx,
    { id: original.id, claimId: 'dispatch-claim', candidateJson: JSON.stringify(value) }));
  const outcome = (overrides: any = {}) => ({ status: 'accepted', parcelId: original.parcelId, acceptedCompensationCents: 100_001,
    originalMapBinding: original.mapBinding, ...overrides });
  const finish = (value = outcome()) => tx(db, WORKER, ctx => saveVoiceOutcome(ctx,
    { id: original.id, claimId: 'dispatch-claim', outcomeJson: JSON.stringify(value) }));
  return { db, original, get, claim, mark, save, outcome, finish };
}

test('reservation is durable and one call per session survives request-key/id changes', () => {
  const f = fixture(), before = f.get();
  tx(f.db, WORKER, ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify(f.original) }));
  assert.deepEqual(f.get(), before);
  for (const changed of [{ requestKey: 'another-request' }, { id: 'another-attempt' }, { offerCents: 99_000 }, { parcelId: 'L002' }]) {
    expectCode(() => tx(f.db, WORKER, ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify({ ...f.original, ...changed }) })), 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(f.db.db.voiceAttempt.count(), 1n);
  assert.equal(f.get().paymentSchedule, 'full-after-signatures');
  assert.equal(f.db.db.obligation.count(), 0n);
});

test('authorization precedes replay and private contacts/evidence never enter result projection', () => {
  const f = fixture(); f.claim(); f.mark(); f.save(); f.finish();
  assert.deepEqual(tx(f.db, STRANGER, ctx => voiceWorkerAttempts(ctx)), []);
  assert.deepEqual(tx(f.db, STRANGER, ctx => voiceResults(ctx)), []);
  expectCode(() => tx(f.db, STRANGER, ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify(f.original) })), 'FORBIDDEN');
  expectCode(() => tx(f.db, STRANGER, ctx => claimVoiceAttempt(ctx, { id: f.original.id, claimId: 'other' })), 'FORBIDDEN');
  const publicText = JSON.stringify(tx(f.db, WORKER, ctx => voiceResults(ctx)));
  for (const privateValue of [f.original.privateContact.phone, f.original.privateContact.name, f.original.bearerTokenHash, candidate().evidenceQuote, 'provider-one']) {
    assert(!publicText.includes(privateValue));
  }
  assert.equal(JSON.parse(tx(f.db, WORKER, ctx => voiceResults(ctx))[0]!.resultJson).acceptedCompensationCents, 100_001);
});

test('atomic claim never expires back into dial eligibility and cannot be stolen on restart', () => {
  const f = fixture(); f.claim(); const claimed = f.get();
  f.claim('replacement-after-restart'); assert.deepEqual(f.get(), claimed);
  f.mark('unknown', '', { event: 'response-unconfirmed' });
  f.claim('another-restart');
  assert.equal(f.get().claimId, 'dispatch-claim'); assert.equal(f.get().status, 'unknown');
  expectCode(() => tx(f.db, WORKER, ctx => markVoiceAttempt(ctx,
    { id: f.original.id, claimId: 'replacement-after-restart', status: 'completed', providerCallId: 'call-stolen', evidenceJson: '{}' })), 'FORBIDDEN');
  f.mark(); assert.equal(f.get().status, 'completed');
});

test('provider identity binding and stale progress guard leave failed transactions unchanged', () => {
  const f = fixture(); f.claim(); f.mark('connected'); const before = f.get();
  expectCode(() => f.mark('ringing'), 'STALE_STATUS');
  expectCode(() => f.mark('completed', 'different-provider'), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.get(), before);
  f.mark('unknown');
  expectCode(() => f.mark('ringing'), 'STALE_STATUS');
  f.mark('connected');
  tx(f.db, WORKER, ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify(input('two')) }));
  tx(f.db, WORKER, ctx => claimVoiceAttempt(ctx, { id: 'voice-two', claimId: 'second-claim' }));
  expectCode(() => tx(f.db, WORKER, ctx => markVoiceAttempt(ctx,
    { id: 'voice-two', claimId: 'second-claim', status: 'completed', providerCallId: 'provider-one', evidenceJson: '{}' })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(JSON.parse(f.db.db.voiceAttempt.id.find('voice-two')!.attemptJson).status, 'dispatching');
});

test('completed call is not consent; accepted exact cents and original binding must match saved evidence', () => {
  const f = fixture(); f.claim(); f.mark();
  expectCode(() => f.finish(), 'INVALID_INPUT');
  f.save();
  for (const override of [{ acceptedCompensationCents: 100_002 }, { acceptedCompensationCents: 100_001.5 }, { parcelId: 'L002' },
    { originalMapBinding: { ...binding, routeVersion: 2 } }]) expectCode(() => f.finish(f.outcome(override)), 'INVALID_INPUT');
  f.finish(); const done = f.get(); f.finish(); assert.deepEqual(f.get(), done);
  expectCode(() => f.finish(f.outcome({ status: 'review_required', acceptedCompensationCents: null })), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => f.save({ ...candidate(), acceptedCompensationCents: 100_002 }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.db.db.obligation.count(), 0n);
});

test('conditional agreement requires verifiable same-parcel relocation and preserves the exact call amount', () => {
  const f = fixture(); f.claim(); f.mark(); f.save(candidate('conditional'));
  expectCode(() => f.finish(), 'INVALID_INPUT');
  const resultingMapBinding = { ...binding, routeVersion: 2, proposalKey: 'verified-relocated-geometry' };
  const proof = { verified: true, parcelId: 'L001', acceptedCompensationCents: 100_001, originalMapBinding: binding,
    condition: { direction: 'north', target: 'edge' },
    resultingMapBinding, geometryHash: 'b'.repeat(64) };
  for (const changed of [{ verified: false }, { parcelId: 'L002' }, { acceptedCompensationCents: 99_999 }, { geometryHash: '' }, { condition: { direction: 'south', target: 'edge' } }]) {
    expectCode(() => f.finish(f.outcome({ resultingMapBinding, relocationVerification: { ...proof, ...changed } })), 'INVALID_INPUT');
  }
  f.finish(f.outcome({ resultingMapBinding, relocationVerification: proof }));
  assert.equal(f.get().outcome.acceptedCompensationCents, 100_001);
  assert.equal(f.get().candidate.condition.direction, 'north');
  assert.equal(f.get().claimId, 'dispatch-claim');
});

test('failed calls become review-required, never refusal without explicit owner evidence', () => {
  const f = fixture(); f.claim(); f.mark('failed', 'provider-one');
  expectCode(() => f.finish(f.outcome({ status: 'refused', acceptedCompensationCents: null })), 'INVALID_INPUT');
  f.finish(f.outcome({ status: 'review_required', acceptedCompensationCents: null }));
  assert.equal(f.get().status, 'review_required');
});

test('reservation rejects missing consent and noninteger or over-cap offers without writing', () => {
  for (const changed of [{ consent: false }, { consentAt: 'invalid' }, { bearerTokenHash: '' }, { offerCents: 1.1 }, { offerCents: 120_000 }]) {
    const db = harness();
    expectCode(() => tx(db, WORKER, ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify({ ...input(), ...changed }) })), 'INVALID_INPUT');
    assert.equal(db.db.voiceAttempt.count(), 0n);
  }
});

test('candidate acceptance cannot invent a quote or replace its provider transcript', () => {
  const f = fixture(); f.claim(); f.mark();
  expectCode(() => f.save({ ...candidate(), evidenceQuote: 'An invented agreement' }), 'INVALID_INPUT');
  expectCode(() => f.save({ ...candidate(), evidenceTurnId: 'agent-turn-one' }), 'INVALID_INPUT');
  expectCode(() => f.save({ ...candidate(), offerQuote: 'A different offer' }), 'INVALID_INPUT');
  f.save(); const saved = f.get();
  expectCode(() => f.mark('completed', 'provider-one', { turns: [{ id: 'different', role: 'owner', text: 'Replacement evidence' }] }), 'INVALID_INPUT');
  assert.deepEqual(f.get(), saved);
  f.finish();
  const publicBefore = tx(f.db, WORKER, ctx => voiceResults(ctx));
  const result = JSON.parse(publicBefore[0]!.resultJson);
  assert.equal(result.eventId, `voice-${f.original.id}-${f.get().revision}`);
  assert.equal(result.approvedAt, new Date(Number(BigInt(f.get().updatedAtMicros) / 1000n)).toISOString());
  f.mark('completed'); f.finish();
  assert.deepEqual(tx(f.db, WORKER, ctx => voiceResults(ctx)), publicBefore);
});

test('voice tool receipts are atomic, private and replay safe; only one bounded final offer is available', () => {
  const f = fixture(); f.claim(); f.mark('connected');
  const tool = (requestId: string, kind: string, payload: any) => tx(f.db, WORKER, ctx => recordVoiceTool(ctx,
    { id: f.original.id, claimId: 'dispatch-claim', requestId, kind, payloadJson: JSON.stringify(payload) }));
  tool('price-one', 'counteroffer', { requestedCents: 110_005 });
  const after = f.get();
  assert.equal(after.currentOfferCents, 110_005);
  assert.equal(after.toolReceipts['price-one'].compensationCents, 110_005);
  tool('price-one', 'counteroffer', { requestedCents: 110_005 }); assert.deepEqual(f.get(), after);
  expectCode(() => tool('price-one', 'counteroffer', { requestedCents: 118_735 }), 'IDEMPOTENCY_CONFLICT');
  tool('price-two', 'counteroffer', { requestedCents: 118_735 }); assert.equal(f.get().currentOfferCents, 110_005);
  tool('raw-answer', 'response', { decision: 'accepted', privateQuote: 'Synthetic tool response.' });
  tool('2', 'response', { decision: 'refused' });
  tool('1', 'response', { decision: 'accepted' });
  tool('2', 'response', { decision: 'refused' });
  assert.equal(f.get().lastResponseRequestId, '1');
  assert.equal(f.get().candidate, null); assert.equal(f.get().outcome, null);
  assert(!JSON.stringify(tx(f.db, WORKER, ctx => voiceResults(ctx))).includes('Synthetic tool response.'));
  f.mark();
  expectCode(() => f.save(candidate()), 'INVALID_INPUT');
  f.save({ ...candidate(), acceptedCompensationCents: 110_005 });
  f.finish(f.outcome({ acceptedCompensationCents: 110_005 }));
  assert.equal(f.get().outcome.acceptedCompensationCents, 110_005);
  tool('raw-answer', 'response', { decision: 'accepted', privateQuote: 'Synthetic tool response.' });
  expectCode(() => tool('late-price', 'counteroffer', { requestedCents: 110_006 }), 'INVALID_INPUT');
});

test('unspecified price objection uses the reserved budget maximum before the dial response arrives', () => {
  const db = harness(), original = { ...input(), maxOfferCents: 105_003 };
  tx(db, WORKER, ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify(original) }));
  tx(db, WORKER, ctx => claimVoiceAttempt(ctx, { id: original.id, claimId: 'dispatch-claim' }));
  tx(db, WORKER, ctx => recordVoiceTool(ctx, { id: original.id, claimId: 'dispatch-claim', requestId: 'unspecified-price',
    kind: 'counteroffer', payloadJson: JSON.stringify({ requestedCents: null }) }));
  const saved = JSON.parse(db.db.voiceAttempt.id.find(original.id)!.attemptJson);
  assert.equal(saved.status, 'dispatching'); assert.equal(saved.providerCallId, null);
  assert.equal(saved.currentOfferCents, 105_003); assert.equal(saved.capCents, 118_735);
  assert.equal(saved.candidate, null); assert.equal(saved.outcome, null);
});
