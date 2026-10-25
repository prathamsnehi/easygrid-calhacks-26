import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {contractSourceFromAgreement,participantAgreementFromAcceptance,simulatedMapAgreement} from '../src/contract-handoff.js';
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

test('a saved call acceptance opens one landowner contract and leaves the other owners pending', () => {
  const parcel = handoff.ownerHandoff.parcels.find(item => item.parcelId === handoff.userRole.parcelId);
  const amount = parcel.offerPolicy.recommendedOfferCents;
  const before = JSON.stringify(handoff.ownerHandoff);
  const accepted = {parcelId:parcel.parcelId,agreedCents:amount,monthlyRentCents:parcel.terms.monthlyRentCents,termsVersion:parcel.terms.termsVersion,
    negotiationRef:{attemptId:'attempt1',eventId:'attempt1-r2',revision:2}};
  const source = contractSourceFromAgreement(participantAgreementFromAcceptance(handoff,accepted),handoff);
  const selected = source.parcels.find(item => item.parcelId === parcel.parcelId);
  assert.equal(selected.accepted,true);
  assert.equal(selected.compensationCents,amount);
  assert.equal(source.approvalScope.parcelId,parcel.parcelId);
  assert.equal(source.parcels.filter(item => item.accepted).length,1);
  assert.equal(JSON.stringify(handoff.ownerHandoff),before);
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

const scopedAgreement=() => {
  const current=agreement(), selected=handoff.userRole.parcelId;
  const accepted=clone(current.ownerHandoff.parcels.find(parcel => parcel.parcelId===selected).terms);
  current.ownerHandoff=clone(handoff.ownerHandoff);
  current.approvalScope={kind:'single-owner',parcelId:selected};
  current.ownerHandoff.parcels.find(parcel => parcel.parcelId===selected).terms=accepted;
  return current;
};

test('single-owner negotiated approval keeps all current parcels and their actual acceptance states', () => {
  const current=scopedAgreement(), selected=current.approvalScope.parcelId;
  const terms=current.ownerHandoff.parcels.find(parcel => parcel.parcelId===selected).terms;
  terms.compensationCents-=1;terms.termsVersion+=2;
  const before=JSON.stringify(current), source=contractSourceFromAgreement(current,handoff);
  assert.equal(current.ownerHandoff.routeStatus,'selected_for_negotiation');
  assert.equal(JSON.stringify(current),before);
  assert.deepEqual(source.approvalScope,{kind:'single-owner',parcelId:selected});
  assert.deepEqual(source.parcels.map(p => p.parcelId).sort(),handoff.ownerHandoff.parcels.map(p => p.parcelId).sort());
  for (const parcel of source.parcels) {
    const packetParcel=current.ownerHandoff.parcels.find(p => p.parcelId===parcel.parcelId);
    assert.equal(parcel.accepted,parcel.parcelId===selected);
    assert.equal(parcel.compensationCents,packetParcel.terms.compensationCents);
    assert.equal(parcel.termsVersion,packetParcel.terms.termsVersion);
    assert.equal(parcel.ownerId,packetParcel.ownerId);
    if (parcel.parcelId!==selected) assert.throws(() => createContractDraft(source,parcel.parcelId),/approval scope/);
  }
  assert.equal(validateContractDraft(createContractDraft(source,selected),source).valid,true);
  const allAccepted=agreement();allAccepted.approvalScope=current.approvalScope;
  const acceptedSource=contractSourceFromAgreement(allAccepted,handoff);
  assert(acceptedSource.parcels.every(parcel => parcel.accepted),'other genuine acceptances are retained, not manufactured or erased');
  assert.throws(() => createContractDraft(acceptedSource,acceptedSource.parcels.find(p => p.parcelId!==selected).parcelId),/approval scope/);
});

test('single-owner scope never substitutes route selection or call consent for selected owner acceptance', () => {
  const valid=scopedAgreement();
  for (const mutate of [a => a.approvalScope=null,a => a.approvalScope.kind='all',a => a.approvalScope.parcelId='missing',
    a => a.ownerHandoff.routeStatus='negotiating',a => a.ownerHandoff.referenceBinding='canonical',
    a => a.ownerHandoff.parcels.find(p => p.parcelId===a.approvalScope.parcelId).terms.outcome='pending',
    a => a.ownerHandoff.parcels.find(p => p.parcelId===a.approvalScope.parcelId).terms.explicitConfirmation=false,
    a => a.ownerHandoff.parcels.find(p => p.parcelId===a.approvalScope.parcelId).terms.accessConsent='unknown',
    a => a.ownerHandoff.parcels.find(p => p.parcelId===a.approvalScope.parcelId).terms.confirmationRef=null]) {
    const invalid=clone(valid);mutate(invalid);assert.throws(() => contractSourceFromAgreement(invalid,handoff));
  }
  const withoutScope=clone(valid);delete withoutScope.approvalScope;
  assert.throws(() => contractSourceFromAgreement(withoutScope,handoff),/complete approved/);
  withoutScope.ownerHandoff.routeStatus='ready_for_agreements';
  assert.throws(() => contractSourceFromAgreement(withoutScope,handoff),/explicit accepted terms/);
});

test('pending owners in a scoped packet retain strict terms, current identities and mock recipient checks', () => {
  const pending=a => a.ownerHandoff.parcels.find(p => p.parcelId!==a.approvalScope.parcelId);
  const owner=a => a.ownerHandoff.owners.find(o => o.ownerId===pending(a).ownerId);
  for (const mutate of [a => pending(a).terms.compensationCents=-1,a => pending(a).terms.compensationCents=0.5,
    a => pending(a).terms.compensationCents=Number.MAX_SAFE_INTEGER+1,a => pending(a).terms.compensationCents=pending(a).offerCapCents+1,
    a => pending(a).terms.termsVersion=0,a => pending(a).terms.termsVersion='1',a => pending(a).terms.outcome='invalid',
    a => pending(a).terms.explicitConfirmation='false',a => pending(a).terms.accessConsent='invalid',
    a => pending(a).terms.confirmationRef='',a => pending(a).terms.outcome='accepted',
    a => pending(a).ownerId='unknown-owner',a => owner(a).alias='Changed owner',
    a => owner(a).banking.paymentRecipientRef='changed-recipient',a => owner(a).banking.accountDisplay='changed account',
    a => owner(a).banking.accountHolderAlias='changed holder',a => owner(a).banking.bankDisplay='changed bank',
    a => a.ownerHandoff.owners.push(clone(a.ownerHandoff.owners[0])),a => a.ownerHandoff.parcels.pop()]) {
    const invalid=scopedAgreement();mutate(invalid);assert.throws(() => contractSourceFromAgreement(invalid,handoff));
  }
});
