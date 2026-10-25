import assert from 'node:assert/strict';
import test from 'node:test';
import { Identity, Timestamp } from 'spacetimedb';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { createInitialOwnerHandoff, type NegotiationCommand, type NegotiationState, type NegotiationTurn } from '@easygrid/contracts';
import * as module from '../src/index.ts';
import { startSession, registerWorker, publishRoute, recordOutcome, type Db } from '../src/logic.ts';
import {
  bindNegotiation, executeNegotiation, claimNegotiationReview, commitNegotiationReview, closeNegotiation,
  negotiationWorkerState, negotiationResults, negotiationAgreements, negotiationReviewState, recordNegotiationTranscript, REVIEW_LEASE_MICROS,
} from '../src/negotiation-state.ts';
import { approveSettlement, openSettlement, paySettlement, settlementStatus, signSettlement } from '../src/settlement-state.ts';
import { createSavedNegotiationHost, type NegotiationBackend } from '../../negotiation-host.ts';

const harness = () => createModuleTestHarness(module.default, module);
type Harness = ReturnType<typeof harness>;
const OPERATOR = new Identity(0n), WORKER = new Identity(1n), STRANGER = new Identity(2n);
const NON_DIALABLE = 'synthetic-non-dialable';
// Actual SpacetimeDB datastore/rollback harness with injected business caller identities.
const tx = <T>(db: Harness, sender: Identity, body: (ctx: Db) => T) => db.withReducerTx(TestAuth.internal(), ctx =>
  body({ ...ctx, db: ctx.db, timestamp: ctx.timestamp, sender } as Db));
const expectCode = (fn: () => unknown, code: string) => assert.throws(fn, error => error instanceof Error && error.message.startsWith(`${code}:`));

function setup(sessionId = 'session-one', bind = true) {
  const db = harness(), packet = createInitialOwnerHandoff();
  packet.sessionId = sessionId; packet.referenceBinding = 'canonical'; packet.revision = 2;
  packet.owners[0]!.contact = { contactRef: 'fixture-reference-only', registration: 'registered', callConsent: true };
  for (const p of packet.parcels) {
    p.offerCapCents = Math.floor(p.terms.compensationCents * 6 / 5);
    p.offerPolicy = { policyId: 'recommended-times-1.2-v1', basis: 'route-impact-v1', recommendedOfferCents: p.terms.compensationCents,
      multiplierNumerator: 6, multiplierDenominator: 5, rounding: 'floor-cent' };
  }
  tx(db, OPERATOR, ctx => startSession(ctx, { sessionId, phone: NON_DIALABLE, projectBudgetCents: packet.budgetCents, requestKey: 'start' }));
  tx(db, OPERATOR, ctx => registerWorker(ctx, { sessionId, expectedRevision: 1, requestKey: 'worker', workerIdentity: WORKER.toHexString() }));
  const input = { sessionId, expectedRevision: 2, requestKey: 'trusted-map', handoffJson: JSON.stringify(packet),
    mapBindingJson: JSON.stringify({ sessionId: 'local-session', routeId: 'local-route', routeVersion: 1, proposalKey: 'fixture-proposal' }) };
  if (bind) tx(db, WORKER, ctx => bindNegotiation(ctx, input));
  const state = () => JSON.parse(db.db.negotiationSession.sessionId.find(sessionId)!.stateJson) as NegotiationState;
  const command = (value: NegotiationCommand, turns: NegotiationTurn[] = []) => tx(db, WORKER, ctx => executeNegotiation(ctx,
    { sessionId, commandJson: JSON.stringify(value), providerTurnsJson: JSON.stringify(turns) }));
  const prepare = (attemptId = 'live-attempt', parcelId = 'L001', mode: 'live' | 'simulated' = 'live') => command({
    kind: 'prepare', attemptId, parcelId, mode, requestId: 'prepare', routeVersion: 1, termsVersion: 1,
  });
  return { db, packet, input, sessionId, state, command, prepare };
}
function agree(f: ReturnType<typeof setup>, attemptId = 'live-attempt', parcelId = 'L001', mode: 'live' | 'simulated' = 'live') {
  f.prepare(attemptId, parcelId, mode);
  const envelope = { attemptId, routeVersion: 1, termsVersion: 1 };
  f.command({ ...envelope, kind: 'response', requestId: 'yes', response: 'agree', turnId: null });
  const offer = f.state().attempts[attemptId]!.offers[0]!;
  const turns: NegotiationTurn[] = [
    { id: `${attemptId}-offer`, role: 'agent', text: `We offer $${offer.compensationCents / 100} plus $${offer.monthlyRentCents / 100} per month. Does that work for you?`, startMs: 0, endMs: 1000 },
    { id: `${attemptId}-yes`, role: 'owner', text: 'Yes, that works.', startMs: 1100, endMs: 1500 },
  ];
  const claimId = `claim-${attemptId}`;
  tx(f.db, WORKER, ctx => recordNegotiationTranscript(ctx, { sessionId: f.sessionId, attemptId, requestId: 'provider-complete', providerTurnsJson: JSON.stringify(turns) }));
  tx(f.db, WORKER, ctx => claimNegotiationReview(ctx, { sessionId: f.sessionId, attemptId, claimId }));
  const review = { ...envelope, requestId: 'post-call-review', kind: 'finalize', candidate: {
    reason: 'AGREED', offerTurnId: turns[0]!.id, ownerTurnId: turns[1]!.id,
    compensationCents: offer.compensationCents, monthlyRentCents: offer.monthlyRentCents,
  } };
  const commit = { sessionId: f.sessionId, claimId, commandJson: JSON.stringify(review), providerTurnsJson: JSON.stringify(turns) };
  tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, commit));
  return commit;
}

test('only the registered worker imports the map; replay retains the original participant and revision', () => {
  const f = setup('import-test', false);
  expectCode(() => tx(f.db, OPERATOR, ctx => bindNegotiation(ctx, f.input)), 'FORBIDDEN');
  tx(f.db, WORKER, ctx => bindNegotiation(ctx, f.input));
  const saved = f.db.db.negotiationSession.sessionId.find(f.sessionId);
  tx(f.db, WORKER, ctx => bindNegotiation(ctx, f.input));
  assert.deepEqual(f.db.db.negotiationSession.sessionId.find(f.sessionId), saved);
  const changed = { ...f.packet, userRole: { parcelId: 'L002', ownerId: 'O002' } };
  expectCode(() => tx(f.db, WORKER, ctx => bindNegotiation(ctx, { ...f.input, requestKey: 'different-map', handoffJson: JSON.stringify(changed) })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.state().handoff.userRole?.parcelId, 'L001');
});

test('stale imports and incorrectly registered packets leave no partial state', () => {
  const f = setup('invalid-import', false);
  expectCode(() => tx(f.db, WORKER, ctx => bindNegotiation(ctx, { ...f.input, expectedRevision: 1 })), 'STALE_REVISION');
  f.packet.owners[0]!.contact = { contactRef: null, registration: 'simulation', callConsent: false };
  expectCode(() => tx(f.db, WORKER, ctx => bindNegotiation(ctx, { ...f.input, handoffJson: JSON.stringify(f.packet) })), 'BLOCKED_STATE');
  assert.equal(f.db.db.negotiationSession.sessionId.find(f.sessionId), null);
  assert.equal(f.db.db.session.sessionId.find(f.sessionId)?.revision, 2);
});

test('terms, budget and replay receipts commit together; changing request keys cannot buy a second raise', () => {
  const f = setup(); f.prepare();
  const raise: NegotiationCommand = { kind: 'counteroffer', attemptId: 'live-attempt', requestId: 'raise', routeVersion: 1, termsVersion: 1, requestedCents: 1_100_000 };
  f.command(raise);
  assert.equal(f.state().handoff.parcels[0]!.terms.compensationCents, 1_100_000);
  const revision = f.state().current.revision;
  f.command(raise); assert.equal(f.state().current.revision, revision);
  expectCode(() => f.command({ ...raise, requestedCents: 1_200_000 }), 'IDEMPOTENCY_CONFLICT');
  f.command({ ...raise, requestId: 'raise-again', termsVersion: 2, requestedCents: 1_200_000 });
  assert.equal(f.state().attempts['live-attempt']!.offers.at(-1)!.compensationCents, 1_100_000);
  assert.equal(f.state().current.termsVersions.L001, 2);
});

test('construction, fixed rent and every other parcel reserve budget before a live increase', () => {
  const f = setup('budget-test', false); f.packet.budgetCents = 11_920_000;
  tx(f.db, OPERATOR, ctx => { const row = ctx.db.session.sessionId.find(f.sessionId)!; ctx.db.session.sessionId.update({ ...row, projectBudgetCents: f.packet.budgetCents }); });
  tx(f.db, WORKER, ctx => bindNegotiation(ctx, { ...f.input, handoffJson: JSON.stringify(f.packet) }));
  f.prepare();
  f.command({ kind: 'counteroffer', attemptId: 'live-attempt', requestId: 'raise', routeVersion: 1, termsVersion: 1, requestedCents: 1_200_000 });
  assert.equal(f.state().attempts['live-attempt']!.offers.at(-1)!.compensationCents, 1_020_000);
});

test('stale, wrong-session and unauthorized commands cannot change saved state, even on replay', () => {
  const f = setup(); f.prepare(); const before = f.state();
  expectCode(() => f.command({ kind: 'counteroffer', attemptId: 'live-attempt', requestId: 'stale', routeVersion: 2, termsVersion: 1, requestedCents: 1_100_000 }), 'STALE_VERSION');
  const prepared = { kind: 'prepare', attemptId: 'live-attempt', requestId: 'prepare', routeVersion: 1, termsVersion: 1, parcelId: 'L001', mode: 'live' };
  expectCode(() => tx(f.db, STRANGER, ctx => executeNegotiation(ctx, { sessionId: f.sessionId, commandJson: JSON.stringify(prepared), providerTurnsJson: '[]' })), 'FORBIDDEN');
  expectCode(() => tx(f.db, WORKER, ctx => executeNegotiation(ctx, { sessionId: 'another-session', commandJson: JSON.stringify(prepared), providerTurnsJson: '[]' })), 'NOT_FOUND');
  assert.deepEqual(f.state(), before);
});

test('saved result views rehydrate outcomes without contact values, opaque contact references or transcript text', () => {
  const f = setup(); agree(f);
  const results = tx(f.db, OPERATOR, ctx => negotiationResults(ctx, f.sessionId));
  assert.equal(JSON.parse(results[0]!.updateJson).summary.disposition, 'successful');
  assert.equal(results[0]!.revision, f.state().current.revision);
  assert(!JSON.stringify(results).includes(NON_DIALABLE));
  assert(!JSON.stringify(results).includes('fixture-reference-only'));
  assert(!JSON.stringify(results).includes('We offer'));
  assert.deepEqual(tx(f.db, STRANGER, ctx => negotiationResults(ctx, f.sessionId)), []);
  expectCode(() => tx(f.db, OPERATOR, ctx => negotiationWorkerState(ctx, f.sessionId)), 'FORBIDDEN');
  const restored = tx(f.db, WORKER, ctx => negotiationWorkerState(ctx, f.sessionId));
  assert.equal(JSON.parse(restored[0]!.stateJson).attempts['live-attempt'].phase, 'finished');
});

test('one successful live parcel cannot open agreements until every final-route parcel accepts', () => {
  const f = setup(); agree(f);
  assert.deepEqual(tx(f.db, OPERATOR, ctx => negotiationAgreements(ctx, f.sessionId)), []);
  agree(f, 'simulated-attempt', 'L002', 'simulated');
  const ready = tx(f.db, OPERATOR, ctx => negotiationAgreements(ctx, f.sessionId));
  assert.equal(ready.length, 1); const packet = JSON.parse(ready[0]!.packetJson);
  assert.equal(packet.routeStatus, 'ready_for_agreements'); assert.equal(packet.parcels.length, 2);
  assert(packet.parcels.every((p: any) => p.terms.outcome === 'accepted'));
  assert(packet.owners.every((o: any) => o.contact.contactRef === null && !o.contact.callConsent));
  assert.equal(f.db.db.session.sessionId.find(f.sessionId)?.status, 'agreement_ready');
  assert.deepEqual(tx(f.db, STRANGER, ctx => negotiationAgreements(ctx, f.sessionId)), []);
});

test('refusal locks the original participant and cannot be bypassed with retries or legacy reducers', () => {
  const f = setup(); f.prepare();
  f.command({ kind: 'refusal', attemptId: 'live-attempt', requestId: 'refuse', routeVersion: 1, termsVersion: 1, reason: 'DO_NOT_CALL', turnId: null });
  assert.equal(f.state().liveCallLocked, true); assert.equal(f.state().workflow, 'stopped');
  expectCode(() => f.prepare('retry'), 'BLOCKED_STATE');
  expectCode(() => f.prepare('other-owner', 'L002', 'live'), 'BLOCKED_STATE');
  const revision = f.state().current.revision;
  expectCode(() => tx(f.db, WORKER, ctx => publishRoute(ctx, { sessionId: f.sessionId, expectedRevision: revision, requestKey: 'legacy-route', parcels: [] })), 'BLOCKED_STATE');
  expectCode(() => tx(f.db, WORKER, ctx => recordOutcome(ctx, { sessionId: f.sessionId, expectedRevision: revision, requestKey: 'legacy-accept', parcelId: 'L001', outcome: 'accepted', requestedCents: 0, agreedCents: 0, explanation: '' })), 'BLOCKED_STATE');
  assert.deepEqual(tx(f.db, OPERATOR, ctx => negotiationAgreements(ctx, f.sessionId)), []);
});

test('durable review leases exclude competing claims and recover after expiry without accepting stale commits', () => {
  const f = setup(); f.prepare();
  f.command({ kind: 'response', attemptId: 'live-attempt', requestId: 'yes', routeVersion: 1, termsVersion: 1, response: 'agree', turnId: null });
  const claim = { sessionId: f.sessionId, attemptId: 'live-attempt', claimId: 'worker-a' };
  tx(f.db, WORKER, ctx => claimNegotiationReview(ctx, claim));
  tx(f.db, WORKER, ctx => claimNegotiationReview(ctx, { ...claim, claimId: 'worker-b' }));
  assert.equal(tx(f.db, WORKER, ctx => negotiationReviewState(ctx, f.sessionId, claim.attemptId))[0]!.claimId, 'worker-a');
  f.db.clock.set(new Timestamp(REVIEW_LEASE_MICROS + 1n));
  expectCode(() => tx(f.db, WORKER, ctx => claimNegotiationReview(ctx, claim)), 'BLOCKED_STATE');
  tx(f.db, WORKER, ctx => claimNegotiationReview(ctx, { ...claim, claimId: 'worker-b' }));
  const failure = { kind: 'failure', reason: 'TRANSCRIPT_UNAVAILABLE', attemptId: 'live-attempt', requestId: 'post-call-review', routeVersion: 1, termsVersion: 1 };
  expectCode(() => tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, { sessionId: f.sessionId, claimId: 'worker-a', commandJson: JSON.stringify(failure), providerTurnsJson: '[]' })), 'BLOCKED_STATE');
  const commit = { sessionId: f.sessionId, claimId: 'worker-b', commandJson: JSON.stringify(failure), providerTurnsJson: '[]' };
  tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, commit)); const saved = f.state();
  tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, commit)); assert.deepEqual(f.state(), saved);
  assert.equal(f.state().attempts['live-attempt']!.summary?.reason, 'TRANSCRIPT_UNAVAILABLE');
});

test('finalizing without a claim or replaying altered review content cannot change accepted terms', () => {
  const f = setup(); const commit = agree(f), raw = JSON.parse(commit.commandJson);
  expectCode(() => f.command(raw), 'BLOCKED_STATE');
  expectCode(() => tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, { ...commit, commandJson: JSON.stringify({ ...raw, candidate: { ...raw.candidate, compensationCents: 1 } }) })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.state().attempts['live-attempt']!.summary?.agreedCents, 1_000_000);
});

test('closing the run retains its saved explanation but rejects late callbacks including receipt replays', () => {
  const f = setup(); const commit = agree(f), last = tx(f.db, OPERATOR, ctx => negotiationResults(ctx, f.sessionId));
  tx(f.db, WORKER, ctx => closeNegotiation(ctx, { sessionId: f.sessionId }));
  expectCode(() => tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, commit)), 'BLOCKED_STATE');
  expectCode(() => f.prepare('late-call'), 'BLOCKED_STATE');
  assert.deepEqual(tx(f.db, OPERATOR, ctx => negotiationResults(ctx, f.sessionId)), last);
  assert.equal(f.db.db.session.sessionId.find(f.sessionId)?.status, 'closed');
});

test('provider evidence is durable before review, append-only and frozen during an active lease', () => {
  const f = setup(); f.prepare();
  const turns: NegotiationTurn[] = [{ id: 'owner-turn', role: 'owner', text: 'I need to think about it.', startMs: 0, endMs: 1000 }];
  const input = { sessionId: f.sessionId, attemptId: 'live-attempt', requestId: 'provider-complete', providerTurnsJson: JSON.stringify(turns) };
  tx(f.db, WORKER, ctx => recordNegotiationTranscript(ctx, input)); const before = f.state();
  tx(f.db, WORKER, ctx => recordNegotiationTranscript(ctx, input)); assert.deepEqual(f.state(), before);
  expectCode(() => tx(f.db, WORKER, ctx => recordNegotiationTranscript(ctx, { ...input, providerTurnsJson: '[]' })), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => tx(f.db, WORKER, ctx => recordNegotiationTranscript(ctx, { ...input, requestId: 'rewrite', providerTurnsJson: JSON.stringify([{ ...turns[0], text: 'Yes.' }]) })), 'BLOCKED_STATE');
  tx(f.db, WORKER, ctx => claimNegotiationReview(ctx, { sessionId: f.sessionId, attemptId: 'live-attempt', claimId: 'reviewer' }));
  expectCode(() => tx(f.db, WORKER, ctx => recordNegotiationTranscript(ctx, { ...input, requestId: 'append-during-review' })), 'BLOCKED_STATE');
  expectCode(() => f.command({ kind: 'response', attemptId: 'live-attempt', requestId: 'late-answer', routeVersion: 1, termsVersion: 1, response: 'agree', turnId: null }), 'BLOCKED_STATE');
  const review = { kind: 'failure', attemptId: 'live-attempt', requestId: 'post-call-review', routeVersion: 1, termsVersion: 1, reason: 'TRANSCRIPT_UNAVAILABLE' };
  expectCode(() => tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, { sessionId: f.sessionId, claimId: 'reviewer', commandJson: JSON.stringify(review), providerTurnsJson: '[]' })), 'BLOCKED_STATE');
  assert.deepEqual(f.state(), before);
  assert.equal(f.state().attempts['live-attempt']!.phase, 'confirming');
});

test('the CAL-33 host adapter executes and reviews against real reducer transactions, with one winning worker', async () => {
  const f = setup(); let sequence = 0;
  const backend: NegotiationBackend = {
    executeNegotiation: async input => tx(f.db, WORKER, ctx => executeNegotiation(ctx, input)),
    recordNegotiationTranscript: async input => tx(f.db, WORKER, ctx => recordNegotiationTranscript(ctx, input)),
    claimNegotiationReview: async input => tx(f.db, WORKER, ctx => claimNegotiationReview(ctx, input)),
    commitNegotiationReview: async input => tx(f.db, WORKER, ctx => commitNegotiationReview(ctx, input)),
    workerState: async sessionId => {
      const rows = tx(f.db, WORKER, ctx => negotiationWorkerState(ctx, sessionId));
      return rows[0] ? JSON.parse(rows[0].stateJson) : null;
    },
    reviewState: async (sessionId, attemptId) => tx(f.db, WORKER, ctx => negotiationReviewState(ctx, sessionId, attemptId))[0] ?? null,
  };
  const host = createSavedNegotiationHost({ backend, sessionId: f.sessionId, newClaimId: () => `review-${++sequence}` });
  const binding = { sessionId: f.sessionId, attemptId: 'live-attempt', routeVersion: 1, termsVersion: 1 };
  await host.execute(binding, { kind: 'prepare', attemptId: binding.attemptId, requestId: 'prepare', parcelId: 'L001', mode: 'live', routeVersion: 1, termsVersion: 1 });
  await host.execute(binding, { kind: 'response', attemptId: binding.attemptId, requestId: 'yes', response: 'agree', turnId: null, routeVersion: 1, termsVersion: 1 });
  const turns: NegotiationTurn[] = [
    { id: 'offer', role: 'agent', text: 'We offer $10000 plus $300 per month. Does that work for you?', startMs: 0, endMs: 1000 },
    { id: 'yes', role: 'owner', text: 'Yes.', startMs: 1100, endMs: 1500 },
  ];
  await host.recordTranscript(binding.attemptId, 'completed-provider-event', turns);
  const other = createSavedNegotiationHost({ backend, sessionId: f.sessionId, newClaimId: () => `review-${++sequence}` });
  const claims = await Promise.all([host.claimReview(binding.attemptId), other.claimReview(binding.attemptId)]);
  assert.equal(claims.filter(Boolean).length, 1); assert.deepEqual(claims[0]!.turns, turns);
  const result = await host.commit({ kind: 'finalize', attemptId: binding.attemptId, requestId: 'post-call-review', routeVersion: 1, termsVersion: 1,
    candidate: { reason: 'AGREED', offerTurnId: 'offer', ownerTurnId: 'yes', compensationCents: 1_000_000, monthlyRentCents: 30000 } }, turns);
  assert.equal(result.summary?.disposition, 'successful');
  assert.equal(await host.claimReview(binding.attemptId), null);
  await assert.rejects(host.execute({ ...binding, sessionId: 'wrong-session' }, { kind: 'failure', attemptId: binding.attemptId, requestId: 'bad', routeVersion: 1, termsVersion: 1, reason: 'DISCONNECTED' }));
});

test('route settlement waits for every parcel, then pays each exact accepted amount once to its saved recipient', () => {
  const f = setup('settlement');
  const before = f.state().current.revision;
  expectCode(() => tx(f.db, WORKER, ctx => openSettlement(ctx, { sessionId: f.sessionId, expectedRevision: before })), 'BLOCKED_STATE');
  agree(f);
  const oneAccepted = f.state().current.revision;
  expectCode(() => tx(f.db, WORKER, ctx => openSettlement(ctx, { sessionId: f.sessionId, expectedRevision: oneAccepted })), 'BLOCKED_STATE');
  agree(f, 'simulated-attempt', 'L002', 'simulated');
  const revision = f.state().current.revision;
  const row = f.db.db.negotiationSession.sessionId.find(f.sessionId)!;
  const saved = JSON.parse(row.stateJson);
  saved.handoff.referenceBinding = 'local-fixture';
  tx(f.db, WORKER, ctx => ctx.db.negotiationSession.sessionId.update({ ...ctx.db.negotiationSession.sessionId.find(f.sessionId)!, stateJson: JSON.stringify(saved) }));
  expectCode(() => tx(f.db, WORKER, ctx => openSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision })), 'BLOCKED_STATE');
  saved.handoff.referenceBinding = 'canonical';
  tx(f.db, WORKER, ctx => ctx.db.negotiationSession.sessionId.update({ ...ctx.db.negotiationSession.sessionId.find(f.sessionId)!, stateJson: JSON.stringify(saved) }));
  expectCode(() => tx(f.db, STRANGER, ctx => openSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision })), 'FORBIDDEN');
  expectCode(() => tx(f.db, WORKER, ctx => openSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision - 1 })), 'STALE_VERSION');
  tx(f.db, WORKER, ctx => openSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision }));
  tx(f.db, WORKER, ctx => openSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision }));
  const handoff = f.state().handoff;
  const owners = handoff.owners;
  tx(f.db, WORKER, ctx => signSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision, role: 'utility', ownerId: '', requestKey: 'sign-utility' }));
  for (const owner of owners) tx(f.db, WORKER, ctx => signSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision, role: 'owner', ownerId: owner.ownerId, requestKey: `sign-${owner.ownerId}` }));
  const first = handoff.parcels.find(parcel => parcel.parcelId === 'L001')!;
  const recipient = owners.find(owner => owner.ownerId === first.ownerId)!.banking.paymentRecipientRef;
  const pay = (amountCents: number, paymentRecipientRef: string, requestKey: string, parcelId = 'L001') => tx(f.db, WORKER, ctx => paySettlement(ctx, {
    sessionId: f.sessionId, expectedRevision: revision, parcelId, amountCents, paymentRecipientRef, requestKey,
  }));
  expectCode(() => pay(first.terms.compensationCents, recipient, 'pay-L001'), 'BLOCKED_STATE');
  tx(f.db, WORKER, ctx => approveSettlement(ctx, { sessionId: f.sessionId, expectedRevision: revision, requestKey: 'approve-route' }));
  expectCode(() => pay(first.terms.compensationCents - 1, recipient, 'pay-L001'), 'BLOCKED_STATE');
  expectCode(() => pay(first.terms.compensationCents, 'mock-mismatched', 'pay-L001'), 'BLOCKED_STATE');
  expectCode(() => pay(first.terms.compensationCents, recipient, 'pay-L999', 'L999'), 'BLOCKED_STATE');
  pay(first.terms.compensationCents, recipient, 'pay-L001');
  pay(first.terms.compensationCents, recipient, 'pay-L001');
  expectCode(() => pay(first.terms.compensationCents, recipient, 'pay-L001-again'), 'BLOCKED_STATE');
  const second = handoff.parcels.find(parcel => parcel.parcelId === 'L002')!;
  const secondRecipient = owners.find(owner => owner.ownerId === second.ownerId)!.banking.paymentRecipientRef;
  pay(second.terms.compensationCents, secondRecipient, 'pay-L002', 'L002');
  const view = tx(f.db, OPERATOR, ctx => settlementStatus(ctx, f.sessionId));
  const projected = JSON.parse(view[0]!.stateJson);
  assert.equal(view[0]!.status, 'paid');
  assert.deepEqual(projected.payments.map((payment: { parcelId: string; amountCents: number; paymentRecipientRef: string }) => [payment.parcelId, payment.amountCents, payment.paymentRecipientRef]).sort(),
    [['L001', first.terms.compensationCents, recipient], ['L002', second.terms.compensationCents, secondRecipient]].sort());
  assert.equal(JSON.stringify(view).includes('fixture-reference-only'), false);
  assert.equal(JSON.stringify(view).includes(NON_DIALABLE), false);
  assert.deepEqual(tx(f.db, STRANGER, ctx => settlementStatus(ctx, f.sessionId)), []);
});
