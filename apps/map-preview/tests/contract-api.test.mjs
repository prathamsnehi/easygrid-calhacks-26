import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
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
    assert.equal(paid.body.payment.amountCents,1200000);
    for (const stage of ['initial','balance']) assert.equal((await call(api,'/api/contracts/submit',{draft,stage})).status,409);
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

test('Nessie readiness is explicit in config and contract state without exposing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(),'quickgrid-nessie-config-'));
  try {
    const environment = {
      EASYGRID_PAYMENT_PROVIDER:'nessie',NESSIE_API_ORIGIN:'https://prod-api.nessieisreal.com',NESSIE_API_KEY:'private-test-key',
      NESSIE_PAYER_ACCOUNT_ID:'private-payer-account',NESSIE_ALLOW_SANDBOX_TRANSFERS:'no',
      NESSIE_OWNER_RECIPIENTS:JSON.stringify({'OWNER-DEMO-004':{accountId:'private-owner-account',customerId:'private-owner-customer'}}),
    };
    const api = await createContractAPI({environment,stateURL:pathToFileURL(join(directory,'state.json')),fetcher:async () => {throw new Error('No provider request expected.');}});
    const result = {}, res = {writeHead(status) {result.status=status;return this;},end(value) {result.body=JSON.parse(value);}};
    await api({method:'GET',headers:{host:'127.0.0.1:4177'}},res,'/api/contracts/config');
    assert.equal(result.status,200);assert.equal(result.body.bankMode,'nessie-sandbox');assert.equal(result.body.paymentsEnabled,false);
    assert.equal(result.body.paymentSemantics,'record-only');assert.equal(result.body.amountIncrementCents,100);
    const draft = createContractDraft(createContractExample(),'P-004',{id:'nessie-read-only-draft'});
    const execution = await call(api,'/api/contracts/state',{draft});
    assert.equal(execution.status,200);assert.equal(execution.body.bankMode,'nessie-sandbox');assert.equal(execution.body.paymentsEnabled,false);
    assert.equal(execution.body.paymentSemantics,'record-only');assert.equal(execution.body.amountIncrementCents,100);
    for(const value of ['private-test-key','private-payer-account','private-owner-account','private-owner-customer']) assert(!JSON.stringify({config:result.body,state:execution.body}).includes(value));
    const persisted = JSON.parse(await readFile(join(directory,'nessie-full-contract-ledger.json'),'utf8'));
    assert.equal(persisted.bankMode,'nessie-sandbox');assert.match(persisted.bankIdentity,/^[a-f0-9]{64}$/);
    for (const change of [{NESSIE_PAYER_ACCOUNT_ID:'other-payer-account'},{NESSIE_API_ORIGIN:'https://api.nessieisreal.com'}]) {
      await assert.rejects(createContractAPI({environment:{...environment,...change},stateURL:pathToFileURL(join(directory,'state.json'))}),/different bank identity/);
    }
    await createContractAPI({environment:{...environment,NESSIE_API_KEY:'rotated-test-key'},stateURL:pathToFileURL(join(directory,'state.json'))});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('a copied local simulation contract ledger is never accepted as Nessie proof', async () => {
  const directory = await mkdtemp(join(tmpdir(),'quickgrid-provider-ledger-'));
  try {
    const options = {environment:{},stateURL:pathToFileURL(join(directory,'state.json'))};
    const simulation = await createContractAPI(options), draft = createContractDraft(createContractExample(),'P-004',{id:'provider-tagged'});
    await call(simulation,'/api/contracts/state',{draft});
    const state = JSON.parse(await readFile(join(directory,'full-contract-ledger.json'),'utf8'));
    await writeFile(join(directory,'nessie-full-contract-ledger.json'),JSON.stringify(state));
    const environment = {EASYGRID_PAYMENT_PROVIDER:'nessie',NESSIE_API_ORIGIN:'https://prod-api.nessieisreal.com',NESSIE_API_KEY:'test-key',
      NESSIE_PAYER_ACCOUNT_ID:'test-payer',NESSIE_OWNER_RECIPIENTS:JSON.stringify({'OWNER-DEMO-004':{accountId:'test-payee',customerId:'test-customer'}})};
    await assert.rejects(createContractAPI({...options,environment}),/different payment provider/);
    delete state.bankMode;
    await writeFile(join(directory,'nessie-full-contract-ledger.json'),JSON.stringify(state));
    await assert.rejects(createContractAPI({...options,environment}),/untagged contract ledger/);
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('the new standalone demo preserves an earlier staged-payment fixture ledger untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(),'easygrid-full-fixture-'));
  try {
    const legacy = JSON.stringify({schemaVersion:1,documents:{},obligations:{'initial-legacy':{status:'paid',amountCents:240000}},audit:[],journal:[],construction:{sessionId:'earlier-demo',routeId:'old-route',routeVersion:1}});
    const oldPath = join(directory,'contract-ledger.json');await writeFile(oldPath,legacy);
    const api = await createContractAPI({environment:{},stateURL:pathToFileURL(join(directory,'ledger.json'))});
    const source = createContractExample(),draft = createContractDraft(source,'P-004',{id:'new-full-fixture'});
    const state = await call(api,'/api/contracts/state',{draft});
    assert.equal(state.status,200,state.body.error);assert.equal(state.body.payment,null);
    assert.equal(await readFile(oldPath,'utf8'),legacy);
    assert.deepEqual(JSON.parse(await readFile(join(directory,'full-contract-ledger.json'),'utf8')).obligations,{});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('a new Nessie full fixture cannot bypass any legacy attempted or uncertain payment', async () => {
  const directory = await mkdtemp(join(tmpdir(),'easygrid-nessie-migration-'));
  try {
    let requests = 0;
    const environment = {EASYGRID_PAYMENT_PROVIDER:'nessie',NESSIE_API_ORIGIN:'https://prod-api.nessieisreal.com',NESSIE_API_KEY:'test-key',
      NESSIE_PAYER_ACCOUNT_ID:'test-payer',NESSIE_ALLOW_SANDBOX_TRANSFERS:'yes',
      NESSIE_OWNER_RECIPIENTS:JSON.stringify({'OWNER-DEMO-004':{accountId:'test-payee',customerId:'test-customer'}})};
    const options = {environment,stateURL:pathToFileURL(join(directory,'state.json')),fetcher:async () => {requests++;throw new Error('No provider request expected.');}};
    // A pre-existing new ledger must not hide a legacy one discovered on restart.
    const api = await createContractAPI(options), draft = createContractDraft(createContractExample(),'P-004',{id:'new-nessie-full'});
    await call(api,'/api/contracts/state',{draft});
    const fullPath = join(directory,'nessie-full-contract-ledger.json'), full = await readFile(fullPath,'utf8');
    const legacyPath = join(directory,'nessie-contract-ledger.json');
    const examples = ['checking','processing','unknown','submitted','paid','review-required'].map(status => ({status}));
    examples.push({status:'held',transactionRef:'previous-transfer'},{status:'rejected',transactionRef:'previous-transfer'});
    for (const stage of ['initial','balance']) for (const example of examples) {
      const legacy = JSON.stringify({schemaVersion:1,documents:{},obligations:{'old-obligation':{id:'old-obligation',stage,parcelId:'P-004',amountCents:240000,...example}},audit:[],journal:[]});
      await writeFile(legacyPath,legacy);
      await assert.rejects(createContractAPI(options),/legacy Nessie fixture has a payment attempt/);
      assert.equal(await readFile(legacyPath,'utf8'),legacy);
      assert.equal(await readFile(fullPath,'utf8'),full);
    }
    const journalOnly = JSON.stringify({schemaVersion:1,documents:{},obligations:{},audit:[],journal:[{obligationId:'orphaned-initial',debitCents:240000,creditCents:240000}]});
    await writeFile(legacyPath,journalOnly);
    await assert.rejects(createContractAPI(options),/legacy Nessie fixture has a payment attempt/);
    assert.equal(await readFile(legacyPath,'utf8'),journalOnly);
    await writeFile(legacyPath,'{broken');
    await assert.rejects(createContractAPI(options),/legacy Nessie ledger could not be loaded/);
    const unattempted = JSON.stringify({schemaVersion:1,documents:{},obligations:{'old-hold':{id:'old-hold',stage:'initial',parcelId:'P-004',status:'held',amountCents:240000}},audit:[],journal:[]});
    await writeFile(legacyPath,unattempted);
    const restored = await createContractAPI(options), state = await call(restored,'/api/contracts/state',{draft});
    assert.equal(state.status,200);assert.equal(state.body.payment,null);assert.deepEqual(state.body.signatures,{});
    assert.equal(await readFile(legacyPath,'utf8'),unattempted);
    assert.equal(requests,0);
  } finally {await rm(directory,{recursive:true,force:true});}
});
