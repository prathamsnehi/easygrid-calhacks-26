import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
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
import {reconstructMapProposal} from '../server/map-contracts.mjs';

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
