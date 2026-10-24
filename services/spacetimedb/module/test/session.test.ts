import assert from 'node:assert/strict';
import test from 'node:test';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import * as module from '../src/index.ts';
import { offerCapCents, publishRoute, recordOutcome, startSession } from '../src/logic.ts';

const PHONE = '+15551212001';

function harness() {
  return createModuleTestHarness(module.default, module);
}

function parcel(id: string, towers: number, recommended: number, line = 1000) {
  return {
    parcelId: id,
    ownerAlias: `Owner ${id}`,
    towerCount: towers,
    lineLengthMillis: line,
    recommendedOfferCents: recommended,
    offerCapCents: offerCapCents(recommended),
    monthlyRentCents: 2500,
  };
}

function run<T>(db: ReturnType<typeof harness>, body: (ctx: Parameters<Parameters<ReturnType<typeof harness>['withReducerTx']>[1]>[0]) => T): T {
  return db.withReducerTx(TestAuth.internal(), body);
}

function expectCode(fn: () => void, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected ${code}, got ${String(caught)}`);
  assert.equal(caught.message.startsWith(`${code}:`), true, caught.message);
}

test('a saved route keeps one live landowner and hides the phone number', () => {
  const db = harness();
  run(db, ctx => startSession(ctx, {
    sessionId: 'demo-1', phone: PHONE, projectBudgetCents: 50_000, requestKey: 'start',
  }));
  run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-1',
    expectedRevision: 1,
    requestKey: 'route-1',
    parcels: [
      parcel('L002', 1, 8_000, 500),
      parcel('L001', 2, 10_000, 100),
      parcel('L003', 0, 1_000, 900),
    ],
  }));
  const progress = run(db, ctx => module.session_progress(ctx, { sessionId: 'demo-1' }))[0];
  const route = run(db, ctx => module.current_route(ctx, { sessionId: 'demo-1' }));
  assert.equal(progress?.status, 'negotiating');
  assert.equal(progress?.liveParcelId, 'L001');
  assert.equal(route.length, 2);
  assert.equal(route.find(row => row.parcelId === 'L001')?.role, 'live');
  assert.equal(route.find(row => row.parcelId === 'L002')?.outcome, 'accepted_simulated');
  assert.equal(JSON.stringify({ progress, route }).includes(PHONE), false);
  assert.equal(db.db.contact.sessionId.find('demo-1')?.phone, PHONE);
});

test('a stale route publish changes nothing', () => {
  const db = harness();
  run(db, ctx => startSession(ctx, {
    sessionId: 'demo-2', phone: PHONE, projectBudgetCents: 50_000, requestKey: 'start',
  }));
  run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-2', expectedRevision: 1, requestKey: 'route-1', parcels: [parcel('L001', 1, 10_000)],
  }));
  expectCode(() => run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-2', expectedRevision: 1, requestKey: 'route-stale', parcels: [parcel('L009', 1, 4_000)],
  })), 'STALE_REVISION');
  assert.equal(db.db.session.sessionId.find('demo-2')?.routeVersion, 1);
  assert.equal(db.db.session.sessionId.find('demo-2')?.liveParcelId, 'L001');
});

test('one raise is matched under the cap and a second request key cannot pay again', () => {
  const db = harness();
  run(db, ctx => startSession(ctx, {
    sessionId: 'demo-3', phone: PHONE, projectBudgetCents: 50_000, requestKey: 'start',
  }));
  run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-3', expectedRevision: 1, requestKey: 'route-1',
    parcels: [parcel('L001', 2, 10_000), parcel('L002', 1, 8_000)],
  }));
  const cap = offerCapCents(10_000);
  run(db, ctx => recordOutcome(ctx, {
    sessionId: 'demo-3', expectedRevision: 2, requestKey: 'yes-1', parcelId: 'L001',
    outcome: 'accepted', requestedCents: cap, agreedCents: cap, explanation: '',
  }));
  const rows = run(db, ctx => module.obligations(ctx, { sessionId: 'demo-3' }));
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.parcelId === 'L001')?.amountCents, Math.floor(cap / 5));
  assert.equal(rows.find(row => row.parcelId === 'L002')?.amountCents, Math.floor(8_000 / 5));
  expectCode(() => run(db, ctx => recordOutcome(ctx, {
    sessionId: 'demo-3', expectedRevision: 3, requestKey: 'yes-2', parcelId: 'L001',
    outcome: 'accepted', requestedCents: cap, agreedCents: cap, explanation: '',
  })), 'BLOCKED_STATE');
  assert.equal(run(db, ctx => module.obligations(ctx, { sessionId: 'demo-3' })).length, 2);
  run(db, ctx => recordOutcome(ctx, {
    sessionId: 'demo-3', expectedRevision: 2, requestKey: 'yes-1', parcelId: 'L001',
    outcome: 'accepted', requestedCents: cap, agreedCents: cap, explanation: '',
  }));
  assert.equal(db.db.session.sessionId.find('demo-3')?.revision, 3);
});

test('a request above the cap must settle at the maximum', () => {
  const db = harness();
  run(db, ctx => startSession(ctx, {
    sessionId: 'demo-4', phone: PHONE, projectBudgetCents: 50_000, requestKey: 'start',
  }));
  run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-4', expectedRevision: 1, requestKey: 'route-1', parcels: [parcel('L001', 1, 10_000)],
  }));
  const cap = offerCapCents(10_000);
  expectCode(() => run(db, ctx => recordOutcome(ctx, {
    sessionId: 'demo-4', expectedRevision: 2, requestKey: 'too-high', parcelId: 'L001',
    outcome: 'accepted', requestedCents: cap + 500, agreedCents: cap + 500, explanation: '',
  })), 'INVALID_INPUT');
  assert.equal(db.db.session.sessionId.find('demo-4')?.status, 'negotiating');
});

test('refusal excludes that parcel and the same session binds the next tower owner', () => {
  const db = harness();
  run(db, ctx => startSession(ctx, {
    sessionId: 'demo-5', phone: PHONE, projectBudgetCents: 80_000, requestKey: 'start',
  }));
  run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-5', expectedRevision: 1, requestKey: 'route-1',
    parcels: [parcel('L001', 2, 10_000), parcel('L002', 1, 8_000)],
  }));
  run(db, ctx => recordOutcome(ctx, {
    sessionId: 'demo-5', expectedRevision: 2, requestKey: 'no-1', parcelId: 'L001',
    outcome: 'refused', requestedCents: 10_000, agreedCents: 0,
    explanation: 'Owner refused the $100.00 opening offer.',
  }));
  expectCode(() => run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-5', expectedRevision: 3, requestKey: 'route-rejected',
    parcels: [parcel('L004', 3, 9_000), parcel('L001', 2, 10_000)],
  })), 'INVALID_INPUT');
  run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-5', expectedRevision: 3, requestKey: 'route-2',
    parcels: [parcel('L004', 3, 9_000), parcel('L002', 1, 8_000)],
  }));
  const progress = run(db, ctx => module.session_progress(ctx, { sessionId: 'demo-5' }))[0];
  assert.equal(progress?.liveParcelId, 'L004');
  assert.equal(progress?.status, 'negotiating');
  const route = run(db, ctx => module.current_route(ctx, { sessionId: 'demo-5' }));
  assert.deepEqual(route.map(row => row.parcelId).sort(), ['L002', 'L004']);
});

test('an unclear call stays in review and blocks payment', () => {
  const db = harness();
  run(db, ctx => startSession(ctx, {
    sessionId: 'demo-6', phone: PHONE, projectBudgetCents: 50_000, requestKey: 'start',
  }));
  run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-6', expectedRevision: 1, requestKey: 'route-1', parcels: [parcel('L001', 1, 10_000)],
  }));
  run(db, ctx => recordOutcome(ctx, {
    sessionId: 'demo-6', expectedRevision: 2, requestKey: 'review-1', parcelId: 'L001',
    outcome: 'needs_review', requestedCents: 11_000, agreedCents: 0,
    explanation: 'The owner did not clearly accept or refuse $100.00.',
  }));
  const progress = run(db, ctx => module.session_progress(ctx, { sessionId: 'demo-6' }))[0];
  assert.equal(progress?.status, 'needs_review');
  assert.equal(run(db, ctx => module.obligations(ctx, { sessionId: 'demo-6' })).length, 0);
  expectCode(() => run(db, ctx => publishRoute(ctx, {
    sessionId: 'demo-6', expectedRevision: 3, requestKey: 'route-2', parcels: [parcel('L002', 1, 8_000)],
  })), 'BLOCKED_STATE');
});
