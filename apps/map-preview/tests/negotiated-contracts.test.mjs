import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {mapContractRequest} from '../src/contract-handoff.js';
import {createContractDraft,contractDocument} from '../src/contract-authoring.js';
import {createContractAPI} from '../server/contract-api.mjs';
import {createMapContractService} from '../server/map-contracts.mjs';
import {agreementFromNegotiation} from '../server/negotiated-contracts.mjs';
import {createDemoBank,DEMO_ACTORS} from '../server/contract-workflow.mjs';
import {createNegotiatedStateFixture} from './helpers/negotiated-state.mjs';

const clone = value => structuredClone(value);
const world = createWorld(), substation = createPlacement(world,'substation',-43,-17);
const placements = {substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const routes = computeTransmissionRoutes(world,placements), route = routes.candidates[0];
const analysis = analyzeRouteParcels(world,route,routes.assumptions);

function negotiation({response = 'agree',amountCents,sessionId = 'negotiated-money-test'} = {}) {
  const handoff = createHandoff({world,route,analysis,placements,sessionId,routeVersion:1});
  const context = mapContractRequest(handoff,placements);
  const fixture = createNegotiatedStateFixture({ownerHandoff:handoff.ownerHandoff,mapBinding:context.mapBinding,
    localParcelId:context.userParcelId,response,amountCents});
  return {handoff,context,...fixture,
    approval:{demoScope:'single-owner',demoTarget:'participant',negotiationRef:fixture.negotiationRef}};
}

async function withDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(),'easygrid-negotiated-contract-'));
  try {await action(directory,pathToFileURL(join(directory,'registry.json')));}
  finally {await rm(directory,{recursive:true,force:true});}
}
async function call(api,operation,input) {
  const req = {method:'POST',headers:{host:'127.0.0.1:4177','content-type':'application/json','x-easygrid-demo':'1',origin:'http://127.0.0.1:4177'},
    async *[Symbol.asyncIterator]() {yield Buffer.from(JSON.stringify(input));}};
  const result = {}, res = {writeHead(status) {result.status=status;return this;},end(body) {result.body=JSON.parse(body);}};
  await api(req,res,`/api/contracts/${operation}`);return result;
}
const scope = approved => ({demoScope:approved.demoScope,demoParcelId:approved.demoParcelId});

test('a reducer-confirmed negotiated amount reaches the selected contract and full payment exactly once',async () => withDirectory(async (directory,stateURL) => {
  const value = negotiation(), resolutions = [];
  assert.notEqual(value.agreedCents,value.originalCents);
  const resolveNegotiation = async request => {resolutions.push(request);return clone(value.trusted);};
  const options = {stateURL,environment:{},resolveNegotiation};
  const api = await createContractAPI(options);
  const approval = await call(api,'approve-map',{context:value.context,...value.approval});
  assert.equal(approval.status,200,approval.body.error);
  const approved = approval.body, selected = approved.input.parcels.find(p => p.parcelId === value.context.userParcelId);
  assert.equal(approved.simulated,false);assert.equal(approved.approvalMode,'negotiated');
  assert.deepEqual(approved.negotiationRef,value.negotiationRef);
  assert.deepEqual(approved.input.approvalScope,{kind:'single-owner',parcelId:selected.parcelId});
  assert.equal(approved.input.parcels.length,value.handoff.ownerHandoff.parcels.length);
  assert.equal(selected.accepted,true);assert.equal(selected.compensationCents,value.agreedCents);
  assert(approved.input.parcels.filter(p => p !== selected).every(p => p.accepted === false));
  for (const other of approved.input.parcels.filter(p => p !== selected)) {
    assert.equal(other.compensationCents,value.handoff.ownerHandoff.parcels.find(p => p.parcelId === other.parcelId).terms.compensationCents);
  }
  const draft = createContractDraft(approved.input,selected.parcelId,{id:'negotiated-full-contract'});
  assert.equal(contractDocument(draft,approved.input).paymentCents,value.agreedCents);
  const command = async (operation,extra = {}, target = api) => {
    const result = await call(target,operation,{packageId:approved.packageId,...scope(approved),draft,...extra});
    assert.equal(result.status,200,result.body.error);return result.body;
  };
  await command('sign/utility');const signed = await command('sign/landowner');
  assert.equal(signed.paymentReady,true);assert.equal(signed.packageReady,false);
  assert.equal(signed.agreementProgress.totalCount,1);assert.equal(signed.routeAgreementProgress.totalCount,approved.input.parcels.length);
  const paid = await command('submit');
  assert.equal(paid.payment.status,'paid');assert.equal(paid.payment.amountCents,value.agreedCents);
  assert.match(paid.payment.obligationId,/^full-[a-f0-9]{32}$/);
  assert.equal(paid.journal.length,1);assert.equal(paid.journal[0].debitCents,value.agreedCents);
  assert.equal(paid.construction.status,'not-applicable');
  const replay = await command('submit');assert.equal(replay.payment.obligationId,paid.payment.obligationId);assert.equal(replay.journal.length,1);
  const restarted = await createContractAPI(options);
  const persisted = await command('submit',{},restarted);assert.equal(persisted.payment.obligationId,paid.payment.obligationId);assert.equal(persisted.journal.length,1);
  const reordered = await call(restarted,'approve-map',{context:value.context,...value.approval,
    negotiationRef:{revision:value.negotiationRef.revision,eventId:value.negotiationRef.eventId,attemptId:value.negotiationRef.attemptId}});
  assert.equal(reordered.status,200,reordered.body.error);assert.equal(reordered.body.packageId,approved.packageId);
  const newDraft = {...draft,id:'same-negotiation-new-draft'};
  assert.equal((await call(restarted,'submit',{packageId:approved.packageId,...scope(approved),draft:newDraft})).status,409);
  assert.equal((await call(api,'approve-map',{context:value.context,demoScope:'single-owner',demoTarget:'participant'})).status,409);
  assert(resolutions.length > 3);assert.deepEqual(resolutions[0],{context:value.context,negotiationRef:value.negotiationRef});
  const saved = JSON.parse(await readFile(join(directory,'map-contracts.json'),'utf8')).packages[approved.packageId];
  assert.equal(Object.keys(saved.ledger.obligations).length,1);assert.equal(saved.ledger.journal.length,1);
  assert(!JSON.stringify(saved).includes('We can offer $'),'private transcript is not copied to contract persistence');
}));

test('negotiated approval requires the configured authoritative resolver and rejects browser money or forged references',async () => withDirectory(async (_directory,stateURL) => {
  const value = negotiation();
  const disconnected = await createMapContractService({stateURL});
  await assert.rejects(disconnected.approve(value.context,value.approval),/not connected/);
  const service = await createMapContractService({stateURL,resolveNegotiation:async () => clone(value.trusted)});
  await assert.rejects(service.approve(value.context,{demoScope:'single-owner',demoTarget:'participant'}),/saved negotiation|reference|saved result/);
  for (const negotiationRef of [
    {...value.negotiationRef,eventId:'different-event'},
    {...value.negotiationRef,attemptId:'different-attempt'},
    {...value.negotiationRef,revision:value.negotiationRef.revision + 1},
    {...value.negotiationRef,agreedCents:1},
  ]) await assert.rejects(service.approve(value.context,{...value.approval,negotiationRef}),/reference|stale/);
  await assert.rejects(service.approve(value.context,{negotiationRef:value.negotiationRef}),/participant contract scope/);
  const api = await createContractAPI({stateURL,environment:{},resolveNegotiation:async () => clone(value.trusted)});
  const altered = await call(api,'approve-map',{context:value.context,...value.approval,agreedCents:1});
  assert.equal(altered.status,409);assert.match(altered.body.error,/never browser-approved money/);
}));

test('trusted snapshots with stale policy, excess compensation or conditional acceptance cannot authorize contracts',() => {
  const value = negotiation();
  assert.equal(value.trusted.state.attempts[value.negotiationRef.attemptId].summary.reason,'AGREED');
  const selected = trusted => trusted.state.handoff.parcels.find(p => p.parcelId === trusted.localParcelId);
  const mutations = [
    trusted => {trusted.mapBinding.routeVersion++;},
    trusted => {trusted.state.current.revision++;},
    trusted => {trusted.state.current.termsVersions[trusted.localParcelId]++;},
    trusted => {trusted.state.current.offerPolicies[trusted.localParcelId].recommendedOfferCents++;},
    trusted => {selected(trusted).offerCapCents++;},
    trusted => {selected(trusted).terms.monthlyRentIsApproximate=true;},
    trusted => {trusted.state.handoff.budgetCents--;},
    trusted => {trusted.state.active=false;},
    trusted => {trusted.state.handoff.owners.find(owner => owner.ownerId === selected(trusted).ownerId).banking.paymentRecipientRef='mock-different-recipient';},
    trusted => {trusted.localParcelId=trusted.state.handoff.parcels.find(p => p.parcelId !== trusted.localParcelId).parcelId;},
    trusted => {
      const parcel = selected(trusted), amount = parcel.offerCapCents + 1;
      const attempt = trusted.state.attempts[value.negotiationRef.attemptId];
      parcel.terms.compensationCents=amount;attempt.offers.at(-1).compensationCents=amount;
      attempt.summary.agreedCents=amount;attempt.summary.offeredCents=amount;
    },
  ];
  for (const mutate of mutations) {
    const trusted = clone(value.trusted);mutate(trusted);
    assert.throws(() => agreementFromNegotiation(trusted,value.handoff,value.negotiationRef));
  }
  const conditioned = negotiation({response:'conditions'});
  assert.equal(conditioned.trusted.state.attempts[conditioned.negotiationRef.attemptId].summary.reason,'ADDITIONAL_CONDITIONS');
  assert.throws(() => agreementFromNegotiation(conditioned.trusted,conditioned.handoff,conditioned.negotiationRef),/not approved/);
});

test('refreshing changed negotiation terms blocks new writes but preserves reconciliation of an existing uncertain attempt',async () => withDirectory(async (_directory,stateURL) => {
  const value = negotiation();let current = clone(value.trusted), transferCount = 0, evidence;
  const baseBank = createDemoBank();
  const bank = {...baseBank,inspect:async () => ({recipientMatches:true,balanceCents:10000000,existingEvidence:evidence ?? null}),
    transfer:async ({obligationId,amountCents}) => {
      transferCount++;evidence={obligationId,amountCents,recipientMatches:true,status:'completed',transactionRef:'test-confirmed-after-timeout'};
      throw new Error('Synthetic response loss after the bank recorded the transfer.');
    }};
  const options = {stateURL,bank,resolveNegotiation:async () => clone(current)};
  const service = await createMapContractService(options), approved = await service.approve(value.context,value.approval);
  const draft = createContractDraft(approved.input,approved.demoParcelId,{id:'negotiated-uncertain-contract'});
  const execute = action => service.execute(approved.packageId,action,scope(approved));
  await execute(workflow => workflow.sign(draft,'utility',DEMO_ACTORS.utility));
  await execute(workflow => workflow.sign(draft,'landowner',DEMO_ACTORS.landowner));
  const uncertain = await execute(workflow => workflow.submit(draft,DEMO_ACTORS.requester));
  assert.equal(uncertain.payment.status,'unknown');assert.equal(transferCount,1);
  const beforeRefresh = await readFile(stateURL,'utf8');
  current = negotiation({amountCents:value.agreedCents + 1}).trusted;
  await assert.rejects(execute(workflow => workflow.submit(draft,DEMO_ACTORS.requester)),/agreed terms changed/);
  await assert.rejects(execute(workflow => workflow.sign(draft,'utility',DEMO_ACTORS.utility)),/agreed terms changed/);
  await assert.rejects(service.approve(value.context,value.approval),/already has a payment attempt/);
  assert.equal(await readFile(stateURL,'utf8'),beforeRefresh);assert.equal(transferCount,1);
  const restarted = await createMapContractService(options);
  const reconciled = await restarted.execute(approved.packageId,workflow => workflow.reconcile(draft,DEMO_ACTORS.requester),
    {...scope(approved),reconciliation:true});
  assert.equal(reconciled.payment.status,'paid');assert.equal(reconciled.payment.obligationId,uncertain.payment.obligationId);
  assert.equal(reconciled.payment.amountCents,value.agreedCents);assert.equal(reconciled.journal.length,1);assert.equal(transferCount,1);
  const noObligationDraft = {...draft,id:'no-new-obligation-via-reconcile'};
  await assert.rejects(restarted.execute(approved.packageId,workflow => workflow.reconcile(noObligationDraft,DEMO_ACTORS.requester),
    {...scope(approved),reconciliation:true}),/locks this parcel/);
}));
