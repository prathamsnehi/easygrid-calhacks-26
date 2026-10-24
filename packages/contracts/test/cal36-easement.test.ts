import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoAgreements,signDemoAgreement,supersedeDemoAgreements,regenerateDemoAgreements,isAgreementPackageReady,compensationTranches,type FinalRoute} from '../src/cal36-easement.ts';
const route=():FinalRoute=>({sessionId:'demo-1',projectId:'project-1',routeId:'route-1',routeVersion:1,
  status:'final_agreement_ready',operatorAlias:'EasyGrid',parcelIds:['A','B'],
  terms:['A','B'].map(id=>({parcelId:id,ownerId:'owner-'+id,ownerAlias:'Owner '+id,
    termsVersion:1,outcome:'accepted' as const,explicitConfirmation:true,
    evidenceRefs:['negotiation:'+id],compensationCents:10003,monthlyRentCents:500,
    corridorDescription:'Synthetic corridor',accessConditions:['Daytime access']}))});
test('CAL-36: final-route agreement has 20/80 exact total and post-completion monthly fee',()=>{
  const pkg=createDemoAgreements(route());
  assert.equal(pkg.agreements.length,2);
  assert.deepEqual(compensationTranches(10003),{contract20Cents:2000,completion80Cents:8003});
  assert.match(pkg.agreements[0]!.preview,/starts after completion/);
  assert.match(pkg.agreements[0]!.preview,/No separate deposit/);
  assert.equal(isAgreementPackageReady(pkg),false);
});
test('CAL-36: reject nonfinal, refused, missing and stale accepted terms',()=>{
  const a=route();a.status='selected_for_negotiation';
  assert.throws(()=>createDemoAgreements(a),{code:'NOT_FINAL'});
  const b=route();b.terms[1]!.outcome='refused';
  assert.throws(()=>createDemoAgreements(b),{code:'NOT_ACCEPTED'});
  const c=route();c.terms.pop();
  assert.throws(()=>createDemoAgreements(c),{code:'MISSING_TERMS'});
  const d=route();d.terms[0]!.termsVersion=0;
  assert.throws(()=>createDemoAgreements(d),{code:'INVALID_TERMS'});
});
test('CAL-36: simulated signatures bind versions and supersession invalidates them',()=>{
  const p=createDemoAgreements(route());
  const s=signDemoAgreement(p,'A','Owner A','2026-10-24T12:00:00Z',p.packageHash);
  assert.equal(s.agreements[0]!.signature?.contentHash,s.agreements[0]!.contentHash);
  assert.throws(()=>signDemoAgreement(s,'A','Owner A','2026-10-24T12:00:00Z',s.packageHash),{code:'BLOCKED_STATE'});
  const all=signDemoAgreement(s,'B','Owner B','2026-10-24T12:00:00Z',s.packageHash);
  assert.equal(isAgreementPackageReady(all),true);
  assert.equal(isAgreementPackageReady(supersedeDemoAgreements(all)),false);
  const updated=route();updated.routeVersion=2;
  const regen=regenerateDemoAgreements(all,updated);
  assert.equal(isAgreementPackageReady(regen.previous),false);
  assert.equal(regen.current.agreements[0]!.contractVersion,2);
  assert.equal(regen.current.agreements[0]!.status,'draft');
  assert.notEqual(regen.current.packageHash,p.packageHash);
});

test('CAL-36: floor cents rounding, stale signatures and changed terms',()=>{
  assert.deepEqual(compensationTranches(10004),{contract20Cents:2000,completion80Cents:8004});
  const original=route();const p=createDemoAgreements(original);
  assert.throws(()=>signDemoAgreement(p,'A','Owner A','2026-10-24T12:00:00Z','wrong'),{code:'STALE_VERSION'});
  assert.throws(()=>signDemoAgreement(p,'A','Wrong owner','2026-10-24T12:00:00Z',p.packageHash),{code:'INVALID_SIGNATURE'});
  const changed=route();changed.terms[0]!.termsVersion=2;
  const regen=regenerateDemoAgreements(p,changed);
  assert.notEqual(regen.current.agreements[0]!.contentHash,p.agreements[0]!.contentHash);
  const rollback=route();rollback.routeVersion=0;
  assert.throws(()=>regenerateDemoAgreements(p,rollback),{code:'STALE_VERSION'});
});
