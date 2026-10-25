import test from 'node:test';
import assert from 'node:assert/strict';
import {createNessieSandboxBank, dollarsToCents} from '../server/nessie-sandbox.mjs';

const input = {ownerId:'OWNER-DEMO-004',obligationId:'full-fixture',amountCents:1200000,documentHash:'a'.repeat(64)};
const config = {now:()=> '2026-10-25T10:00:00.000Z',apiKey:'test-only-key',baseUrl:'https://prod-api.nessieisreal.com',payerId:'sandbox-payer',recipients:{'OWNER-DEMO-004':{accountId:'sandbox-payee',customerId:'sandbox-customer'}}};
function transport({complete = true, wrongAccount = false, failPost = false, missingTransactionId = false} = {}) {
  const calls = []; let created = false;
  const row = () => ({id:'transfer-fixture',transaction_date:'2026-10-25',amount:12000,status:complete?'completed':'pending',description:`EasyGrid ${input.obligationId} ${input.documentHash} ${createNessieSandboxBank(config).recipientBinding(input.ownerId)}`});
  return {calls, fetcher:async (url, options) => {
    assert.equal(url.searchParams.get('key'),'test-only-key'); assert.equal(options.redirect,'error');
    calls.push({path:url.pathname,method:options.method,body:options.body});
    if (options.method === 'POST') {
      if (failPost) throw new Error('private upstream key must not escape');
      assert.deepEqual(JSON.parse(options.body),{transaction_date:'2026-10-25',status:'pending',amount:12000,description:row().description});
      created = true; return Response.json({objectCreated:{_id:'transfer-fixture'}},{status:201});
    }
    if (url.pathname === '/accounts/sandbox-payer') return Response.json({_id:wrongAccount?'different':'sandbox-payer',balance:10000});
    if (url.pathname === '/accounts/sandbox-payee') return Response.json({_id:'sandbox-payee',customer_id:'sandbox-customer'});
    if (url.pathname === '/accounts/sandbox-payer/transfers') return Response.json(created?[row()]:[]);
    if (url.pathname === '/transfers/transfer-fixture') return Response.json(missingTransactionId ? {...row(),id:undefined} : row());
    throw new Error('Unexpected endpoint.');
  }};
}

test('Nessie verifies one account-scoped API record without claiming a recipient transfer', async () => {
  const mock = transport(), bank = createNessieSandboxBank({...config,allowTransfers:true,fetcher:mock.fetcher});
  const before = await bank.inspect(input); assert.equal(before.balanceCents,1000000); assert.equal(before.existingEvidence,null);
  const receipt = await bank.transfer(input); assert.equal(receipt.status,'recorded'); assert.equal(receipt.amountCents,1200000); assert.equal(receipt.recipientMatches,true);
  assert.equal(mock.calls.filter(row => row.method === 'POST').length,1);
  const after = await bank.inspect(input); assert.equal(after.existingEvidence.transactionRef,'nessie-transfer-fixture');
  const exposed = JSON.stringify(receipt); for (const secret of ['test-only-key','sandbox-payer','sandbox-payee']) assert(!exposed.includes(secret));
});

test('a pending provider record is verified as recorded without claiming settlement', async () => {
  const mock = transport({complete:false}), bank = createNessieSandboxBank({...config,allowTransfers:true,fetcher:mock.fetcher});
  const receipt=await bank.transfer(input);
  assert.equal(receipt.status,'recorded');assert.equal(receipt.paymentSemantics,'record-only');
  assert.equal(bank.paymentSemantics,'record-only');assert.equal(bank.amountIncrementCents,100);
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
    return url.pathname==='/transfers/transfer-fixture'?Response.json({...await response.json(),id:'unrelated-transfer'}):response;
  };
  await assert.rejects(createNessieSandboxBank({...config,allowTransfers:true,fetcher}).transfer(input),/different transaction identity/);
});

test('the verified live empty-list 404 permits inspection before one transfer and later matching evidence', async () => {
  const mock = transport();
  const fetcher = async (url,options) => {
    const response = await mock.fetcher(url,options);
    if (options.method === 'GET' && url.pathname === '/accounts/sandbox-payer/transfers') {
      const rows = await response.json();
      return rows.length ? Response.json(rows) : Response.json('No transfers found for this account',{status:404});
    }
    return response;
  };
  const bank = createNessieSandboxBank({...config,allowTransfers:true,fetcher});
  const before = await bank.inspect(input);
  assert.equal(before.existingEvidence,null);assert.equal(before.recipientMatches,true);
  assert.deepEqual(mock.calls.map(call => call.path),['/accounts/sandbox-payer','/accounts/sandbox-payee','/accounts/sandbox-payer/transfers']);
  assert.equal(mock.calls.some(call => call.method === 'POST'),false);
  const receipt = await bank.transfer(input), after = await bank.inspect(input);
  assert.equal(receipt.status,'recorded');assert.equal(receipt.amountCents,input.amountCents);
  assert.deepEqual(after.existingEvidence,receipt);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length,1);
});

test('other transfer-list errors and malformed responses never become an empty collection', async () => {
  const emptyMessage = 'No transfers found for this account';
  const cases = [
    () => Response.json('Not Found',{status:404}),
    () => Response.json(`${emptyMessage}.`,{status:404}),
    () => Response.json({message:emptyMessage},{status:404}),
    () => Response.json([],{status:404}),
    () => Response.json(null,{status:404}),
    () => new Response(emptyMessage,{status:404}),
    () => new Response('"No transfers found',{status:404}),
    ...[401,403,500].map(status => () => Response.json(emptyMessage,{status})),
    () => Response.json(emptyMessage),
  ];
  for (const errorResponse of cases) {
    const mock = transport();
    const fetcher = async (url,options) => url.pathname === '/accounts/sandbox-payer/transfers' ? errorResponse() : mock.fetcher(url,options);
    const bank = createNessieSandboxBank({...config,allowTransfers:true,fetcher});
    await assert.rejects(bank.inspect(input),/HTTP|Invalid sandbox transfer evidence/);
    assert.equal(mock.calls.some(call => call.method === 'POST'),false);
  }
});

test('both account identities must be verified before the empty transfer-list exception applies', async () => {
  for (const failedPath of ['/accounts/sandbox-payer','/accounts/sandbox-payee']) {
    const calls = [], mock = transport();
    const fetcher = async (url,options) => {
      calls.push(url.pathname);
      return url.pathname === failedPath ? Response.json('No transfers found for this account',{status:404}) : mock.fetcher(url,options);
    };
    const bank = createNessieSandboxBank({...config,fetcher});
    await assert.rejects(bank.inspect(input),/HTTP 404/);
    assert(!calls.includes('/accounts/sandbox-payer/transfers'));
  }
  for (const changed of ['payer','payee','customer']) {
    let transferListRead = false;
    const mock = transport(), fetcher = async (url,options) => {
      if (url.pathname === '/accounts/sandbox-payer/transfers') {transferListRead = true;return Response.json('No transfers found for this account',{status:404});}
      const response = await mock.fetcher(url,options), row = await response.json();
      if (url.pathname === `/accounts/sandbox-${changed}`) row._id = 'another-account';
      if (changed === 'customer' && url.pathname === '/accounts/sandbox-payee') row.customer_id = 'another-customer';
      return Response.json(row);
    };
    await assert.rejects(createNessieSandboxBank({...config,fetcher}).inspect(input),/identity/);
    assert.equal(transferListRead,false);
  }
});

test('the empty-list message cannot turn a failed transfer POST or confirmation GET into success', async () => {
  for (const failure of ['POST','confirmation']) {
    const mock = transport(), fetcher = async (url,options) => {
      if (failure === 'POST' && options.method === 'POST' || failure === 'confirmation' && url.pathname === '/transfers/transfer-fixture') {
        return Response.json('No transfers found for this account',{status:404});
      }
      return mock.fetcher(url,options);
    };
    await assert.rejects(createNessieSandboxBank({...config,allowTransfers:true,fetcher}).transfer(input),/HTTP 404/);
  }
});


test('fractional approved amounts are never rounded or sent to the integer-only record API', async () => {
  const mock=transport(),bank=createNessieSandboxBank({...config,allowTransfers:true,fetcher:mock.fetcher});
  for (const amountCents of [1,5516,114499]) {
    assert.match(bank.amountIssue(amountCents),/whole-dollar/);
    await assert.rejects(bank.transfer({...input,amountCents}),/whole-dollar/);
  }
  assert.equal(mock.calls.length,0);
  assert.equal(bank.amountIssue(114400),null);
});

test('completed and executed API records remain record-only and require exact readback amount and context', async () => {
  for (const status of ['completed','executed']) {
    const mock=transport(),fetcher=async(url,options)=>{
      const response=await mock.fetcher(url,options);
      return url.pathname==='/transfers/transfer-fixture'?Response.json({...await response.json(),status}):response;
    };
    const receipt=await createNessieSandboxBank({...config,allowTransfers:true,fetcher}).transfer(input);
    assert.equal(receipt.status,'recorded');assert.equal(receipt.paymentSemantics,'record-only');
  }
  for (const change of [{amount:11999},{description:`EasyGrid ${input.obligationId} ${input.documentHash}`},{description:'unrelated record'}]) {
    const mock=transport(),fetcher=async(url,options)=>{
      const response=await mock.fetcher(url,options);
      return url.pathname==='/transfers/transfer-fixture'?Response.json({...await response.json(),...change}):response;
    };
    const receipt=await createNessieSandboxBank({...config,allowTransfers:true,fetcher}).transfer(input);
    assert(receipt.amountCents!==input.amountCents || receipt.recipientMatches===false);
  }
});

test('conflicting current and legacy record IDs cannot establish a verified API record', async () => {
  const mock=transport(),fetcher=async(url,options)=>{
    const response=await mock.fetcher(url,options);
    return url.pathname==='/transfers/transfer-fixture'?Response.json({...await response.json(),_id:'different-id'}):response;
  };
  await assert.rejects(createNessieSandboxBank({...config,allowTransfers:true,fetcher}).transfer(input),/conflicting record identities/);
});
