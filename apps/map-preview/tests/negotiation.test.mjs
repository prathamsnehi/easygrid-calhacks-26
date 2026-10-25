import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world.js';
import { createPlacement } from '../src/placement.js';
import { computeTransmissionRoutes } from '../src/routing.js';
import { analyzeRouteParcels } from '../src/parcel-analysis.js';
import { createHandoff, localPointToGeoJSON } from '../src/handoff.js';
import { createNegotiationController } from '../src/negotiation-controller.js';
import { createMapNegotiationUpdate } from '../../../packages/contracts/src/map-negotiation.ts';

const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const baseline=computeTransmissionRoutes(world,placements);
const route=baseline.candidates.find(c=>c.id===baseline.recommendedId);
const participant={alias:'Private tester',phoneE164:'+12025550147',consent:true};
function packet(routeResult=baseline,{version=1,userParcelId,sessionId='post-call-test',liveCallLocked=false}={}){
  const selected=routeResult.candidates.find(c=>c.id===routeResult.recommendedId);
  return createHandoff({world,placements,route:selected,analysis:analyzeRouteParcels(world,selected,routeResult.assumptions),
    participant,sessionId,routeVersion:version,userParcelId,liveCallLocked});
}
const initial=packet(),original=initial.userRole.parcelId;
let bypass;
function bypassPacket(){
  bypass??=computeTransmissionRoutes(world,placements,{blockedParcelIds:[original]});
  return packet(bypass,{version:2,userParcelId:original,liveCallLocked:true});
}
function harness({onNextOwner=()=>false}={}){
  let handoff=structuredClone(initial),session=handoff.sessionId,invalidations=0,locks=0;
  const requests=[],states=[],tasks=new Map();let sequence=0;
  const controller=createNegotiationController({world,getHandoff:()=>handoff,getSessionId:()=>session,
    onReroute:options=>requests.push(options),onChange:state=>states.push(state),
    invalidateApproval:()=>invalidations++,lockLiveCall:()=>locks++,onNextOwner,
    scheduleTask:fn=>{const id=++sequence;tasks.set(id,fn);return id;},cancelTask:id=>tasks.delete(id)});
  function update(overrides={}){
    const p=handoff.ownerHandoff.parcels.find(p=>p.parcelId===handoff.userRole.parcelId);
    return {schemaVersion:1,kind:'easygrid-map-negotiation',eventId:'verified-event-1',mapBinding:controller.getBinding(),
      parcelId:p.parcelId,sourceMode:'live',outcome:'refused',accessConsent:'refused',explicitConfirmation:true,
      evidenceRefs:['provider:verified-utterance-1'],termsVersion:1,hasUnresolvedConditions:false,
      terms:{upfrontCents:p.terms.compensationCents,depositCents:0,depositCreditPolicy:'credited_to_upfront',monthlyRentCents:p.terms.monthlyRentCents,termMonths:12},...overrides};
  }
  return {controller,requests,states,update,get invalidations(){return invalidations;},get locks(){return locks;},
    setHandoff(value){handoff=value;controller.routeChanged();},
    reset(){session='next-demo';handoff=null;controller.reset();},
    flush(){for(const [id,fn] of [...tasks]){tasks.delete(id);fn();}}};
}

test('confirmed refusal reroutes, preserves exclusion, then simulates every other final-route owner',()=>{
  const h=harness(),event=h.update();
  assert.deepEqual(h.controller.applyUpdate(event),{status:'applied',rerouteNeeded:true});
  assert.equal(h.locks,1);assert.equal(h.invalidations,1);
  assert.deepEqual(h.requests[0].blockedParcelIds,[original]);
  h.setHandoff(null);assert.equal(h.controller.getState().phase,'rerouting');
  h.setHandoff(bypassPacket());assert.equal(h.controller.getState().phase,'negotiating');
  assert.equal(h.controller.getAgreement(),null);h.flush();
  const state=h.controller.getState(),agreed=h.controller.getAgreement();
  assert.equal(state.phase,'confirmed');assert.equal(state.simulated,true);
  assert(!state.next.parcelIds.includes(original));assert(state.previous.parcelIds.includes(original));
  assert.equal(state.costDeltaCents,state.next.totalCostCents-state.previous.totalCostCents);
  assert.equal(agreed.negotiations.length,state.next.parcelIds.length);
  assert(agreed.negotiations.every(n=>n.sourceMode==='mock'&&n.explicitConfirmation&&n.outcome==='accepted'));
  assert.equal(agreed.ownerHandoff.userRole.parcelId,original);
  assert.equal(agreed.ownerHandoff.referenceBinding,'local-fixture');
  assert(!JSON.stringify(state).includes(participant.alias));assert(!JSON.stringify(agreed).includes(participant.phoneE164));
  assert.deepEqual(h.controller.applyUpdate(event),{status:'duplicate'},'redelivery after route change must replay');
  assert.equal(h.requests.length,1);
  assert.throws(()=>h.controller.applyUpdate({...event,sourceMode:'mock'}),/Conflicting/);
  assert.deepEqual(h.controller.getRoutingOptions().blockedParcelIds,[original]);
});

test('refusal is allowed before pricing review but replacement agreement still requires eligibility',()=>{
  const h=harness(),unpriced=structuredClone(initial);
  unpriced.snapshot.routes[0].eligible=false;
  h.setHandoff(unpriced);
  assert.equal(h.controller.runRefusalDemo().rerouteNeeded,true);
  assert.deepEqual(h.requests[0].blockedParcelIds,[original]);
  const unpricedReplacement=bypassPacket();
  unpricedReplacement.snapshot.routes[0].eligible=false;
  h.setHandoff(unpricedReplacement);h.flush();
  assert.equal(h.controller.getState().phase,'review_required');
  assert.equal(h.controller.getAgreement(),null);
});

test('unverified refusal, stale route, wrong parcel and raw transcript are rejected without side effects',()=>{
  for(const modify of [e=>({...e,explicitConfirmation:false}),e=>({...e,evidenceRefs:[]}),
    e=>({...e,mapBinding:{...e.mapBinding,routeVersion:9}}),e=>({...e,parcelId:'not-on-route'}),
    e=>({...e,transcript:'private content'}),e=>({...e,terms:{...e.terms,upfrontCents:1.1}})]){
    const h=harness();assert.throws(()=>h.controller.applyUpdate(modify(h.update())));
    assert.equal(h.requests.length,0);assert.equal(h.locks,0);assert.equal(h.invalidations,0);
  }
});

test('call pending, ambiguous conditions and monetary counteroffers do not imply refusal or agreement',()=>{
  for(const outcome of ['pending','review_required','counteroffer']){
    const h=harness();h.controller.applyUpdate(h.update({outcome,accessConsent:'unknown',explicitConfirmation:false,hasUnresolvedConditions:true}));
    assert.equal(h.requests.length,0);assert.equal(h.locks,0);assert.equal(h.controller.getAgreement(),null);
    assert.equal(h.controller.getState().phase,'review_required');
  }
  const h=harness();assert.throws(()=>h.controller.applyUpdate(h.update({outcome:'accepted',accessConsent:'allowed',hasUnresolvedConditions:true})),/confirmed amounts/);
});

test('verified exclusion polygon uses declared geographic transform and malformed geometry cannot partially commit',()=>{
  const h=harness(),p=world.parcelById.get(original),ring=p.geometry.rings[0];
  const xs=ring.map(p=>p[0]),zs=ring.map(p=>p[1]),x=(Math.min(...xs)+Math.max(...xs))/2,z=(Math.min(...zs)+Math.max(...zs))/2;
  const local=[[x-.2,z-.2],[x+.2,z-.2],[x+.2,z+.2],[x-.2,z+.2],[x-.2,z-.2]];
  const event=h.update({outcome:'counteroffer',accessConsent:'unknown',explicitConfirmation:false,
    exclusionGeometry:{type:'Polygon',coordinates:[local.map(([x,z])=>localPointToGeoJSON(x,z).coordinates)]}});
  h.controller.applyUpdate(event);assert.equal(h.requests.length,1);assert.equal(h.locks,0);
  assert.equal(h.requests[0].exclusionZones[0].parcelId,original);
  assert(Math.abs(h.requests[0].exclusionZones[0].ring[0][0]-local[0][0])<1e-7);
  const bad=harness();assert.throws(()=>bad.controller.applyUpdate({...event,mapBinding:bad.controller.getBinding(),
    exclusionGeometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}));
  assert.equal(bad.requests.length,0);assert.equal(bad.invalidations,0);
});

test('no feasible route, edited route, and new session never preserve a completed agreement',()=>{
  const h=harness(),old=h.update();h.controller.applyUpdate(old);h.setHandoff(null);h.controller.noRoute();
  assert.equal(h.controller.getState().phase,'no_route');assert.equal(h.controller.getAgreement(),null);
  assert.deepEqual(h.controller.getRoutingOptions().blockedParcelIds,[original]);
  h.reset();assert.deepEqual(h.controller.getRoutingOptions().blockedParcelIds,[]);
  assert.throws(()=>h.controller.applyUpdate(old),/Stale/);
  const next=harness();next.controller.runRefusalDemo();next.setHandoff(bypassPacket());
  next.setHandoff(null);next.flush();assert.equal(next.controller.getAgreement(),null);
});

test('host subscription binds current proposal, aborts old delivery, and reports unavailable state',async()=>{
  const h=harness(),streams=[];let cleaned=0;
  h.controller.setSource(stream=>{streams.push(stream);stream.onReady();return ()=>cleaned++;});
  await Promise.resolve();assert.equal(h.controller.getState().connected,true);
  assert.throws(()=>h.controller.runRefusalDemo(),/current demo route/,'no mock injection while live source connected');
  const old=streams[0],event=h.update();h.setHandoff(bypassPacket());await Promise.resolve();
  assert.equal(old.signal.aborted,true);assert.equal(cleaned,1);
  assert.deepEqual(old.onUpdate(event),{status:'ignored'});assert.equal(h.requests.length,0);
  streams[1].onUnavailable();assert.equal(h.controller.getState().connected,false);assert.equal(h.invalidations,1);
  h.reset();assert.equal(streams[1].signal.aborted,true);
});

test('reordered older terms and invalid credited deposits cannot replace the current outcome',()=>{
  const h=harness(),latest=h.update({eventId:'terms-5',termsVersion:5,outcome:'counteroffer',accessConsent:'unknown',explicitConfirmation:false});
  h.controller.applyUpdate(latest);
  assert.deepEqual(h.controller.applyUpdate(Object.fromEntries(Object.entries(latest).reverse())),{status:'duplicate'});
  assert.throws(()=>h.controller.applyUpdate(h.update({eventId:'terms-2',termsVersion:2})),/stale/);
  assert.equal(h.requests.length,0);assert.equal(h.locks,0);
  const next=harness(),invalid=next.update();invalid.terms.depositCents=invalid.terms.upfrontCents+1;
  assert.throws(()=>next.controller.applyUpdate(invalid),/Invalid negotiation terms/);
});

test('throwing source cleanup cannot prevent session reset or cancellation',async()=>{
  const h=harness();let stream;
  h.controller.setSource(value=>{stream=value;return ()=>{throw new Error('cleanup failed');};});
  await Promise.resolve();assert.doesNotThrow(()=>h.reset());
  assert.equal(stream.signal.aborted,true);assert.equal(h.controller.getState().sessionId,'next-demo');
  assert.deepEqual(h.controller.getRoutingOptions().blockedParcelIds,[]);
});

test('shared server helper maps distinct canonical call IDs into the actual map consumer',()=>{
  const h=harness(),local=h.update();
  const binding={projectId:'server-project',callSessionId:'server-call',parcelId:'server-parcel',
    routeVersion:17,termsVersion:3,localParcelId:original};
  const result={schemaVersion:1,sourceMode:'live',id:'saved-refusal',projectId:binding.projectId,
    sessionId:binding.callSessionId,parcelId:binding.parcelId,routeVersion:17,termsVersion:3,
    ...local.terms,outcome:'refused',accessConsent:'refused',explicitConfirmation:true,
    conditions:['No passage through this parcel.'],evidenceRefs:['provider:confirmed-utterance']};
  const projection=createMapNegotiationUpdate({handoff:initial,result,binding,confirmationVerified:true});
  assert.equal(projection.parcelId,original);assert.equal(projection.mapBinding.routeVersion,1);
  assert.equal(projection.conditions,undefined);
  assert.deepEqual(h.controller.applyUpdate(projection),{status:'applied',rerouteNeeded:true});
  assert.deepEqual(h.requests[0].blockedParcelIds,[original]);
});

test('recalculation after a refusal reconfirms new simulated terms without reopening a live call',()=>{
  const h=harness();h.controller.runRefusalDemo();h.setHandoff(bypassPacket());h.flush();
  assert.equal(h.controller.getState().phase,'confirmed');
  h.setHandoff(null);const revised=packet(bypass,{version:3,userParcelId:original,liveCallLocked:true});
  h.setHandoff(revised);assert.equal(h.controller.getState().phase,'negotiating');assert.equal(h.controller.getAgreement(),null);
  h.flush();assert.equal(h.controller.getAgreement().ownerHandoff.routeVersion,3);
  assert.equal(h.controller.getState().previous,null,'manual edits do not keep a misleading old-route comparison');
  assert.deepEqual(h.controller.getRoutingOptions().blockedParcelIds,[original]);assert.equal(h.locks,1);
});

test('simulated approval accepts only the original call target without rerouting or claiming all-owner agreement',()=>{
  const h=harness(),beforeBinding=h.controller.getBinding(),beforeOptions=h.controller.getRoutingOptions();
  const initialCopy=structuredClone(initial);
  assert.deepEqual(h.controller.runApprovalDemo(),{status:'applied',rerouteNeeded:false});
  const state=h.controller.getState();
  assert.equal(state.phase,'approved');assert.equal(state.reason,'Current landowner approved · simulated');
  assert.equal(state.simulated,true);
  assert.deepEqual(state.outcomes,[{parcelId:original,outcome:'accepted',sourceMode:'mock'}]);
  assert.deepEqual(h.controller.getBinding(),beforeBinding,'approval preserves the original route binding');
  assert.deepEqual(h.controller.getRoutingOptions(),beforeOptions,'approval adds no refusal or spatial constraints');
  assert.equal(h.requests.length,0);assert.equal(h.locks,0);assert.equal(h.invalidations,1);
  assert.equal(state.previous,null);assert.equal(state.next,null);
  assert.equal(state.agreementReady,false);assert.equal(h.controller.getAgreement(),null,'one owner is not an all-route agreement');
  h.flush();assert.equal(h.controller.getAgreement(),null,'approval schedules no hidden all-owner signing');
  assert.deepEqual(initial,initialCopy,'the original fixture and route are not changed');
  for(const secret of [participant.alias,participant.phoneE164])assert(!JSON.stringify(state).includes(secret));
});

test('repeating simulated approval is idempotent for the current binding and performs no hidden follow-up',()=>{
  const h=harness();h.controller.runApprovalDemo();
  const state=h.controller.getState(),emissions=h.states.length;
  assert.deepEqual(h.controller.runApprovalDemo(),{status:'duplicate',rerouteNeeded:false});
  assert.deepEqual(h.controller.getState(),state);
  assert.equal(h.states.length,emissions,'retrying contract preparation does not emit a second approval');
  assert.equal(h.invalidations,1);assert.equal(h.requests.length,0);assert.equal(h.locks,0);
});

test('approval demo rejects missing, ineligible, locked, off-route or host-owned targets before side effects',()=>{
  const mutate=[
    h=>h.setHandoff(null),
    h=>{const packet=structuredClone(initial);packet.snapshot.routes[0].eligible=false;h.setHandoff(packet);},
    h=>{const packet=structuredClone(initial);packet.userRole.liveCallLocked=true;h.setHandoff(packet);},
    h=>{const packet=structuredClone(initial);packet.userRole.roleOnRoute=false;packet.snapshot.routes[0].parcelIds=packet.snapshot.routes[0].parcelIds.filter(id=>id!==original);h.setHandoff(packet);},
    h=>{const packet=structuredClone(initial);packet.ownerHandoff.parcels=packet.ownerHandoff.parcels.filter(parcel=>parcel.parcelId!==original);h.setHandoff(packet);},
    h=>h.controller.setSource(()=>{}),
    h=>h.controller.setSource(stream=>stream.onReady()),
    h=>h.controller.setSource(stream=>stream.onUnavailable()),
    h=>{h.controller.runApprovalDemo();h.controller.setSource(()=>{});},
  ];
  for(const setup of mutate){
    const h=harness();assert.equal(typeof h.controller.runApprovalDemo,'function');setup(h);const invalidations=h.invalidations,state=h.controller.getState();
    assert.throws(()=>h.controller.runApprovalDemo());
    assert.equal(h.invalidations,invalidations);assert.equal(h.requests.length,0);assert.equal(h.locks,0);
    assert.deepEqual(h.controller.getState(),state);assert.equal(h.controller.getAgreement(),null);
  }
});

test('approval demo cannot replace an in-progress result and old approval evidence does not survive route changes',()=>{
  for(const outcome of ['pending','counteroffer','refused']){
    const h=harness();
    h.controller.applyUpdate(h.update(outcome==='refused'?{}:{outcome,accessConsent:'unknown',explicitConfirmation:false,hasUnresolvedConditions:true}));
    const state=h.controller.getState(),invalidations=h.invalidations,requests=h.requests.length;
    assert.throws(()=>h.controller.runApprovalDemo());
    assert.deepEqual(h.controller.getState(),state);assert.equal(h.invalidations,invalidations);assert.equal(h.requests.length,requests);
  }
  const h=harness(),old=h.update({eventId:'old-approved-evidence',outcome:'accepted',accessConsent:'allowed'});
  h.controller.runApprovalDemo();
  h.setHandoff(packet(baseline,{version:2,userParcelId:original}));
  assert.equal(h.controller.getState().phase,'idle');assert.deepEqual(h.controller.getState().outcomes,[]);
  assert.equal(h.controller.getAgreement(),null);
  assert.throws(()=>h.controller.applyUpdate(old),/Stale/);
  assert.deepEqual(h.controller.runApprovalDemo(),{status:'applied',rerouteNeeded:false});
  assert.equal(h.controller.getState().phase,'approved');assert.equal(h.requests.length,0);
  h.reset();assert.throws(()=>h.controller.runApprovalDemo());assert.equal(h.controller.getState().phase,'idle');
});

test('saved live outcomes reuse approval and refusal behavior with live provenance and no second call',()=>{
  const accepted=harness(),p=initial.ownerHandoff.parcels.find(p=>p.parcelId===original);
  const event={kind:'easygrid-voice-result',saved:true,mode:'live',attemptId:'voice-attempt',eventId:'voice-accepted',
    mapBinding:accepted.controller.getBinding(),localParcelId:original,outcome:'accepted',acceptedCompensationCents:p.offerPolicy.recommendedOfferCents,monthlyRentCents:0,termsVersion:p.terms.termsVersion};
  accepted.controller.applySavedVoiceResult(event);
  assert.equal(accepted.controller.getState().phase,'approved');assert.equal(accepted.controller.getState().simulated,false);
  assert.equal(accepted.controller.getState().outcomes[0].sourceMode,'live');assert.equal(accepted.requests.length,0);
  assert.equal(accepted.controller.applySavedVoiceResult(event).status,'duplicate');assert.equal(accepted.invalidations,1);
  const nextTargets=[];
  const refused=harness({onNextOwner:ids=>{nextTargets.push(ids);return true;}});
  refused.controller.applySavedVoiceResult({...event,eventId:'voice-refused',mapBinding:refused.controller.getBinding(),outcome:'refused'});
  assert.deepEqual(refused.requests[0].blockedParcelIds,[original]);assert.equal(refused.locks,0);
  refused.setHandoff(bypassPacket());refused.flush();
  assert.equal(refused.controller.getState().phase,'awaiting_owners');
  assert.equal(refused.controller.getAgreement(),null,'a live disagreement waits for the next owner instead of simulating one');
  assert.deepEqual(nextTargets,[[original]]);
  const review=harness();review.controller.applySavedVoiceResult({...event,eventId:'voice-review',mapBinding:review.controller.getBinding(),outcome:'review_required'});
  assert.equal(review.requests.length,0);assert.equal(review.controller.getState().phase,'review_required');assert.equal(review.controller.getAgreement(),null);
});
