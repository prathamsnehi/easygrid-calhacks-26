import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcceptedOwnerHandoff,createInitialOwnerHandoff,createOwnerHandoffCurrent} from '../src/owner-handoff-fixtures.ts';
import {buildCal36FromOwnerHandoff} from '../src/cal36-shared-handoff.ts';
import {signDemoAgreement} from '../src/cal36-easement.ts';
import {approveCal37,settleCal37,emptyCal37State,cal37Status,cal37PublicView,settleCal37Authoritatively,approveCal37Authoritatively} from '../src/cal37-approval.ts';
import {settlementObligationId} from '../src/owner-handoff.ts';
function fixture(){
 const packet=createAcceptedOwnerHandoff(),current=createOwnerHandoffCurrent(packet);
 const issued=buildCal36FromOwnerHandoff(packet,current,'EasyGrid');
 let signed=issued.agreementPackage;
 for(const a of signed.agreements)signed=signDemoAgreement(signed,a.parcelId,a.ownerAlias,'2026-10-24T10:00:00Z',signed.packageHash);
 return {packet,current,issued,signed};
}
function approval(f=fixture()){
 return approveCal37({...f,operatorAlias:'EasyGrid',managerAlias:'Operator',managerConfirmed:true,
 approvedAt:'2026-10-24T11:00:00Z',state:emptyCal37State(),expectedStateRevision:0});
}
test('CAL-37 explicit manager approval requires complete current simulated signatures',()=>{
 const f=fixture();
 assert.throws(()=>approveCal37({...f,operatorAlias:'EasyGrid',managerAlias:'Operator',managerConfirmed:false,
 approvedAt:'2026-10-24T11:00:00Z',state:emptyCal37State(),expectedStateRevision:0}),{code:'BLOCKED_STATE'});
 assert.throws(()=>approveCal37({...f,signed:f.issued.agreementPackage,operatorAlias:'EasyGrid',managerAlias:'Operator',managerConfirmed:true,
 approvedAt:'2026-10-24T11:00:00Z',state:emptyCal37State(),expectedStateRevision:0}),{code:'BLOCKED_STATE'});
 const approved=approval(f);
 assert.equal(approved.approval?.packageHash,f.signed.packageHash);
 assert.equal(Object.keys(approved.approval!.contractVersions).length,2);
 assert.equal(cal37Status(approved).approval,'approved');
 assert.throws(()=>approveCal37({...f,operatorAlias:'EasyGrid',managerAlias:'Operator',managerConfirmed:true,
 approvedAt:'2026-10-24T11:00:00Z',state:approved,expectedStateRevision:1}),{code:'BLOCKED_STATE'});
});
test('CAL-37 first 20% is exact cents, simulated, owner-bound and paid once',()=>{
 const f=fixture(),approved=approval(f);
 const paid=settleCal37({...f,state:approved,expectedStateRevision:1,attemptedAt:'2026-10-24T11:05:00Z',
 outcome:'simulated_success',requestKey:'key-a'});
 assert.equal(paid.receipts.length,2);
 assert.deepEqual(paid.receipts.map(x=>x.amountCents),[240000,160000]);
 assert.equal(paid.receipts.reduce((sum,x)=>sum+x.amountCents,0),400000);
 assert.equal(paid.state.ledger.length,2);
 assert.equal(cal37Status(paid.state).paid,2);
 assert.equal(paid.receipts[0]?.simulated,true);
 assert.match(paid.receipts[0]!.label,/NO REAL FUNDS/);
 assert.equal(paid.receipts[0]!.obligationId,settlementObligationId(f.packet.sessionId,f.packet.parcels[0]!.parcelId,'contract_tranche'));
 assert.match(paid.state.ledger[0]!.recipientDisplay,/\*{4}\d{4}/);
 assert.throws(()=>settleCal37({...f,state:paid.state,expectedStateRevision:2,
 attemptedAt:'2026-10-24T11:06:00Z',outcome:'simulated_success',requestKey:'different-key'}),{code:'BLOCKED_STATE'});
});
test('CAL-37 failed attempts remain visible and retry cannot duplicate obligations',()=>{
 const f=fixture(),approved=approval(f);
 const failed=settleCal37({...f,state:approved,expectedStateRevision:1,
 attemptedAt:'2026-10-24T11:05:00Z',outcome:'simulated_failure',requestKey:'first'});
 assert.equal(failed.receipts.length,0);
 assert.equal(cal37Status(failed.state).attempted,2);
 const retry=settleCal37({...f,state:failed.state,expectedStateRevision:2,
 attemptedAt:'2026-10-24T11:06:00Z',outcome:'simulated_success',requestKey:'second'});
 assert.equal(retry.state.ledger.length,2);
 assert.equal(cal37Status(retry.state).paid,2);
 assert.equal(new Set(retry.state.ledger.map(x=>x.obligationId)).size,2);
});
test('CAL-37 rejects stale route, terms, owner bank, package and concurrent writes',()=>{
 const f=fixture(),approved=approval(f);
 const stale={...f.current,revision:f.current.revision+1};
 assert.throws(()=>settleCal37({...f,current:stale,state:approved,expectedStateRevision:1,
 attemptedAt:'2026-10-24T11:05:00Z',outcome:'simulated_success',requestKey:'x'}),{code:'STALE_VERSION'});
 const wrong=structuredClone(f.packet);wrong.owners[0]!.banking.paymentRecipientRef='mock-other';
 assert.throws(()=>settleCal37({...f,packet:wrong,state:approved,expectedStateRevision:1,
 attemptedAt:'2026-10-24T11:05:00Z',outcome:'simulated_success',requestKey:'x'}));
 assert.throws(()=>settleCal37({...f,state:approved,expectedStateRevision:0,
 attemptedAt:'2026-10-24T11:05:00Z',outcome:'simulated_success',requestKey:'x'}),{code:'STALE_VERSION'});
 const pending=createInitialOwnerHandoff();
 assert.throws(()=>approveCal37({...f,packet:pending,current:createOwnerHandoffCurrent(pending),
 operatorAlias:'EasyGrid',managerAlias:'Operator',managerConfirmed:true,
 approvedAt:'2026-10-24T11:00:00Z',state:emptyCal37State(),expectedStateRevision:0}));
});

test('CAL-37 partial owner retry pays only remaining approved obligations',()=>{
 const f=fixture(),approved=approval(f),first=f.packet.parcels[0]!.parcelId;
 const paidOne=settleCal37({...f,state:approved,expectedStateRevision:1,
  attemptedAt:'2026-10-24T11:10:00Z',outcome:'simulated_success',requestKey:'partial-1',selectedParcelIds:[first]});
 assert.equal(paidOne.receipts.length,1);
 assert.equal(paidOne.state.ledger.length,1);
 const rest=settleCal37({...f,state:paidOne.state,expectedStateRevision:2,
  attemptedAt:'2026-10-24T11:11:00Z',outcome:'simulated_success',requestKey:'partial-2'});
 assert.equal(rest.receipts.length,1);
 assert.equal(rest.state.ledger.length,2);
 assert.equal(rest.state.ledger.filter(e=>e.status==='paid').length,2);
 assert.equal(cal37PublicView(rest.state).payments.length,2);
 assert.equal(JSON.stringify(cal37PublicView(rest.state)).includes('paymentRecipientRef'),false);
 assert.throws(()=>settleCal37({...f,state:rest.state,expectedStateRevision:3,
  attemptedAt:'2026-10-24T11:12:00Z',outcome:'simulated_success',requestKey:'partial-3',selectedParcelIds:[first]}),{code:'BLOCKED_STATE'});
});
test('CAL-37 refuses forged paid rows, altered amount, and recipient reference',()=>{
 const f=fixture(),approved=approval(f);
 const paid=settleCal37({...f,state:approved,expectedStateRevision:1,
  attemptedAt:'2026-10-24T11:10:00Z',outcome:'simulated_success',requestKey:'valid',selectedParcelIds:[f.packet.parcels[0]!.parcelId]});
 for(const change of [(x:any)=>x.amountCents++, (x:any)=>x.paymentRecipientRef='mock-evil',
   (x:any)=>x.termsVersion++, (x:any)=>x.recipientDisplay='Real Bank 123456789', (x:any)=>x.obligationId='fake']){
  const state=structuredClone(paid.state);change(state.ledger[0]);
  assert.throws(()=>settleCal37({...f,state,expectedStateRevision:2,
   attemptedAt:'2026-10-24T11:11:00Z',outcome:'simulated_success',requestKey:'retry'}),{code:'STALE_VERSION'});
 }
});
test('CAL-37 authoritative CAS rejects concurrent writes without returning paid receipts',async()=>{
 const f=fixture(),state=approval(f);let commits=0;
 const store={async load(sessionId:string){assert.equal(sessionId,f.packet.sessionId);
  return {...f,state};},async compareAndSwap(_sessionId:string,expectedRevision:number,next:any){
   assert.equal(expectedRevision,1);assert.equal(next.revision,2);commits++;return false;
  }};
 await assert.rejects(settleCal37Authoritatively(store,f.packet.sessionId,{
  attemptedAt:'2026-10-24T11:10:00Z',outcome:'simulated_success',requestKey:'cas'}),{code:'STALE_VERSION'});
 assert.equal(commits,1);
 assert.equal(state.ledger.length,0);
});

test('CAL-37 authoritative manager approval commits only after CAS',async()=>{
 const f=fixture();let state=emptyCal37State();
 const store={async load(){return {...f,state}},async compareAndSwap(_id:string,expected:number,next:typeof state){
  if(expected!==state.revision)return false;state=next;return true;
 }};
 const approved=await approveCal37Authoritatively(store,f.packet.sessionId,{
  operatorAlias:'EasyGrid',managerAlias:'Operator',managerConfirmed:true,
  approvedAt:'2026-10-24T11:00:00Z'});
 assert.equal(approved.revision,1);assert.equal(state.approval?.simulated,true);
 await assert.rejects(approveCal37Authoritatively(store,f.packet.sessionId,{
  operatorAlias:'EasyGrid',managerAlias:'Operator',managerConfirmed:true,
  approvedAt:'2026-10-24T11:01:00Z'}),{code:'BLOCKED_STATE'});
});
