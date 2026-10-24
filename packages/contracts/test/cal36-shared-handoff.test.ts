import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCal36ApprovalPackage} from '../src/cal36-shared-handoff.ts';
import {signDemoAgreement,isAgreementPackageReady} from '../src/cal36-easement.ts';
const example=()=>({
  sessionId:'demo-example-001',projectId:'project-example-001',
  routeId:'route-demo-001',routeVersion:1,routeStatus:'ready_for_agreements',
  currency:'USD',operatorAlias:'EasyGrid',finalParcelIds:['L001','L002'],
  parcelDetails:[
    {parcelId:'L001',ownerId:'O001',ownerAlias:'Morgan Reed',corridorDescription:'Two towers, 400m wire',accessConditions:['daytime access']},
    {parcelId:'L002',ownerId:'O002',ownerAlias:'Dana Brooks',corridorDescription:'One tower, 300m wire',accessConditions:['inspection access']}
  ],
  acceptedTerms:[
    {parcelId:'L001',ownerId:'O001',termsVersion:2,outcome:'accepted',confirmationRef:'confirmation-example-o001-v2',compensationCents:1200000,monthlyFeeCents:30000,paymentRecipientRef:'mock-recipient-o001'},
    {parcelId:'L002',ownerId:'O002',termsVersion:1,outcome:'accepted',confirmationRef:'confirmation-example-o002-v1',compensationCents:800000,monthlyFeeCents:20000,paymentRecipientRef:'mock-recipient-o002'}
  ],
  totalCompensationCents:2000000,totalMonthlyFeeCents:50000
});
test('CAL-36: documented CAL-27 handoff produces full approval package',()=>{
  const h=buildCal36ApprovalPackage(example());
  assert.equal(h.agreementPackage.agreements.length,2);
  assert.equal(h.agreementPackage.agreements[0]!.contract20Cents,240000);
  assert.equal(h.agreementPackage.agreements[0]!.completion80Cents,960000);
  assert.equal(h.ownerRecipients[1]!.paymentRecipientRef,'mock-recipient-o002');
  assert.equal(h.readyForApproval,false);
  const p=h.agreementPackage;
  const a=signDemoAgreement(p,'L001','Morgan Reed','2026-10-24T12:00:00Z',p.packageHash);
  const b=signDemoAgreement(a,'L002','Dana Brooks','2026-10-24T12:00:00Z',a.packageHash);
  assert.equal(isAgreementPackageReady(b),true);
});
test('CAL-36: rejects missing parcel, unconfirmed outcome, bad totals, conflicting owner registry',()=>{
  const a=example();a.acceptedTerms.pop();
  assert.throws(()=>buildCal36ApprovalPackage(a),{code:'MISSING_TERMS'});
  const b=example();b.acceptedTerms[0]!.outcome='counteroffer';
  assert.throws(()=>buildCal36ApprovalPackage(b),{code:'INVALID_INPUT'});
  const c=example();c.totalCompensationCents=1;
  assert.throws(()=>buildCal36ApprovalPackage(c),{code:'INVALID_AMOUNT'});
  const d=example();d.parcelDetails[0]!.ownerId='wrong';
  assert.throws(()=>buildCal36ApprovalPackage(d),{code:'INVALID_INPUT'});
  const e=example();e.parcelDetails=[];
  assert.throws(()=>buildCal36ApprovalPackage(e),{code:'MISSING_TERMS'});
});
