import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff,validateDemoParticipant,buildCallSessionRequest,localPointToGeoJSON,DEMO_COORDINATE_TRANSFORM} from '../src/handoff.js';

const world=createWorld();
const substation=createPlacement(world,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const result=computeTransmissionRoutes(world,placements);
assert.equal(result.status,'ok');
const route=result.candidates[0],analysis=analyzeRouteParcels(world,route,result.assumptions);
const input={world,route,analysis,placements,sessionId:'handoff-test-session',routeVersion:4};
const clone=value=>JSON.parse(JSON.stringify(value));

test('participant setup requires a name, international phone and explicit roleplay consent',()=>{
  const accepted=validateDemoParticipant({alias:'  Test participant  ',phone:'+1 (415) 555-0134',consent:true});
  assert.equal(accepted.valid,true);
  assert.deepEqual(accepted.participant,{alias:'Test participant',phoneE164:'+14155550134',consent:true});
  for(const alias of ['', '   ', null])assert.equal(validateDemoParticipant({alias,phone:'+14155550134',consent:true}).valid,false);
  for(const phone of ['', '4155550134','+0123456789','+14155550134 ext 5','++14155550134','+1234567','+1234567890123456']){
    assert.equal(validateDemoParticipant({alias:'Test participant',phone,consent:true}).valid,false,phone);
  }
  for(const consent of [false,undefined,'true',1])assert.equal(validateDemoParticipant({alias:'Test participant',phone:'+14155550134',consent}).valid,false);
  assert.equal(validateDemoParticipant({alias:'A\nB',phone:'+14155550134',consent:true}).valid,false);
  assert.equal(validateDemoParticipant({alias:'x'.repeat(81),phone:'+14155550134',consent:true}).valid,false);
});

test('every selected route receives exactly one in-route judge role without changing fixture owners',()=>{
  const before=JSON.stringify({owners:world.owners,parcels:world.parcels});
  for(const candidate of result.candidates){
    const nextAnalysis=analyzeRouteParcels(world,candidate,result.assumptions);
    const packet=createHandoff({...input,route:candidate,analysis:nextAnalysis,judgeParcelId:'not-on-route'});
    assert(candidate.parcelIds.includes(packet.judgeRole.parcelId));
    assert.equal(packet.parcelAnalysis.filter(row=>row.judgeRole).length,1);
    assert.equal(packet.judgeRole.participantReady,false);
    assert.equal(packet.callPreparation.status,'participant-required');
    assert.equal(packet.callPreparation.canStartCall,false);
    assert.equal(packet.snapshot.routes[0].readyToApprove,false);
    assert(packet.snapshot.parcels.every(parcel=>parcel.accessConsent==='unknown'));
    const selected=packet.snapshot.parcels.find(parcel=>parcel.id===packet.judgeRole.parcelId);
    assert.equal(selected.ownerAlias,world.parcelById.get(selected.id).ownerAlias);
  }
  assert.equal(JSON.stringify({owners:world.owners,parcels:world.parcels}),before);
});

test('shared packet redacts real participant alias and number while exposing exact route and proposal costs',()=>{
  const participant=validateDemoParticipant({alias:'Secret Judge Name 907',phone:'+14155550134',consent:true}).participant;
  const packet=createHandoff({...input,participant,judgeParcelId:route.parcelIds.at(-1)});
  const json=JSON.stringify(packet);
  assert(!json.includes(participant.alias));assert(!json.includes(participant.phoneE164));assert(!json.includes('14155550134'));
  assert.equal(packet.judgeRole.parcelId,route.parcelIds.at(-1));
  assert.equal(packet.judgeRole.participantReady,true);
  assert.equal(packet.callPreparation.status,'ready-for-host-adapter');
  assert.equal(packet.callPreparation.backendBindingRequired,true);
  assert.equal(packet.callPreparation.contactRegistered,false);
  assert.equal(packet.callPreparation.canStartCall,false);
  const selected=packet.parcelAnalysis.find(row=>row.judgeRole);
  assert.equal(selected.email,null);assert.equal(selected.phoneDisplay,'Private demo participant');
  assert.equal(selected.displayOwnerAlias,'Judge participant');
  assert.equal(packet.parcelAnalysis.reduce((sum,p)=>sum+p.upfrontCents,0),route.costBreakdown.compensationCents);
  assert.equal(packet.parcelAnalysis.reduce((sum,p)=>sum+p.rentTotalCents,0),route.costBreakdown.rentCents);
  const candidate=packet.snapshot.routes[0];
  assert.equal(candidate.totalCostCents,candidate.constructionCents+candidate.upfrontCompensationCents+candidate.recurringRentTotalCents);
  assert.equal(packet.callPreparation.proposedTerms.rentTotalCents,selected.rentTotalCents);
  assert.equal(packet.snapshot.project.revision,0,'offline fixture revisions are not backend revisions');
});

test('synthetic coordinate conversion declares origin, scale and orientation and preserves closed parcel rings',()=>{
  assert.deepEqual(localPointToGeoJSON(0,0),{type:'Point',coordinates:[-120.5,37]});
  const east=localPointToGeoJSON(1,0).coordinates,south=localPointToGeoJSON(0,1).coordinates;
  assert(east[0]>-120.5);assert.equal(east[1],37);assert.equal(south[0],-120.5);assert(south[1]<37);
  assert.equal(DEMO_COORDINATE_TRANSFORM.metersPerTile,100);
  const packet=createHandoff(input);
  assert.equal(packet.snapshot.routes[0].lengthMeters,route.lengthTiles*100);
  for(const parcel of packet.snapshot.parcels){
    assert.equal(parcel.areaSqM,world.parcelById.get(parcel.id).areaTiles*10000);
    for(const ring of parcel.geometry.coordinates)assert.deepEqual(ring[0],ring.at(-1));
  }
  assert.deepEqual(packet.snapshot.project.endpointA.coordinates,packet.snapshot.routes[0].geometry.coordinates[0]);
  assert.deepEqual(packet.snapshot.project.endpointB.coordinates,packet.snapshot.routes[0].geometry.coordinates.at(-1));
  assert.throws(()=>localPointToGeoJSON(Infinity,0),/finite/);
  assert.throws(()=>localPointToGeoJSON(0,1e9),/WGS84/);
});

test('stale route analysis, moved facilities, malformed versions and inconsistent costs block handoff',()=>{
  const badAnalysis=clone(analysis);badAnalysis.parcels[0].upfrontCents++;
  assert.throws(()=>createHandoff({...input,analysis:badAnalysis}),/reconcile/);
  assert.throws(()=>createHandoff({...input,analysis:{...analysis,routeId:'old-route'}}),/match/);
  const badRoute=clone(route);badRoute.totalCostCents++;
  assert.throws(()=>createHandoff({...input,route:badRoute}),/reconcile/);
  const moved=clone(placements);moved.datacenter.connectionPoint.x++;
  assert.throws(()=>createHandoff({...input,placements:moved}),/terminals/);
  assert.throws(()=>createHandoff({...input,routeVersion:0}),/Route version/);
  assert.throws(()=>createHandoff({...input,sessionId:'../unsafe'}),/identifier/);
  assert.throws(()=>createHandoff({...input,budgetCents:NaN}),/safe integer/);
  assert.throws(()=>createHandoff({...input,analysis:{...analysis,parcels:[]}}),/match/);
});

test('offer caps and fictional budget prevent handoff readiness without fabricating approval',()=>{
  const budgetPacket=createHandoff({...input,budgetCents:route.totalCostCents-1});
  assert.equal(budgetPacket.snapshot.routes[0].eligible,false);
  assert.equal(budgetPacket.callPreparation.status,'review-required');
  const ownerParcel=world.parcelById.get(analysis.parcels[0].parcelId);
  const cap=ownerParcel.compensation.offerCapCents;
  try{
    ownerParcel.compensation.offerCapCents=0;
    const updated=analyzeRouteParcels(world,route,result.assumptions);
    const packet=createHandoff({...input,analysis:updated});
    assert.equal(packet.snapshot.routes[0].eligible,false);
    assert.equal(packet.snapshot.routes[0].readyToApprove,false);
    assert.equal(packet.callPreparation.status,'review-required');
  }finally{ownerParcel.compensation.offerCapCents=cap;}
});

test('call requests require explicit backend binding, current versions, consent and idempotency',()=>{
  const bound={projectId:'server-project-01',parcelId:'server-parcel-07',expectedRevision:9,routeVersion:6,
    registeredContactRef:'server-contact-4',participantConsent:true,idempotencyKey:'call-action-018'};
  const request=buildCallSessionRequest(bound);
  assert.deepEqual(request,{schemaVersion:1,projectId:'server-project-01',parcelId:'server-parcel-07',expectedRevision:9,routeVersion:6,
    participantContactRef:'server-contact-4',participantConsent:true,idempotencyKey:'call-action-018'});
  for(const key of Object.keys(bound))assert.throws(()=>buildCallSessionRequest({...bound,[key]:undefined}),undefined,key);
  assert.throws(()=>buildCallSessionRequest({...bound,registeredContactRef:'+14155550134'}),/identifier/);
  assert.throws(()=>buildCallSessionRequest({...bound,participantConsent:false}),/consent/);
  assert.throws(()=>buildCallSessionRequest({...bound,expectedRevision:-1}),/revision/);
});
