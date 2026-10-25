import assert from 'node:assert/strict';
import test from 'node:test';
import { Identity } from 'spacetimedb';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { createWorld } from '../../../../apps/map-preview/src/world.js';
import { createPlacement } from '../../../../apps/map-preview/src/placement.js';
import { computeTransmissionRoutes } from '../../../../apps/map-preview/src/routing.js';
import { analyzeRouteParcels } from '../../../../apps/map-preview/src/parcel-analysis.js';
import { createHandoff } from '../../../../apps/map-preview/src/handoff.js';
import { mapContractRequest } from '../../../../apps/map-preview/src/contract-handoff.js';
import {
  assessRegisteredDemo, createSavedNegotiationResultSource, importReconstructedNegotiation, registeredDemoRestoreRecord,
} from '../../../../apps/map-preview/server/negotiation-import.mjs';
import * as module from '../src/index.ts';
import { registerWorker, startSession, type Db } from '../src/logic.ts';
import { bindNegotiation, executeNegotiation, negotiationWorkerState } from '../src/negotiation-state.ts';
import { createModuleNegotiationBackend, NEGOTIATION_REDUCERS, NEGOTIATION_VIEWS } from '../../negotiation-client.ts';

const OPERATOR = new Identity(0n), WORKER = new Identity(1n);
const NON_DIALABLE = 'synthetic-non-dialable';
const harness = () => createModuleTestHarness(module.default, module);
type Harness = ReturnType<typeof harness>;
const tx = <T>(db: Harness, sender: Identity, body: (ctx: Db) => T) => db.withReducerTx(TestAuth.internal(), ctx =>
  body({ ...ctx, db: ctx.db, timestamp: ctx.timestamp, sender } as Db));

function mapContext() {
  const world = createWorld();
  const substation = createPlacement(world, 'substation', -43, -17);
  const placements = { substation, datacenter: createPlacement(world, 'datacenter', 43, -17, { substation }) };
  const result = computeTransmissionRoutes(world, placements);
  const route = result.candidates[0];
  assert.ok(route);
  const handoff = createHandoff({
    world, route, analysis: analyzeRouteParcels(world, route, result.assumptions), placements,
    sessionId: 'local-map-session', routeVersion: 1,
  });
  return { handoff, context: mapContractRequest(handoff, placements), placements };
}

test('trusted reconstruction binds the original map and privately registered participant', async () => {
  const db = harness();
  const { handoff, context } = mapContext();
  const session = { sessionId: 'canonical-session', revision: 2, budgetCents: handoff.ownerHandoff.budgetCents };
  const registration = { ownerId: handoff.userRole.ownerId, contactRef: 'fixture-reference-only', callConsent: true as const };
  tx(db, OPERATOR, ctx => startSession(ctx, {
    sessionId: session.sessionId, phone: NON_DIALABLE, projectBudgetCents: session.budgetCents, requestKey: 'start',
  }));
  tx(db, OPERATOR, ctx => registerWorker(ctx, {
    sessionId: session.sessionId, expectedRevision: 1, requestKey: 'worker', workerIdentity: WORKER.toHexString(),
  }));
  let calls = 0;
  const client = {
    async callReducer(name: string, args: { sessionId: string; expectedRevision: number; requestKey: string; handoffJson: string; mapBindingJson: string }) {
      assert.equal(name, 'bind_negotiation');
      calls += 1;
      tx(db, WORKER, ctx => bindNegotiation(ctx, args));
    },
  };
  const imported = await importReconstructedNegotiation({ context, registration, session, requestKey: 'trusted-map-import', client });
  assert.equal(calls, 1);
  assert.deepEqual(imported.mapBinding, context.mapBinding);
  assert.equal(imported.packet.referenceBinding, 'canonical');
  assert.equal(imported.packet.sessionId, session.sessionId);
  const participant = imported.packet.owners.find(owner => owner.ownerId === registration.ownerId);
  assert.equal(participant?.contact.registration, 'registered');
  assert.equal(participant?.contact.contactRef, registration.contactRef);
  assert.equal(JSON.stringify(imported.packet).includes(`"${NON_DIALABLE}"`), false);
  assert.equal(tx(db, WORKER, ctx => negotiationWorkerState(ctx, session.sessionId))[0]?.mapBindingJson, JSON.stringify(context.mapBinding));
  await importReconstructedNegotiation({ context, registration, session, requestKey: 'trusted-map-import', client });
  assert.equal(calls, 2);
  await assert.rejects(() => importReconstructedNegotiation({
    context: { ...context, ownerHandoff: handoff.ownerHandoff }, registration, session, requestKey: 'browser-packet', client,
  }), /browser packet/);
  await assert.rejects(() => importReconstructedNegotiation({
    context, registration: { ...registration, callConsent: false }, session, requestKey: 'no-consent', client,
  }), /private registration/);
  const parcelId = handoff.userRole.parcelId;
  const backend = createModuleNegotiationBackend({
    async callReducer(name, args) {
      assert.equal(name, NEGOTIATION_REDUCERS.executeNegotiation);
      tx(db, WORKER, ctx => executeNegotiation(ctx, args as { sessionId: string; commandJson: string; providerTurnsJson: string }));
    },
    async readView(name, args) {
      assert.equal(name, NEGOTIATION_VIEWS.workerState);
      return tx(db, WORKER, ctx => negotiationWorkerState(ctx, args.sessionId));
    },
  });
  await backend.executeNegotiation({
    sessionId: session.sessionId,
    commandJson: JSON.stringify({
      kind: 'prepare', attemptId: 'live-attempt', requestId: 'prepare', parcelId, mode: 'live', routeVersion: 1, termsVersion: 1,
    }),
    providerTurnsJson: '[]',
  });
  const state = await backend.workerState(session.sessionId);
  assert.equal(state?.attempts['live-attempt']?.parcelId, parcelId);
  assert.equal(state?.attempts['live-attempt']?.phase, 'negotiating');
});

test('saved rows arrive before ready, and facility coordinates alone do not restore the demo', async () => {
  const { handoff, context, placements } = mapContext();
  const mapBinding = context.mapBinding;
  const update = { schemaVersion: 1, kind: 'easygrid-negotiation-result', eventId: 'saved-result', revision: 4, saved: true, mapBinding };
  let release: (rows: Array<{ revision: number; updateJson: string }>) => void = () => {};
  const updates: unknown[] = [];
  let ready = false;
  const source = createSavedNegotiationResultSource({
    mapBinding,
    readResults: () => new Promise(resolve => { release = resolve; }),
  });
  source({
    mapBinding, signal: new AbortController().signal,
    onUpdate: value => { assert.equal(ready, false); updates.push(value); return { status: 'applied' }; },
    onReady: () => { ready = true; },
    onUnavailable: () => { throw new Error('The applied subscription should be ready.'); },
  });
  await Promise.resolve();
  assert.equal(ready, false);
  release([{ revision: 4, updateJson: JSON.stringify(update) }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready, true);
  assert.equal(updates.length, 1);
  let unavailable = false;
  createSavedNegotiationResultSource({ mapBinding, readResults: async () => [] })({
    mapBinding: { ...mapBinding, routeVersion: mapBinding.routeVersion + 1 }, signal: new AbortController().signal,
    onUpdate: () => { throw new Error('A different map cannot receive these rows.'); },
    onReady: () => { throw new Error('An unbound page is not ready.'); },
    onUnavailable: () => { unavailable = true; },
  });
  assert.equal(unavailable, true);
  const active = { active: true, mapBinding };
  const record = registeredDemoRestoreRecord(active);
  assert.equal(record.userParcelId, handoff.userRole.parcelId);
  assert.equal(record.sessionId, 'local-map-session');
  assert.equal(JSON.stringify(record).includes(NON_DIALABLE), false);
  const facilities = placements;
  assert.deepEqual(assessRegisteredDemo({ facilities }), { restored: false, facilitiesRestored: true, reason: 'facilities-only' });
  assert.equal(assessRegisteredDemo({ facilities, active, recomputedBinding: { ...mapBinding, proposalKey: `${mapBinding.proposalKey}changed` } }).reason, 'binding-mismatch');
  assert.equal(assessRegisteredDemo({ facilities, active, recomputedBinding: mapBinding }).restored, true);
  assert.equal(assessRegisteredDemo({ facilities, active: { ...active, active: false }, recomputedBinding: mapBinding }).reason, 'facilities-only');
});
