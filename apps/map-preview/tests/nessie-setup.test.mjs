import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {createNessieSetup, nessieDemoOwners, nessieDemoTarget,runNessieSetupCLI} from '../server/nessie-setup.mjs';

const CONFIG = {NESSIE_API_KEY:'test-only-key',NESSIE_API_ORIGIN:'https://prod-api.nessieisreal.com'};
function provider({failAccountResponse = false, duplicateCustomer = false, failBeforeAccountCreate = false} = {}) {
  const customers = [], accounts = [], calls = [];let responseLost = failAccountResponse;
  if (duplicateCustomer) for (let i = 0;i < 2;i++) customers.push({...nessieDemoTarget('CAL-POWER').customer,_id:`duplicate-${i}`});
  return {customers,accounts,calls,fetcher:async (url,options) => {
    assert.equal(url.searchParams.get('key'),'test-only-key');assert.equal(options.redirect,'error');
    assert(!url.pathname.includes('transfers'));calls.push({path:url.pathname,method:options.method});
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.pathname === '/customers' && options.method === 'GET') return Response.json(customers);
    if (url.pathname === '/customers' && options.method === 'POST') {
      const row = {...body,_id:`customer-${customers.length + 1}`};customers.push(row);
      return Response.json({code:201,objectCreated:row},{status:201});
    }
    const match = url.pathname.match(/^\/customers\/([^/]+)\/accounts$/);
    if (match && options.method === 'GET') return Response.json(accounts.filter(account => account.customer_id === match[1]));
    if (match && options.method === 'POST') {
      if (failBeforeAccountCreate) throw new Error('private provider URL and key must never escape');
      const row = {...body,_id:`account-${accounts.length + 1}`,customer_id:match[1]};accounts.push(row);
      if (responseLost) {responseLost = false;throw new Error('private key URL must never escape');}
      return Response.json({code:201,objectCreated:row},{status:201});
    }
    throw new Error('Unexpected test endpoint');
  }};
}
function checkpoint(initial = CONFIG) {
  let config = {...initial};const history = [];
  return {get config() {return {...config};},history,persist:async next => {config = {...next};history.push({...next});}};
}

test('setup owner coverage includes all map owners and independent standalone example owners', () => {
  const owners = nessieDemoOwners();
  assert.equal(owners.length,26);assert(owners.includes('O001'));assert(owners.includes('O024'));
  assert(owners.includes('OWNER-DEMO-004'));assert(owners.includes('OWNER-DEMO-009'));
  assert.equal(nessieDemoTarget('CAL-POWER').account.balance,10000000);
  assert.equal(nessieDemoTarget('O001').account.balance,0);
});

test('default check only reads and reports missing setup without changing private config', async () => {
  const api = provider(), saved = checkpoint();
  const result = await createNessieSetup({config:saved.config,persist:saved.persist,fetcher:api.fetcher,ownerIds:['O001','O002']}).run();
  assert.equal(result.ready,false);assert.equal(result.missingCustomers,3);
  assert.equal(result.matchedRecipients,0);assert.equal(saved.history.length,0);
  assert(api.calls.every(call => call.method === 'GET'));
  assert(!JSON.stringify(result).includes('test-only-key'));
});

test('create checkpoints each account, funds payer once, enables provider only after complete setup and reuses records on rerun', async () => {
  const api = provider(), saved = checkpoint();
  const run = () => createNessieSetup({config:saved.config,persist:saved.persist,fetcher:api.fetcher,ownerIds:['O001','OWNER-DEMO-004']});
  const result = await run().run({createAccounts:true,enableTransfers:true});
  assert.equal(result.ready,true);assert.equal(result.transfersEnabled,true);
  assert.equal(api.customers.length,3);assert.equal(api.accounts.length,3);
  assert.equal(api.accounts[0].balance,10000000);
  assert.deepEqual(api.accounts.slice(1).map(row => row.balance),[0,0]);
  assert.equal(saved.config.EASYGRID_PAYMENT_PROVIDER,'nessie');
  assert.equal(Object.keys(JSON.parse(saved.config.NESSIE_OWNER_RECIPIENTS)).length,2);
  const progress = saved.history.map(row => Object.keys(JSON.parse(row.NESSIE_OWNER_RECIPIENTS)).length);
  assert(progress.includes(1));assert(progress.includes(2));
  assert(saved.history.slice(0,-1).every(row => row.NESSIE_ALLOW_SANDBOX_TRANSFERS === 'no'));
  const posts = api.calls.filter(call => call.method === 'POST').length;
  await run().run({createAccounts:true});
  assert.equal(api.calls.filter(call => call.method === 'POST').length,posts);
  assert.equal(saved.config.NESSIE_ALLOW_SANDBOX_TRANSFERS,'no');
  const checks = await run().run();assert.equal(checks.ready,true);
  for (const row of [...api.customers,...api.accounts]) assert(!JSON.stringify(result).includes(row._id));
});

test('ambiguous same-name customers fail without creating duplicates', async () => {
  const api = provider({duplicateCustomer:true}), saved = checkpoint();
  await assert.rejects(createNessieSetup({config:saved.config,persist:saved.persist,fetcher:api.fetcher,ownerIds:['O001']}).run({createAccounts:true}),/More than one fictional customer/);
  assert.equal(api.calls.filter(call => call.method === 'POST').length,0);
  assert.equal(saved.config.NESSIE_ALLOW_SANDBOX_TRANSFERS,'no');
});

test('a lost account POST response is checkpointed and resumed by GET without a duplicate POST', async () => {
  const api = provider({failAccountResponse:true}), saved = checkpoint();
  const run = () => createNessieSetup({config:saved.config,persist:saved.persist,fetcher:api.fetcher,ownerIds:['O001']});
  await assert.rejects(run().run({createAccounts:true}),error => /outcome is uncertain/.test(error.message) && !error.message.includes('private key'));
  assert.equal(api.accounts.length,1);
  assert.equal(JSON.parse(saved.config.NESSIE_SETUP_STATE).pending.kind,'account');
  const result = await run().run({createAccounts:true});
  assert.equal(result.ready,true);assert.equal(api.accounts.length,2);
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.path === '/customers/customer-1/accounts').length,1);
  assert.equal(JSON.parse(saved.config.NESSIE_SETUP_STATE).pending,null);
});

test('an uncertain POST with no visible record stays blocked across reruns instead of blindly retrying', async () => {
  const api = provider({failBeforeAccountCreate:true}), saved = checkpoint();
  const run = () => createNessieSetup({config:saved.config,persist:saved.persist,fetcher:api.fetcher,ownerIds:['O001']});
  await assert.rejects(run().run({createAccounts:true}),/outcome is uncertain/);
  const count = api.calls.filter(call => call.method === 'POST').length;
  await assert.rejects(run().run({createAccounts:true}),/unresolved outcome/);
  assert.equal(api.calls.filter(call => call.method === 'POST').length,count);
  const result = await run().run();assert.equal(result.ready,false);assert.equal(result.pendingOperation,true);
});

test('existing saved payout mapping cannot be silently replaced', async () => {
  const api = provider(), saved = checkpoint();
  const options = {persist:saved.persist,fetcher:api.fetcher,ownerIds:['O001']};
  await createNessieSetup({...options,config:saved.config}).run({createAccounts:true});
  const wrong = {...saved.config,NESSIE_OWNER_RECIPIENTS:JSON.stringify({O001:{accountId:'different-account',customerId:'customer-2'}})};
  const posts = api.calls.filter(call => call.method === 'POST').length;
  await assert.rejects(createNessieSetup({...options,config:wrong}).run({createAccounts:true}),/payout mapping differs/);
  assert.equal(api.calls.filter(call => call.method === 'POST').length,posts);
});

test('checkpoint failure stops before external creation and check cannot enable transfers', async () => {
  const api = provider();
  await assert.rejects(createNessieSetup({config:CONFIG,fetcher:api.fetcher,ownerIds:['O001'],persist:async () => {throw new Error('private file detail');}}).run({createAccounts:true}),/checkpoint could not be saved/);
  assert.equal(api.calls.length,0);
  await assert.rejects(createNessieSetup({config:CONFIG,fetcher:api.fetcher,ownerIds:['O001']}).run({enableTransfers:true}),/requires/);
  assert.equal(api.calls.length,0);
});

test('duplicate account nickname and changed synthetic address stop without creating a replacement', async () => {
  const api = provider(), saved = checkpoint(), options = {persist:saved.persist,fetcher:api.fetcher,ownerIds:['O001']};
  await createNessieSetup({...options,config:saved.config}).run({createAccounts:true});
  const posts = api.calls.filter(call => call.method === 'POST').length;
  api.accounts.push({...api.accounts[0],_id:'duplicate-account'});
  await assert.rejects(createNessieSetup({...options,config:saved.config}).run(),/More than one account/);
  api.accounts.pop();api.customers[0].address.zip = '00000';
  await assert.rejects(createNessieSetup({...options,config:saved.config}).run({createAccounts:true}),/unexpected identity or address/);
  assert.equal(api.calls.filter(call => call.method === 'POST').length,posts);
});

test('CLI privately persists parseable configuration, restricts file permissions and read-only check leaves it untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(),'easygrid-nessie-setup-'));
  const file = join(directory,'.env.nessie'), api = provider();
  try {
    await writeFile(file,"NESSIE_API_KEY='test-only-key'\nNESSIE_API_ORIGIN=https://prod-api.nessieisreal.com\nEASYGRID_PREVIEW_PORT=4182\n",{mode:0o644});
    const result = await runNessieSetupCLI(['--create-demo-accounts',`--env-file=${file}`],{fetcher:api.fetcher});
    assert.equal(result.ready,true);assert.equal(result.ownerCount,26);assert.equal(result.transfersEnabled,false);
    const content = await readFile(file,'utf8'), config = parseEnv(content);
    assert.equal(config.NESSIE_API_KEY,'test-only-key');assert.equal(config.EASYGRID_PREVIEW_PORT,'4182');
    assert.equal(Object.keys(JSON.parse(config.NESSIE_OWNER_RECIPIENTS)).length,26);
    assert.equal((await stat(file)).mode & 0o777,0o600);
    await assert.rejects(stat(`${file}.setup.lock`),{code:'ENOENT'});
    const before = api.calls.length;
    const check = await runNessieSetupCLI(['--check',`--env-file=${file}`],{fetcher:api.fetcher});
    assert.equal(check.ready,true);assert.equal(await readFile(file,'utf8'),content);
    assert(api.calls.slice(before).every(call => call.method === 'GET'));
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('CLI reads the latest pending checkpoint after lock acquisition and cannot resend an uncertain creation', async () => {
  const directory = await mkdtemp(join(tmpdir(),'easygrid-nessie-lock-'));
  const file = join(directory,'.env.nessie'), api = provider();
  const original = "NESSIE_API_KEY='test-only-key'\nNESSIE_API_ORIGIN=https://prod-api.nessieisreal.com\n";
  try {
    await writeFile(file,original,{mode:0o600});
    const acquireLock = async path => {
      // Model another process finishing between this invocation and gaining exclusion.
      // Its POST response was lost and its customer is not visible to GET yet.
      const pending = JSON.stringify({schemaVersion:1,customers:{},pending:{kind:'customer',targetId:'CAL-POWER'}});
      await writeFile(file,original + `NESSIE_SETUP_STATE='${pending}'\n`,{mode:0o600});
      return open(path,'wx',0o600);
    };
    await assert.rejects(runNessieSetupCLI(['--create-demo-accounts',`--env-file=${file}`],{fetcher:api.fetcher,acquireLock}),/unresolved outcome/);
    assert(api.calls.every(call => call.method === 'GET'));
    assert.equal(api.customers.length,0);assert.equal(api.accounts.length,0);
    const saved = parseEnv(await readFile(file,'utf8'));
    assert.equal(JSON.parse(saved.NESSIE_SETUP_STATE).pending.kind,'customer');
    await assert.rejects(stat(`${file}.setup.lock`),{code:'ENOENT'});
  } finally {await rm(directory,{recursive:true,force:true});}
});
