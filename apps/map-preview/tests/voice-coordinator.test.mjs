import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceCoordinator} from '../server/voice-coordinator.mjs';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {mapContractRequest,contractSourceFromAgreement} from '../src/contract-handoff.js';
import {agreementFromNegotiation} from '../server/negotiated-contracts.mjs';

const clone=structuredClone,world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const routes=computeTransmissionRoutes(world,placements),route=routes.candidates[0],assumptions=routes.assumptions;
const handoff=createHandoff({world,route,placements,analysis:analyzeRouteParcels(world,route,assumptions),sessionId:'coordinator-test',routeVersion:1});
const context=mapContractRequest(handoff,placements),proposal={handoff,route,placements,assumptions};
const participant={alias:'PRIVATE_TEST_NAME',phoneE164:'+10000000000',consent:true};
const input={clientId:'client-a',context,participant,requestKey:'request-one'};
const terminal=new Set(['accepted','refused','review_required']);

/** In-memory transactional test double, never used by the application runtime. */
function storeFixture() {
  const rows=new Map(),listeners=new Set();let tick=0;
  const emit=()=>{for(const listener of listeners)listener([...rows.values()].map(a=>({id:a.id,sessionId:a.sessionId,revision:a.revision,status:a.status})));};
  const save=a=>{a.revision++;a.updatedAtMicros=String(1792929600000000n+BigInt(++tick)*1000n);rows.set(a.id,a);emit();return clone(a);};
  return {rows,
    async getAttempt(id){return clone(rows.get(id)??null);},
    async reserveAttempt(value){const prior=rows.get(value.id);if(prior)throw new Error('IDEMPOTENCY_CONFLICT');
      const a={...clone(value),revision:0,status:'reserved',claimId:null,providerCallId:null,candidate:null,outcome:null,evidence:[],
        currentOfferCents:value.offerCents,finalOfferMade:false,toolReceipts:{},createdAtMicros:'1792929600000000',paymentSchedule:'full-after-signatures'};
      return{attempt:save(a),replayed:false};},
    async claimAttempt({id}){const a=rows.get(id);if(a.status!=='reserved'||a.claimId)return{attempt:clone(a),claimed:false};
      a.claimId='durable-claim';a.status='dispatching';return{attempt:save(a),claimed:true};},
    async markAttempt({id,status,providerCallId,evidence={}}){const a=rows.get(id);if(terminal.has(a.status))return clone(a);
      a.status=status;if(providerCallId)a.providerCallId=providerCallId;if(Object.keys(evidence).length)a.evidence.push(clone(evidence));return save(a);},
    async saveCandidate({id,candidate}){const a=rows.get(id);if(a.candidate){assert.deepEqual(a.candidate,candidate);return clone(a);}
      assert.equal(candidate.acceptedCompensationCents,a.currentOfferCents);a.candidate=clone(candidate);return save(a);},
    async saveOutcome({id,outcome}){const a=rows.get(id);if(a.outcome){assert.deepEqual(a.outcome,outcome);return clone(a);}
      a.outcome=clone(outcome);a.status=outcome.status;return save(a);},
    async recordTool({id,requestId,kind,payload}){const a=rows.get(id),prior=a.toolReceipts[requestId];
      if(prior){assert.deepEqual(prior.payload,payload);return{attempt:clone(a),receipt:clone(prior)};}
      if(kind==='counteroffer'&&!a.finalOfferMade){a.currentOfferCents=Math.max(a.offerCents,Math.min(payload.requestedCents??a.maxOfferCents,a.maxOfferCents));a.finalOfferMade=true;}
      const receipt={requestId,kind,payload:clone(payload),compensationCents:a.currentOfferCents,finalOffer:a.finalOfferMade};a.toolReceipts[requestId]=receipt;
      return{attempt:save(a),receipt:clone(receipt)};},
    async listPending(){return clone([...rows.values()].filter(a=>!terminal.has(a.status)));},
    subscribeResults(fn){listeners.add(fn);emit();return()=>listeners.delete(fn);},
  };
}
function setup({store=storeFixture(),startFailure=false,inspectStatus='completed',conditional=false,relocate,now=()=> '2026-10-25T12:00:00.000Z'}={}) {
  let starts=0,inspections=0,cancels=0,secret;
  const runtimeFactory=async a=>({
    async start(call){assert.equal(a.status,'dispatching');starts++;secret=call.attemptSecret;if(startFailure)throw new Error('response lost');return{id:'provider-call-test'};},
    async inspect({callId,approvedOfferCents}){assert.equal(callId,'provider-call-test');inspections++;
      if(inspectStatus!=='completed')return{status:inspectStatus,reasonCode:null};
      const amount=approvedOfferCents[0],offer=`We offer $${(amount/100).toFixed(2)}. Does that work?`,owner=conditional?'Yes, if you move the tower to the north edge of my parcel.':'Yes, that works.';
      return{status:'completed',candidate:{decision:conditional?'conditional':'accepted',acceptedCompensationCents:amount,
        condition:conditional?{direction:'north',target:'edge'}:null,offerTurnId:'provider-offer',offerQuote:offer,evidenceTurnId:'provider-owner',evidenceQuote:owner,reasonCode:'ACCEPTED'},
      turns:[{id:'provider-offer',role:'agent',text:offer,index:0},{id:'provider-owner',role:'owner',text:owner,index:1}]};},
    async cancel(){cancels++;return{cancelled:true};},
  });
  const options={store,runtimeFactory,createProposal:async value=>{assert.deepEqual(value,context);return clone(proposal);},world,secret:'test-server-secret-never-log-1234567890',now,...(relocate?{relocate}:{})};
  const coordinator=createVoiceCoordinator(options);
  coordinator.setApproveMap(async(finalContext,{negotiationRef})=>{
    const h=await coordinator.resolveProposal(finalContext),trusted=await coordinator.resolveNegotiation({context:finalContext,negotiationRef});
    const agreement=agreementFromNegotiation(trusted,h,negotiationRef);
    return{input:contractSourceFromAgreement(agreement,h),mapBinding:agreement.mapBinding,negotiationRef,approvalMode:'negotiated',demoScope:'single-owner',demoTarget:'participant',demoParcelId:input.context.userParcelId};
  });
  return{coordinator,options,store,get starts(){return starts;},get inspections(){return inspections;},get cancels(){return cancels;},get secret(){return secret;}};
}

test('reservation and a durable claim allow one call across concurrent hosts, retry and restart',async()=>{
  const x=setup(),other=createVoiceCoordinator(x.options);
  const [first,second]=await Promise.all([x.coordinator.start(input),other.start({...input,requestKey:'request-two'})]);
  assert.equal(first.attemptId,second.attemptId);assert.equal(x.starts,1);
  await other.start({...input,requestKey:'request-three'});assert.equal(x.starts,1);
  x.coordinator.close();other.close();const restarted=createVoiceCoordinator(x.options);
  await restarted.start(input);assert.equal(x.starts,1);
  assert.equal((await restarted.getResult({clientId:'client-b',sessionId:context.sessionId})),null);
  const publicResult=await restarted.getResult({clientId:'client-a',sessionId:context.sessionId});
  for(const secret of [participant.alias,participant.phoneE164,x.secret,'durable-claim'])assert(!JSON.stringify(publicResult).includes(secret));
  restarted.close();
});

test('unknown dispatch never retries the provider and uncertain claim acknowledgement never grants a call',async()=>{
  const x=setup({startFailure:true}),receipt=await x.coordinator.start(input);
  assert.equal(x.starts,1);assert.equal(x.store.rows.get(receipt.attemptId).status,'unknown');
  await x.coordinator.start(input);await x.coordinator.refresh(receipt.attemptId);assert.equal(x.starts,1);assert.equal(x.inspections,0);x.coordinator.close();
  const store=storeFixture(),claim=store.claimAttempt;
  store.claimAttempt=async args=>{await claim(args);throw new Error('lost claim acknowledgement');};
  const y=setup({store});await assert.rejects(y.coordinator.start(input));assert.equal(y.starts,0);
  store.claimAttempt=claim;await y.coordinator.start(input);assert.equal(y.starts,0);y.coordinator.close();
});

test('a verified provider result becomes a private-evidence-free participant contract at the exact counteroffer',async()=>{
  const x=setup(),receipt=await x.coordinator.start(input),a=x.store.rows.get(receipt.attemptId);
  const amount=a.offerCents+Math.floor(a.offerCents/10);
  const tool=await x.coordinator.tool({authorization:`Bearer ${x.secret}`,kind:'counteroffer',input:{requestId:'offer-one',requestedCompensationCents:amount}});
  assert.equal(tool.compensationCents,amount);assert.equal(tool.finalOffer,true);
  const event=await x.coordinator.refresh(receipt.attemptId);
  assert.equal(event.outcome,'accepted');assert.equal(event.acceptedCompensationCents,amount);assert.equal(event.monthlyRentCents,0);
  assert.equal(event.contractApproval.input.parcels.filter(p=>p.accepted).length,1);
  assert.equal(event.contractApproval.input.parcels.find(p=>p.accepted).compensationCents,amount);
  assert.equal(event.status,'finished');assert.equal(x.inspections,1);
  assert.deepEqual(await x.coordinator.refresh(receipt.attemptId),event);assert.equal(x.inspections,1);
  for(const value of [participant.alias,participant.phoneE164,'Does that work?','provider-owner',x.secret])assert(!JSON.stringify(event).includes(value));
  await assert.rejects(x.coordinator.resolveNegotiation({context,negotiationRef:{...event.contractApproval.negotiationRef,eventId:'forged-event'}}),/stale/);
  x.coordinator.close();
});

test('tool credentials and provider identity bind one saved attempt; later keys cannot raise a second final offer',async()=>{
  const x=setup();await x.coordinator.start(input);
  await assert.rejects(x.coordinator.tool({authorization:'Bearer invalid',kind:'counteroffer',input:{requestId:'bad',requestedCents:1}}),/authorized/);
  await assert.rejects(x.coordinator.tool({authorization:x.secret,providerCallId:'wrong-call',kind:'counteroffer',input:{requestId:'bad',requestedCents:1}}),/authorized/);
  const first=await x.coordinator.tool({authorization:x.secret,providerCallId:'provider-call-test',kind:'counteroffer',input:{requestId:'offer-one',requestedCents:null}});
  const second=await x.coordinator.tool({authorization:x.secret,kind:'counteroffer',input:{requestId:'offer-two',requestedCents:999999999}});
  assert.equal(second.compensationCents,first.compensationCents);assert.equal(x.starts,1);
  await x.coordinator.refresh((await x.coordinator.getResult({clientId:'client-a',sessionId:context.sessionId})).attemptId);
  await assert.rejects(x.coordinator.tool({authorization:x.secret,kind:'response',input:{requestId:'late',decision:'accepted'}}),/no longer/);x.coordinator.close();
});

test('infeasible first-call conditions remain review-required with no contract and no second call',async()=>{
  const x=setup({conditional:true,relocate:()=>({status:'review_required',reason:'fixture geometry blocked'})});
  const receipt=await x.coordinator.start(input),event=await x.coordinator.refresh(receipt.attemptId);
  assert.equal(event.outcome,'review_required');assert.equal(event.acceptedCompensationCents,null);assert.equal(event.contractApproval,undefined);
  await x.coordinator.start(input);assert.equal(x.starts,1);x.coordinator.close();
});

test('verified first-call conditions reuse original limits and install the final route before scoped approval',async()=>{
  const x=setup({conditional:true,relocate:({route,condition,parcelId})=>({status:'applied',route:clone(route),conditionEvidence:{parcelId,condition,outsideGeometryUnchanged:true}})});
  const receipt=await x.coordinator.start(input),event=await x.coordinator.refresh(receipt.attemptId);
  assert.equal(event.outcome,'accepted');assert.equal(event.relocation.status,'applied');assert.equal(event.relocation.snapshot.routeVersion,2);
  assert.equal(event.contractApproval.input.route.version,2);assert.match(event.contractApproval.input.parcels.find(p=>p.accepted).accessTerms,/north edge/);
  assert.equal(event.contractApproval.input.parcels.filter(p=>p.accepted).length,1);assert.equal(x.starts,1);
  assert.deepEqual(await x.coordinator.refresh(receipt.attemptId),event);x.coordinator.close();
});

test('active session restoration uses only the owning client and original route without contact details',async()=>{
  const x=setup({conditional:true,relocate:({route,condition,parcelId})=>({status:'applied',route:clone(route),conditionEvidence:{parcelId,condition,outsideGeometryUnchanged:true}})});
  assert.equal(await x.coordinator.getActive({clientId:'client-a'}),null);
  const receipt=await x.coordinator.start(input);await x.coordinator.refresh(receipt.attemptId);
  x.coordinator.close();const restarted=createVoiceCoordinator(x.options),active=await restarted.getActive({clientId:'client-a'});
  assert.equal(active.record.routeVersion,1);assert.deepEqual(active.record.mapBinding,context.mapBinding);
  assert.deepEqual(active.facilities,{substation:context.substation,datacenter:context.datacenter});
  assert.equal(await restarted.getActive({clientId:'client-b'}),null);
  for(const value of [participant.alias,participant.phoneE164,x.secret])assert(!JSON.stringify(active).includes(value));
  restarted.close();
});

test('persisted connected time stops a call once at the deadline and survives a coordinator restart',async()=>{
  let time='2026-10-25T12:00:00.000Z';const x=setup({inspectStatus:'started',now:()=>time});
  const receipt=await x.coordinator.start(input);await x.coordinator.refresh(receipt.attemptId);
  assert.equal(x.store.rows.get(receipt.attemptId).evidence.find(e=>e.connectedAt).connectedAt,time);
  x.coordinator.close();const restarted=createVoiceCoordinator(x.options);
  time='2026-10-25T12:01:01.000Z';const stopped=await restarted.refresh(receipt.attemptId);
  assert.equal(stopped.outcome,'review_required');assert.equal(x.cancels,1);assert.equal(x.starts,1);
  await restarted.refresh(receipt.attemptId);assert.equal(x.cancels,1);restarted.close();
});

test('a crash after the durable cancellation marker resumes review without another cancel or inspection',async()=>{
  const x=setup(),receipt=await x.coordinator.start(input),a=x.store.rows.get(receipt.attemptId);
  await x.store.markAttempt({id:a.id,claimId:a.claimId,status:'cancelled',providerCallId:a.providerCallId,evidence:{reasonCode:'CONNECTED_DEADLINE'}});
  x.coordinator.close();const restarted=createVoiceCoordinator(x.options),event=await restarted.refresh(a.id);
  assert.equal(event.outcome,'review_required');assert.equal(x.starts,1);assert.equal(x.inspections,0);assert.equal(x.cancels,0);restarted.close();
});
