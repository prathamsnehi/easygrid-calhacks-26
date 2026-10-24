import test from 'node:test';
import assert from 'node:assert/strict';
import {createNegotiationResultController} from '../src/negotiation-result-controller.js';
import {settlementBinding} from '../src/settlement-controller.js';
const handoff=()=>({sessionId:'map-session',routeVersion:1,snapshot:{routes:[{id:'route'}]},
  ownerHandoff:{routeId:'route',parcels:[{parcelId:'parcel'}]},coordinateTransform:{},costModel:{}});
function setup(){
  let h=handoff(),callbacks,cleanups=0;
  const states=[],controller=createNegotiationResultController({getHandoff:()=>h,onChange:s=>states.push(s)});
  controller.setSource(args=>{callbacks=args;args.onReady();return()=>cleanups++;});
  return {controller,states,get callbacks(){return callbacks;},get cleanups(){return cleanups;},setHandoff:next=>h=next};
}
const update=(extra={})=>({schemaVersion:1,kind:'easygrid-negotiation-result',eventId:'saved-1',revision:2,saved:true,
  mapBinding:settlementBinding(handoff()),localParcelId:'parcel',mode:'live',phase:'confirming',summary:null,...extra});
const summary=(extra={})=>({attemptId:'attempt',mode:'live',disposition:'unsuccessful',reason:'PRICE_REJECTED',outcome:'refused',
  nextAction:'stop',explanation:'Owner requested $15,000; our final offer was $12,000. Price too high.',...extra});

test('saved final result retains factual details and survives source reconnect without rerouting',async()=>{
  const s=setup();s.callbacks.onUpdate(update());
  assert.equal(s.controller.getState().view.phase,'confirming');
  s.callbacks.onUpdate(update({eventId:'saved-2',revision:3,phase:'finished',summary:summary()}));
  assert.equal(s.controller.getState().view.summary.explanation,summary().explanation);
  assert(s.controller.getState().terminal);
  s.controller.routeChanged();await Promise.resolve();assert.equal(s.controller.getState().view.summary.explanation,summary().explanation);
  assert(s.cleanups>=1);assert(!JSON.stringify(s.controller.getState()).includes('rerout'));
});
test('initial subscription snapshot restores a saved result into a fresh controller',()=>{
  const controller=createNegotiationResultController({getHandoff:handoff});
  controller.setSource(({onUpdate})=>{onUpdate(update({phase:'finished',summary:summary()}));});
  assert.equal(controller.getState().view.summary.disposition,'unsuccessful');
});
test('stale session/proposal callbacks and updates after New Demo are ignored',()=>{
  const s=setup(),previous=s.callbacks;
  s.setHandoff({...handoff(),sessionId:'new-demo'});s.controller.routeChanged();
  assert.equal(previous.onUpdate(update()).status,'ignored');
  assert.equal(s.callbacks.onUpdate(update()).status,'ignored');
  assert.equal(s.controller.getState().view,null);
  s.controller.reset();assert.equal(s.callbacks.onUpdate(update()).status,'ignored');
});
test('duplicate delivery is harmless, conflicting delivery fails, earlier revision cannot replace final',()=>{
  const s=setup(),final=update({phase:'finished',summary:summary()});
  assert.equal(s.callbacks.onUpdate(final).status,'applied');
  assert.equal(s.callbacks.onUpdate(final).status,'duplicate');
  assert.throws(()=>s.callbacks.onUpdate({...final,summary:summary({explanation:'Changed'})}),/Conflicting/);
  assert.equal(s.callbacks.onUpdate(update({eventId:'old',revision:1})).status,'ignored');
  assert.equal(s.controller.getState().view.phase,'finished');
});
test('simulation cannot overwrite an uncertain live outcome',()=>{
  const s=setup();s.callbacks.onUpdate(update());
  assert.throws(()=>s.callbacks.onUpdate(update({eventId:'simulation',revision:3,mode:'simulated'})),/simulation/);
});
test('unsaved/invalid summaries cannot claim success, outage stays separate from last saved result',()=>{
  const s=setup();assert.throws(()=>s.callbacks.onUpdate(update({saved:false})),/Invalid/);
  assert.throws(()=>s.callbacks.onUpdate(update({phase:'finished',summary:summary({disposition:'successful'})})),/Invalid terminal/);
  s.callbacks.onUpdate(update({phase:'finished',summary:summary()}));s.callbacks.onUnavailable();
  assert(s.controller.getState().unavailable);assert.equal(s.controller.getState().view.summary.reason,'PRICE_REJECTED');
});
test('source cleanup arriving late is still called and cannot resurrect a closed session',async()=>{
  let resolve,cleanups=0;
  const controller=createNegotiationResultController({getHandoff:handoff});
  controller.setSource(()=>new Promise(r=>resolve=r));controller.reset();resolve(()=>cleanups++);
  await Promise.resolve();assert.equal(cleanups,1);assert.equal(controller.getState().view,null);
});

test('New Demo retains the host factory but clears the old saved result and subscription',()=>{
  const s=setup(),old=s.callbacks;
  s.callbacks.onUpdate(update({phase:'finished',summary:summary()}));
  s.controller.reset();assert.equal(s.controller.getState().view,null);assert(s.controller.getState().installed);
  s.setHandoff({...handoff(),sessionId:'second-demo'});s.controller.routeChanged();
  assert.notEqual(s.callbacks,old);assert.equal(old.onUpdate(update()).status,'ignored');
});
