import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostedPreview} from '../server/hosted-preview.mjs';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractDraft} from '../src/contract-authoring.js';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {mapContractRequest} from '../src/contract-handoff.js';

const origin = 'https://easygrid.example';
const copy = value => structuredClone(value);

/** Model D1 compare-and-swap, including independent reads by concurrent workers. */
function fakeDatabase() {
  const rows = new Map();
  const database = {rows, reads:0, writes:0, conflicts:0, failures:0, beforeWrite:null,
    prepare(sql) {
      assert(!/CREATE|ALTER/i.test(sql), 'request handlers must not run migrations');
      return {bind(...args) {
        return {
          async first() {
            assert.match(sql, /^SELECT\s+revision\s*,\s*snapshot_json\s+FROM\s+worker_state\s+WHERE\s+id\s*=\s*\?/i);
            database.reads++;
            return rows.has(args[0]) ? copy(rows.get(args[0])) : null;
          },
          async run() {
            database.writes++;
            if (database.beforeWrite) await database.beforeWrite();
            if (database.failures > 0) {database.failures--; throw new Error('private database connection failure');}
            if (database.conflicts > 0) {database.conflicts--; return {meta:{changes:0}};}
            if (/^INSERT\s+INTO\s+worker_state/i.test(sql)) {
              const [id,snapshot_json] = args;
              assert.match(sql, /ON\s+CONFLICT\s*\(id\)\s+DO\s+NOTHING/i);
              if (rows.has(id)) return {meta:{changes:0}};
              rows.set(id,{revision:1,snapshot_json});
            } else {
              assert.match(sql, /^UPDATE\s+worker_state\s+SET\s+revision\s*=\s*\?/i);
              const [revision,snapshot_json,id,previous] = args;
              if (rows.get(id)?.revision !== previous) return {meta:{changes:0}};
              assert.equal(revision,previous + 1);
              rows.set(id,{revision,snapshot_json});
            }
            return {meta:{changes:1}};
          },
        };
      }};
    },
  };
  return database;
}

function request(path, body, {identity='owner-1', headers={}, method=body === undefined ? 'GET' : 'POST'} = {}) {
  return new Request(`${origin}${path}`,{method,
    headers:{...(identity ? {'oai-authenticated-user-id':identity} : {}),
      ...(method === 'POST' ? {origin,'content-type':'application/json','x-easygrid-demo':'1'} : {}),...headers},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
}
async function call(handler, path, body, options) {
  const response = await handler(request(path,body,options));
  return {status:response.status, body:await response.json()};
}
const operation = (handler, name, body, options) => call(handler,`/api/contracts/${name}`,body,options);
async function successful(result) {
  const value = await result;
  assert.equal(value.status,200,JSON.stringify(value.body));
  return value.body;
}

test('hosted APIs require durable storage and platform identity; static paths remain delegated', async () => {
  assert.equal(await createHostedPreview({})(request('/')),null);
  assert.equal((await call(createHostedPreview({}),'/api/contracts/config')).status,503);
  const database = fakeDatabase(), handler = createHostedPreview({database});
  assert.equal((await call(handler,'/api/contracts/config',undefined,{identity:null})).status,401);
  assert.equal(database.reads,0); assert.equal(database.writes,0);
});

test('hosted mutation boundary rejects foreign or missing origins and request markers before reading state', async () => {
  const database = fakeDatabase(), handler = createHostedPreview({database});
  for (const headers of [
    {origin:'https://attacker.example'}, {origin:''},
    {'x-easygrid-demo':''}, {'content-type':'text/plain'},
  ]) {
    assert.equal((await operation(handler,'sign/utility',{}, {headers})).status,403);
  }
  assert.equal(database.reads,0); assert.equal(database.writes,0);
});

test('hosted preview reports simulation, serves the approved example, and never enables voice', async () => {
  const database = fakeDatabase(), handler = createHostedPreview({database});
  const config = await successful(call(handler,'/api/contracts/config'));
  assert.equal(config.bankMode,'simulation');
  assert.equal(config.paymentSemantics,'simulated-transfer');
  const example = await successful(call(handler,'/api/contracts/example'));
  assert.equal(example.simulated,true);
  assert.deepEqual(example.source,createContractExample());
  const voice = await successful(call(handler,'/api/voice/config'));
  assert.equal(voice.enabled,false);
  for (const path of ['/api/voice/calls','/api/voice/tools/response','/api/voice/tools/counteroffer']) {
    assert.equal((await call(handler,path,{})).status,503);
  }
  assert.equal(database.writes,0,'read-only configuration does not create an empty durable ledger');
});

test('oversized or malformed requests fail before loading a ledger', async () => {
  const database = fakeDatabase(), handler = createHostedPreview({database});
  assert.equal((await operation(handler,'state',{padding:'x'.repeat(256000)})).status,413);
  assert.equal((await operation(handler,'state',{}, {headers:{'content-length':'256001'}})).status,413);
  const malformed = new Request(`${origin}/api/contracts/state`,{method:'POST',
    headers:{origin,'content-type':'application/json','x-easygrid-demo':'1','oai-authenticated-user-id':'owner-1'},body:'{'});
  assert.equal((await handler(malformed)).status,400);
  assert.equal(database.reads,0); assert.equal(database.writes,0);
});

test('corrupt stored snapshots fail closed without replacing existing evidence', async () => {
  for (const row of [
    {revision:1,snapshot_json:'not valid json'},
    {revision:0,snapshot_json:JSON.stringify({schemaVersion:1,files:{}})},
    {revision:1,snapshot_json:JSON.stringify({schemaVersion:2,files:{}})},
    {revision:1,snapshot_json:JSON.stringify({schemaVersion:1,files:[]})},
    {revision:1,snapshot_json:JSON.stringify({schemaVersion:1,files:{'file:///easygrid-preview/full-contract-ledger.json':{invalid:'existing-evidence'}}})},
  ]) {
    const database = fakeDatabase(); database.rows.set('easygrid:owner-1',copy(row));
    const result = await call(createHostedPreview({database}),'/api/contracts/config');
    assert.equal(result.status,503);
    assert.deepEqual(database.rows.get('easygrid:owner-1'),row);
    assert.equal(database.writes,0);
    assert(!JSON.stringify(result.body).includes('existing-evidence'));
  }
});

test('signatures survive new handlers and gate one 100 percent simulated payment without duplicate journals', async () => {
  const database = fakeDatabase(), source = createContractExample();
  let handler = createHostedPreview({database});
  const drafts = source.parcels.map(parcel=>createContractDraft(source,parcel.parcelId,{id:`hosted-${parcel.parcelId}`}));
  assert.equal((await operation(handler,'submit',{draft:drafts[0]})).status,409);
  for (const draft of drafts) {
    await successful(operation(handler,'sign/utility',{draft}));
    handler = createHostedPreview({database});
    await successful(operation(handler,'sign/landowner',{draft}));
  }
  handler = createHostedPreview({database});
  const [paid,repeat] = await Promise.all([
    successful(operation(handler,'submit',{draft:drafts[0]})),
    successful(operation(createHostedPreview({database}),'submit',{draft:drafts[0]})),
  ]);
  for (const value of [paid,repeat]) {
    assert.equal(value.payment.status,'paid');
    assert.equal(value.payment.amountCents,source.parcels[0].compensationCents);
    assert.equal(value.journal.length,1);
    assert.equal(value.journal[0].stage,'full');
    assert.equal(value.balancePayment,undefined);
  }
  const restored = await successful(operation(createHostedPreview({database}),'state',{draft:drafts[0]}));
  assert.equal(restored.journal.length,1); assert.equal(restored.payment.status,'paid');
  assert.equal(database.rows.size,1);
  assert(database.rows.has('easygrid:owner-1'));
});

test('concurrent distinct signers retain both signatures after compare-and-swap retry', async () => {
  const database = fakeDatabase(), draft = createContractDraft(createContractExample(),'P-004',{id:'concurrent-signatures'});
  await Promise.all([
    successful(operation(createHostedPreview({database}),'sign/utility',{draft})),
    successful(operation(createHostedPreview({database}),'sign/landowner',{draft})),
  ]);
  const restored = await successful(operation(createHostedPreview({database}),'state',{draft}));
  assert(restored.signatures.utility); assert(restored.signatures.landowner);
  assert(database.writes >= 3,'a stale request is replayed against the committed snapshot');
});

test('ledger identity comes only from authenticated platform headers', async () => {
  const database = fakeDatabase(), draft = createContractDraft(createContractExample(),'P-004',{id:'isolated-draft'});
  await successful(operation(createHostedPreview({database}),'sign/utility',{draft,identity:'owner-2',userId:'owner-2'}));
  const stranger = await successful(operation(createHostedPreview({database}),'state',{draft},{identity:'owner-2'}));
  assert.deepEqual(stranger.signatures,{});
  const owner = await successful(operation(createHostedPreview({database}),'state',{draft}));
  assert(owner.signatures.utility);
  assert.equal(database.rows.size,2);
});

test('successful mutation response waits for D1 commit and database failures never report a signature', async () => {
  const database = fakeDatabase(), draft = createContractDraft(createContractExample(),'P-004',{id:'durable-signature'});
  let release,entered;
  const atWrite = new Promise(resolve=>{entered=resolve;});
  database.beforeWrite = async()=>{entered();await new Promise(resolve=>{release=resolve;});};
  let completed = false;
  const pending = operation(createHostedPreview({database}),'sign/utility',{draft}).then(value=>{completed=true;return value;});
  await atWrite; await Promise.resolve();
  assert.equal(completed,false); assert.equal(database.rows.size,0);
  database.beforeWrite=null; release(); await successful(pending);
  const unavailable = fakeDatabase(); unavailable.failures=1;
  const result = await operation(createHostedPreview({database:unavailable}),'sign/utility',{draft});
  assert.equal(result.status,503); assert.equal(unavailable.rows.size,0);
  assert(!JSON.stringify(result.body).includes('private database'));
});

test('conflicts retry at most three times without reporting an uncommitted mutation', async () => {
  const database = fakeDatabase(), draft = createContractDraft(createContractExample(),'P-004',{id:'cas-signature'});
  database.conflicts=2;
  await successful(operation(createHostedPreview({database}),'sign/utility',{draft}));
  assert.equal(database.writes,3); assert.equal(database.rows.size,1);
  const blocked = fakeDatabase(); blocked.conflicts=10;
  const result = await operation(createHostedPreview({database:blocked}),'sign/utility',{draft});
  assert.equal(result.status,409); assert.equal(blocked.writes,3); assert.equal(blocked.rows.size,0);
});

test('map approval, participant contract and full payment persist through the same hosted adapter', async () => {
  const database = fakeDatabase(), world = createWorld();
  const substation = createPlacement(world,'substation',-43,-17);
  const placements = {substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
  const routes = computeTransmissionRoutes(world,placements), route = routes.candidates[0];
  const handoff = createHandoff({world,route,placements,analysis:analyzeRouteParcels(world,route,routes.assumptions),sessionId:'hosted-map',routeVersion:1});
  const context = mapContractRequest(handoff,placements);
  const approved = await successful(operation(createHostedPreview({database}),'approve-map',{
    context,demoScope:'single-owner',demoTarget:'participant',
  }));
  assert.equal(approved.demoParcelId,context.userParcelId);
  const draft = createContractDraft(approved.input,approved.demoParcelId,{id:'hosted-map-draft'});
  const command = {draft,packageId:approved.packageId,demoScope:approved.demoScope,demoParcelId:approved.demoParcelId};
  await successful(operation(createHostedPreview({database}),'sign/utility',command));
  await successful(operation(createHostedPreview({database}),'sign/landowner',command));
  const paid = await successful(operation(createHostedPreview({database}),'submit',command));
  assert.equal(paid.payment.status,'paid');
  assert.equal(paid.payment.amountCents,approved.input.parcels.find(p=>p.parcelId===approved.demoParcelId).compensationCents);
  assert.equal(paid.journal.length,1);
  const repeated = await successful(operation(createHostedPreview({database}),'submit',command));
  assert.equal(repeated.journal.length,1);
});
