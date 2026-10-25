import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceStore, createVoiceStoreOnConnection, VoiceStoreUnavailableError,
  type VoiceConnection, type VoiceAttempt, type ReserveVoiceAttempt } from '../voice-store.ts';

const reservation: ReserveVoiceAttempt = {
  id: 'attempt-one', sessionId: 'session-one', requestKey: 'request-one', parcelId: 'parcel-one',
  mapBinding: { sessionId: 'map-one', routeId: 'route-one', routeVersion: 1, proposalKey: 'public-fixture' },
  canonicalJson: '{}', privateContact: { name: 'Demo participant', phone: 'non-dialable-fixture' },
  consent: true, consentAt: '2026-10-24T12:00:00Z', bearerTokenHash: 'a'.repeat(64), offerCents: 100, capCents: 120,
};
const reserved = (): VoiceAttempt => ({ ...structuredClone(reservation), paymentSchedule: 'full-after-signatures',
  revision: 1, status: 'reserved', claimId: null, providerCallId: null, candidate: null, outcome: null,
  currentOfferCents: 100, finalOfferMade: false, toolReceipts: {}, lastResponseRequestId: null,
  evidence: [], createdAtMicros: '1', updatedAtMicros: '1' });

function fakeConnection(initial: VoiceAttempt[] = []) {
  type Row = { id: string; sessionId: string; revision: number; status: string; attemptJson: string };
  const rows = new Map<string, Row>(), callbacks = new Set<() => void>();
  let applied = () => {}, subscriptionError = () => {}, disconnected = () => {}, claims = 0;
  const project = (a: VoiceAttempt) => ({ id: a.id, sessionId: a.sessionId, revision: a.revision, status: a.status, attemptJson: JSON.stringify(a) });
  for (const a of initial) rows.set(a.id, project(a));
  const put = (a: VoiceAttempt) => { rows.set(a.id, project(a)); for (const callback of callbacks) callback(); };
  const table = { iter: () => rows.values(), onInsert: (cb: () => void) => callbacks.add(cb), onUpdate: (cb: () => void) => callbacks.add(cb), onDelete: (cb: () => void) => callbacks.add(cb) };
  const resultTable = { ...table, iter: function* () {
    for (const row of rows.values()) {
      const a = JSON.parse(row.attemptJson);
      yield { ...row, resultJson: JSON.stringify({ id: a.id, sessionId: a.sessionId, revision: a.revision, status: a.status, parcelId: a.parcelId,
        paymentSchedule: a.paymentSchedule, originalMapBinding: a.mapBinding, resultingMapBinding: null, acceptedCompensationCents: null }) };
    }
  } };
  const connection: VoiceConnection = {
    db: { voiceWorkerAttempts: table, voiceResults: resultTable },
    reducers: {
      reserveVoiceAttempt: async () => { put(reserved()); },
      claimVoiceAttempt: async input => {
        claims++;
        const a = JSON.parse(rows.get(input.id)!.attemptJson) as VoiceAttempt;
        if (!a.claimId) put({ ...a, status: 'dispatching', claimId: input.claimId, revision: a.revision + 1 });
      },
      markVoiceAttempt: async () => {}, saveVoiceCandidate: async () => {}, saveVoiceOutcome: async () => {},
      recordVoiceTool: async () => {},
    },
    subscriptionBuilder: () => ({ onApplied: callback => { applied = callback; return {
      onError: callback => { subscriptionError = callback; return { subscribe: queries => {
        assert.deepEqual(queries, ['SELECT * FROM voice_worker_attempts', 'SELECT * FROM voice_results']); queueMicrotask(() => applied());
      } }; },
    }; } }),
    disconnect: () => { disconnected(); },
  };
  const connect = (timeoutMs = 100) => createVoiceStoreOnConnection(connection, { timeoutMs, onDisconnect: callback => { disconnected = callback; } });
  return { connection, connect, put, claims: () => claims, error: () => subscriptionError(), disconnect: () => disconnected() };
}

test('live construction requires a stable application token before loading generated bindings', async () => {
  await assert.rejects(() => createVoiceStore({ uri: 'https://maincloud.spacetimedb.com', databaseName: 'fixture' }), /stable SPACETIMEDB_TOKEN/);
});

test('committed mutation waits for its matching delayed subscription update', async () => {
  const fixture = fakeConnection();
  fixture.connection.reducers.reserveVoiceAttempt = async () => { setTimeout(() => fixture.put(reserved()), 25); };
  const store = await fixture.connect();
  let done = false;
  const pending = store.reserveAttempt(reservation).then(value => { done = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(done, false);
  const result = await pending; assert.equal(result.attempt.status, 'reserved'); assert.equal(result.replayed, false);
  store.close();
});

test('two concurrent claims in one transport grant only one dispatch permission', async () => {
  const fixture = fakeConnection([reserved()]), store = await fixture.connect();
  const results = await Promise.all([store.claimAttempt({ id: reservation.id, claimId: 'claim-one' }), store.claimAttempt({ id: reservation.id, claimId: 'claim-two' })]);
  assert.deepEqual(results.map(value => value.claimed), [true, false]); assert.equal(fixture.claims(), 1);
  store.close();
});

test('restart with a prior dispatch claim cannot authorize redial even with the same claim ID', async () => {
  const attempt = { ...reserved(), status: 'dispatching', claimId: 'old-claim', revision: 2 };
  const fixture = fakeConnection([attempt]), store = await fixture.connect();
  const result = await store.claimAttempt({ id: reservation.id, claimId: 'old-claim' });
  assert.equal(result.claimed, false); assert.equal(fixture.claims(), 0);
  assert.equal((await store.listPending())[0]?.claimId, 'old-claim'); store.close();
});

test('lost reducer confirmation throws even if its committed dispatch arrives in the subscription', async () => {
  const fixture = fakeConnection([reserved()]);
  fixture.connection.reducers.claimVoiceAttempt = async input => {
    fixture.put({ ...reserved(), status: 'dispatching', claimId: input.claimId, revision: 2 });
    throw new VoiceStoreUnavailableError();
  };
  const store = await fixture.connect();
  await assert.rejects(() => store.claimAttempt({ id: reservation.id, claimId: 'lost-confirmation' }), VoiceStoreUnavailableError);
  assert.equal((await store.claimAttempt({ id: reservation.id, claimId: 'lost-confirmation' })).claimed, false);
  store.close();
});

test('missing subscription evidence times out and does not manufacture a successful reservation', async () => {
  const fixture = fakeConnection(); fixture.connection.reducers.reserveVoiceAttempt = async () => {};
  const store = await fixture.connect(10);
  await assert.rejects(() => store.reserveAttempt(reservation), VoiceStoreUnavailableError); store.close();
});

test('disconnect prevents cached private state from authorizing further work', async () => {
  const fixture = fakeConnection([reserved()]), store = await fixture.connect(); fixture.disconnect();
  await assert.rejects(() => store.getAttempt(reservation.id), VoiceStoreUnavailableError);
  await assert.rejects(() => store.claimAttempt({ id: reservation.id }), VoiceStoreUnavailableError);
  store.close();
});

test('public result listeners receive only redacted projections and cannot mutate the cache', async () => {
  const fixture = fakeConnection([reserved()]), store = await fixture.connect();
  let observed = '';
  const unsubscribe = store.subscribeResults(result => { observed = JSON.stringify(result); result[0]!.status = 'locally-tampered'; });
  assert(!observed.includes('non-dialable-fixture')); assert(!observed.includes('privateContact'));
  assert.equal((await store.getAttempt(reservation.id))?.status, 'reserved'); unsubscribe(); store.close();
});

test('recordTool waits for the exact saved receipt and returns the committed offer', async () => {
  const attempt = { ...reserved(), status: 'connected', claimId: 'call-claim', providerCallId: 'provider-call', revision: 2 };
  const fixture = fakeConnection([attempt]), store = await fixture.connect();
  fixture.connection.reducers.recordVoiceTool = async input => {
    const receipt = { requestId: input.requestId, kind: 'counteroffer' as const, payload: JSON.parse(input.payloadJson), compensationCents: 115, finalOffer: true };
    setTimeout(() => fixture.put({ ...attempt, revision: 3, currentOfferCents: 115, finalOfferMade: true,
      toolReceipts: { [input.requestId]: receipt } }), 20);
  };
  const result = await store.recordTool({ id: reservation.id, claimId: 'call-claim', requestId: 'price-one', kind: 'counteroffer', payload: { requestedCents: 115 } });
  assert.equal(result.receipt.compensationCents, 115); assert.equal(result.attempt.currentOfferCents, 115);
  result.receipt.compensationCents = 1;
  assert.equal((await store.getAttempt(reservation.id))?.toolReceipts['price-one']?.compensationCents, 115);
  store.close();
});

test('markAttempt cannot confirm from an unrelated revision before its evidence reaches the subscription', async () => {
  const attempt = { ...reserved(), status: 'connected', claimId: 'call-claim', providerCallId: 'provider-call', revision: 2 };
  const fixture = fakeConnection([attempt]), store = await fixture.connect(20);
  fixture.connection.reducers.markVoiceAttempt = async () => {
    fixture.put({ ...attempt, revision: 3, currentOfferCents: 110 });
  };
  await assert.rejects(() => store.markAttempt({ id: reservation.id, claimId: 'call-claim', status: 'completed',
    providerCallId: 'provider-call', evidence: { verifiedTranscript: true } }), VoiceStoreUnavailableError);
  store.close();
});
