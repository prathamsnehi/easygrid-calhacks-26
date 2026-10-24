import test from 'node:test';
import assert from 'node:assert/strict';
import {hyphenateFinanceAudit,verifyNessieSandboxAccount} from '../src/sponsor-finance-adapters.ts';
import {emptyCal37State} from '../src/cal37-approval.ts';
import {emptyLaterState} from '../src/cal38-39-settlement.ts';
test('Hyphenate audit is safe and clearly simulated',()=>{
 const audit=hyphenateFinanceAudit(emptyCal37State(),emptyLaterState());
 assert.equal(audit.simulated,true);
 assert.ok(audit.exceptions.includes('Manager approval missing'));
 assert.match(audit.label,/NO REAL FUNDS/);
});
test('Nessie sandbox lookup is read-only, validates account and never transfers',async()=>{
 let called='';
 const fetcher=(async(url:string,options:any)=>{
  called=options.method+' '+url;
  return {ok:true,json:async()=>({_id:'sandbox123'})};
 }) as typeof fetch;
 const result=await verifyNessieSandboxAccount({baseUrl:'https://api.reimaginebanking.com',
 apiKey:'test-key',sandboxAccountId:'sandbox123',fetcher});
 assert.equal(result.verified,true);
 assert.match(called,/^GET /);
 assert.ok(!/transfer|withdrawal|deposit/i.test(called));
 await assert.rejects(verifyNessieSandboxAccount({baseUrl:'http://insecure',apiKey:'x',
 sandboxAccountId:'sandbox123',fetcher}));
});
