import test from 'node:test';
import assert from 'node:assert/strict';
import {financeHandoffView,emptyFinanceState,financeAction,financeTotals,financeContractPreview,financeMonitoring} from '../src/finance-panel.js';
const handoff=()=>({kind:'easygrid-map-handoff',sessionId:'test-s',routeVersion:1,
 snapshot:{project:{selectedRouteId:'route-A'},routes:[{id:'route-A',parcelIds:['L001','L002']}]},
 parcelAnalysis:[{parcelId:'L001',ownerId:'O001',ownerAlias:'Morgan Reed',upfrontCents:1200000,monthlyRentEquivalentCents:30000,monthlyRentIsApproximate:false},
 {parcelId:'L002',ownerId:'O002',ownerAlias:'Dana Brooks',upfrontCents:800000,monthlyRentEquivalentCents:20000,monthlyRentIsApproximate:false}]});
function setup(){const view=financeHandoffView(handoff());return {view,s:emptyFinanceState(view)}}
const apply=(obj,a)=>{obj.s=financeAction(obj.view,obj.s,a)};
test('CAL-36/37 signing, manager approval and exact initial tranche are gated',()=>{
 const f=setup();
 assert.throws(()=>apply(f,'approve'),/sign/);
 assert.throws(()=>apply(f,'complete'),/approval|20%/);
 apply(f,'prepare');apply(f,'sign:L001');
 assert.throws(()=>apply(f,'approve'),/sign/);
 apply(f,'sign:L002');apply(f,'approve');
 apply(f,'first-fail');
 assert.equal(financeTotals(f.s).unmatched,400000);
 assert.equal(f.s.first,false);
 apply(f,'first');
 assert.equal(f.s.ledger.filter(x=>x.stage==='20%').length,2);
 assert.deepEqual(f.s.ledger.filter(x=>x.stage==='20%').map(x=>x.amount),[240000,160000]);
 assert.throws(()=>apply(f,'first'),/unsettled/);
});
test('CAL-38 completion one time, exact remainder and monthly gates',()=>{
 const f=setup();apply(f,'prepare');apply(f,'sign:L001');apply(f,'sign:L002');apply(f,'approve');
 assert.throws(()=>apply(f,'advance'),/Complete/);
 apply(f,'first');apply(f,'complete');
 assert.throws(()=>apply(f,'complete'),/already/);
 apply(f,'balance-fail');assert.equal(f.s.balance,false);
 apply(f,'balance');assert.deepEqual(f.s.ledger.filter(x=>x.stage==='80%').map(x=>x.amount),[960000,640000]);
 assert.throws(()=>apply(f,'balance'),/unpaid/);
});
test('CAL-39 two months, matching payments, mismatch and no duplicates after restored snapshot',()=>{
 const f=setup();for(const a of ['prepare','sign:L001','sign:L002','approve','first','complete','balance','advance','rent'])apply(f,a);
 assert.equal(f.s.month,1);assert.equal(f.s.ledger.filter(x=>x.stage==='rent').length,2);
 assert.throws(()=>apply(f,'rent'),/already/);
 const restored=structuredClone(f.s);
 f.s=restored;apply(f,'advance');apply(f,'mismatch');
 const rows=f.s.ledger.filter(x=>x.stage==='rent');
 assert.equal(rows.length,4);assert.equal(financeTotals(f.s).discrepant,5000);
 assert.equal(rows.filter(x=>x.status==='discrepant').length,1);
 assert.throws(()=>apply(f,'mismatch'),/already/);
 assert.throws(()=>apply(f,'advance'),/at most/);
});
test('route/revision/term change blocks old signed session',()=>{
 const f=setup();apply(f,'prepare');
 const next=handoff();next.routeVersion=2;
 const altered=financeHandoffView(next);
 assert.throws(()=>financeAction(altered,f.s,'approve'),/Route/);
});

test('CAL-36 previews display versions and exact 20/80 split; regeneration voids simulated signatures',()=>{
 const f=setup();apply(f,'prepare');
 const p=financeContractPreview(f.view,f.s,'L001');
 assert.match(p.text,/SIMULATED EASEMENT/);
 assert.match(p.text,/2,400\.00/);
 assert.match(p.text,/9,600\.00/);
 assert.match(p.text,/NOT SPACETIMEDB APPROVED CONTRACT/);
 apply(f,'sign:L001');
 assert.equal(f.s.signatureReceipts.L001.contractVersion,1);
 apply(f,'regenerate');
 assert.equal(f.s.contractVersion,2);
 assert.equal(f.s.signed.length,0);
 assert.equal(f.s.signatureReceipts.L001,undefined);
 assert.throws(()=>apply(f,'approve'),/sign/);
});
test('Hyphenate status is explicitly local rules, and failed attempt history remains visible after retry',()=>{
 const f=setup();for(const a of ['prepare','sign:L001','sign:L002','approve','first-fail','first'])apply(f,a);
 assert.equal(f.s.attempts.filter(x=>x.stage==='20%').length,4);
 assert.deepEqual(f.s.attempts.map(x=>x.status),['attempted','attempted','paid','paid']);
 const report=financeMonitoring(f.view,f.s);
 assert.equal(report.source,'local-deterministic-rules');
 assert.equal(report.autoExecute,false);
 assert.match(report.issues.join(' '),/Failed payment attempts/);
});
