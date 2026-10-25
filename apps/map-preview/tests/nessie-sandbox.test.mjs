import test from 'node:test';
import assert from 'node:assert/strict';
import {createNessieSandboxBank, dollarsToCents} from '../server/nessie-sandbox.mjs';

const input = {ownerId:'OWNER-DEMO-004',obligationId:'full-fixture',amountCents:1200000,documentHash:'a'.repeat(64)};
const config = {apiKey:'test-only-key',baseUrl:'https://prod-api.nessieisreal.com',payerId:'sandbox-payer',recipients:{'OWNER-DEMO-004':{accountId:'sandbox-payee',customerId:'sandbox-customer'}}};
function transport({complete = true, wrongAccount = false, failPost = false, missingTransactionId = false} = {}) {
  const calls = []; let created = false;
  const row = () => ({_id:'transfer-fixture',payer_id:'sandbox-payer',payee_id:'sandbox-payee',amount:12000,status:complete?'completed':'pending',description:`EasyGrid ${input.obligationId} ${input.documentHash}`});
  return {calls, fetcher:async (url, options) => {
    assert.equal(url.searchParams.get('key'),'test-only-key'); assert.equal(options.redirect,'error');
    calls.push({path:url.pathname,method:options.method,body:options.body});
    if (options.method === 'POST') {
      if (failPost) throw new Error('private upstream key must not escape');
      assert.deepEqual(JSON.parse(options.body),{medium:'balance',payee_id:'sandbox-payee',amount:12000,description:row().description});
      created = true; return Response.json({objectCreated:{_id:'transfer-fixture'}},{status:201});
    }
    if (url.pathname === '/accounts/sandbox-payer') return Response.json({_id:wrongAccount?'different':'sandbox-payer',balance:10000});
    if (url.pathname === '/accounts/sandbox-payee') return Response.json({_id:'sandbox-payee',customer_id:'sandbox-customer'});
    if (url.pathname === '/accounts/sandbox-payer/transfers') return Response.json(created?[row()]:[]);
    if (url.pathname === '/transfers/transfer-fixture') return Response.json(missingTransactionId ? {...row(),_id:undefined} : row());
    throw new Error('Unexpected endpoint.');
  }};
}

test('Nessie uses verified account-scoped reads and a single explicitly enabled sandbox transfer', async () => {
  const mock = transport(), bank = createNessieSandboxBank({...config,allowTransfers:true,fetcher:mock.fetcher});
  const before = await bank.inspect(input); assert.equal(before.balanceCents,1000000); assert.equal(before.existingEvidence,null);
  const receipt = await bank.transfer(input); assert.equal(receipt.status,'completed'); assert.equal(receipt.amountCents,1200000); assert.equal(receipt.recipientMatches,true);
  assert.equal(mock.calls.filter(row => row.method === 'POST').length,1);
  const after = await bank.inspect(input); assert.equal(after.existingEvidence.transactionRef,'nessie-transfer-fixture');
  const exposed = JSON.stringify(receipt); for (const secret of ['test-only-key','sandbox-payer','sandbox-payee']) assert(!exposed.includes(secret));
});

test('a sandbox acknowledgement stays pending until completed matching bank evidence exists', async () => {
  const mock = transport({complete:false}), bank = createNessieSandboxBank({...config,allowTransfers:true,fetcher:mock.fetcher});
  assert.equal((await bank.transfer(input)).status,'pending');
});

test('Nessie refuses unsafe origins, mismatched identities, missing mappings and unapproved writes', async () => {
  for (const baseUrl of ['http://prod-api.nessieisreal.com','https://example.com','https://prod-api.nessieisreal.com@evil.example','https://prod-api.nessieisreal.com/?leak=1']) assert.throws(() => createNessieSandboxBank({...config,baseUrl}),/HTTPS/);
  const mock = transport({wrongAccount:true}), bank = createNessieSandboxBank({...config,fetcher:mock.fetcher});
  await assert.rejects(bank.inspect(input),/identity/); assert.equal(mock.calls.some(call => call.method === 'POST'),false);
  await assert.rejects(bank.transfer(input),/disabled/);
  await assert.rejects(bank.inspect({...input,ownerId:'unmapped-owner'}),/recipient/);
  const failure = transport({failPost:true});
  await assert.rejects(createNessieSandboxBank({...config,allowTransfers:true,fetcher:failure.fetcher}).transfer(input), error => error.message === 'Nessie sandbox request could not be confirmed.');
});

test('bank dollar conversion preserves cents and rejects fractional cents or overflow', () => {
  assert.equal(dollarsToCents(2400.01),240001); assert.equal(dollarsToCents('0.05'),5);
  for (const invalid of ['1.001',-1,NaN,Infinity,'1e10','90071992547409999']) assert.throws(() => dollarsToCents(invalid));
});

test('a bank response without a verifiable transaction ID cannot prove a completed payment', async () => {
  const mock = transport({missingTransactionId:true});
  const bank = createNessieSandboxBank({...config,allowTransfers:true,fetcher:mock.fetcher});
  await assert.rejects(bank.transfer(input),/transaction identity/);
  assert.equal(mock.calls.filter(row => row.method === 'POST').length,1);
});


test('payer and API origin are part of sandbox authorization and storage identity', () => {
  const bank=createNessieSandboxBank(config);
  const otherPayer=createNessieSandboxBank({...config,payerId:'another-payer'});
  assert.notEqual(bank.recipientBinding(input.ownerId),otherPayer.recipientBinding(input.ownerId));
  assert.notEqual(bank.storageNamespace,otherPayer.storageNamespace);
  const otherRecipient=createNessieSandboxBank({...config,recipients:{[input.ownerId]:{accountId:'another-payee',customerId:'sandbox-customer'}}});
  assert.equal(bank.storageNamespace,otherRecipient.storageNamespace);
  assert.notEqual(bank.recipientBinding(input.ownerId),otherRecipient.recipientBinding(input.ownerId));
});

test('terminal failed transfer evidence is preserved and a different transfer ID is rejected', async () => {
  for (const status of ['failed','rejected','cancelled']) {
    const mock=transport();
    const fetcher=async (url,options) => {
      const response=await mock.fetcher(url,options);
      if(url.pathname==='/transfers/transfer-fixture') return Response.json({...await response.json(),status});
      return response;
    };
    const result=await createNessieSandboxBank({...config,allowTransfers:true,fetcher}).transfer(input);
    assert.equal(result.status,status==='cancelled'?'rejected':status);
  }
  const mock=transport();
  const fetcher=async(url,options)=>{
    const response=await mock.fetcher(url,options);
    return url.pathname==='/transfers/transfer-fixture'?Response.json({...await response.json(),_id:'unrelated-transfer'}):response;
  };
  await assert.rejects(createNessieSandboxBank({...config,allowTransfers:true,fetcher}).transfer(input),/different transaction identity/);
});
