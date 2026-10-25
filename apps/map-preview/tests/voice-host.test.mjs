import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDialArgs, createLiveCallHost, projectNegotiationResult } from '../src/voice-host.js';

const phone = '+15551212001';
const handoff = {
  sessionId: 'map-session-1',
  userRole: { parcelId: 'L001' },
  ownerHandoff: { budgetCents: 5_000_000, parcels: [{ parcelId: 'L001', terms: { monthlyRentCents: 2500 } }] },
  parcelAnalysis: [{ parcelId: 'L001', ownerAlias: 'Fictional Owner', towerCount: 2, lineLengthTiles: 4, recommendedOfferCents: 10_000, offerCapCents: 12_000, monthlyRentEquivalentCents: 2500 }],
};

test('the dial request carries the private phone once and the saved result does not', async () => {
  const args = buildDialArgs(handoff, { phoneE164: phone, consent: true });
  assert.equal(args.phone, phone);
  assert.equal(args.ownerAlias, 'Fictional Owner');
  assert.equal(args.monthlyRentCents, 2500);
  assert.equal(args.lineLengthMillis, 4 * 25 * 1000);
  const calls = [];
  const storage = new Map();
  let stop = () => {};
  let saw = false;
  const host = createLiveCallHost({
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body });
      if (String(url).endsWith('/v1/identity')) {
        return { ok: true, headers: { get: () => 'client-token' }, json: async () => ({}) };
      }
      if (String(url).endsWith('/call/start_call')) {
        return { ok: true, json: async () => 'requested' };
      }
      return { ok: true, json: async () => [{ schema: { elements: [{ name: { some: 'session_id' } }, { name: { some: 'attempt_id' } }, { name: { some: 'parcel_id' } }, { name: { some: 'mode' } }, { name: { some: 'phase' } }, { name: { some: 'revision' } }, { name: { some: 'reason' } }, { name: { some: 'disposition' } }, { name: { some: 'explanation' } }, { name: { some: 'next_action' } }, { name: { some: 'outcome' } }] }, rows: [['map-session-1', 'cabc', 'L001', 'live', 'negotiating', 1, '', '', '', '', '']] }] };
    },
    installSource: source => {
      stop = source({
        mapBinding: { sessionId: 'map-session-1', routeId: 'route', routeVersion: 1, proposalKey: 'key' },
        signal: new AbortController().signal,
        onReady: () => {},
        onUnavailable: () => { throw new Error('unavailable'); },
        onUpdate: update => {
          saw = true;
          assert.equal(JSON.stringify(update).includes(phone), false);
          assert.equal(update.summary, null);
          assert.equal(update.phase, 'negotiating');
          return { status: 'applied' };
        },
      }) ?? (() => {});
    },
  });
  await host.handle({ handoff, participant: { phoneE164: phone, consent: true }, signal: new AbortController().signal });
  await new Promise(resolve => setTimeout(resolve, 30));
  stop();
  assert.equal(saw, true);
  const dial = calls.find(call => call.url.endsWith('/call/start_call'));
  assert.equal(JSON.parse(dial.body)[1], phone);
  assert.equal(calls.some(call => String(call.body).includes(phone) && String(call.url).endsWith('/sql')), false);
  const finished = projectNegotiationResult({
    attemptId: 'cabc', sessionId: 'map-session-1', parcelId: 'L001', mode: 'simulated', phase: 'finished', revision: 2,
    reason: 'SERVICE_UNAVAILABLE', disposition: 'needs_review', explanation: 'The phone provider did not place a call. This is a labeled simulation, not a completed phone call.',
    nextAction: 'stop', outcome: 'pending',
  }, { sessionId: 'map-session-1', routeId: 'route', routeVersion: 1, proposalKey: 'key' });
  assert.equal(finished.summary.outcome, 'pending');
  assert.equal(finished.summary.agreedCents, undefined);
  assert.equal(JSON.stringify(finished).includes(phone), false);
  const agreed = projectNegotiationResult({
    attempt_id: 'attempt-agreed', parcel_id: 'L023', mode: 'live', phase: 'finished', revision: '2',
    reason: 'AGREED', disposition: 'successful', outcome: 'accepted', next_action: 'continue',
    explanation: 'Owner agreed to $1,063.56 plus $10.88 per month. This saved demo result is not a payment.',
    agreed_cents: 106356, monthly_rent_cents: '1088',
  }, { sessionId: 'map-session-1', routeId: 'route', routeVersion: 1, proposalKey: 'key' });
  assert.equal(agreed.localParcelId, 'L023');
  assert.equal(agreed.summary.agreedCents, 106356);
  assert.equal(agreed.summary.offeredCents, 106356);
  assert.equal(agreed.summary.monthlyRentCents, 1088);
  assert.equal(agreed.summary.accessConsent, 'allowed');
  assert.equal(agreed.summary.termsVersion, 1);
});

const binding = { sessionId: 'map-session-1', routeId: 'route', routeVersion: 1, proposalKey: 'key' };
const savedRow = overrides => ({
  sessionId: 'map-session-1', attemptId: 'attempt1', parcelId: 'L001', mode: 'live', phase: 'finished', revision: 2,
  reason: 'PRICE_REJECTED', disposition: 'unsuccessful', explanation: 'The owner declined the offered price. No agreement was saved.',
  nextAction: 'stop', outcome: 'refused', ...overrides,
});
async function settled() { for (let step = 0; step < 8; step++) await Promise.resolve(); }

test('a finished price, access, or do-not-call refusal notifies the map once', async () => {
  for (const reason of ['PRICE_REJECTED', 'ACCESS_REFUSED', 'DO_NOT_CALL']) {
    const refusals = [];
    let locks = 0;
    let poll = null;
    const host = createLiveCallHost({
      storage: { getItem: () => 'client-token', setItem() {} },
      schedulePoll: fn => { poll = fn; return 7; },
      cancelPoll() {},
      fetch: async url => {
        assert.equal(String(url).endsWith('/sql'), true);
        return { ok: true, json: async () => ({ rows: [savedRow({ reason })] }) };
      },
      lockLiveCall: () => { locks += 1; },
      onConfirmedRefusal: update => { refusals.push(update.summary.reason); },
    });
    host.source({
      mapBinding: binding,
      onReady() {},
      onUnavailable() { throw new Error('unavailable'); },
      onUpdate: () => ({ status: 'applied' }),
    });
    await settled();
    assert.deepEqual(refusals, [reason]);
    assert.equal(locks, 0);
    await poll();
    host.source({
      mapBinding: binding,
      callSessionId: 'map-session-1',
      onReady() {},
      onUnavailable() { throw new Error('unavailable'); },
      onUpdate: () => { throw new Error('a finished disagreement must not replay onto the next owner'); },
    });
    await settled();
    assert.deepEqual(refusals, [reason]);
    assert.equal(locks, 0);
  }
});

test('pending and needs-review summaries do not reroute or lock another call', async () => {
  const rows = [
    savedRow({ phase: 'negotiating', revision: 1, reason: '', disposition: '', explanation: '', nextAction: '', outcome: '' }),
    savedRow({ reason: 'UNCLEAR_RESPONSE', disposition: 'needs_review', outcome: 'pending', explanation: 'The wording did not confirm a decision.' }),
    savedRow({ reason: 'ADDITIONAL_CONDITIONS', disposition: 'needs_review', outcome: 'review_required', explanation: 'The condition needs human review.' }),
  ];
  for (const row of rows) {
    const refusals = [];
    let locks = 0;
    const host = createLiveCallHost({
      storage: { getItem: () => 'client-token', setItem() {} },
      schedulePoll: () => 1,
      cancelPoll() {},
      fetch: async () => ({ ok: true, json: async () => ({ rows: [row] }) }),
      lockLiveCall: () => { locks += 1; },
      onConfirmedRefusal: () => refusals.push(row.reason),
    });
    host.source({
      mapBinding: binding,
      onReady() {},
      onUnavailable() { throw new Error('unavailable'); },
      onUpdate: () => ({ status: 'applied' }),
    });
    await settled();
    assert.equal(refusals.length, 0);
    assert.equal(locks, 0);
  }
});

test('a repeated poll of the same revision does not notify again', async () => {
  let updates = 0;
  let poll = null;
  const host = createLiveCallHost({
    storage: { getItem: () => 'client-token', setItem() {} },
    schedulePoll: fn => { poll = fn; return 1; },
    cancelPoll() {},
    fetch: async () => ({ ok: true, json: async () => ({ rows: [savedRow({ phase: 'negotiating', revision: 4, reason: '', disposition: '', explanation: '', nextAction: '', outcome: '' })] }) }),
    onConfirmedRefusal: () => { throw new Error('An unfinished call cannot reroute.'); },
  });
  host.source({
    mapBinding: binding,
    onReady() {},
    onUnavailable() { throw new Error('unavailable'); },
    onUpdate: () => { updates += 1; return { status: 'applied' }; },
  });
  await settled();
  await poll();
  assert.equal(updates, 1);
});

test('an open call is not replaced when reset is unavailable, and a finished call can dial a new session', async () => {
  const requests = [];
  const host = createLiveCallHost({
    storage: { getItem: () => 'client-token', setItem() {} },
    schedulePoll: () => 1,
    cancelPoll() {},
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body });
      if (String(url).endsWith('/call/reset_demo_call')) return { ok: false, json: async () => ({}) };
      if (String(url).endsWith('/call/start_call')) return { ok: true, json: async () => 'requested' };
      return { ok: true, json: async () => ({ rows: [] }) };
    },
    installSource() {},
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    host.handle({ handoff, participant: { phoneE164: phone, consent: true }, signal, call: { sessionId: 'map-session-1:call:2', previousSessionId: 'map-session-1', previousOpen: true } }),
    /still open/,
  );
  assert.equal(requests.some(request => request.url.endsWith('/call/start_call')), false);
  requests.length = 0;
  let query = '';
  const finished = createLiveCallHost({
    storage: { getItem: () => 'client-token', setItem() {} },
    schedulePoll: () => 1,
    cancelPoll() {},
    fetch: async (url, init) => {
      requests.push(String(url));
      if (String(url).endsWith('/sql')) query = String(init?.body ?? '');
      if (String(url).endsWith('/call/reset_demo_call')) return { ok: false, json: async () => ({}) };
      if (String(url).endsWith('/call/start_call')) return { ok: true, json: async () => 'requested' };
      return { ok: true, json: async () => ({ rows: [] }) };
    },
    installSource: source => source({
      mapBinding: binding, signal, onReady() {}, onUnavailable() {}, onUpdate: () => ({ status: 'applied' }),
    }),
  });
  await finished.handle({
    handoff, participant: { phoneE164: phone, consent: true }, signal,
    call: { sessionId: 'map-session-1:call:2', previousSessionId: 'map-session-1', previousOpen: false },
  });
  await settled();
  assert.equal(requests.some(url => url.endsWith('/call/start_call')), true);
  assert.match(query, /map-session-1:call:2/);
});
