import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapNegotiationUpdate } from '../src/map-negotiation.ts';
import { createInitialOwnerHandoff } from '../src/owner-handoff-fixtures.ts';
import { Snapshot, type NegotiationResult } from '../src/schemas.ts';

function input() {
  const packet = createInitialOwnerHandoff();
  packet.referenceBinding = 'local-fixture';
  packet.parcels.forEach(parcel => {
    parcel.offerPolicy = { policyId: 'recommended-times-1.2-v1', basis: 'route-impact-v1',
      recommendedOfferCents: parcel.terms.compensationCents, multiplierNumerator: 6,
      multiplierDenominator: 5, rounding: 'floor-cent' };
    parcel.offerCapCents = Number(BigInt(parcel.terms.compensationCents) * 6n / 5n);
  });
  const meta = { schemaVersion: 1 as const, sourceMode: 'fixture' as const, evidenceRefs: ['fixture:map'] };
  const snapshot = Snapshot.parse({
    project: { ...meta, id: packet.projectId, revision: packet.revision,
      endpointA: { type: 'Point', coordinates: [-120.5, 37] },
      endpointB: { type: 'Point', coordinates: [-120.49, 37] }, budgetCents: packet.budgetCents,
      rentHorizonMonths: packet.rentHorizonMonths, selectedRouteId: packet.routeId,
      approvedRouteVersion: null, status: 'draft' },
    owners: packet.owners.map(owner => ({ ...meta, id: owner.ownerId, alias: owner.alias, synthetic: true })),
    parcels: packet.parcels.map(parcel => ({ ...meta, id: parcel.parcelId, projectId: packet.projectId,
      geometry: parcel.geometry, ownerId: parcel.ownerId,
      ownerAlias: packet.owners.find(owner => owner.ownerId === parcel.ownerId)!.alias,
      synthetic: true, landUse: parcel.landUse, areaSqM: parcel.areaSqM, offerCapCents: parcel.offerCapCents,
      accessConsent: 'unknown', negotiationStatus: 'pending' })),
    routes: [{ ...meta, id: packet.routeId, projectId: packet.projectId, version: packet.routeVersion,
      geometry: { type: 'LineString', coordinates: [[-120.5, 37], [-120.49, 37]] },
      parcelIds: packet.parcels.map(parcel => parcel.parcelId), lengthMeters: 100,
      constructionCents: packet.constructionCents, upfrontCompensationCents: 0,
      recurringRentTotalCents: 0, separateDepositTotalCents: 0, totalCostCents: packet.constructionCents,
      eligible: true, readyToApprove: false, reasons: [], regulatoryChecks: [] }],
    negotiations: [], easements: [], approvals: [], payments: [], reconciliations: [], events: [],
  });
  const handoff = { schemaVersion: 2 as const, kind: 'easygrid-map-handoff' as const,
    sourceMode: 'fixture' as const, sessionId: packet.sessionId, routeVersion: packet.routeVersion,
    snapshot, ownerHandoff: packet, coordinateTransform: { id: 'test-map-transform' }, costModel: { id: 'test-cost' } };
  // Canonical identities/versions intentionally differ from map-local identities.
  const binding = { projectId: 'server-project', callSessionId: 'server-call', parcelId: 'server-parcel',
    routeVersion: 12, termsVersion: 4, localParcelId: packet.parcels[0]!.parcelId };
  const result: NegotiationResult = { ...meta, id: 'outcome-1', sourceMode: 'live',
    evidenceRefs: ['evidence:confirmed-utterance'], projectId: binding.projectId, sessionId: binding.callSessionId,
    parcelId: binding.parcelId, routeVersion: binding.routeVersion, termsVersion: binding.termsVersion,
    outcome: 'refused', accessConsent: 'refused', explicitConfirmation: true,
    upfrontCents: packet.parcels[0]!.terms.compensationCents, depositCents: 0,
    depositCreditPolicy: 'credited_to_upfront', monthlyRentCents: 100, termMonths: packet.rentHorizonMonths,
    conditions: [] };
  return { handoff, result, binding, confirmationVerified: true, spatialConditionsVerified: false };
}
const polygon = { type: 'Polygon' as const,
  coordinates: [[[-120.5, 37], [-120.49, 37], [-120.49, 36.99], [-120.5, 37]]] as [number, number][][] };

test('maps a corroborated canonical refusal onto exact local proposal without modifying inputs', () => {
  const value = input(), before = structuredClone(value), update = createMapNegotiationUpdate(value);
  assert.equal(update.outcome, 'refused'); assert.equal(update.explicitConfirmation, true);
  assert.equal(update.parcelId, value.binding.localParcelId);
  assert.equal(update.mapBinding.routeVersion, value.handoff.routeVersion);
  assert.equal(update.termsVersion, value.binding.termsVersion);
  assert.equal(update.mapBinding.proposalKey, JSON.stringify({ snapshot: value.handoff.snapshot,
    ownerHandoff: value.handoff.ownerHandoff, coordinateTransform: value.handoff.coordinateTransform,
    costModel: value.handoff.costModel }));
  update.evidenceRefs.push('other'); update.terms.upfrontCents++;
  assert.deepEqual(value, before);
});

test('rejects wrong canonical project, call, parcel and route/terms versions', () => {
  for (const key of ['projectId', 'sessionId', 'parcelId', 'routeVersion', 'termsVersion'] as const) {
    const value = input();
    if (key === 'routeVersion' || key === 'termsVersion') value.result[key]++;
    else value.result[key] += '-wrong';
    assert.throws(() => createMapNegotiationUpdate(value), /authoritative call/);
  }
  const absent = input(); absent.binding.localParcelId = 'L999';
  assert.throws(() => createMapNegotiationUpdate(absent), /imported parcel/);
});

test('rejects inconsistent local session, route, owner and fixed cap bindings', () => {
  const mutations = [
    (v: ReturnType<typeof input>) => { v.handoff.sessionId += '-wrong'; },
    (v: ReturnType<typeof input>) => { v.handoff.routeVersion++; },
    (v: ReturnType<typeof input>) => { v.handoff.snapshot.project.selectedRouteId = 'wrong'; },
    (v: ReturnType<typeof input>) => { v.handoff.snapshot.routes[0]!.version++; },
    (v: ReturnType<typeof input>) => { v.handoff.snapshot.parcels[0]!.ownerId = 'wrong-owner'; },
    (v: ReturnType<typeof input>) => { v.handoff.snapshot.parcels[0]!.offerCapCents++; },
    (v: ReturnType<typeof input>) => { v.handoff.ownerHandoff.parcels[0]!.offerCapCents++; },
  ];
  for (const mutate of mutations) { const value = input(); mutate(value); assert.throws(() => createMapNegotiationUpdate(value)); }
});

test('weak refusal becomes review-required and malformed input is rejected', () => {
  for (const weaken of [
    (v: ReturnType<typeof input>) => { v.confirmationVerified = false; },
    (v: ReturnType<typeof input>) => { v.result.explicitConfirmation = false; },
    (v: ReturnType<typeof input>) => { v.result.evidenceRefs = []; },
    (v: ReturnType<typeof input>) => { v.result.accessConsent = 'unknown'; },
  ]) {
    const value = input(); weaken(value); const update = createMapNegotiationUpdate(value);
    assert.equal(update.outcome, 'review_required'); assert.equal(update.accessConsent, 'unknown');
    assert.equal(update.explicitConfirmation, false);
  }
  const malformed = input(); malformed.result.upfrontCents = 0.5;
  assert.throws(() => createMapNegotiationUpdate(malformed));
  assert.throws(() => createMapNegotiationUpdate({ ...input(), result: { ...input().result, transcript: 'private' } }));
});

test('condition text is not exposed and conditioned acceptance cannot become final acceptance', () => {
  const value = input(); value.result.outcome = 'accepted'; value.result.accessConsent = 'allowed';
  value.result.conditions = ['Private utterance must never be copied to the map'];
  const update = createMapNegotiationUpdate(value);
  assert.equal(update.outcome, 'counteroffer'); assert.equal(update.explicitConfirmation, false);
  assert.equal(update.accessConsent, 'unknown'); assert.equal(update.hasUnresolvedConditions, true);
  assert(!JSON.stringify(update).includes('Private utterance'));
  assert(!('conditions' in update)); assert(!('sessionId' in update)); assert(!('binding' in update));
});

test('geometry needs corroboration and explicit spatial verification, even when condition text is empty', () => {
  const value = input(); value.result.outcome = 'accepted'; value.result.accessConsent = 'allowed';
  value.result.exclusionGeometry = structuredClone(polygon);
  const unverified = createMapNegotiationUpdate(value);
  assert.equal(unverified.outcome, 'counteroffer'); assert.equal(unverified.hasUnresolvedConditions, true);
  assert(!('exclusionGeometry' in unverified));
  value.spatialConditionsVerified = true;
  const verified = createMapNegotiationUpdate(value);
  assert.equal(verified.outcome, 'counteroffer'); assert.equal(verified.explicitConfirmation, false);
  assert.equal(verified.hasUnresolvedConditions, false); assert.deepEqual(verified.exclusionGeometry, polygon);
  verified.exclusionGeometry!.coordinates[0]![0]![0] = -1;
  assert.deepEqual(value.result.exclusionGeometry, polygon);
  value.confirmationVerified = false;
  assert(!('exclusionGeometry' in createMapNegotiationUpdate(value)));
});

test('unconditional acceptance requires corroboration and obeys the fixed cap including separate deposit', () => {
  const value = input(); value.result.outcome = 'accepted'; value.result.accessConsent = 'allowed';
  value.result.upfrontCents = value.handoff.ownerHandoff.parcels[0]!.offerCapCents;
  assert.equal(createMapNegotiationUpdate(value).outcome, 'accepted');
  value.result.upfrontCents++;
  assert.throws(() => createMapNegotiationUpdate(value), /offer cap/);
  value.result.upfrontCents--; value.result.depositCreditPolicy = 'separate_charge'; value.result.depositCents = 1;
  assert.throws(() => createMapNegotiationUpdate(value), /offer cap/);
  value.confirmationVerified = false;
  assert.equal(createMapNegotiationUpdate(value).outcome, 'review_required');
});

test('nonfinal outcomes cannot assert final confirmation, consent or whole-parcel refusal', () => {
  for (const outcome of ['pending', 'counteroffer', 'review_required'] as const) {
    const value = input(); value.result.outcome = outcome; value.result.accessConsent = 'allowed';
    const update = createMapNegotiationUpdate(value);
    assert.equal(update.outcome, outcome); assert.equal(update.explicitConfirmation, false);
    assert.equal(update.accessConsent, 'unknown');
  }
  const value = input(); value.result.outcome = 'counteroffer';
  assert.equal(createMapNegotiationUpdate(value).outcome, 'review_required');
});
