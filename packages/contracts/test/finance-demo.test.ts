import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgreementPackage, demoSignAgreement, splitCompensation, initialFinanceState,
  approvePackage, payContractTranches, simulateCompletion, postMonthlyRent,
  reconciliation, rentDueDate, resetDemo, supersedePackage, type AgreementPackage
} from '../src/finance-demo.ts';

const parcel = (parcelId: string, compensationCents=10003) => ({
  parcelId, ownerAlias: 'Owner '+parcelId, termsVersion: 1,
  outcome: 'accepted' as const, explicitConfirmation: true, evidenceRefs: ['consent:'+parcelId],
  compensationCents, monthlyRentCents: 501, accessConditions: ['Daytime access'],
  corridorDescription: 'Synthetic wire corridor'
});
const make = (overrides: Record<string,unknown>={}) => buildAgreementPackage({
  sessionId: 'demo-1', projectId: 'p', routeId: 'r', routeVersion: 1,
  finalParcelIds: ['A','B'], parcels: [parcel('A'),parcel('B',9999)],
  operatorAlias: 'Synthetic Operator', ...overrides
});
const signAll = (pkg: AgreementPackage) => pkg.agreements.reduce((s,a) =>
  demoSignAgreement(s,a.parcelId,a.ownerAlias,'2026-10-24T12:00:00Z'),pkg);
const approved = () => {
  const signed = signAll(make());
  return approvePackage(initialFinanceState(signed), {
    approverId:'manager',requestedBy:'agent',approvalId:'approval-1',
    at:'2026-10-24T12:00:00Z',expectedPackageHash:signed.packageHash
  });
};
test('20 percent half-up cents and exact remainder; no deposit', () => {
  assert.deepEqual(splitCompensation(10003),{contractCents:2001,completionCents:8002});
  assert.deepEqual(splitCompensation(9999),{contractCents:2000,completionCents:7999});
  assert.deepEqual(splitCompensation(1),{contractCents:0,completionCents:1});
  assert.throws(()=>splitCompensation(-1),{code:'INVALID_AMOUNT'});
  const pkg=make();
  assert.equal(pkg.agreements[0].contractTrancheCents+pkg.agreements[0].completionTrancheCents,10003);
  assert.match(pkg.agreements[0].preview,/SIMULATED EASEMENT/);
  assert.match(pkg.agreements[0].preview,/No separate deposit/);
  assert.match(pkg.agreements[0].contentHash,/^sha256:/);
});
test('all final-route parcels must have accepted terms and evidence', () => {
  assert.throws(()=>make({parcels:[parcel('A')]}),{code:'MISSING_TERMS'});
  assert.throws(()=>make({parcels:[parcel('A'),{...parcel('B'),outcome:'refused'}]}),{code:'UNACCEPTED_TERMS'});
  assert.throws(()=>make({parcels:[parcel('A'),{...parcel('B'),explicitConfirmation:false}]}),{code:'UNACCEPTED_TERMS'});
  assert.throws(()=>make({parcels:[parcel('A'),{...parcel('B'),corridorDescription:''}]}),{code:'MISSING_TERMS'});
  assert.throws(()=>make({finalParcelIds:['A','A']}),{code:'INVALID_ROUTE'});
});
test('simulated signature is version bound and old agreement can be superseded', () => {
  const pkg=make();
  assert.throws(()=>demoSignAgreement(pkg,'A','Wrong person','2026-10-24'),{code:'UNAUTHORIZED'});
  const signed=signAll(pkg);
  assert.equal(signed.agreements[0].signature?.contentHash,signed.agreements[0].contentHash);
  assert.throws(()=>demoSignAgreement(signed,'A','Owner A','2026-10-24'),{code:'BLOCKED_STATE'});
  assert.equal(supersedePackage(signed).agreements[0].signature,undefined);
});
test('approval blocked for unsigned, stale and same requester/approver', () => {
  assert.throws(()=>approvePackage(initialFinanceState(make()),{
    approverId:'manager',requestedBy:'agent',approvalId:'x',at:'2026-10-24',expectedPackageHash:make().packageHash
  }),{code:'UNSIGNED'});
  const pkg=signAll(make());
  assert.throws(()=>approvePackage(initialFinanceState(pkg),{
    approverId:'manager',requestedBy:'agent',approvalId:'x',at:'2026-10-24',expectedPackageHash:'stale'
  }),{code:'STALE_VERSION'});
  assert.throws(()=>approvePackage(initialFinanceState(pkg),{
    approverId:'agent',requestedBy:'agent',approvalId:'x',at:'2026-10-24',expectedPackageHash:pkg.packageHash
  }),{code:'SEGREGATION_OF_DUTIES'});
});
test('20% once, completion only after settled 20%, remaining 80% once', () => {
  assert.throws(()=>simulateCompletion(approved(),'agent','2026-10-24T12:00:00Z'),{code:'PAYMENT_REQUIRED'});
  const first=payContractTranches(approved(),'agent','2026-10-24T12:00:00Z');
  assert.equal(first.ledger.length,2);
  assert.throws(()=>payContractTranches(first,'agent','2026-10-24T12:00:00Z'),{code:'DUPLICATE_OBLIGATION'});
  const done=simulateCompletion(first,'agent','2026-10-24T13:00:00Z');
  assert.equal(done.ledger.length,4);
  assert.throws(()=>simulateCompletion(done,'agent','2026-10-24T13:00:00Z'),{code:'DUPLICATE_COMPLETION'});
  assert.equal(reconciliation(done).expectedCents,20002);
  assert.equal(reconciliation(done).paidCents,20002);
  assert.equal(reconciliation(done).balanced,true);
});
test('no rent before completion, first full month due after calendar month', () => {
  assert.throws(()=>postMonthlyRent(approved(),{
    monthNumber:1,demoDate:'2026-11-24',actor:'agent',at:'2026-11-24'
  }),{code:'NOT_COMPLETED'});
  assert.equal(rentDueDate('2026-01-31T10:00:00Z',1),'2026-02-28');
  assert.equal(rentDueDate('2026-12-31T10:00:00Z',2),'2027-02-28');
  const done=simulateCompletion(payContractTranches(approved(),'agent','2026-10-24T12:00:00Z'),'agent','2026-10-24T13:00:00Z');
  assert.throws(()=>postMonthlyRent(done,{
    monthNumber:1,demoDate:'2026-11-23',actor:'agent',at:'2026-11-23'
  }),{code:'NOT_DUE'});
});
test('two months, one matched and one mismatch, audit and double entry', () => {
  const done=simulateCompletion(payContractTranches(approved(),'agent','2026-10-24T12:00:00Z'),'agent','2026-10-24T13:00:00Z');
  const month1=postMonthlyRent(done,{monthNumber:1,demoDate:'2026-11-24',actor:'agent',at:'2026-11-24'});
  const month2=postMonthlyRent(month1,{monthNumber:2,demoDate:'2026-12-24',actor:'agent',at:'2026-12-24',paidByParcel:{A:400}});
  const result=reconciliation(month2);
  assert.equal(result.mismatches.length,1);
  assert.equal(result.unmatchedCents,101);
  assert.equal(result.balanced,true);
  assert.equal(month2.ledger.length,8);
  assert.ok(month2.audit.length>=5);
  assert.throws(()=>postMonthlyRent(month2,{monthNumber:2,demoDate:'2026-12-24',actor:'agent',at:'2026-12-24'}),{code:'DUPLICATE_OBLIGATION'});
});
test('stale approval and reset isolation', () => {
  const state=approved();
  const changed={...state,package:{...state.package,packageHash:'new'}};
  assert.throws(()=>payContractTranches(changed,'agent','2026-10-24'),{code:'STALE_APPROVAL'});
  const newPkg=make({sessionId:'demo-2'});
  const reset=resetDemo(newPkg);
  assert.equal(reset.approval,undefined);
  assert.equal(reset.ledger.length,0);
  assert.notEqual(reset.package.packageHash,state.package.packageHash);
});
