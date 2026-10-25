import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSettlementController,settlementBinding} from '../src/settlement-controller.js';

const fixture=JSON.parse(readFileSync(new URL('../dist/demo-handoff-example.json',import.meta.url),'utf8'));
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=`sha256:${'a'.repeat(64)}`;
function setup(){
  const nodes=new Map(['settle-payment','settlement-status','settlement-feedback'].map(id=>[id,{
    textContent:'',disabled:false,className:'',classes:new Set(),
    classList:{toggle(name,on){const node=nodes.get(id);on?node.classes.add(name):node.classes.delete(name);}},
    addEventListener(_type,fn){this.click=fn;},
  }]));
  globalThis.document={querySelector:selector=>nodes.get(selector.slice(1))};
  let handoff=clone(fixture);
  const controller=createSettlementController({getHandoff:()=>handoff});
  const receipt=()=>({approvalId:'approval-1',packageHash:hash,simulated:true,mapBinding:controller.getBinding()});
  return {controller,nodes,receipt,get handoff(){return handoff;},set handoff(value){handoff=value;},
    button:nodes.get('settle-payment'),status:nodes.get('settlement-status'),feedback:nodes.get('settlement-feedback')};
}
const acknowledge=request=>({status:'submitted',approvalId:request.approval.approvalId,requestKey:request.requestKey,requestId:'request-1'});

test('settlement requires a matching approved package and connected handler; call consent is insufficient',async()=>{
  const app=setup();let calls=0;
  assert.equal(app.button.disabled,true);assert.equal(app.status.textContent,'Awaiting approval');
  app.handoff.userRole.participantConsent=true;
  app.controller.setHandler(async request=>{calls++;return acknowledge(request);});
  await app.button.click();assert.equal(calls,0);assert.equal(app.button.disabled,true);
  app.controller.setHandler(null);app.controller.setApproval(app.receipt());
  assert.equal(app.status.textContent,'Approved');assert.equal(app.button.disabled,true);
  assert.match(app.feedback.textContent,/not connected/);
  app.controller.setHandler(async request=>{calls++;return acknowledge(request);});
  assert.equal(app.button.disabled,false);assert(app.button.classes.has('settlement-ready'));
  assert.equal(app.feedback.textContent,'');
  app.controller.setApproval(null);assert.equal(app.button.disabled,true);assert(!app.button.classes.has('settlement-ready'));
});

test('mismatched, malformed and ineligible approvals revoke readiness',()=>{
  const app=setup();app.controller.setHandler(async()=>{});
  const original=app.receipt();
  for(const mutation of [r=>r.simulated=false,r=>r.approvalId=42,r=>r.packageHash='anything',
    r=>r.mapBinding.sessionId='other',r=>r.mapBinding.routeVersion++,r=>r.mapBinding.proposalKey+='changed']){
    app.controller.setApproval(original);const bad=clone(original);mutation(bad);
    assert.throws(()=>app.controller.setApproval(bad),/match/);assert.equal(app.button.disabled,true);
  }
  app.handoff.snapshot.routes[0].eligible=false;
  assert.throws(()=>app.controller.setApproval(app.receipt()),/match/);
  app.handoff=null;assert.equal(app.controller.getBinding(),null);
  assert.throws(()=>app.controller.setApproval(original),/match/);
});

test('settlement dispatch is detached, explicit, once per approval, and never claims payment',async()=>{
  const app=setup(),before=JSON.stringify(app.handoff);let request,resolve;
  app.controller.setHandler(input=>{request=input;return new Promise(done=>resolve=done);});
  const approval=app.receipt();app.controller.setApproval(approval);approval.approvalId='tampered-outside';
  const pending=app.button.click();assert.equal(app.button.disabled,true);assert.equal(app.status.textContent,'Sending');
  assert.equal(request.approval.approvalId,'approval-1');assert.equal(request.stage,'full');
  assert.equal(request.paymentSchedule,'full-after-signatures');
  assert(!('participant' in request));assert.match(request.requestKey,/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  request.handoff.snapshot.project.budgetCents=0;assert.equal(JSON.stringify(app.handoff),before);
  await app.button.click();resolve(acknowledge(request));await pending;
  assert.equal(app.button.disabled,true);assert.equal(app.button.textContent,'Request sent');
  assert.equal(app.feedback.textContent,'Settlement request sent.');assert.doesNotMatch(app.feedback.textContent,/paid/i);
  app.controller.setApproval(app.receipt());assert.equal(app.button.disabled,true);
});

test('revoked, changed-route and changed-adapter responses cannot restore settlement readiness',async()=>{
  for(const change of [app=>app.controller.setApproval(null),app=>{app.handoff.routeVersion++;app.controller.invalidate();},
    app=>app.controller.setHandler(null),app=>{app.handoff.ownerHandoff.parcels[0].terms.compensationCents++;}]){
    const app=setup();let request,resolve;
    app.controller.setHandler(input=>{request=input;return new Promise(done=>resolve=done);});
    app.controller.setApproval(app.receipt());const pending=app.button.click();change(app);
    resolve(acknowledge(request));await pending;
    assert.equal(app.button.disabled,true);assert.notEqual(app.button.textContent,'Request sent');
  }
});

test('unknown outcomes stay blocked until host reconciliation and retries keep the same key',async()=>{
  const app=setup();let request,calls=0;
  app.controller.setHandler(async input=>{request=input;calls++;throw new Error('private provider detail');});
  app.controller.setApproval(app.receipt());await app.button.click();const requestKey=request.requestKey;
  assert.equal(app.button.disabled,true);assert.equal(app.status.textContent,'Check status');
  assert.doesNotMatch(app.feedback.textContent,/private provider/);
  await app.button.click();assert.equal(calls,1);
  const resolution={approvalId:'approval-1',packageHash:hash,requestKey,status:'not-submitted'};
  assert.throws(()=>app.controller.resolveAttempt({...resolution,requestKey:'wrong'}),/matching/);
  app.controller.resolveAttempt(resolution);assert.equal(app.button.disabled,false);
  await app.button.click();assert.equal(calls,2);assert.equal(request.requestKey,requestKey);
  app.controller.resolveAttempt({...resolution,status:'submitted'});assert.equal(app.button.disabled,true);
  assert.equal(app.button.textContent,'Request sent');
});

test('duplicate approval delivery preserves the request and stale errors do not alter a new proposal',async()=>{
  const app=setup();let request,resolve;
  app.controller.setHandler(input=>{request=input;return new Promise(done=>resolve=done);});
  const approval=app.receipt();app.controller.setApproval(approval);const pending=app.button.click();
  app.controller.setApproval(clone(approval));assert.equal(request.signal.aborted,false);assert.equal(app.status.textContent,'Sending');
  resolve(acknowledge(request));await pending;assert.equal(app.button.textContent,'Request sent');
  const changed=setup();let reject;
  changed.controller.setHandler(()=>new Promise((_resolve,fail)=>reject=fail));
  changed.controller.setApproval(changed.receipt());const old=changed.button.click();
  changed.handoff.ownerHandoff.parcels[0].terms.compensationCents++;
  reject(new Error('old failure'));await old;
  assert.equal(changed.status.textContent,'Awaiting approval');assert.equal(changed.feedback.textContent,'');
});

test('an unbound callback response cannot masquerade as settlement acceptance',async()=>{
  for(const response of [undefined,{status:'paid'}, {status:'submitted',approvalId:'wrong',requestKey:'wrong',requestId:'request-1'}]){
    const app=setup();app.controller.setHandler(async()=>response);app.controller.setApproval(app.receipt());
    await app.button.click();assert.equal(app.status.textContent,'Check status');assert.equal(app.button.disabled,true);
  }
});

test('the exact proposal binding changes with amounts, terms, banking and costs',()=>{
  const app=setup(),original=settlementBinding(app.handoff);
  for(const mutate of [h=>h.ownerHandoff.parcels[0].terms.compensationCents++,
    h=>h.ownerHandoff.parcels[0].terms.termsVersion++,h=>h.ownerHandoff.owners[0].banking.paymentRecipientRef='mock-other',
    h=>h.snapshot.routes[0].totalCostCents++]){
    const changed=clone(app.handoff);mutate(changed);
    assert.notEqual(settlementBinding(changed).proposalKey,original.proposalKey);
  }
});
