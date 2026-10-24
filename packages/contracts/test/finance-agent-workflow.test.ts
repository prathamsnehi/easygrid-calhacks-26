import test from 'node:test';
import assert from 'node:assert/strict';
import {collectNessieEvidence,planFinanceAgent} from '../src/finance-agent-workflow.ts';
import {emptyCal37State} from '../src/cal37-approval.ts';
import {emptyLaterState} from '../src/cal38-39-settlement.ts';

test('CAL-37/38/39 advisory agent explains missing approval / provider evidence without making payments',()=>{
 const first=emptyCal37State(),later=emptyLaterState();
 const report=planFinanceAgent(first,later);
 assert.equal(report.mode,'advisory_only');
 assert.equal(report.requiresHumanApproval,true);
 assert.equal(report.severity,'review');
 assert.ok(report.actions.some(a=>a.kind==='await_approval'));
 assert.ok(report.actions.every(a=>!a.autoExecute));
 assert.equal(first.revision,0);
 assert.equal(later.revision,0);
});
test('Capital One Nessie adapter reads only verified sandbox account, deposits and withdrawals',async()=>{
 const visited:string[]=[];
 const fetcher=(async(url:string,init:any)=>{
  const u=new URL(url);visited.push(init.method+' '+u.pathname);
  assert.equal(init.redirect,'error');assert.equal(u.searchParams.get('key'),'sandbox-test');
  const data=u.pathname.endsWith('/deposits')?[{_id:'deposit-1',amount:12.30,status:'completed'}]:
   u.pathname.endsWith('/withdrawals')?[{_id:'withdrawal-1',amount:5.5,status:'pending'}]:
   {_id:'sandbox-1'};
  return {ok:true,json:async()=>data};
 }) as typeof fetch;
 const result=await collectNessieEvidence({baseUrl:'https://api.nessieisreal.com/',apiKey:'sandbox-test',sandboxAccountId:'sandbox-1',fetcher});
 assert.deepEqual(visited,['GET /accounts/sandbox-1','GET /accounts/sandbox-1/deposits','GET /accounts/sandbox-1/withdrawals']);
 assert.equal(result.transactions[0]?.amountCents,1230);
 assert.equal(result.transactions[1]?.amountCents,550);
 assert.match(result.note,/NOT PROOF/);
});
test('Nessie prevents key exfiltration, mismatched account and invalid non-cent amounts',async()=>{
 const never=(async()=>{throw Error('should not fetch')}) as typeof fetch;
 await assert.rejects(collectNessieEvidence({baseUrl:'https://evil.example/',apiKey:'secret',sandboxAccountId:'sandbox-1',fetcher:never}));
 await assert.rejects(collectNessieEvidence({baseUrl:'https://api.nessieisreal.com.evil.example/',apiKey:'secret',sandboxAccountId:'sandbox-1',fetcher:never}));
 const mismatch=(async()=>({ok:true,json:async()=>({_id:'other'})})) as typeof fetch;
 await assert.rejects(collectNessieEvidence({baseUrl:'https://api.nessieisreal.com/',apiKey:'key',sandboxAccountId:'sandbox-1',fetcher:mismatch}));
 const invalid=(async(url:string)=>{
  const p=new URL(url).pathname;
  return {ok:true,json:async()=>p.endsWith('/deposits')?[{_id:'d1',amount:1.234,status:'completed'}]:p.endsWith('/withdrawals')?[]:{_id:'sandbox-1'}};
 }) as typeof fetch;
 await assert.rejects(collectNessieEvidence({baseUrl:'https://api.nessieisreal.com/',apiKey:'key',sandboxAccountId:'sandbox-1',fetcher:invalid}));
});
test('Hyphenate-themed agent marks mismatches as blocked and requires manual resolution',()=>{
 const first=emptyCal37State(),later=emptyLaterState();
 later.payments.push({obligationId:'x',parcelId:'L001',ownerId:'O001',recipientDisplay:'Demo Bank ****1001',
 amountCents:25000,expectedCents:30000,status:'discrepant',kind:'monthly_fee',period:'2026-11',
 requestKey:'demo',simulated:true,label:'SIMULATED PAYMENT — NO REAL FUNDS TRANSFERRED'});
 const report=planFinanceAgent(first,later);
 assert.equal(report.severity,'blocked');
 assert.ok(report.actions.some(a=>a.kind==='review_discrepancy'));
 assert.equal(later.payments.length,1);
});
