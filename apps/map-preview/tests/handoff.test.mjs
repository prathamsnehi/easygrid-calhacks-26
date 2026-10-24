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

test('participant setup requires a name, supported phone and explicit roleplay consent',()=>{
  const accepted=validateDemoParticipant({alias:'  Test participant  ',phone:'+1 (415) 555-0134',consent:true});
  assert.equal(accepted.valid,true);
  assert.deepEqual(accepted.participant,{alias:'Test participant',phoneE164:'+14155550134',consent:true});
  for(const alias of ['', '   ', null])assert.equal(validateDemoParticipant({alias,phone:'+14155550134',consent:true}).valid,false);
  for(const phone of ['', '5550134','415555013','41555501345','24155550134','+0123456789','+14155550134 ext 5','++14155550134','+1234567','+1234567890123456']){
    assert.equal(validateDemoParticipant({alias:'Test participant',phone,consent:true}).valid,false,phone);
  }
  for(const consent of [false,undefined,'true',1])assert.equal(validateDemoParticipant({alias:'Test participant',phone:'+14155550134',consent}).valid,false);
  assert.equal(validateDemoParticipant({alias:'A\nB',phone:'+14155550134',consent:true}).valid,false);
  assert.equal(validateDemoParticipant({alias:'x'.repeat(81),phone:'+14155550134',consent:true}).valid,false);
});

test('US national phone inputs normalize to +1 while explicit international prefixes are preserved',()=>{
  const cases=[
    ['4155550134','+14155550134'],['(415) 555-0134','+14155550134'],
    [' 415.555.0134 ','+14155550134'],['1 (415) 555-0134','+14155550134'],
    ['+1 415 555 0134','+14155550134'],['+82 10 0000 0000','+821000000000'],
    ['+44 7700 900123','+447700900123'],
  ];
  for(const [phone,expected] of cases){
    const result=validateDemoParticipant({alias:'Test participant',phone,consent:true});
    assert.equal(result.valid,true,phone);
    assert.equal(result.participant.phoneE164,expected,phone);
    assert.equal(validateDemoParticipant({alias:'Test participant',phone:expected,consent:true}).participant.phoneE164,expected);
  }
});

test('an unassigned session receives one in-route user role without changing fixture owners',()=>{
  const before=JSON.stringify({owners:world.owners,parcels:world.parcels});
  for(const candidate of result.candidates){
    const nextAnalysis=analyzeRouteParcels(world,candidate,result.assumptions);
    const packet=createHandoff({...input,route:candidate,analysis:nextAnalysis});
    assert.equal(packet.schemaVersion,2);
    assert.equal(packet.snapshot.project.schemaVersion,1);
    assert.doesNotMatch(JSON.stringify(packet),/judge/i);
    assert(candidate.parcelIds.includes(packet.userRole.parcelId));
    assert.equal(packet.userRole.participantContactRef,`${input.sessionId}:user`);
    assert.equal(packet.parcelAnalysis.filter(row=>row.userRole).length,1);
    assert.equal(packet.userRole.participantReady,false);
    assert.equal(packet.callPreparation.status,'participant-required');
    assert.equal(packet.callPreparation.canStartCall,false);
    assert.equal(packet.snapshot.routes[0].readyToApprove,false);
    assert(packet.snapshot.parcels.every(parcel=>parcel.accessConsent==='unknown'));
    const selected=packet.snapshot.parcels.find(parcel=>parcel.id===packet.userRole.parcelId);
    assert.equal(selected.ownerAlias,world.parcelById.get(selected.id).ownerAlias);
  }
  assert.equal(JSON.stringify({owners:world.owners,parcels:world.parcels}),before);
  assert.throws(()=>createHandoff({...input,userParcelId:'not-on-route'}),/existing fictional parcel/);
});

test('shared packet redacts real participant alias and number while exposing exact route and proposal costs',()=>{
  const participant=validateDemoParticipant({alias:'Secret User Name 907',phone:'+14155550134',consent:true}).participant;
  const packet=createHandoff({...input,participant,userParcelId:route.parcelIds.at(-1)});
  const json=JSON.stringify(packet);
  assert(!json.includes(participant.alias));assert(!json.includes(participant.phoneE164));assert(!json.includes('14155550134'));
  assert.equal(packet.userRole.parcelId,route.parcelIds.at(-1));
  assert.equal(packet.userRole.participantReady,true);
  assert.equal(packet.callPreparation.status,'ready-for-host-adapter');
  assert.equal(packet.callPreparation.backendBindingRequired,true);
  assert.equal(packet.callPreparation.contactRegistered,false);
  assert.equal(packet.callPreparation.canStartCall,false);
  const selected=packet.parcelAnalysis.find(row=>row.userRole);
  assert.equal(selected.email,null);assert.equal(selected.phoneDisplay,'Private demo participant');
  assert.equal(selected.displayOwnerAlias,'User participant');
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
  assert.equal(DEMO_COORDINATE_TRANSFORM.metersPerTile,25);
  assert.equal(DEMO_COORDINATE_TRANSFORM.id,'california-valley-synthetic-wgs84-v2');
  const packet=createHandoff(input);
  assert.equal(packet.snapshot.routes[0].lengthMeters,route.lengthTiles*25);
  for(const parcel of packet.snapshot.parcels){
    assert.equal(parcel.areaSqM,world.parcelById.get(parcel.id).areaTiles*625);
    for(const ring of parcel.geometry.coordinates)assert.deepEqual(ring[0],ring.at(-1));
  }
  assert.deepEqual(packet.snapshot.project.endpointA.coordinates,packet.snapshot.routes[0].geometry.coordinates[0]);
  assert.deepEqual(packet.snapshot.project.endpointB.coordinates,packet.snapshot.routes[0].geometry.coordinates.at(-1));
  assert.throws(()=>localPointToGeoJSON(Infinity,0),/finite/);
  assert.throws(()=>localPointToGeoJSON(0,1e9),/WGS84/);
});

test('handoff records the effective construction rates when an integration overrides the defaults',()=>{
  const custom=computeTransmissionRoutes(world,placements,{rates:{towerCents:1}});
  const customRoute=custom.candidates[0];
  const packet=createHandoff({...input,route:customRoute,analysis:analyzeRouteParcels(world,customRoute,custom.assumptions)});
  assert.equal(packet.costModel.towerCents,1);
  assert.equal(packet.costModel.effectiveRates.towerCents,1);
  assert.equal(packet.costModel.rateSource,'custom-demo-rates');
  assert.deepEqual(packet.costModel.rateOverrides,['towerCents']);
  assert.equal(customRoute.costBreakdown.towerCents,customRoute.metrics.towerCount);
  packet.costModel.effectiveRates.towerCents=2;
  assert.equal(customRoute.costModel.effectiveRates.towerCents,1,'handoff metadata is an independent snapshot');
  const standard=createHandoff(input);
  assert.equal(standard.costModel.rateSource,'miso-benchmark-with-demo-allowances');
  assert.equal(standard.ownerHandoff.constructionCents,route.totalCostCents-route.costBreakdown.compensationCents-route.costBreakdown.rentCents);
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

test('route-specific caps and fictional budget are validated without fabricating approval',()=>{
  const budgetPacket=createHandoff({...input,budgetCents:route.totalCostCents-1});
  assert.equal(budgetPacket.snapshot.routes[0].eligible,false);
  assert.equal(budgetPacket.callPreparation.status,'review-required');
  const changed=clone(analysis);changed.parcels[0].offerCapCents++;
  assert.throws(()=>createHandoff({...input,analysis:changed}),/offer-cap/);
  const packet=createHandoff(input);
  for(const row of packet.parcelAnalysis){
    assert.equal(row.recommendedOfferCents,row.upfrontCents);
    assert.equal(row.offerCapCents,Number(BigInt(row.recommendedOfferCents)*6n/5n));
    const shared=packet.ownerHandoff.parcels.find(p=>p.parcelId===row.parcelId);
    assert.equal(shared.offerCapCents,row.offerCapCents);
    assert.equal(shared.offerPolicy.recommendedOfferCents,row.recommendedOfferCents);
    assert.equal(shared.terms.compensationCents,row.recommendedOfferCents);
    assert.equal(packet.snapshot.parcels.find(p=>p.id===row.parcelId).offerCapCents,row.offerCapCents);
  }
  assert.equal(packet.callPreparation.proposedTerms.offerPolicy.recommendedOfferCents,packet.callPreparation.proposedTerms.upfrontCents);
  assert.equal(packet.snapshot.routes[0].readyToApprove,false);
});

test('corridor-only impact blocks readiness and cannot be relabeled as a completed valuation',()=>{
  const corridorPlacements={substation,datacenter:createPlacement(world,'datacenter',43,35,{substation})};
  const corridorResult=computeTransmissionRoutes(world,corridorPlacements);
  assert.equal(corridorResult.status,'ok');
  const corridorRoute=corridorResult.candidates.find(candidate=>candidate.id==='low-impact');
  assert(corridorRoute);
  const corridorAnalysis=analyzeRouteParcels(world,corridorRoute,corridorResult.assumptions);
  const parcel=corridorAnalysis.parcels.find(row=>row.parcelId==='L008');
  assert(parcel);
  assert.equal(parcel.lineLengthTiles,0);assert.equal(parcel.towerCount,0);
  assert.equal(parcel.corridorOnly,true);assert.equal(parcel.recommendationStatus,'review-required');
  const corridorInput={...input,placements:corridorPlacements,route:corridorRoute,analysis:corridorAnalysis};
  const packet=createHandoff(corridorInput);
  assert.equal(packet.snapshot.routes[0].eligible,false);
  assert.equal(packet.ownerHandoff.simulationChecksPassed,false);
  assert.equal(packet.callPreparation.status,'review-required');
  for(const changes of [
    {corridorOnly:false},
    {recommendationStatus:'estimated'},
    {corridorOnly:false,recommendationStatus:'estimated'},
  ]){
    const changed=clone(corridorAnalysis);
    Object.assign(changed.parcels.find(row=>row.parcelId===parcel.parcelId),changes);
    assert.throws(()=>createHandoff({...corridorInput,analysis:changed}),/recommendation status/);
  }
  for(const towerCount of [-1,.5,NaN,undefined]){
    const changed=clone(corridorAnalysis);
    changed.parcels.find(row=>row.parcelId===parcel.parcelId).towerCount=towerCount;
    assert.throws(()=>createHandoff({...corridorInput,analysis:changed}),/tower count/);
  }
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
