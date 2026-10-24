import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {createAnalysisController} from '../src/analysis-controller.js';
import {Snapshot} from '../../../packages/contracts/src/schemas.ts';
import {OwnerHandoff,createVoiceHandoff} from '../../../packages/contracts/src/owner-handoff.ts';

const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const initial=computeTransmissionRoutes(world,placements),route=initial.candidates[0];
const packetInput={world,route,analysis:analyzeRouteParcels(world,route,initial.assumptions),placements,
  sessionId:'stable-role-test',routeVersion:1};
const original=createHandoff(packetInput).userRole;
const rerouted=computeTransmissionRoutes(world,placements,{blockedParcelIds:[original.parcelId]});
assert.equal(rerouted.status,'ok');
const nextRoute=rerouted.candidates[0];
const nextInput={...packetInput,route:nextRoute,analysis:analyzeRouteParcels(world,nextRoute,rerouted.assumptions),routeVersion:2};

test('reroute preserves the historical role and mock recipient without rebinding or offering a new call',()=>{
  const privateParticipant={alias:'Private Participant 400',phoneE164:'+12025550147',consent:true};
  const packet=createHandoff({...nextInput,userParcelId:original.parcelId,participant:privateParticipant});
  assert(!nextRoute.parcelIds.includes(original.parcelId));
  assert.equal(packet.userRole.parcelId,original.parcelId);
  assert.equal(packet.userRole.ownerId,original.ownerId);
  assert.equal(packet.userRole.roleOnRoute,false);
  assert.equal(packet.parcelAnalysis.filter(row=>row.userRole).length,0);
  assert.equal(packet.callPreparation.status,'role-not-on-route');
  assert.equal(packet.callPreparation.proposedTerms,null);
  assert.equal(packet.callPreparation.canStartCall,false);
  assert.equal(packet.ownerHandoff.userRole.parcelId,original.parcelId);
  const historical=packet.ownerHandoff.owners.find(owner=>owner.ownerId===original.ownerId);
  assert.deepEqual(historical.banking,world.ownerById.get(original.ownerId).banking);
  assert.equal(historical.contact.registration,'unregistered');
  assert.equal(historical.contact.callConsent,false);
  assert(!packet.ownerHandoff.parcels.some(parcel=>parcel.parcelId===original.parcelId));
  assert.deepEqual(OwnerHandoff.parse(packet.ownerHandoff),packet.ownerHandoff);
  assert.deepEqual(Snapshot.parse(packet.snapshot),packet.snapshot);
  assert.equal(createVoiceHandoff(packet.ownerHandoff).roleOnRoute,false);
  const json=JSON.stringify(packet);
  assert(!json.includes(privateParticipant.alias));assert(!json.includes(privateParticipant.phoneE164));
  const locked=createHandoff({...nextInput,userParcelId:original.parcelId,liveCallLocked:true});
  assert.equal(locked.callPreparation.status,'refused');
  assert.equal(locked.userRole.liveCallLocked,true);
});

function setup(t){
  const oldDocument=globalThis.document,oldWindow=globalThis.window;
  const nodes=new Map();
  function node(id=''){
    const listeners=new Map(),attributes=new Map(),classes=new Set();
    return {id,children:[],dataset:{},value:'',checked:false,hidden:id==='analysis-panel',disabled:false,
      textContent:'',className:'',classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}},
      setAttribute(name,value){attributes.set(name,String(value));},getAttribute:name=>attributes.get(name),
      addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
      async emit(type){for(const fn of listeners.get(type)??[])await fn({preventDefault(){},stopPropagation(){}});},
      appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;},
      focus(){globalThis.document.activeElement=this;}};
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id);};
  globalThis.document={...node(),querySelector:selector=>get(selector.slice(1)),createElement:()=>node(),activeElement:null};
  globalThis.window={...node(),crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'}};
  t.after(()=>{globalThis.document=oldDocument;globalThis.window=oldWindow;});
  const focused=[];
  const controller=createAnalysisController({world,canvas:get('canvas'),getPlacements:()=>placements,onFocusParcel:id=>focused.push(id)});
  const register=async()=>{
    get('user-alias').value='Private Participant 400';get('user-phone').value='+12025550147';get('user-consent').checked=true;
    await get('user-form').emit('submit');
  };
  return {controller,get,register,focused};
}

test('call lock survives rerouting, participant edits and late callbacks; a new demo gets a new session',async t=>{
  const {controller,get,register,focused}=setup(t);
  controller.setRoute({route,assumptions:initial.assumptions,routeVersion:1});await register();
  const before=controller.getOriginalRole(),sessionId=controller.getSessionId();
  let calls=0,pending,finish;
  controller.setHandoffHandler(request=>{calls++;pending=request;return new Promise(resolve=>finish=resolve);});
  const call=get('agent-call').emit('click');
  assert.equal(calls,1);assert.equal(pending.signal.aborted,false);
  controller.setLiveCallLockout();
  assert.equal(pending.signal.aborted,true);
  finish();await call;
  assert.equal(get('agent-call').disabled,true);assert.equal(get('handoff-status-badge').textContent,'DECLINED');
  assert.throws(()=>controller.setLiveCallLockout(false),/new demo/);
  controller.setRoute(null);
  assert.equal(controller.getOriginalRole().parcelId,before.parcelId);
  controller.setRoute({route:nextRoute,assumptions:rerouted.assumptions,routeVersion:2});
  assert.equal(controller.getHandoff().userRole.parcelId,before.parcelId);
  assert.equal(controller.getOriginalRole().roleOnRoute,false);
  assert.equal(controller.getParcelRole(before.parcelId).ownerAlias,'Private Participant 400');
  await get('focus-user-parcel').emit('click');assert.equal(focused.at(-1),before.parcelId);
  await get('edit-participant').emit('click');await register();
  await get('agent-call').emit('click');assert.equal(calls,1);
  assert.equal(controller.getSessionId(),sessionId);
  controller.resetParticipant();
  assert.equal(controller.getOriginalRole(),null);assert.notEqual(controller.getSessionId(),sessionId);
  assert.equal(controller.getHandoff(),null);
  controller.setRoute({route,assumptions:initial.assumptions,routeVersion:3});await register();
  assert.equal(controller.getOriginalRole().liveCallLocked,false);
  assert.equal(controller.getHandoff().callPreparation.status,'ready-for-host-adapter');
  assert.equal(get('agent-call').disabled,false);
});

test('negotiation display is version-bound, labelled and cannot manufacture accepted handoff terms',async t=>{
  const {controller,get,register}=setup(t);
  controller.setRoute({route,assumptions:initial.assumptions,routeVersion:1});await register();
  const before=JSON.stringify(controller.getHandoff());
  const display={routeVersion:1,outcomes:route.parcelIds.map(parcelId=>({parcelId,outcome:'accepted',sourceMode:'mock'}))};
  assert.equal(controller.setNegotiationDisplay(display),true);
  assert.equal(get('analysis-negotiation').textContent,'Accepted · simulated');
  assert.equal(get('analysis-consent-note').textContent,'0 pending');
  assert.equal(JSON.stringify(controller.getHandoff()),before);
  assert(controller.getHandoff().ownerHandoff.parcels.every(parcel=>parcel.terms.outcome==='pending'));
  assert.equal(controller.setNegotiationDisplay({...display,routeVersion:99}),false);
  assert.throws(()=>controller.setNegotiationDisplay({routeVersion:1,outcomes:[{parcelId:'missing',outcome:'accepted',sourceMode:'mock'}]}),/Invalid negotiation display/);
  display.outcomes[0].outcome='refused';
  assert.equal(get('analysis-consent-note').textContent,'0 pending');
  controller.setRoute({route:nextRoute,assumptions:rerouted.assumptions,routeVersion:2});
  assert.equal(get('analysis-negotiation').textContent,'Pending');
  assert.equal(get('analysis-consent-note').textContent,`${nextRoute.parcelIds.length} pending`);
  assert.equal(controller.setNegotiationDisplay(null),true);
});
