import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcceptedOwnerHandoff,createOwnerHandoffCurrent} from '../src/owner-handoff.ts';
import {buildCal36FromOwnerHandoff} from '../src/cal36-shared-handoff.ts';
import {signDemoAgreement} from '../src/cal36-easement.ts';
import {approveCal37,settleCal37,emptyCal37State} from '../src/cal37-approval.ts';
import {emptyLaterState,simulateCompletion,settleCompletionBalance,advanceMonthlyPeriod,laterPublicView} from '../src/cal38-39-settlement.ts';
function setup(){
 const packet=createAcceptedOwnerHandoff(),current=createOwnerHandoffCurrent(packet);
 const issued=buildCal36FromOwnerHandoff(packet,current,'EasyGrid');
 let signed=issued.agreementPackage;
 for(const a of signed.agreements)signed=signDemoAgreement(signed,a.parcelId,a.ownerAlias,'2026-10-24T10:00:00Z',signed.packageHash);
 const approved=approveCal37({packet,current,issued,signed,operatorAlias:'EasyGrid',managerAlias:'Manager',
 managerConfirmed:true,approvedAt:'2026-10-24T11:00:00Z',state:emptyCal37State(),expectedStateRevision:0});
 const first=settleCal37({packet,current,signed,state:approved,expectedStateRevision:1,
 attemptedAt:'2026-10-24T11:01:00Z',outcome:'simulated_success',requestKey:'first'}).state;
 return {packet,current,signed,first,later:emptyLaterState(),expectedRevision:0};
}
test('CAL-38 completion requires settled 20%, is immutable and pays exact 80% once',()=>{
 const f=setup();
 assert.throws(()=>settleCompletionBalance({...f,requestKey:'early',outcome:'simulated_success'}));
 const completed=simulateCompletion({...f,completedOn:'2026-10-24',operatorConfirmed:true});
 assert.throws(()=>simulateCompletion({...f,later:completed,expectedRevision:1,completedOn:'2026-10-25',operatorConfirmed:true}));
 const paid=settleCompletionBalance({...f,later:completed,expectedRevision:1,requestKey:'balance',outcome:'simulated_success'});
 assert.deepEqual(paid.payments.map(p=>p.amountCents),[960000,640000]);
 assert.throws(()=>settleCompletionBalance({...f,later:paid,expectedRevision:2,requestKey:'different',outcome:'simulated_success'}));
});
test('CAL-39 two monthly periods and mismatch reconcile, pre-completion rejected',()=>{
 const f=setup();
 assert.throws(()=>advanceMonthlyPeriod({...f,month:1,asOfDate:'2026-11-24',requestKey:'early',outcome:'simulated_success'}));
 const completed=simulateCompletion({...f,completedOn:'2026-10-24',operatorConfirmed:true});
 const c={...f,later:completed,expectedRevision:1};
 assert.throws(()=>advanceMonthlyPeriod({...c,month:1,asOfDate:'2026-11-23',requestKey:'early',outcome:'simulated_success'}));
 assert.throws(()=>advanceMonthlyPeriod({...c,month:2,asOfDate:'2026-12-24',requestKey:'skip',outcome:'simulated_success'}));
 const first=advanceMonthlyPeriod({...c,month:1,asOfDate:'2026-11-24',requestKey:'month1',outcome:'simulated_success'});
 const second=advanceMonthlyPeriod({...f,later:first,expectedRevision:2,month:2,asOfDate:'2026-12-24',
 requestKey:'month2',outcome:'simulated_success',discrepancy:{parcelId:f.packet.parcels[0]!.parcelId,actualCents:25000}});
 assert.equal(second.payments.length,4);
 const view=laterPublicView(second);
 assert.equal(view.discrepantCents,5000);
 assert.equal(view.paidCents,80000);
 assert.equal(view.expectedCents,100000);
 assert.equal(JSON.stringify(view).includes('paymentRecipientRef'),false);
 assert.throws(()=>advanceMonthlyPeriod({...f,later:second,expectedRevision:3,month:2,asOfDate:'2026-12-24',
 requestKey:'retry',outcome:'simulated_success'}));
});
