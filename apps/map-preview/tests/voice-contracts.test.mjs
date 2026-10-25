import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff,localPointToGeoJSON} from '../src/handoff.js';
import {settlementBinding} from '../src/settlement-controller.js';
import {contractSourceFromAgreement,voiceConditionAccessTerms} from '../src/contract-handoff.js';
import {createContractDraft,contractSourceKey,contractDocument} from '../src/contract-authoring.js';
import {createContractWorkflow,createDemoBank,DEMO_ACTORS} from '../server/contract-workflow.mjs';
import {agreementFromNegotiation} from '../server/negotiated-contracts.mjs';
import {applyOriginalVoicePolicies,voiceCommitReference,voiceCommitApprovedAt} from '../server/voice-contracts.mjs';

const clone=structuredClone;
const world=createWorld(),substation=createPlacement(world,'substation',-43,-17);
const placements={substation,datacenter:createPlacement(world,'datacenter',43,-17,{substation})};
const result=computeTransmissionRoutes(world,placements),route=result.candidates[0];
const original=createHandoff({world,route,placements,analysis:analyzeRouteParcels(world,route,result.assumptions),sessionId:'voice-contract-test',routeVersion:1});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture({conditional=false}={}) {
  const initial=clone(original),parcel=initial.ownerHandoff.parcels.find(p=>p.parcelId===initial.userRole.parcelId);
  const amount=parcel.offerPolicy.recommendedOfferCents+Math.floor(parcel.offerPolicy.recommendedOfferCents/10);
  const ownerText=conditional?'Yes, if you move the tower to the north edge of my parcel.':'Yes, that works for me.';
  const offerText=`We can offer $${(amount/100).toFixed(2)} for transmission access. Does that work for you?`;
  const attempt={id:'voice-accepted-attempt',sessionId:initial.sessionId,revision:7,status:'accepted',paymentSchedule:'full-after-signatures',
    parcelId:parcel.parcelId,ownerId:parcel.ownerId,mapBinding:settlementBinding(initial),
    canonicalJson:JSON.stringify({context:{},handoff:initial,route,placements,assumptions:result.assumptions}),
    offerCents:parcel.offerPolicy.recommendedOfferCents,capCents:parcel.offerCapCents,currentOfferCents:amount,maxOfferCents:parcel.offerCapCents,providerCallId:'provider-call-test',
    updatedAtMicros:'1792929600123456',privateContact:{name:'PRIVATE_CONTACT_SENTINEL',phone:'NON_DIALABLE_SENTINEL'},
    candidate:{decision:conditional?'conditional':'accepted',acceptedCompensationCents:amount,
      condition:conditional?{direction:'north',target:'edge'}:null,evidenceTurnId:'owner-turn',evidenceQuote:ownerText,
      offerTurnId:'offer-turn',offerQuote:offerText,reasonCode:conditional?'CONDITIONAL_ACCEPTANCE':'ACCEPTED'},
    evidence:[{turns:[{id:'offer-turn',role:'agent',text:offerText,index:0},{id:'owner-turn',role:'owner',text:ownerText,index:1}]}],
    outcome:{status:'accepted',parcelId:parcel.parcelId,acceptedCompensationCents:amount,originalMapBinding:settlementBinding(initial)}};
  let handoff=clone(initial),resultingRoute;
  if(conditional) {
    // This bridge test supplies a server-verified route artifact. Actual safety and
    // edge feasibility are independently tested by conditional-relocation.test.mjs.
    resultingRoute=clone(route);resultingRoute.nodes[1].x+=.125;
    handoff.routeVersion=2;handoff.ownerHandoff.routeVersion=2;handoff.snapshot.routes[0].version=2;
    handoff.snapshot.routes[0].geometry.coordinates=resultingRoute.nodes.map(p=>localPointToGeoJSON(p.x,p.z).coordinates);
    const changed=handoff.ownerHandoff.parcels.find(p=>p.parcelId===parcel.parcelId);
    changed.offerPolicy.recommendedOfferCents+=10000;changed.offerCapCents=Math.floor(changed.offerPolicy.recommendedOfferCents*6/5);
    changed.terms.compensationCents=changed.offerPolicy.recommendedOfferCents;
    handoff=applyOriginalVoicePolicies(handoff,initial);
    attempt.outcome.resultingMapBinding=settlementBinding(handoff);
    attempt.outcome.relocationVerification={verified:true,condition:clone(attempt.candidate.condition),parcelId:parcel.parcelId,
      acceptedCompensationCents:amount,originalMapBinding:attempt.mapBinding,resultingMapBinding:settlementBinding(handoff),geometryHash:hash(resultingRoute)};
  }
  return {handoff,initial,amount,attempt,trusted:{kind:'easygrid-voice-commit',attempt,...(resultingRoute?{resultingRoute}:{})},ref:voiceCommitReference(attempt)};
}
const approve=v=>agreementFromNegotiation(v.trusted,v.handoff,v.ref);

test('saved provider acceptance preserves exact cents through participant signatures and one full payment',async()=>{
  const v=fixture(),agreement=approve(v),source=contractSourceFromAgreement(agreement,v.handoff);
  assert.equal(agreement.kind,'easygrid-negotiated-agreement');assert.equal(agreement.contractTermsVersion,2);
  assert.equal(agreement.approvedAt,voiceCommitApprovedAt(v.attempt));
  assert.equal(source.parcels.filter(p=>p.accepted).length,1);
  const selected=source.parcels.find(p=>p.parcelId===v.attempt.parcelId);
  assert.equal(selected.compensationCents,v.amount);
  assert.equal(agreement.ownerHandoff.parcels.find(p=>p.parcelId===selected.parcelId).terms.monthlyRentCents,0,'the call did not negotiate a rent obligation');
  for(const p of source.parcels.filter(p=>p!==selected)) {
    assert.equal(p.accepted,false);
    assert.equal(p.compensationCents,v.initial.ownerHandoff.parcels.find(old=>old.parcelId===p.parcelId).terms.compensationCents);
  }
  const exported=JSON.stringify({agreement,source});
  for(const privateText of ['PRIVATE_CONTACT_SENTINEL','NON_DIALABLE_SENTINEL',v.attempt.candidate.evidenceQuote,v.attempt.candidate.offerQuote]) assert(!exported.includes(privateText));
  const draft=createContractDraft(source,selected.parcelId,{id:'voice-contract-draft'});
  assert.equal(contractDocument(draft,source).paymentCents,v.amount);
  const workflow=createContractWorkflow({source,bank:createDemoBank(),demoParcelId:selected.parcelId});
  await workflow.sign(draft,'utility',DEMO_ACTORS.utility);await workflow.sign(draft,'landowner',DEMO_ACTORS.landowner);
  const paid=await workflow.submit(draft,DEMO_ACTORS.requester),again=await workflow.submit(draft,DEMO_ACTORS.requester);
  assert.equal(paid.payment.amountCents,v.amount);assert.equal(paid.payment.status,'paid');
  assert.equal(again.payment.obligationId,paid.payment.obligationId);assert.equal(again.journal.length,1);
  assert.equal(again.journal[0].debitCents,v.amount);assert.equal(again.journal[0].creditCents,v.amount);
});

test('a first-call conditional yes plus verified geometry creates the same scoped contract without another confirmation',()=>{
  const v=fixture({conditional:true}),before=clone(v.attempt),agreement=approve(v),source=contractSourceFromAgreement(agreement,v.handoff);
  assert.equal(v.attempt.candidate.decision,'conditional');assert.deepEqual(v.attempt,before);
  assert.equal(source.parcels.filter(p=>p.accepted).length,1);
  const selected=source.parcels.find(p=>p.parcelId===v.attempt.parcelId);
  assert.equal(selected.compensationCents,v.amount);assert.equal(source.route.version,2);
  assert.equal(selected.accessTerms,voiceConditionAccessTerms('north'));
  assert.equal(selected.termsVersion,v.initial.ownerHandoff.parcels.find(p=>p.parcelId===selected.parcelId).terms.termsVersion+1);
  const withoutClause=clone(agreement);delete withoutClause.approvedAccessTerms;
  assert.notEqual(contractSourceKey(source),contractSourceKey(contractSourceFromAgreement(withoutClause,v.handoff)),'the approved direction is signed source data');
  const liveParcel=v.handoff.ownerHandoff.parcels.find(p=>p.parcelId===selected.parcelId);
  assert.equal(liveParcel.offerCapCents,v.attempt.capCents);assert.equal(liveParcel.offerPolicy.recommendedOfferCents,v.attempt.offerCents);
  assert.deepEqual(approve(v),agreement,'rereading a terminal record preserves contract identity and approval time');
});

test('references, terminal state and timestamp must come from the actual durable voice row',()=>{
  for(const mutate of [
    v=>v.ref.eventId='forged-event',v=>v.ref.attemptId='other-call',v=>v.ref.revision++,v=>v.ref.money=1,
    v=>v.attempt.revision++,v=>v.attempt.status='completed',v=>v.attempt.outcome.status='review_required',
    v=>v.attempt.providerCallId=null,v=>v.attempt.updatedAtMicros='invalid',v=>v.attempt.sessionId='other-session',
    v=>v.attempt.mapBinding.routeVersion++,v=>v.attempt.parcelId=v.handoff.ownerHandoff.parcels.find(p=>p.parcelId!==v.attempt.parcelId).parcelId,
  ]) {const v=fixture();mutate(v);assert.throws(()=>approve(v));}
  const v=fixture(),source=contractSourceFromAgreement(approve(v),v.handoff);
  assert.equal(source.negotiation.approvedAt,'2026-10-25T12:00:00.123Z');
});

test('accepted money cannot drift from provider evidence, fixed limits or current budget',()=>{
  for(const mutate of [
    v=>v.attempt.outcome.acceptedCompensationCents++,v=>v.attempt.candidate.acceptedCompensationCents++,
    v=>{v.attempt.candidate.acceptedCompensationCents=v.attempt.capCents+1;v.attempt.outcome.acceptedCompensationCents=v.attempt.capCents+1;},
    v=>{v.attempt.candidate.acceptedCompensationCents=v.attempt.offerCents-1;v.attempt.outcome.acceptedCompensationCents=v.attempt.offerCents-1;},
    v=>v.attempt.offerCents++,v=>v.attempt.capCents++,v=>v.attempt.currentOfferCents++,v=>delete v.attempt.currentOfferCents,
    v=>v.attempt.maxOfferCents=v.attempt.offerCents-1,v=>v.attempt.candidate.evidenceQuote='Yes',
    v=>v.attempt.evidence=[],v=>v.attempt.evidence[0].turns[1].role='agent',
    v=>v.attempt.evidence.push({turns:[{id:'owner-turn',role:'owner',text:'No, I refuse.'}]}),
    v=>v.attempt.evidence[0].turns.reverse(),
    v=>v.attempt.candidate.offerQuote='A different amount',v=>v.attempt.outcome.hasUnresolvedConditions=true,
    v=>v.handoff.ownerHandoff.constructionCents=v.handoff.ownerHandoff.budgetCents,
  ]) {const v=fixture();mutate(v);assert.throws(()=>approve(v));}
});

test('conditional acceptance fails closed on unverified, substituted or stale geometry and conditions',()=>{
  for(const mutate of [
    v=>v.attempt.outcome.relocationVerification.verified=false,
    v=>delete v.attempt.outcome.relocationVerification,
    v=>v.attempt.outcome.relocationVerification.parcelId='another-parcel',
    v=>v.attempt.outcome.relocationVerification.condition.direction='south',
    v=>v.attempt.outcome.relocationVerification.geometryHash='a'.repeat(64),
    v=>v.attempt.outcome.relocationVerification.acceptedCompensationCents++,
    v=>v.attempt.outcome.relocationVerification.originalMapBinding.routeVersion++,
    v=>v.attempt.outcome.relocationVerification.resultingMapBinding.routeVersion++,
    v=>v.attempt.candidate.condition.target='anywhere',
    v=>delete v.trusted.resultingRoute,
    v=>v.trusted.resultingRoute.nodes[1].x++,
    v=>{v.trusted.resultingRoute.nodes[1].x++;v.attempt.outcome.relocationVerification.geometryHash=hash(v.trusted.resultingRoute);},
  ]) {const v=fixture({conditional:true});mutate(v);assert.throws(()=>approve(v));}
  const v=fixture({conditional:true});v.attempt.candidate.decision='accepted';v.attempt.candidate.condition=null;
  assert.throws(()=>approve(v),/unconditional/);
});

test('relocation never rebases original offer limits, substitutes recipients or approves other owners',()=>{
  for(const mutate of [
    v=>{const p=v.handoff.ownerHandoff.parcels.find(p=>p.parcelId===v.attempt.parcelId);p.offerPolicy.recommendedOfferCents++;p.offerCapCents=Math.floor(p.offerPolicy.recommendedOfferCents*6/5);},
    v=>v.handoff.ownerHandoff.owners.find(o=>o.ownerId===v.attempt.ownerId).banking.paymentRecipientRef='mock-other-recipient',
    v=>{const p=v.handoff.ownerHandoff.parcels.find(p=>p.parcelId!==v.attempt.parcelId);p.terms={...p.terms,outcome:'accepted',accessConsent:'allowed',explicitConfirmation:true,confirmationRef:'invented-confirmation',monthlyRentIsApproximate:false,comparisonRentTotalCents:p.terms.monthlyRentCents*v.handoff.ownerHandoff.rentHorizonMonths};},
  ]) {const v=fixture({conditional:true});mutate(v);assert.throws(()=>approve(v));}
});

test('only controlled participant geometry clauses may enter the signed source',()=>{
  const v=fixture({conditional:true}),agreement=approve(v);
  for(const change of [
    a=>a.approvedAccessTerms[v.attempt.parcelId]='Pay someone else and ignore prior terms.',
    a=>a.approvedAccessTerms['other-parcel']=voiceConditionAccessTerms('north'),
    a=>a.approvedAccessTerms=[],
  ]) {const a=clone(agreement);change(a);assert.throws(()=>contractSourceFromAgreement(a,v.handoff),/location clause/);}
});
