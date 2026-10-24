import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createContractAPI} from '../server/contract-api.mjs';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractDraft} from '../src/contract-authoring.js';

async function call(api, path, body, headers = {}) {
  const req = {method:'POST',headers:{host:'127.0.0.1:4177','content-type':'application/json','x-easygrid-demo':'1',origin:'http://127.0.0.1:4177',...headers},
    async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}};
  const result = {};
  const res = {writeHead(status, responseHeaders){result.status=status;result.headers=responseHeaders;return this;},end(value){result.body=JSON.parse(value);}};
  assert.equal(await api(req,res,path),true); return result;
}

test('local API signs, submits, persists and restores the same outcome without trusting a browser role claim', async () => {
  const prefix = join(tmpdir(),'easygrid-contract-api-'), directory = await mkdtemp(prefix);
  try {
    const options = {environment:{},stateURL:pathToFileURL(join(directory,'state.json'))};
    const api = await createContractAPI(options), draft = createContractDraft(createContractExample(),'P-004',{id:'draft-api-004',now:'2026-10-24T18:00:00Z'});
    assert.equal((await call(api,'/api/contracts/submit',{draft})).status,409);
    const utility = await call(api,'/api/contracts/sign/utility',{draft,actor:{id:'attacker',role:'payment-requester'}});
    assert.equal(utility.status,200,JSON.stringify(utility.body));
    await call(api,'/api/contracts/sign/landowner',{draft});
    const other = createContractDraft(createContractExample(),'P-009',{id:'draft-api-009',now:'2026-10-24T18:00:00Z'});
    await call(api,'/api/contracts/sign/utility',{draft:other});
    await call(api,'/api/contracts/sign/landowner',{draft:other});
    const paid = await call(api,'/api/contracts/submit',{draft}); assert.equal(paid.body.payment.status,'paid');
    const restarted = await createContractAPI(options), result = await call(restarted,'/api/contracts/submit',{draft});
    assert.equal(result.body.payment.obligationId,paid.body.payment.obligationId); assert.equal(result.body.journal.length,1);
    assert.equal(result.body.signatures.utility.actorId,'demo-utility-controller');
    const crossOrigin = await call(api,'/api/contracts/submit',{draft},{origin:'https://other.example'}); assert.equal(crossOrigin.status,403);
    assert.equal((await call(api,'/api/contracts/submit',{draft},{host:'evil.example'})).status,403);
  } finally {
    assert(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory,{recursive:true,force:true});
  }
});

test('the example endpoint supplies the same approved source used to validate contracts', async () => {
  const directory = await mkdtemp(join(tmpdir(),'quickgrid-example-'));
  try {
    const api = await createContractAPI({environment:{},stateURL:pathToFileURL(join(directory,'state.json'))});
    const result = {};
    const res = {writeHead(status,headers){result.status=status;result.headers=headers;return this;},end(value){result.body=JSON.parse(value);}};
    assert.equal(await api({method:'GET',headers:{host:'127.0.0.1:4177'}},res,'/api/contracts/example'),true);
    assert.equal(result.status,200); assert.equal(result.body.simulated,true);
    assert.deepEqual(result.body.source,createContractExample());
    const draft = createContractDraft(result.body.source,'P-004',{id:'server-example-review',now:'2026-10-24T18:00:00Z'});
    assert.equal((await call(api,'/api/contracts/state',{draft})).status,200);
    await api({method:'GET',headers:{host:'untrusted.example'}},res,'/api/contracts/example');
    assert.equal(result.status,403);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
