import test from 'node:test';
import assert from 'node:assert/strict';
import {createCal36AgreementHandoff,signCal36Handoff,replaceCal36Handoff} from '../src/cal36-handoff.ts';
const parcel=(id:string)=>({
  parcelId:id,ownerId:'owner-'+id,ownerAlias:'Owner '+id,termsVersion:1,
  outcome:'accepted',explicitConfirmation:true,evidenceRefs:['negotiation:'+id],
  compensationCents:10003,monthlyRentCents:500,
  corridorDescription:'Tower and wire corridor',accessConditions:['Daytime access'],
  paymentRecipientRef:'mock-recipient-'+id
});
const handoff=()=>({
  sessionId:'demo-1',projectId:'project-1',routeId:'route-1',routeVersion:1,
  routeStatus:'final_agreement_ready',operatorAlias:'EasyGrid',
  finalParcelIds:['A','B'],parcels:[parcel('A'),parcel('B')]
});
test('CAL-36 full final-route agreement, 20/80, completion-gated rent and recipient mapping',()=>{
  const h=createCal36AgreementHandoff(handoff());
  assert.equal(h.package.agreements.length,2);
  assert.equal(h.package.agreements[0]!.contractTrancheCents,2001);
  assert.equal(h.package.agreements[0]!.completionTrancheCents,8002);
  assert.match(h.package.agreements[0]!.preview,/first due one calendar month after completion/);
  assert.equal(h.recipients.A!.paymentRecipientRef,'mock-recipient-A');
  assert.match(h.package.agreements[0]!.preview,/NOT LEGALLY EXECUTED/);
});
test('rejects missing, pending, unconfirmed, stale and extraneous parcel terms',()=>{
  assert.throws(()=>createCal36AgreementHandoff({...handoff(),parcels:[parcel('A')]}),{code:'MISSING_TERMS'});
  assert.throws(()=>createCal36AgreementHandoff({...handoff(),parcels:[parcel('A'),{...parcel('B'),outcome:'pending'}]}),{code:'INVALID_HANDOFF'});
  assert.throws(()=>createCal36AgreementHandoff({...handoff(),parcels:[parcel('A'),{...parcel('B'),explicitConfirmation:false}]}),{code:'INVALID_HANDOFF'});
  assert.throws(()=>createCal36AgreementHandoff({...handoff(),routeVersion:0}),{code:'INVALID_HANDOFF'});
  assert.throws(()=>createCal36AgreementHandoff({...handoff(),parcels:[parcel('A'),parcel('B'),parcel('C')]}),{code:'MISSING_TERMS'});
  assert.throws(()=>createCal36AgreementHandoff({...handoff(),routeStatus:'selected_for_negotiation'}),{code:'INVALID_HANDOFF'});
});
test('simulated signatures version-bound; changed terms supersede previous package',()=>{
  const old=createCal36AgreementHandoff(handoff());
  const signed=signCal36Handoff(old,'A','Owner A','2026-10-24T12:00:00Z');
  assert.equal(signed.package.agreements[0]!.status,'demo_signed');
  assert.throws(()=>signCal36Handoff(signed,'A','Owner A','2026-10-24T12:00:00Z'),{code:'BLOCKED_STATE'});
  const newer=handoff();newer.parcels[0]!.termsVersion=2;
  const revised=replaceCal36Handoff(signed,newer);
  assert.equal(revised.superseded.package.agreements[0]!.signature,undefined);
  assert.equal(revised.current.package.agreements[0]!.status,'draft');
  assert.notEqual(revised.current.package.packageHash,signed.package.packageHash);
});
test('recipient mismatch for same owner fails closed',()=>{
  const h=handoff();h.parcels[1]!.ownerId='owner-A';
  assert.throws(()=>createCal36AgreementHandoff(h),{code:'RECIPIENT_MISMATCH'});
});
