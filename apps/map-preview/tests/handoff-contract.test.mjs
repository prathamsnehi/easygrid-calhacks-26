import test from 'node:test';
import assert from 'node:assert/strict';
import {Snapshot} from '../../../packages/contracts/src/schemas.ts';
import {operations} from '../../../packages/contracts/src/api.ts';
import {OwnerHandoff} from '../../../packages/contracts/src/owner-handoff.ts';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff,buildCallSessionRequest} from '../src/handoff.js';

test('every map handoff snapshot and canonical call request pass the frozen shared Zod schemas',()=>{
  const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
  const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
  const result=computeTransmissionRoutes(world,placements);
  assert.equal(result.status,'ok');
  for(const route of result.candidates){
    const analysis=analyzeRouteParcels(world,route,result.assumptions);
    const handoff=createHandoff({world,route,analysis,placements,sessionId:'schema-check',routeVersion:7});
    assert.equal(handoff.schemaVersion,2,'the renamed public envelope has its own version');
    assert.equal(handoff.snapshot.project.schemaVersion,1,'the shared API remains v1');
    assert.deepEqual(Snapshot.parse(handoff.snapshot),handoff.snapshot);
    assert.deepEqual(OwnerHandoff.parse(handoff.ownerHandoff),handoff.ownerHandoff);
    assert.equal(handoff.ownerHandoff.referenceBinding,'local-fixture');
    assert.equal(handoff.ownerHandoff.routeStatus,'selected_for_negotiation');
    assert.equal(handoff.ownerHandoff.routeVersion,7);
    assert.equal(handoff.ownerHandoff.parcels.length,handoff.snapshot.parcels.length);
    for(const parcel of handoff.ownerHandoff.parcels){
      const row=handoff.parcelAnalysis.find(item=>item.parcelId===parcel.parcelId);
      assert.equal(parcel.ownerId,row.ownerId);
      assert.equal(parcel.terms.compensationCents,row.upfrontCents);
      assert.equal(parcel.terms.comparisonRentTotalCents,row.rentTotalCents);
      assert.equal(parcel.terms.monthlyRentCents,row.monthlyRentEquivalentCents);
      assert.equal(parcel.terms.monthlyRentIsApproximate,row.monthlyRentIsApproximate);
      assert.equal(parcel.terms.outcome,'pending');
      assert.equal(parcel.terms.explicitConfirmation,false);
      assert.equal(parcel.terms.confirmationRef,null);
    }
    const request=buildCallSessionRequest({projectId:'backend-project-17',parcelId:handoff.userRole.parcelId,
      expectedRevision:8,routeVersion:7,registeredContactRef:'registered-demo-contact-19',
      participantConsent:true,idempotencyKey:`call-${route.id}-7`});
    assert.deepEqual(operations.createCallSession.request.parse(request),request);
    assert.equal(request.participantContactRef,'registered-demo-contact-19');
    assert.notEqual(request.participantContactRef,handoff.userRole.participantContactRef);
  }
});

function sample(){
  const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
  const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
  const result=computeTransmissionRoutes(world,placements),route=result.candidates[0];
  return {world,placements,route,analysis:analyzeRouteParcels(world,route,result.assumptions),
    sessionId:'owner-handoff-check',routeVersion:1};
}

test('all 24 fictional owners have stable, distinct mock banking profiles',()=>{
  const first=createWorld(),second=createWorld();
  assert.equal(first.owners.length,24);
  assert.equal(new Set(first.owners.map(owner=>owner.banking.paymentRecipientRef)).size,24);
  for(const owner of first.owners){
    const banking=owner.banking;
    assert.deepEqual(banking,second.ownerById.get(owner.id).banking);
    assert.equal(banking.ownerId,owner.id);
    assert.equal(banking.accountHolderAlias,owner.alias);
    assert.equal(banking.mode,'simulated');
    assert.match(banking.paymentRecipientRef,/^mock-recipient-o\d{3}$/);
    assert.match(banking.accountDisplay,/^\*{4}\d{4}$/);
    assert.match(banking.bankDisplay,/simulated/);
    assert(!('accountNumber' in banking));assert(!('routingNumber' in banking));
  }
});

test('owner handoff keeps roleplay contact private, unregistered and separate from banking identity',()=>{
  const input=sample(),userParcelId=input.route.parcelIds.at(-1);
  const participant={alias:'Private Participant 762',phoneE164:'+14155550134',consent:true};
  const ownerId=input.world.parcelById.get(userParcelId).ownerId;
  const original=input.world.ownerById.get(ownerId);
  const packet=createHandoff({...input,userParcelId,participant});
  const shared=OwnerHandoff.parse(packet.ownerHandoff),user=shared.owners.find(owner=>owner.ownerId===ownerId);
  assert.deepEqual(shared.userRole,{ownerId,parcelId:userParcelId});
  assert.equal(user.contact.contactRef,`${input.sessionId}:user`);
  assert.equal(user.contact.registration,'unregistered');
  assert.equal(user.contact.callConsent,false);
  assert.equal(packet.userRole.participantConsent,true,'local form consent does not register a server contact');
  assert.deepEqual(user.banking,original.banking);
  assert.equal(user.alias,original.alias);
  const serialized=JSON.stringify(shared);
  assert(!serialized.includes(participant.alias));assert(!serialized.includes(participant.phoneE164));
  for(const owner of shared.owners){assert(!('email' in owner.contact));assert(!('phoneE164' in owner.contact));}
  shared.owners[0].banking.accountDisplay='****9999';
  assert.notEqual(input.world.ownerById.get(shared.owners[0].ownerId).banking.accountDisplay,'****9999');
});

test('missing, mismatched or duplicate banking recipients block the map handoff',()=>{
  const input=sample(),owner=input.world.ownerById.get(input.analysis.parcels[0].ownerId),banking=owner.banking;
  owner.banking=null;
  assert.throws(()=>createHandoff(input),/banking profile/);
  owner.banking={...banking,ownerId:'different-owner'};
  assert.throws(()=>createHandoff(input),/banking profile/);
  owner.banking={...banking,mode:'live'};
  assert.throws(()=>createHandoff(input),/banking profile/);
  owner.banking={...banking,accountDisplay:'123456789'};
  assert.throws(()=>createHandoff(input),/banking profile/);
  const other=input.world.ownerById.get(input.analysis.parcels[1].ownerId);
  owner.banking={...banking,paymentRecipientRef:other.banking.paymentRecipientRef};
  assert.throws(()=>createHandoff(input),/distinct mock payment recipient/);
});

test('ineligible map data stays a negotiation snapshot and never an agreement-ready packet',()=>{
  const input=sample();
  const packet=createHandoff({...input,budgetCents:0});
  assert.equal(packet.snapshot.routes[0].eligible,false);
  const shared=OwnerHandoff.parse(packet.ownerHandoff);
  assert.equal(shared.budgetCents,0);
  assert.equal(shared.routeStatus,'selected_for_negotiation');
  assert(shared.parcels.every(parcel=>parcel.terms.outcome==='pending'));
});
