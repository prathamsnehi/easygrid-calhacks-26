import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCal36FromOwnerHandoff,finalizeCal36ApprovalPackage} from '../src/cal36-shared-handoff.ts';
import {createAcceptedOwnerHandoff,createInitialOwnerHandoff,createOwnerHandoffCurrent} from '../src/owner-handoff-fixtures.ts';
import {signDemoAgreement,isAgreementPackageReady} from '../src/cal36-easement.ts';
test('CAL-36 consumes Theo real accepted OwnerHandoff and verifies 20/80',()=>{
 const packet=createAcceptedOwnerHandoff(),current=createOwnerHandoffCurrent(packet);
 const result=buildCal36FromOwnerHandoff(packet,current,'EasyGrid');
 assert.equal(result.agreementPackage.agreements.length,2);
 assert.equal(result.agreementPackage.agreements[0]!.compensationCents,1200000);
 assert.equal(result.agreementPackage.agreements[0]!.contract20Cents,240000);
 assert.equal(result.agreementPackage.agreements[0]!.completion80Cents,960000);
 assert.equal(result.agreementPackage.agreements[0]!.monthlyRentCents,30000);
 assert.equal(result.ownerRecipients[0]!.paymentRecipientRef,'mock-recipient-o001');
 let signed=result.agreementPackage;
 for(const a of signed.agreements) signed=signDemoAgreement(signed,a.parcelId,a.ownerAlias,'2026-10-24T12:00:00Z',signed.packageHash);
 assert.equal(isAgreementPackageReady(signed),true);
});
test('CAL-36 respects CAL-27 authoritative readiness and rejects stale or pending',()=>{
 const accepted=createAcceptedOwnerHandoff();
 const current=createOwnerHandoffCurrent(accepted);
 const stale={...current,revision:current.revision+1};
 assert.throws(()=>buildCal36FromOwnerHandoff(accepted,stale,'EasyGrid'),{code:'STALE_VERSION'});
 const pending=createInitialOwnerHandoff();
 assert.throws(()=>buildCal36FromOwnerHandoff(pending,createOwnerHandoffCurrent(pending),'EasyGrid'),{code:'BLOCKED_STATE'});
 const changed=structuredClone(accepted);changed.parcels[0]!.terms.monthlyRentIsApproximate=true;
 assert.throws(()=>buildCal36FromOwnerHandoff(changed,current,'EasyGrid'),{code:'INVALID_INPUT'});
});

test('CAL-36 approval handoff is blocked until all signatures and becomes ready only for the issued package',()=>{
 const packet=createAcceptedOwnerHandoff();
 const initial=buildCal36FromOwnerHandoff(packet,createOwnerHandoffCurrent(packet),'EasyGrid');
 assert.equal(initial.readyForApproval,false);
 assert.throws(()=>finalizeCal36ApprovalPackage(initial,initial.agreementPackage),{code:'BLOCKED_STATE'});
 let signed=initial.agreementPackage;
 const first=signed.agreements[0]!;
 signed=signDemoAgreement(signed,first.parcelId,first.ownerAlias,'2026-10-24T12:00:00Z',signed.packageHash);
 assert.throws(()=>finalizeCal36ApprovalPackage(initial,signed),{code:'BLOCKED_STATE'});
 for(const a of signed.agreements.filter(a=>a.status==='draft'))
   signed=signDemoAgreement(signed,a.parcelId,a.ownerAlias,'2026-10-24T12:00:00Z',signed.packageHash);
 const approved=finalizeCal36ApprovalPackage(initial,signed);
 assert.equal(approved.readyForApproval,true);
 assert.equal(approved.packageHash,initial.packageHash);
 assert.equal(approved.agreementPackage.agreements.every(a=>a.status==='demo_signed'),true);
 const tampered=structuredClone(signed);
 tampered.agreements[0]!.paymentRecipientRef='mock-attacker';
 assert.throws(()=>finalizeCal36ApprovalPackage(initial,tampered),{code:'STALE_VERSION'});
 const wrongRoute=structuredClone(signed);wrongRoute.routeVersion+=1;
 assert.throws(()=>finalizeCal36ApprovalPackage(initial,wrongRoute),{code:'STALE_VERSION'});
});
