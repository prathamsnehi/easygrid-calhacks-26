import test from 'node:test';
import assert from 'node:assert/strict';
import {OwnerHandoff,assertAgreementReady} from '../../../packages/contracts/src/owner-handoff.ts';
import {NegotiationResult} from '../../../packages/contracts/src/schemas.ts';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {createSimulatedAgreement} from '../src/demo-agreements.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const before=computeTransmissionRoutes(world,placements),rerouted=computeTransmissionRoutes(world,placements,{blockedParcelIds:['L010']});
const route=rerouted.candidates[0],analysis=analyzeRouteParcels(world,route,rerouted.assumptions);
const participant={alias:'Private Demo Person 932',phoneE164:'+14155550134',consent:true};
function sample(){
  return createHandoff({world,placements,route,analysis,sessionId:'agreement-check',routeVersion:2,
    userParcelId:'L010',liveCallLocked:true,participant});
}
function simulate(handoff=sample()){return createSimulatedAgreement(handoff,{blockedParcelIds:['L010']});}

test('refusal bypass ends with explicit mock acceptance by every final-route owner',()=>{
  assert(before.candidates[0].parcelIds.includes('L010'));
  assert(!route.parcelIds.includes('L010'));
  const handoff=sample(),agreement=simulate(handoff);
  assert.equal(agreement.sourceMode,'mock');
  assert.equal(agreement.kind,'easygrid-simulated-agreement');
  assert.deepEqual(OwnerHandoff.parse(agreement.ownerHandoff),agreement.ownerHandoff);
  assert.equal(agreement.ownerHandoff.routeStatus,'ready_for_agreements');
  assert.equal(agreement.ownerHandoff.referenceBinding,'local-fixture');
  assert.equal(agreement.ownerHandoff.userRole.parcelId,'L010');
  assert.equal(agreement.ownerHandoff.routeVersion,2);
  assert.deepEqual(agreement.negotiations.map(item=>item.parcelId).sort(),route.parcelIds.slice().sort());
  for(const result of agreement.negotiations){
    assert.deepEqual(NegotiationResult.parse(result),result);
    assert.equal(result.sourceMode,'mock');assert.equal(result.outcome,'accepted');
    assert.equal(result.accessConsent,'allowed');assert.equal(result.explicitConfirmation,true);
    assert.equal(result.routeVersion,2);assert.equal(result.projectId,handoff.snapshot.project.id);
    assert(result.evidenceRefs.every(ref=>ref.startsWith('mock')));
  }
  const original=agreement.ownerHandoff.owners.find(owner=>owner.ownerId===handoff.userRole.ownerId);
  assert.deepEqual(original,handoff.ownerHandoff.owners.find(owner=>owner.ownerId===original.ownerId));
  assert(!agreement.ownerHandoff.parcels.some(parcel=>parcel.ownerId===original.ownerId));
  for(const parcel of agreement.ownerHandoff.parcels){
    const owner=agreement.ownerHandoff.owners.find(item=>item.ownerId===parcel.ownerId);
    assert.equal(owner.contact.registration,'simulation');assert.equal(owner.contact.callConsent,false);
    assert.equal(parcel.terms.monthlyRentIsApproximate,false);
    assert.equal(parcel.terms.comparisonRentTotalCents,parcel.terms.monthlyRentCents*agreement.ownerHandoff.rentHorizonMonths);
    assert.equal(parcel.offerCapCents,Math.floor(parcel.offerPolicy.recommendedOfferCents*1.2));
  }
  assert.equal(agreement.totals.totalCostCents,agreement.totals.constructionCents+
    agreement.totals.compensationCents+agreement.totals.rentTotalCents);
});

test('new exact simulated monthly offers are priced over the same horizon and budget checked',()=>{
  const handoff=sample(),agreement=simulate(handoff);
  assert(handoff.parcelAnalysis.some(row=>row.monthlyRentIsApproximate));
  assert.equal(agreement.totals.rentTotalCents,agreement.negotiations.reduce((sum,item)=>sum+item.monthlyRentCents*item.termMonths,0));
  assert.equal(agreement.ownerHandoff.rentHorizonMonths,handoff.snapshot.project.rentHorizonMonths);
  const limited=copy(handoff);
  limited.ownerHandoff.budgetCents=limited.snapshot.project.budgetCents=agreement.totals.totalCostCents-1;
  assert.throws(()=>simulate(limited),/budget/);
  const changed=copy(handoff);changed.ownerHandoff.rentHorizonMonths=24;
  assert.throws(()=>simulate(changed),/horizon/);
});

test('ineligible, unpriced, blocked or original-owner routes cannot be scripted into acceptance',()=>{
  const badRoute=sample();badRoute.snapshot.routes[0].eligible=false;
  assert.throws(()=>simulate(badRoute),/route/);
  const unpriced=sample();unpriced.parcelAnalysis[0].recommendationStatus='review-required';
  assert.throws(()=>simulate(unpriced),/priced recommendation/);
  const blocked=sample();
  assert.throws(()=>createSimulatedAgreement(blocked,{blockedParcelIds:['L010',route.parcelIds[0]]}),/Refused parcels/);
  const refused=sample();refused.snapshot.parcels[0].negotiationStatus='refused';
  assert.throws(()=>simulate(refused),/Refused parcels/);
  assert.throws(()=>createSimulatedAgreement(sample()),/refused original/);
  const originalOnRoute=sample();
  const active=originalOnRoute.ownerHandoff.parcels[0];
  originalOnRoute.userRole.parcelId=active.parcelId;originalOnRoute.userRole.ownerId=active.ownerId;
  originalOnRoute.ownerHandoff.userRole={parcelId:active.parcelId,ownerId:active.ownerId};
  assert.throws(()=>createSimulatedAgreement(originalOnRoute,{blockedParcelIds:[active.parcelId]}),/refused original/);
});

test('simulation cannot rebase the fixed cap, redirect banking or manufacture canonical approval',()=>{
  const cap=sample();cap.ownerHandoff.parcels[0].offerCapCents+=100;
  assert.throws(()=>simulate(cap),/120 percent cap/);
  const banking=sample();banking.ownerHandoff.owners[0].banking.ownerId='wrong-owner';
  assert.throws(()=>simulate(banking),/banking/);
  const agreement=simulate(),packet=agreement.ownerHandoff;
  const current={
    sessionId:packet.sessionId,projectId:packet.projectId,routeId:packet.routeId,routeVersion:packet.routeVersion,
    revision:packet.revision,termsVersions:Object.fromEntries(packet.parcels.map(p=>[p.parcelId,p.terms.termsVersion])),
    offerPolicies:Object.fromEntries(packet.parcels.map(p=>[p.parcelId,{policyId:p.offerPolicy.policyId,basis:p.offerPolicy.basis,
      recommendedOfferCents:p.offerPolicy.recommendedOfferCents,offerCapCents:p.offerCapCents}])),
  };
  assert.deepEqual(assertAgreementReady(packet,current),packet,'pure readiness supports a matching fixture context; it is not authorization');
  assert.equal(packet.referenceBinding,'local-fixture');
  assert.throws(()=>assertAgreementReady(packet,{...current,routeVersion:1}),/routeVersion/);
  assert(!('approvals' in agreement));assert(!('payments' in agreement));assert(!('contracts' in agreement));
});

test('simulated packet stays detached and contact redacted, and does not mutate planning state',()=>{
  const handoff=sample(),before=copy(handoff),agreement=simulate(handoff);
  assert.deepEqual(handoff,before);
  const json=JSON.stringify(agreement);
  assert(!json.includes(participant.alias));assert(!json.includes(participant.phoneE164));
  assert(!json.includes('phoneE164'));assert(!json.includes('accountNumber'));
  agreement.ownerHandoff.owners[0].banking.accountDisplay='****1111';
  agreement.ownerHandoff.parcels[0].terms.compensationCents=1;
  agreement.negotiations[0].evidenceRefs.push('changed');
  assert.deepEqual(handoff,before);
  assert.notDeepEqual(simulate(handoff),agreement);
});
