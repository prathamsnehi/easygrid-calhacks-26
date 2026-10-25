import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
import {createContractDraft, contractDocument, contractSourceKey} from '../src/contract-authoring.js';
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
    assert.equal(doc.paymentCents,original.terms.compensationCents);
    assert.equal(doc.paymentSchedule,'full-after-signatures');
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

test('approved map context drives actual contract API, one full payment and persistent state with the same owners/amounts', async () => withAPI(async (api,options,directory) => {
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
    const result=await command('submit',draft,{stage:'full'});
    assert.equal(result.payment.status,'paid');assert.equal(result.journal.length,1);
    assert.equal(result.balancePayment,undefined);
    paidTotal+=result.payment.amountCents;
  }
  assert.equal(paidTotal,source.parcels.reduce((sum,p)=>sum+p.compensationCents,0));
  const restarted=await createContractAPI(options);
  const restored=await call(restarted,'submit',{draft:drafts[0],packageId,stage:'full'});
  assert.equal(restored.body.payment.status,'paid');assert.equal(restored.body.journal.length,1);
  assert.equal((await call(api,'state',{draft:drafts[0]})).status,409);
  assert.equal((await call(api,'approve-map',{context:mapContractRequest(proposal(2),placements)})).status,409);
  const persisted=await readFile(join(directory,'map-contracts.json'),'utf8');
  const saved=JSON.parse(persisted).packages[packageId].ledger;
  assert.equal(Object.values(saved.obligations).filter(p=>p.status==='paid').length,drafts.length);
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
  for (const draft of drafts) assert.equal((await command('submit',draft,{stage:'full'})).payment.status,'paid');
  const persisted=JSON.parse(await readFile(join(directory,'map-contracts.json'),'utf8')).packages[packageId];
  assert.equal(Object.keys(persisted.ledger.obligations).length,drafts.length);
  assert.equal(persisted.ledger.journal.reduce((sum,p)=>sum+p.debitCents,0),handoff.snapshot.routes[0].upfrontCompensationCents);
}));

function nessieFixture(source, {status = 'pending', failConfirmation = false} = {}) {
  const recipients = Object.fromEntries(source.parcels.map(parcel => [parcel.ownerId,{accountId:`account-${parcel.ownerId}`,customerId:`customer-${parcel.ownerId}`}])) ;
  const rows = [], calls = [];
  let confirmationFailed = false;
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
    if (url.pathname === '/accounts/test-project-payer/transfers' && options.method === 'GET') return rows.length ? Response.json(rows) : Response.json('No transfers found for this account',{status:404});
    if (url.pathname === '/accounts/test-project-payer/transfers' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(),['amount','description','status','transaction_date']);
      assert.equal(body.status,'pending');assert(Number.isSafeInteger(body.amount));
      assert.match(body.transaction_date,/^\d{4}-\d{2}-\d{2}$/);
      assert.match(body.description,/^EasyGrid full-[a-f0-9]{32} [a-f0-9]{64} [a-f0-9]{64}$/);
      const row = {...body,id:`test-record-${rows.length+1}`,status};
      rows.push(row);return Response.json({objectCreated:{...body,_id:row.id}},{status:201});
    }
    const record = rows.find(row => `/transfers/${row.id}` === url.pathname);
    if (record) {
      if (failConfirmation && !confirmationFailed) {confirmationFailed = true;return Response.json('Confirmation temporarily unavailable',{status:503});}
      return Response.json(record);
    }
    throw new Error('Unexpected mock Nessie endpoint.');
  };
  return {environment,fetcher,rows,calls};
}

test('map Nessie records require all signatures, preserve exact whole-dollar amounts and never claim settlement', async () => withAPI(async (_simulation,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const source = contractSourceFromAgreement(agreement(),proposal()), mock = nessieFixture(source,{status:'completed'});
  const nessieOptions = {...options,environment:mock.environment,fetcher:mock.fetcher};
  const api = await createContractAPI(nessieOptions);
  const approved = await call(api,'approve-map',{context});
  assert.equal(approved.status,200,approved.body.error);
  assert.equal(approved.body.bankMode,'nessie-sandbox');assert.equal(approved.body.paymentsEnabled,true);
  assert.equal(approved.body.paymentSemantics,'record-only');assert.equal(approved.body.amountIncrementCents,100);
  const {packageId,input} = approved.body;
  const drafts = input.parcels.map((parcel,index) => createContractDraft(input,parcel.parcelId,{id:`nessie-map-${index}`}));
  const index = input.parcels.findIndex(parcel => parcel.compensationCents % 100 === 0);
  assert(index >= 0,'trusted map fixture must contain a whole-dollar contract');
  const target = drafts[index];
  const command = async (operation,draft,extra={}) => {
    const result = await call(api,operation,{packageId,draft,...extra});
    assert.equal(result.status,200,result.body.error);assert.equal(result.body.bankMode,'nessie-sandbox');return result.body;
  };
  assert.equal((await call(api,'submit',{packageId,draft:target})).status,409);
  await command('sign/utility',target);await command('sign/landowner',target);
  assert.equal((await call(api,'submit',{packageId,draft:target})).status,409);
  assert.equal(mock.calls.length,0,'unsigned packages must not contact the bank');
  for(const draft of drafts.filter(draft => draft !== target)) {await command('sign/utility',draft);await command('sign/landowner',draft);}
  const first = await command('submit',target);
  assert.equal(first.payment.status,'recorded');assert.equal(first.payment.mode,'nessie-sandbox');
  assert.equal(first.paymentSemantics,'record-only');assert.equal(first.payment.paymentSemantics,'record-only');
  assert.equal(first.payment.amountCents,input.parcels[index].compensationCents);
  assert.equal(mock.rows[0].amount,first.payment.amountCents/100);
  assert.equal(first.payment.transactionRef,'nessie-test-record-1');
  assert.equal(first.journal.length,0);assert.equal(first.construction.status,'not-applicable');assert.equal(first.construction.paidCount,0);
  await Promise.all([command('submit',target),command('submit',target)]);
  assert.equal(mock.rows.length,1);
  const restarted = await createContractAPI(nessieOptions);
  const replay = await call(restarted,'submit',{packageId,draft:target});
  assert.equal(replay.body.payment.status,'recorded');assert.equal(replay.body.journal.length,0);assert.equal(mock.rows.length,1);
  const newDraft = {...target,id:'new-id-same-obligation'};
  await call(restarted,'state',{packageId,draft:newDraft});
  assert.equal((await call(restarted,'submit',{packageId,draft:newDraft})).status,409);
  assert.equal(mock.rows.length,1,'regenerated draft IDs must not create another record');
  assert.equal((await call(restarted,'submit',{packageId,draft:target,stage:'balance'})).status,409);
  assert.equal((await call(restarted,'construction-complete',{packageId,draft:target,completion:{}})).status,409);
  const serialized = await readFile(join(directory,'nessie-map-contracts.json'),'utf8');
  const saved = JSON.parse(serialized);
  assert.equal(saved.bankMode,'nessie-sandbox');assert.match(saved.bankIdentity,/^[a-f0-9]{64}$/);
  assert.equal(saved.packages[packageId].ledger.journal.length,0);assert.equal(saved.packages[packageId].ledger.construction,undefined);
  for (const change of [{NESSIE_PAYER_ACCOUNT_ID:'different-project-payer'},{NESSIE_API_ORIGIN:'https://api.nessieisreal.com'}]) {
    await assert.rejects(createContractAPI({...nessieOptions,environment:{...mock.environment,...change}}),/different bank identity/);
  }
  for (const secret of [mock.environment.NESSIE_API_KEY,'test-project-payer',...Object.values(JSON.parse(mock.environment.NESSIE_OWNER_RECIPIENTS)).map(row=>row.accountId)]) assert(!serialized.includes(secret));
}));

test('an unknown Nessie record reconciles after restart without resubmitting and simulation cannot satisfy it', async () => withAPI(async (simulation,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const simulated = await call(simulation,'approve-map',{context}), {packageId,input} = simulated.body;
  const drafts = input.parcels.map((parcel,index)=>createContractDraft(input,parcel.parcelId,{id:`isolated-${index}`}));
  const index = input.parcels.findIndex(parcel => parcel.compensationCents % 100 === 0);
  assert(index >= 0,'trusted map fixture must contain a whole-dollar contract');
  for(const draft of drafts) {
    await call(simulation,'sign/utility',{packageId,draft});await call(simulation,'sign/landowner',{packageId,draft});
  }
  assert.equal((await call(simulation,'submit',{packageId,draft:drafts[index]})).body.payment.status,'paid');
  const mock = nessieFixture(input,{failConfirmation:true}), nessieOptions = {...options,environment:mock.environment,fetcher:mock.fetcher};
  const api = await createContractAPI(nessieOptions);
  assert.equal((await call(api,'state',{packageId,draft:drafts[index]})).status,409);
  const approvedNessie = await call(api,'approve-map',{context});assert.equal(approvedNessie.status,200);
  const nessieDrafts = approvedNessie.body.input.parcels.map((parcel,index)=>createContractDraft(approvedNessie.body.input,parcel.parcelId,{id:`nessie-isolated-${index}`}));
  const target = nessieDrafts[index];
  const blank = await call(api,'state',{packageId,draft:target});assert.equal(blank.status,200,blank.body.error);
  assert.deepEqual(blank.body.signatures,{});assert.equal(blank.body.payment,null);
  assert.equal((await call(api,'submit',{packageId,draft:target})).status,409);
  for(const draft of nessieDrafts) {await call(api,'sign/utility',{packageId,draft});await call(api,'sign/landowner',{packageId,draft});}
  const unknown = await call(api,'submit',{packageId,draft:target});
  assert.equal(unknown.body.payment.status,'unknown');assert.equal(unknown.body.journal.length,0);
  assert.equal(unknown.body.construction.status,'not-applicable');
  const restarted = await createContractAPI(nessieOptions);
  const stillUnknown = await call(restarted,'submit',{packageId,draft:target});
  assert.equal(stillUnknown.body.payment.status,'unknown');assert.equal(mock.rows.length,1);
  assert.equal(mock.rows[0].status,'pending');
  const confirmed = await call(restarted,'reconcile',{packageId,draft:target});
  assert.equal(confirmed.body.payment.status,'recorded');assert.equal(confirmed.body.journal.length,0);assert.equal(mock.rows.length,1);
  assert.equal(confirmed.body.payment.transactionRef,'nessie-test-record-1');
  assert.equal(confirmed.body.construction.paidCount,0);
  assert.equal(JSON.parse(await readFile(join(directory,'map-contracts.json'),'utf8')).bankMode,'simulation');
  assert.equal(JSON.parse(await readFile(join(directory,'nessie-map-contracts.json'),'utf8')).bankMode,'nessie-sandbox');
}));

test('fractional map compensation is held unchanged before any Nessie provider request', async () => withAPI(async (_simulation,options) => {
  const source = contractSourceFromAgreement(agreement(),proposal()),mock = nessieFixture(source);
  const api = await createContractAPI({...options,environment:mock.environment,fetcher:mock.fetcher});
  const approved = await call(api,'approve-map',{context:mapContractRequest(proposal(),placements)});
  const {packageId,input} = approved.body;
  const drafts = input.parcels.map((parcel,index)=>createContractDraft(input,parcel.parcelId,{id:`fractional-${index}`}));
  const index = input.parcels.findIndex(parcel => parcel.compensationCents % 100 !== 0);
  assert(index >= 0,'trusted map fixture must include a fractional-dollar contract');
  for(const draft of drafts) {await call(api,'sign/utility',{packageId,draft});await call(api,'sign/landowner',{packageId,draft});}
  const held = await call(api,'submit',{packageId,draft:drafts[index]});
  assert.equal(held.status,200,held.body.error);assert.equal(held.body.payment.status,'held');
  assert.equal(held.body.payment.amountCents,input.parcels[index].compensationCents);
  assert.match(held.body.payment.reason,/whole-dollar/);assert.equal(mock.calls.length,0);assert.equal(mock.rows.length,0);
  assert.equal(held.body.journal.length,0);assert.equal(held.body.construction.status,'not-applicable');
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


test('upgrading an existing map package preserves staged evidence and blocks full-payment or route-change bypasses', async () => withAPI(async (api,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const approved = await call(api,'approve-map',{context}), {packageId,input:source} = approved.body;
  const stateURL = pathToFileURL(join(directory,'map-contracts.json'));
  const registry = JSON.parse(await readFile(stateURL,'utf8')), record = registry.packages[packageId];
  delete record.source.paymentSchedule;record.source.project.developerName='Cal Power';
  const parcel = source.parcels[0];
  const id = `initial-${createHash('sha256').update(JSON.stringify([source.sessionId,parcel.parcelId])).digest('hex').slice(0,32)}`;
  const previous = {id,stage:'initial',parcelId:parcel.parcelId,status:'paid',amountCents:Math.floor(parcel.compensationCents/5),transactionRef:'old-simulated-payment',documentHash:'old-split-document'};
  record.ledger.obligations[id] = previous;
  record.ledger.journal.push({obligationId:id,debitCents:previous.amountCents,creditCents:previous.amountCents});
  await writeFile(stateURL,JSON.stringify(registry));
  const restarted = await createContractAPI(options), updated = await call(restarted,'approve-map',{context});
  assert.equal(updated.status,200,updated.body.error);assert.equal(updated.body.packageId,packageId);
  assert.equal(updated.body.input.paymentSchedule,'full-after-signatures');
  assert.equal(updated.body.input.project.developerName,'EasyGrid');
  assert.equal(contractSourceKey(updated.body.input),contractSourceKey(contractSourceFromAgreement(updated.body.agreement,proposal())));
  const draft = createContractDraft(updated.body.input,parcel.parcelId,{id:'new-full-terms'});
  const blocked = await call(restarted,'sign/utility',{packageId,draft});
  assert.equal(blocked.status,409);assert.match(blocked.body.error,/legacy staged-payment attempt/);
  assert.equal((await call(restarted,'submit',{packageId,draft})).status,409);
  assert.equal((await call(restarted,'approve-map',{context:mapContractRequest(proposal(2),placements)})).status,409);
  const saved = JSON.parse(await readFile(stateURL,'utf8')).packages[packageId].ledger;
  assert.deepEqual(saved,record.ledger,'migration must retain previous payment and journal evidence');
}));


test('same-package company migration evicts a cached worker and requires fresh EasyGrid signatures', async () => withAPI(async (api,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const approved = await call(api,'approve-map',{context}), {packageId} = approved.body;
  const stateURL = pathToFileURL(join(directory,'map-contracts.json'));
  const registry = JSON.parse(await readFile(stateURL,'utf8')), record = registry.packages[packageId];
  record.source.project.developerName='Cal Power';
  await writeFile(stateURL,JSON.stringify(registry));
  const restarted = await createContractAPI(options);
  const oldDrafts = record.source.parcels.map((parcel,index)=>createContractDraft(record.source,parcel.parcelId,{id:`previous-company-${index}`}));
  // Open and sign through the old source before approve() upgrades this existing package.
  for (const draft of oldDrafts) {
    assert.equal((await call(restarted,'sign/utility',{packageId,draft})).status,200);
    assert.equal((await call(restarted,'sign/landowner',{packageId,draft})).status,200);
  }
  const priorLedger = JSON.parse(await readFile(stateURL,'utf8')).packages[packageId].ledger;
  const updated = await call(restarted,'approve-map',{context});
  assert.equal(updated.status,200,updated.body.error);assert.equal(updated.body.packageId,packageId);
  assert.equal(updated.body.input.project.developerName,'EasyGrid');
  assert.equal(contractSourceKey(updated.body.input),contractSourceKey(contractSourceFromAgreement(updated.body.agreement,proposal())));
  const migrated = JSON.parse(await readFile(stateURL,'utf8')).packages[packageId];
  assert.deepEqual(migrated.ledger,priorLedger,'company migration must preserve the existing ledger');
  assert.equal(migrated.source.project.developerName,'EasyGrid');
  assert.equal((await call(restarted,'submit',{packageId,draft:oldDrafts[0]})).status,409);
  const drafts = updated.body.input.parcels.map((parcel,index)=>createContractDraft(updated.body.input,parcel.parcelId,{id:`easygrid-company-${index}`}));
  const first = await call(restarted,'state',{packageId,draft:drafts[0]});
  assert.equal(first.status,200,first.body.error);assert.deepEqual(first.body.signatures,{});assert.equal(first.body.packageReady,false);
  for (const draft of drafts) {
    assert.equal((await call(restarted,'sign/utility',{packageId,draft})).status,200);
    assert.equal((await call(restarted,'sign/landowner',{packageId,draft})).status,200);
  }
  const paid = await call(restarted,'submit',{packageId,draft:drafts[0]});
  assert.equal(paid.status,200,paid.body.error);assert.equal(paid.body.payment.status,'paid');
  assert.equal(paid.body.payment.amountCents,updated.body.input.parcels[0].compensationCents);
}));


test('single-owner map scope preserves the full source and restricts signing, readiness and construction', async () => withAPI(async (api,options,directory) => {
  const context = mapContractRequest(proposal(),placements);
  const routeApproval = await call(api,'approve-map',{context});
  assert.equal(routeApproval.status,200,routeApproval.body.error);
  const approved = await call(api,'approve-map',{context,demoScope:'single-owner'});
  assert.equal(approved.status,200,approved.body.error);
  const {packageId,input,demoScope,demoParcelId} = approved.body, scope = {packageId,demoScope,demoParcelId};
  assert.equal(packageId,routeApproval.body.packageId);assert.deepEqual(input,routeApproval.body.input);
  assert.deepEqual(approved.body.agreement,routeApproval.body.agreement);
  assert.deepEqual(approved.body.mapBinding,routeApproval.body.mapBinding);
  assert.equal(demoScope,'single-owner');assert(input.parcels.length > 1);
  const expected = input.parcels.find(p=>p.parcelId==='L017') ?? input.parcels.find(p=>p.compensationCents%100===0) ?? input.parcels[0];
  assert.equal(demoParcelId,expected.parcelId);
  const draft = createContractDraft(input,demoParcelId,{id:'single-owner-contract'});
  const other = createContractDraft(input,input.parcels.find(p=>p.parcelId!==demoParcelId).parcelId,{id:'excluded-owner-contract'});
  assert.equal((await call(api,'state',{packageId,draft})).status,409,'commands must bind the approved scope');
  assert.equal((await call(api,'state',{...scope,demoParcelId:other.parcelId,draft})).status,409);
  for (const operation of ['state','sign/utility','sign/landowner','submit']) {
    assert.equal((await call(api,operation,{...scope,draft:other})).status,409,'scope must not authorize another owner');
  }
  assert.equal((await call(api,'submit',{...scope,draft})).status,409);
  await call(api,'sign/utility',{...scope,draft});
  const signed = await call(api,'sign/landowner',{...scope,draft});
  assert.equal(signed.status,200,signed.body.error);assert.equal(signed.body.paymentReady,true);assert.equal(signed.body.packageReady,false);
  assert.deepEqual(signed.body.agreementProgress,{signedCount:1,totalCount:1,nextUnsignedParcelId:null});
  assert.equal(signed.body.routeAgreementProgress.signedCount,1);assert.equal(signed.body.routeAgreementProgress.totalCount,input.parcels.length);
  const paid = await call(api,'submit',{...scope,draft});
  assert.equal(paid.status,200,paid.body.error);assert.equal(paid.body.payment.status,'paid');
  assert.equal(paid.body.payment.amountCents,expected.compensationCents);assert.equal(paid.body.packageReady,false);
  assert.equal(paid.body.construction.status,'not-applicable');
  assert.equal((await call(api,'construction-complete',{...scope,draft,completion:{}})).status,409);
  const restarted = await createContractAPI(options), replay = await call(restarted,'submit',{...scope,draft});
  assert.equal(replay.body.payment.obligationId,paid.body.payment.obligationId);assert.equal(replay.body.journal.length,1);
  const newDraft = {...draft,id:'another-single-owner-id'};
  assert.equal((await call(restarted,'submit',{...scope,draft:newDraft})).status,409);
  const record = JSON.parse(await readFile(join(directory,'map-contracts.json'),'utf8')).packages[packageId];
  assert.equal(Object.keys(record.ledger.obligations).length,1);assert.equal(record.ledger.construction,undefined);
  assert.equal(record.demoParcelId,demoParcelId);assert.deepEqual(record.source,input);
}));

test('single-owner conversion preserves recorded and unknown Nessie obligations without another POST', async () => {
  for (const failConfirmation of [false,true]) await withAPI(async (_simulation,options,directory) => {
    const context = mapContractRequest(proposal(),placements),source = contractSourceFromAgreement(agreement(),proposal());
    const mock = nessieFixture(source,{failConfirmation}), nessieOptions = {...options,environment:mock.environment,fetcher:mock.fetcher};
    const api = await createContractAPI(nessieOptions), original = await call(api,'approve-map',{context});
    const {packageId,input} = original.body;
    const expected = input.parcels.find(p=>p.parcelId==='L017') ?? input.parcels.find(p=>p.compensationCents%100===0) ?? input.parcels[0];
    assert.equal(expected.compensationCents%100,0);
    const drafts = input.parcels.map((parcel,index)=>createContractDraft(input,parcel.parcelId,{id:`scope-convert-${index}`}));
    for (const draft of drafts) {await call(api,'sign/utility',{packageId,draft});await call(api,'sign/landowner',{packageId,draft});}
    const draft = drafts.find(draft=>draft.parcelId===expected.parcelId), before = await call(api,'submit',{packageId,draft});
    assert.equal(before.status,200,before.body.error);assert.equal(before.body.payment.status,failConfirmation?'unknown':'recorded');
    const path = join(directory,'nessie-map-contracts.json'), prior = JSON.parse(await readFile(path,'utf8')).packages[packageId];
    const approved = await call(api,'approve-map',{context,demoScope:'single-owner'});
    assert.equal(approved.status,200,approved.body.error);assert.equal(approved.body.packageId,packageId);
    assert.equal(approved.body.demoParcelId,draft.parcelId);assert.deepEqual(approved.body.input,input);
    const scope = {packageId,demoScope:approved.body.demoScope,demoParcelId:approved.body.demoParcelId};
    const after = JSON.parse(await readFile(path,'utf8')).packages[packageId];
    assert.deepEqual(after.ledger,prior.ledger,'scope changes must not reset attempts or audit evidence');
    assert.equal((await call(api,'submit',{packageId,draft})).status,409,'old unscoped commands are stale');
    const replay = await call(api,'submit',{...scope,draft});
    assert.equal(replay.body.payment.obligationId,before.body.payment.obligationId);
    assert.equal(replay.body.payment.status,before.body.payment.status);assert.equal(mock.rows.length,1);
    const restarted = await createContractAPI(nessieOptions);
    const confirmed = await call(restarted,'reconcile',{...scope,draft});
    assert.equal(confirmed.status,200,confirmed.body.error);assert.equal(confirmed.body.payment.status,'recorded');
    assert.equal(confirmed.body.payment.obligationId,before.body.payment.obligationId);assert.equal(confirmed.body.journal.length,0);
    assert.equal(mock.calls.filter(call=>call.method==='POST').length,1);
  });
});

test('a single-owner conversion cannot hide an unknown attempt belonging to an excluded parcel', async () => withAPI(async (api,options,directory) => {
  const context = mapContractRequest(proposal(),placements), approved = await call(api,'approve-map',{context});
  const {packageId,input} = approved.body, selected = input.parcels.find(p=>p.parcelId==='L017') ?? input.parcels.find(p=>p.compensationCents%100===0) ?? input.parcels[0];
  const excluded = input.parcels.find(p=>p.parcelId!==selected.parcelId), path = join(directory,'map-contracts.json');
  const registry = JSON.parse(await readFile(path,'utf8')), record = registry.packages[packageId];
  const id = `full-${createHash('sha256').update(JSON.stringify([input.sessionId,excluded.parcelId])).digest('hex').slice(0,32)}`;
  record.ledger.obligations[id] = {id,stage:'full',parcelId:excluded.parcelId,status:'unknown',amountCents:excluded.compensationCents,documentHash:'previous-current-document',reason:'Earlier response was lost'};
  await writeFile(path,JSON.stringify(registry));
  const restarted = await createContractAPI(options), blocked = await call(restarted,'approve-map',{context,demoScope:'single-owner'});
  assert.equal(blocked.status,409);assert.match(blocked.body.error,/Other landowner payment attempts/);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),registry,'rejected conversion must preserve scope, source and every ledger record');
  const normal = await call(restarted,'approve-map',{context});
  assert.equal(normal.status,200,normal.body.error);assert.equal(normal.body.demoScope,null);assert.equal(normal.body.demoParcelId,null);
}));

test('scope changes wait for in-flight commands and reject queued commands carrying the old scope', async () => withAPI(async (_api,_options,directory) => {
  const service = await createMapContractService({stateURL:pathToFileURL(join(directory,'scope-queue.json'))});
  const context = mapContractRequest(proposal(),placements), original = await service.approve(context);
  const selected = original.input.parcels.find(p=>p.parcelId==='L017') ?? original.input.parcels.find(p=>p.compensationCents%100===0) ?? original.input.parcels[0];
  const draft = createContractDraft(original.input,selected.parcelId,{id:'queued-scope-contract'});
  let release, started;
  const gate = new Promise(resolve=>{release=resolve;}), entered = new Promise(resolve=>{started=resolve;});
  const inFlight = service.execute(original.packageId,async workflow=>{
    started();await gate;
    return workflow.sign(draft,'utility',{id:'demo-utility-controller',role:'utility-approver'});
  });
  await entered;
  const switching = service.approve(context,{demoScope:'single-owner'});
  const stale = service.execute(original.packageId,workflow=>workflow.inspect(draft));
  const staleRejected = assert.rejects(stale,/demo scope changed/);
  release();await inFlight;
  const converted = await switching;await staleRejected;
  assert.equal(converted.packageId,original.packageId);assert.equal(converted.demoParcelId,draft.parcelId);
  const restored = await service.execute(original.packageId,workflow=>workflow.inspect(draft),{demoScope:converted.demoScope,demoParcelId:converted.demoParcelId});
  assert.equal(restored.signatures.utility.actorId,'demo-utility-controller');
  assert.equal(restored.agreementProgress.totalCount,1);assert.equal(restored.paymentReady,false);
}));
