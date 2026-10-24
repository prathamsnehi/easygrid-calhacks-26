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
function harness(){
  let handoff=structuredClone(initial),session=handoff.sessionId,invalidations=0,locks=0;
  const requests=[],states=[],tasks=new Map();let sequence=0;
  const controller=createNegotiationController({world,getHandoff:()=>handoff,getSessionId:()=>session,
    onReroute:options=>requests.push(options),onChange:state=>states.push(state),
    invalidateApproval:()=>invalidations++,lockLiveCall:()=>locks++,
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
  assert.throws(()=>h.controller.runRefusalDemo(),/eligible demo/,'no mock injection while live source connected');
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
