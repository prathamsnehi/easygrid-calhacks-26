import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialOwnerHandoff, createOwnerHandoffCurrent, applyNegotiationCommand, createNegotiationTools,
  createNegotiationResultUpdate, type NegotiationState } from '@easygrid/contracts';
import { createClaudeNegotiationReviewer, reviewCompletedNegotiation } from '../src/client.ts';

test('synthetic full path: tool candidate -> single review -> committed outcome -> redacted public projection', async () => {
  const packet=createInitialOwnerHandoff();packet.referenceBinding='canonical';
  for(const p of packet.parcels){p.offerCapCents=Math.floor(p.terms.compensationCents*6/5);
    p.offerPolicy={policyId:'recommended-times-1.2-v1',basis:'route-impact-v1',recommendedOfferCents:p.terms.compensationCents,multiplierNumerator:6,multiplierDenominator:5,rounding:'floor-cent'};}
  const current=createOwnerHandoffCurrent(packet);current.offerPolicies=Object.fromEntries(packet.parcels.map(p=>[p.parcelId,{policyId:p.offerPolicy!.policyId,basis:p.offerPolicy!.basis,recommendedOfferCents:p.offerPolicy!.recommendedOfferCents,offerCapCents:p.offerCapCents}]));
  // Test-only transaction harness, not a replacement for CAL-29 persistence.
  let state:NegotiationState={active:true,liveCallLocked:false,workflow:'negotiating',handoff:packet,current,attempts:{},receipts:{}};
  const binding={attemptId:'synthetic-attempt',sessionId:packet.sessionId,routeVersion:1,termsVersion:1};
  function commit(command:unknown,turns:Parameters<typeof applyNegotiationCommand>[2]=[]){const tx=applyNegotiationCommand(state,command,turns);state=tx.state;binding.termsVersion=tx.result.offers.at(-1)!.termsVersion;return tx.result;}
  commit({kind:'prepare',attemptId:binding.attemptId,requestId:'prepare',routeVersion:1,termsVersion:1,parcelId:'L001',mode:'simulated'});
  const tool=createNegotiationTools({authorize:async()=>binding,execute:async(_binding,command)=>commit(command)});
  const offer=await tool({credential:'synthetic-auth',callReference:'synthetic-call',input:{tool:'evaluate_counteroffer',requestId:'raise',requestedCents:1_100_000}});
  assert.equal(offer.compensationCents,1_100_000);
  await tool({credential:'synthetic-auth',callReference:'synthetic-call',input:{tool:'record_owner_response',requestId:'answer',response:'agree'}});
  assert.equal(state.attempts[binding.attemptId]!.summary,null);
  const turns=[{id:'spoken-offer',role:'agent' as const,text:'We offer $11000 plus $300 per month. Does that work for you?',startMs:20000,endMs:25000},
    {id:'spoken-yes',role:'owner' as const,text:'Yes, that works.',startMs:26000,endMs:28000}];
  let requests=0,claimed=false;
  const reviewer=createClaudeNegotiationReviewer({apiKey:'synthetic-key',model:'synthetic-model',fetch:async()=>{requests++;return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({reason:'AGREED',offerTurnId:'spoken-offer',ownerTurnId:'spoken-yes',compensationCents:1_100_000,monthlyRentCents:30000})}]});}});
  const host={claimReview:async()=>{if(claimed)return null;claimed=true;return{attempt:state.attempts[binding.attemptId]!,turns};},commit:async(command:Parameters<typeof commit>[0],evidence:typeof turns)=>commit(command,evidence)};
  const reviewed=await reviewCompletedNegotiation(host,reviewer,binding.attemptId);
  assert.equal(reviewed!.attempt.summary!.disposition,'successful');assert.equal(requests,1);
  assert.equal(await reviewCompletedNegotiation(host,reviewer,binding.attemptId),null);
  const publicResult=createNegotiationResultUpdate({attempt:reviewed!.attempt,eventId:'public-receipt',revision:state.current.revision,
    mapBinding:{sessionId:'local-map',routeId:'local-route',routeVersion:1,proposalKey:'trusted-import-mapping'},localParcelId:'local-parcel'});
  assert.equal(publicResult.summary!.explanation,'Owner agreed to $11,000 plus $300/month.');
  assert(!JSON.stringify(publicResult).includes('spoken-offer\",\"role'));assert(!('turns' in publicResult));
  assert.equal(publicResult.mode,'simulated');
});
