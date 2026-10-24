import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcceptedOwnerHandoff,createInitialOwnerHandoff,createOwnerHandoffCurrent} from '../src/owner-handoff-fixtures.ts';
import {buildCal36FromOwnerHandoff} from '../src/cal36-shared-handoff.ts';
import {signDemoAgreement} from '../src/cal36-easement.ts';
import {approveCal37,settleCal37,emptyCal37State,cal37Status} from '../src/cal37-approval.ts';
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
