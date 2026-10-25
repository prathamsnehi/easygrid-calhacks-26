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
  assert.equal(JSON.stringify(finished).includes(phone), false);
});
