import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {mapContractRequest, contractSourceFromAgreement, simulatedMapAgreement} from '../src/contract-handoff.js';
import {createContractDraft, contractDocument} from '../src/contract-authoring.js';
import {createContractAPI} from '../server/contract-api.mjs';
import {createMapContractService, reconstructMapProposal} from '../server/map-contracts.mjs';
import {createDemoBank} from '../server/contract-workflow.mjs';

const world = createWorld();
const substation = createPlacement(world,'substation',-43,-17);
const placements = {substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const result = computeTransmissionRoutes(world,placements), route = result.candidates[0];
const analysis = analyzeRouteParcels(world,route,result.assumptions);
const clone = value => JSON.parse(JSON.stringify(value));
function proposal(version = 1, sessionId = 'map-contract-integration') {
  return createHandoff({world,route,analysis,placements,sessionId,routeVersion:version,
    participant:{alias:'Private participant name',phoneE164:'+12025550123',consent:true}});
}
function agreement(handoff = proposal()) {
  return simulatedMapAgreement(handoff,{negotiationId:'neg-current-map',approvedAt:'2026-10-24T20:00:00Z'});
}
async function call(api, operation, input) {
  const req = {method:'POST',headers:{host:'127.0.0.1:4177','content-type':'application/json','x-easygrid-demo':'1',origin:'http://127.0.0.1:4177'},
    async *[Symbol.asyncIterator]() {yield Buffer.from(JSON.stringify(input));}};
  const result = {};
  const res = {writeHead(status) {result.status=status;return this;},end(body) {result.body=JSON.parse(body);}};
  await api(req,res,`/api/contracts/${operation}`);return result;
}
async function withAPI(action) {
  const prefix = join(tmpdir(),'easygrid-map-contract-'), directory = await mkdtemp(prefix);
  const options = {environment:{},stateURL:pathToFileURL(join(directory,'ledger.json'))};
  try {await action(await createContractAPI(options),options,directory);}
  finally {assert(resolve(directory).startsWith(resolve(prefix)));await rm(directory,{recursive:true,force:true});}
}

test('map contract inputs preserve the selected session, route, all original owners and exact compensation without contact', () => {
  const handoff = proposal(), context = mapContractRequest(handoff,placements);
  const source = contractSourceFromAgreement(agreement(handoff),handoff);
  assert.equal(source.sessionId,handoff.sessionId);assert.equal(source.route.id,handoff.ownerHandoff.routeId);
  assert.deepEqual(source.parcels.map(p => p.parcelId).sort(),[...route.parcelIds].sort());
  for (const parcel of source.parcels) {
    const original = handoff.ownerHandoff.parcels.find(p => p.parcelId === parcel.parcelId);
    assert.equal(parcel.ownerId,original.ownerId);assert.equal(parcel.compensationCents,original.terms.compensationCents);
    const doc = contractDocument(createContractDraft(source,parcel.parcelId),source);
    assert.equal(doc.initialCents + doc.completionCents,original.terms.compensationCents);
    assert.equal(doc.ownerName,world.ownerById.get(parcel.ownerId).alias);
  }
  const serialized = JSON.stringify({context,source});
  assert(!serialized.includes('Private participant name'));assert(!serialized.includes('+12025550123'));
  assert(!source.parcels.some(p => p.ownerId.startsWith('OWNER-DEMO-')));
});

test('selection and call consent cannot grant agreement; missing, stale, changed-recipient and unsigned terms are rejected', () => {
  const handoff = proposal();
  assert.throws(() => contractSourceFromAgreement({mapBinding:mapContractRequest(handoff,placements).mapBinding,ownerHandoff:handoff.ownerHandoff},handoff),/approved development/);
  for (const mutate of [
    a => {a.ownerHandoff.parcels[0].terms.explicitConfirmation=false;},
    a => {a.ownerHandoff.parcels[0].terms.outcome='refused';},
    a => {a.ownerHandoff.parcels[0].ownerId='different-owner';},
    a => {a.ownerHandoff.parcels.pop();},
    a => {a.ownerHandoff.parcels[0].terms.compensationCents=Number.MAX_SAFE_INTEGER;},
    a => {a.ownerHandoff.owners[0].banking.paymentRecipientRef='mock-redirected';},
    a => {a.mapBinding.routeVersion++;},
  ]) {const value=agreement(handoff);mutate(value);assert.throws(() => contractSourceFromAgreement(value,handoff));}
});

test('the server reconstructs trusted geometry/prices and rejects altered proposal bindings or private input fields', () => {
  const context = mapContractRequest(proposal(),placements);
  assert.equal(reconstructMapProposal(context,world).ownerHandoff.routeId,route.id);
  const altered = clone(context);altered.mapBinding.proposalKey = altered.mapBinding.proposalKey.replace('"compensationCents":','"compensationCents":9');
  assert.throws(() => reconstructMapProposal(altered,world),/changed/);
  assert.throws(() => reconstructMapProposal({...context,participant:{phone:'+12025550123'}},world),/public map context/);
  assert.throws(() => reconstructMapProposal({...context,substation:{x:999,z:999}},world),/placements/);
});

test('approved map context drives actual contract API, both tranches and persistent state with the same owners/amounts', async () => withAPI(async (api,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const approved = await call(api,'approve-map',{context});assert.equal(approved.status,200,approved.body.error);
  const {packageId,input:source} = approved.body;
  assert.equal((await call(api,'approve-map',{context})).body.packageId,packageId);
  const drafts = source.parcels.map((p,i) => createContractDraft(source,p.parcelId,{id:`map-draft-${i}`}));
  const command = async (operation,draft,extra={}) => {
    const response=await call(api,operation,{draft,packageId,...extra});assert.equal(response.status,200,response.body.error);return response.body;
  };
  await command('sign/utility',drafts[0]);await command('sign/landowner',drafts[0]);
  assert.equal((await call(api,'submit',{draft:drafts[0],packageId})).status,409);
  for(const draft of drafts.slice(1)) {await command('sign/utility',draft);await command('sign/landowner',draft);}
  let funded;
  for(const draft of drafts) funded=await command('submit',draft);
  assert.equal(funded.construction.status,'in-progress');
  assert.equal((await call(api,'submit',{draft:drafts[0],packageId,stage:'balance'})).status,409);
  await command('construction-complete',drafts[0],{completion:{...funded.construction,eventId:'map-preview-completion'}});
  let paidTotal=0;
  for(const draft of drafts) {
    const result=await command('submit',draft,{stage:'balance'});
    assert.equal(result.balancePayment.status,'paid');assert.equal(result.journal.length,2);
    paidTotal+=result.payment.amountCents+result.balancePayment.amountCents;
  }
  assert.equal(paidTotal,source.parcels.reduce((sum,p)=>sum+p.compensationCents,0));
  const restarted=await createContractAPI(options);
  const restored=await call(restarted,'submit',{draft:drafts[0],packageId,stage:'balance'});
  assert.equal(restored.body.balancePayment.status,'paid');assert.equal(restored.body.journal.length,2);
  assert.equal((await call(api,'state',{draft:drafts[0]})).status,409);
  assert.equal((await call(api,'approve-map',{context:mapContractRequest(proposal(2),placements)})).status,409);
  const persisted=await readFile(join(directory,'map-contracts.json'),'utf8');
  const saved=JSON.parse(persisted).packages[packageId].ledger;
  assert.equal(Object.values(saved.obligations).filter(p=>p.status==='paid').length,drafts.length*2);
  assert.equal(saved.journal.reduce((sum,p)=>sum+p.debitCents,0),paidTotal);
  assert(!persisted.includes('Private participant name'));assert(!persisted.includes('+12025550123'));
}));

test('new route version supersedes an unpaid package and old package commands cannot use its signatures', async () => withAPI(async api => {
  const first=await call(api,'approve-map',{context:mapContractRequest(proposal(),placements)});
  const draft=createContractDraft(first.body.input,first.body.input.parcels[0].parcelId,{id:'superseded-draft'});
  await call(api,'sign/utility',{draft,packageId:first.body.packageId});
  const second=await call(api,'approve-map',{context:mapContractRequest(proposal(2),placements)});
  assert.equal(second.status,200,second.body.error);assert.notEqual(first.body.packageId,second.body.packageId);
  assert.equal((await call(api,'state',{draft,packageId:first.body.packageId})).status,409);
  assert.equal((await call(api,'approve-map',{context:mapContractRequest(proposal(),placements)})).status,409);
}));

test('a refusal reroute signs and pays only final-route owners, with server-validated restrictions', async () => withAPI(async (api,options,directory) => {
  const original = proposal(), refused = original.userRole.parcelId;
  const restrictions = {blockedParcelIds:[refused],blockedTowerParcelIds:[],exclusionZones:[]};
  const rerouted = computeTransmissionRoutes(world,placements,restrictions);
  const selected = rerouted.candidates.find(candidate => {
    const handoff = createHandoff({world,route:candidate,placements,analysis:analyzeRouteParcels(world,candidate,rerouted.assumptions),sessionId:original.sessionId,routeVersion:2,userParcelId:refused});
    return handoff.snapshot.routes[0].eligible;
  });
  assert(selected,'fixture must offer an eligible reroute');
  const handoff = createHandoff({world,route:selected,placements,analysis:analyzeRouteParcels(world,selected,rerouted.assumptions),sessionId:original.sessionId,routeVersion:2,userParcelId:refused,liveCallLocked:true});
  const context = mapContractRequest(handoff,placements,restrictions);
  assert.equal(reconstructMapProposal(context).userRole.parcelId,refused);
  const missingRestrictions = clone(context);delete missingRestrictions.routingConstraints;
  assert.throws(() => reconstructMapProposal(missingRestrictions));
  const approved = await call(api,'approve-map',{context});assert.equal(approved.status,200,approved.body.error);
  const {packageId,input:source} = approved.body;
  assert.deepEqual(source.parcels.map(p=>p.parcelId).sort(),[...selected.parcelIds].sort());
  assert(!source.parcels.some(p=>p.parcelId===refused || p.ownerId===original.userRole.ownerId));
  const drafts = source.parcels.map((p,i)=>createContractDraft(source,p.parcelId,{id:`reroute-draft-${i}`}));
  const command = async (operation,draft,extra={}) => {
    const response=await call(api,operation,{packageId,draft,...extra});assert.equal(response.status,200,response.body.error);return response.body;
  };
  for (const draft of drafts) {await command('sign/utility',draft);await command('sign/landowner',draft);}
  let initial;
  for (const draft of drafts) initial=await command('submit',draft);
  assert.equal(initial.construction.status,'in-progress');
  assert.equal((await call(api,'submit',{packageId,draft:drafts[0],stage:'balance'})).status,409);
  await command('construction-complete',drafts[0],{completion:{...initial.construction,eventId:'reroute-complete'}});
  for (const draft of drafts) assert.equal((await command('submit',draft,{stage:'balance'})).balancePayment.status,'paid');
  const persisted=JSON.parse(await readFile(join(directory,'map-contracts.json'),'utf8')).packages[packageId];
  assert.equal(Object.keys(persisted.ledger.obligations).length,drafts.length*2);
  assert.equal(persisted.ledger.journal.reduce((sum,p)=>sum+p.debitCents,0),handoff.snapshot.routes[0].upfrontCompensationCents);
}));

function nessieFixture(source, {pending = false} = {}) {
  const recipients = Object.fromEntries(source.parcels.map(parcel => [parcel.ownerId,{accountId:`account-${parcel.ownerId}`,customerId:`customer-${parcel.ownerId}`}])) ;
  const rows = [], calls = [];
  const environment = {
    EASYGRID_PAYMENT_PROVIDER:'nessie',NESSIE_API_KEY:'test-only-nessie-key',NESSIE_API_ORIGIN:'https://prod-api.nessieisreal.com',
    NESSIE_PAYER_ACCOUNT_ID:'test-project-payer',NESSIE_OWNER_RECIPIENTS:JSON.stringify(recipients),NESSIE_ALLOW_SANDBOX_TRANSFERS:'yes',
  };
  const fetcher = async (url, options) => {
    assert.equal(url.searchParams.get('key'),environment.NESSIE_API_KEY);
    assert.equal(options.redirect,'error');
    calls.push({path:url.pathname,method:options.method});
    if (url.pathname === '/accounts/test-project-payer') return Response.json({_id:'test-project-payer',balance:1000000});
    const recipient = Object.values(recipients).find(row => `/accounts/${row.accountId}` === url.pathname);
    if (recipient) return Response.json({_id:recipient.accountId,customer_id:recipient.customerId});
    if (url.pathname === '/accounts/test-project-payer/transfers' && options.method === 'GET') return Response.json(rows);
    if (url.pathname === '/accounts/test-project-payer/transfers' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.medium,'balance');
      assert(Object.values(recipients).some(row => row.accountId === body.payee_id));
      const row = {...body,_id:`test-transfer-${rows.length+1}`,payer_id:'test-project-payer',status:pending?'pending':'completed'};
      rows.push(row);return Response.json({objectCreated:row},{status:201});
    }
    const transfer = rows.find(row => `/transfers/${row._id}` === url.pathname);
    if (transfer) return Response.json(transfer);
    throw new Error('Unexpected mock Nessie endpoint.');
  };
  return {environment,fetcher,rows,calls};
}

test('map contracts use Nessie only after all signatures, preserve exact amounts and never resend after restart', async () => withAPI(async (_simulation,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const source = contractSourceFromAgreement(agreement(),proposal()), mock = nessieFixture(source);
  const nessieOptions = {...options,environment:mock.environment,fetcher:mock.fetcher};
  const api = await createContractAPI(nessieOptions);
  const approved = await call(api,'approve-map',{context});
  assert.equal(approved.status,200,approved.body.error);
  assert.equal(approved.body.bankMode,'nessie-sandbox');assert.equal(approved.body.paymentsEnabled,true);
  const {packageId,input} = approved.body;
  const drafts = input.parcels.map((parcel,index) => createContractDraft(input,parcel.parcelId,{id:`nessie-map-${index}`}));
  const command = async (operation,draft,extra={}) => {
    const result = await call(api,operation,{packageId,draft,...extra});
    assert.equal(result.status,200,result.body.error);assert.equal(result.body.bankMode,'nessie-sandbox');return result.body;
  };
  assert.equal((await call(api,'submit',{packageId,draft:drafts[0]})).status,409);
  await command('sign/utility',drafts[0]);await command('sign/landowner',drafts[0]);
  assert.equal((await call(api,'submit',{packageId,draft:drafts[0]})).status,409);
  assert.equal(mock.calls.length,0,'unsigned packages must not contact the bank');
  for(const draft of drafts.slice(1)) {await command('sign/utility',draft);await command('sign/landowner',draft);}
  const first = await command('submit',drafts[0]);
  assert.equal(first.payment.status,'paid');assert.equal(first.payment.mode,'nessie-sandbox');
  assert.equal(first.payment.amountCents,Math.floor(input.parcels[0].compensationCents/5));
  assert.equal(mock.rows[0].amount,first.payment.amountCents/100);
  assert.equal(first.payment.transactionRef,'nessie-test-transfer-1');
  await Promise.all([command('submit',drafts[0]),command('submit',drafts[0])]);
  assert.equal(mock.rows.length,1);
  const restarted = await createContractAPI(nessieOptions);
  const replay = await call(restarted,'submit',{packageId,draft:drafts[0]});
  assert.equal(replay.body.payment.status,'paid');assert.equal(replay.body.journal.length,1);assert.equal(mock.rows.length,1);
  const newDraft = {...drafts[0],id:'new-id-same-obligation'};
  await call(restarted,'state',{packageId,draft:newDraft});
  assert.equal((await call(restarted,'submit',{packageId,draft:newDraft})).status,409);
  assert.equal(mock.rows.length,1,'regenerated draft IDs must not create another payment');
  assert.equal((await call(restarted,'submit',{packageId,draft:drafts[0],stage:'balance'})).status,409);
  const serialized = await readFile(join(directory,'nessie-map-contracts.json'),'utf8');
  assert.equal(JSON.parse(serialized).bankMode,'nessie-sandbox');
  assert.match(JSON.parse(serialized).bankIdentity,/^[a-f0-9]{64}$/);
  for (const change of [{NESSIE_PAYER_ACCOUNT_ID:'different-project-payer'},{NESSIE_API_ORIGIN:'https://api.nessieisreal.com'}]) {
    await assert.rejects(createContractAPI({...nessieOptions,environment:{...mock.environment,...change}}),/different bank identity/);
  }
  for (const secret of [mock.environment.NESSIE_API_KEY,'test-project-payer',...Object.values(JSON.parse(mock.environment.NESSIE_OWNER_RECIPIENTS)).map(row=>row.accountId)]) assert(!serialized.includes(secret));
}));

test('pending Nessie payment reconciles after restart without resubmitting and simulation payments cannot satisfy it', async () => withAPI(async (simulation,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const simulated = await call(simulation,'approve-map',{context}), {packageId,input} = simulated.body;
  const drafts = input.parcels.map((parcel,index)=>createContractDraft(input,parcel.parcelId,{id:`isolated-${index}`}));
  for(const draft of drafts) {
    await call(simulation,'sign/utility',{packageId,draft});await call(simulation,'sign/landowner',{packageId,draft});
  }
  assert.equal((await call(simulation,'submit',{packageId,draft:drafts[0]})).body.payment.status,'paid');
  const mock = nessieFixture(input,{pending:true}), nessieOptions = {...options,environment:mock.environment,fetcher:mock.fetcher};
  const api = await createContractAPI(nessieOptions);
  assert.equal((await call(api,'state',{packageId,draft:drafts[0]})).status,409);
  const approvedNessie = await call(api,'approve-map',{context});assert.equal(approvedNessie.status,200);
  const nessieDrafts = approvedNessie.body.input.parcels.map((parcel,index)=>createContractDraft(approvedNessie.body.input,parcel.parcelId,{id:`nessie-isolated-${index}`}));
  const blank = await call(api,'state',{packageId,draft:nessieDrafts[0]});assert.equal(blank.status,200,blank.body.error);
  assert.deepEqual(blank.body.signatures,{});assert.equal(blank.body.payment,null);
  assert.equal((await call(api,'submit',{packageId,draft:nessieDrafts[0]})).status,409);
  for(const draft of nessieDrafts) {await call(api,'sign/utility',{packageId,draft});await call(api,'sign/landowner',{packageId,draft});}
  const pending = await call(api,'submit',{packageId,draft:nessieDrafts[0]});
  assert.equal(pending.body.payment.status,'submitted');assert.equal(pending.body.journal.length,0);
  assert.equal(pending.body.construction.status,'awaiting-initial-payments');
  const restarted = await createContractAPI(nessieOptions);
  await call(restarted,'submit',{packageId,draft:nessieDrafts[0]});assert.equal(mock.rows.length,1);
  mock.rows[0].status='completed';
  const confirmed = await call(restarted,'reconcile',{packageId,draft:nessieDrafts[0]});
  assert.equal(confirmed.body.payment.status,'paid');assert.equal(confirmed.body.journal.length,1);assert.equal(mock.rows.length,1);
  assert.equal(JSON.parse(await readFile(join(directory,'map-contracts.json'),'utf8')).bankMode,'simulation');
  assert.equal(JSON.parse(await readFile(join(directory,'nessie-map-contracts.json'),'utf8')).bankMode,'nessie-sandbox');
}));

test('provider-tagged and legacy simulation ledgers cannot be loaded as Nessie evidence', async () => withAPI(async (api,options,directory) => {
  await call(api,'approve-map',{context:mapContractRequest(proposal(),placements)});
  const stateURL = pathToFileURL(join(directory,'map-contracts.json'));
  const bank = {...createDemoBank(),mode:'nessie-sandbox'};
  await assert.rejects(createMapContractService({stateURL,bank}),/different payment provider/);
  const legacy = JSON.parse(await readFile(stateURL,'utf8'));legacy.schemaVersion=1;delete legacy.bankMode;
  await writeFile(stateURL,JSON.stringify(legacy));
  await assert.rejects(createMapContractService({stateURL,bank}),/Invalid map contract registry/);
  const restoredSimulation = await createMapContractService({stateURL});
  assert.equal((await restoredSimulation.approve(mapContractRequest(proposal(),placements))).bankMode,'simulation');
}));
