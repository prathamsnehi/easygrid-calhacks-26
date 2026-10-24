import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcceptedOwnerHandoff,createOwnerHandoffCurrent} from '../src/owner-handoff-fixtures.ts';
import {buildCal36FromOwnerHandoff} from '../src/cal36-shared-handoff.ts';
import {signDemoAgreement} from '../src/cal36-easement.ts';
import {approveCal37,settleCal37,emptyCal37State} from '../src/cal37-approval.ts';
import {emptyFollowupState,completeSimulated,settleFollowup,publicSettlementView,settleFollowupAuthoritatively} from '../src/cal38-39-settlement.ts';
function setup(){
 const packet=createAcceptedOwnerHandoff(),current=createOwnerHandoffCurrent(packet);
 const issued=buildCal36FromOwnerHandoff(packet,current,'EasyGrid');
 let signed=issued.agreementPackage;
 for(const a of signed.agreements)signed=signDemoAgreement(signed,a.parcelId,a.ownerAlias,'2026-10-24T10:00:00Z',signed.packageHash);
 const approved=approveCal37({packet,current,issued,signed,operatorAlias:'EasyGrid',
 managerAlias:'Operator',managerConfirmed:true,approvedAt:'2026-10-24T11:00:00Z',
 state:emptyCal37State(),expectedStateRevision:0});
 const first=settleCal37({packet,current,signed,state:approved,expectedStateRevision:1,
 attemptedAt:'2026-10-24T11:10:00Z',outcome:'simulated_success',requestKey:'first'}).state;
 return {packet,first};
}
test('CAL-38 requires 20%, explicit unique completion and exact 80% balances',()=>{
 const {packet,first}=setup();const zero=emptyFollowupState();
 assert.throws(()=>completeSimulated(packet,first,zero,0,'2026-10-24',false));
 const completed=completeSimulated(packet,first,zero,0,'2026-10-24',true);
 assert.throws(()=>completeSimulated(packet,first,completed,1,'2026-10-24',true));
 assert.throws(()=>settleFollowup(packet,first,completed,0,{stage:'completion_balance',asOfDate:'2026-10-24',outcome:'simulated_success'}));
 const paid=settleFollowup(packet,first,completed,1,{stage:'completion_balance',asOfDate:'2026-10-24',outcome:'simulated_success'});
 assert.deepEqual(paid.entries.map(e=>e.amountCents),[960000,640000]);
 assert.equal(publicSettlementView(first,paid).balance.paidCents,1600000);
 assert.throws(()=>settleFollowup(packet,first,paid,2,{stage:'completion_balance',asOfDate:'2026-10-24',outcome:'simulated_success'}));
});
test('CAL-39 two completion-anchored monthly periods and deliberate mismatch',()=>{
 const {packet,first}=setup();
 const completed=completeSimulated(packet,first,emptyFollowupState(),0,'2026-10-24',true);
 assert.throws(()=>settleFollowup(packet,first,completed,1,{stage:'monthly_fee',monthlyIndex:1,asOfDate:'2026-11-24',outcome:'simulated_success'}));
 const balance=settleFollowup(packet,first,completed,1,{stage:'completion_balance',asOfDate:'2026-10-24',outcome:'simulated_success'});
 assert.throws(()=>settleFollowup(packet,first,balance,2,{stage:'monthly_fee',monthlyIndex:1,asOfDate:'2026-11-23',outcome:'simulated_success'}));
 const month1=settleFollowup(packet,first,balance,2,{stage:'monthly_fee',monthlyIndex:1,asOfDate:'2026-11-24',outcome:'simulated_success'});
 const month2=settleFollowup(packet,first,month1,3,{stage:'monthly_fee',monthlyIndex:2,asOfDate:'2026-12-24',outcome:'simulated_mismatch'});
 const view=publicSettlementView(first,month2);
 assert.equal(view.monthly.expectedCents,100000);
 assert.equal(view.monthly.paidCents,99998);
 assert.equal(view.monthly.unmatchedCents,2);
 assert.equal(view.entries.filter(e=>e.stage==='monthly_fee').length,4);
 assert.equal(JSON.stringify(view).includes('paymentRecipientRef'),false);
 const retried=settleFollowup(packet,first,month2,4,{stage:'monthly_fee',monthlyIndex:2,asOfDate:'2026-12-24',outcome:'simulated_success'});
 assert.equal(retried.entries.length,6);
 assert.equal(publicSettlementView(first,retried).monthly.unmatchedCents,0);
 assert.throws(()=>settleFollowup(packet,first,retried,5,{stage:'monthly_fee',monthlyIndex:2,asOfDate:'2026-12-24',outcome:'simulated_success'}));
});

test('CAL-29 handoff refuses stale atomic CAS before reporting a committed payment',async()=>{
 const {packet,first}=setup();
 const state=completeSimulated(packet,first,emptyFollowupState(),0,'2026-10-24',true);
 let writes=0;
 const store={async load(){return {packet,first,state}},
 async compareAndSwap(_session:string,expected:number,next:typeof state){
  assert.equal(expected,1);assert.equal(next.revision,2);writes++;return false;
 }};
 await assert.rejects(settleFollowupAuthoritatively(store,packet.sessionId,
  (p,f,s,r)=>settleFollowup(p,f,s,r,{stage:'completion_balance',asOfDate:'2026-10-24',outcome:'simulated_success'})),
 /Concurrent authoritative ledger update/);
 assert.equal(writes,1);assert.equal(state.entries.length,0);
});
