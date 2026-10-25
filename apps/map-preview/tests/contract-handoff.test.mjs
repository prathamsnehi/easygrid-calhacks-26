import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {contractSourceFromAgreement,simulatedMapAgreement} from '../src/contract-handoff.js';
import {createContractDraft,contractSourceKey,validateContractDraft} from '../src/contract-authoring.js';

const world = createWorld();
const substation = createPlacement(world,'substation',-43,-17);
const placements = {substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const routes = computeTransmissionRoutes(world,placements), route = routes.candidates[0];
const handoff = createHandoff({world,route,placements,analysis:analyzeRouteParcels(world,route,routes.assumptions),
  sessionId:'contract-terms-version-compatibility',routeVersion:1});
const clone = value => JSON.parse(JSON.stringify(value));
const legacyTerms = 'Use only the selected fictional corridor and tower foundations. Coordinate access with the fictional landowner and restore disturbed ground.';
const agreement = () => simulatedMapAgreement(handoff,{negotiationId:'terms-version-negotiation',approvedAt:'2026-10-25T00:00:00Z'});

test('unversioned and v1 saved agreements preserve the old exact source and draft binding', () => {
  const current = agreement(), savedSource = contractSourceFromAgreement(current,handoff);
  savedSource.parcels.forEach(parcel => {parcel.accessTerms = legacyTerms;});
  const draft = createContractDraft(savedSource,savedSource.parcels[0].parcelId,{id:'previously-signed-draft',now:'2026-10-25T00:00:00Z'});
  const unversioned = clone(current);delete unversioned.contractTermsVersion;
  for (const savedAgreement of [unversioned,{...unversioned,contractTermsVersion:1}]) {
    const before = JSON.stringify(savedAgreement), restored = contractSourceFromAgreement(savedAgreement,handoff);
    assert.deepEqual(restored,savedSource);
    assert.equal(contractSourceKey(restored),draft.sourceKey);
    assert.equal(validateContractDraft(draft,restored).valid,true);
    assert.equal(JSON.stringify(savedAgreement),before);
  }
  const newSource = contractSourceFromAgreement(current,handoff);
  assert.equal(validateContractDraft(draft,newSource).valid,false,'new terms must not reuse a previously signed draft');
});

test('new simulated agreements select concise v2 terms without changing the shared owner packet', () => {
  const current = agreement(), source = contractSourceFromAgreement(current,handoff);
  assert.equal(current.contractTermsVersion,2);
  assert.equal(Object.hasOwn(current.ownerHandoff,'contractTermsVersion'),false);
  assert(source.parcels.every(parcel => parcel.accessTerms === 'Use the approved corridor and tower sites. Coordinate access and restore the land.'));
});

test('unsupported contract terms versions are rejected instead of silently changing the source', () => {
  for (const contractTermsVersion of [null,0,3,1.5,'1','2']) {
    assert.throws(() => contractSourceFromAgreement({...agreement(),contractTermsVersion},handoff),/Unsupported development contract terms version/);
  }
});
