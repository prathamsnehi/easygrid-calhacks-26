import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCartesiaTranscript, validateEasyGridVoiceCandidate, reviewEasyGridToolResponse, createEasyGridVoiceRuntime, buildEasyGridVoiceVariables } from '../easygrid-voice.js';
import { easyGridVoiceToolDefinitions, provisionEasyGridVoiceTools } from '../easygrid-tools.js';
import type { CallRecord } from '../calls.service.js';

const call=(owner='Yes.',agent='We offer $989.46 for transmission access. Does that work for you?'):CallRecord=>({id:'call_fixture',agent_id:'agent_fixture',status:'completed',transcript:[
  {role:'assistant',text:agent,start_timestamp:0.1,end_timestamp:4.5},
  {role:'user',text:owner,start_timestamp:4.8,end_timestamp:6.2},
  {role:'assistant',text:'Thank you. Goodbye.',start_timestamp:6.5,end_timestamp:7.5},
]});
function fixture(owner='Yes.',agent?:string){
  const turns=normalizeCartesiaTranscript(call(owner,agent));
  const input={approvedOfferCents:[98946],turns};
  const candidate={decision:'accepted',acceptedCompensationCents:98946,condition:null,evidenceTurnId:turns[1]!.id,evidenceQuote:turns[1]!.text,offerTurnId:turns[0]!.id,offerQuote:turns[0]!.text,reasonCode:'EXPLICIT_ACCEPTANCE'};
  return {input,candidate};
}
test('actual GET-call transcript shape produces stable evidence, not tool arguments or provider summary',()=>{
  const record=call();record.summary='Invented approval';record.dynamic_variables={private:'do not project'};
  record.transcript!.push({role:'assistant',tool_calls:[{arguments:{accepted:true}}]});
  const turns=normalizeCartesiaTranscript(record);
  assert.equal(turns.length,3);assert.deepEqual(turns,normalizeCartesiaTranscript(record));
  assert(!JSON.stringify(turns).includes('Invented'));assert(!JSON.stringify(turns).includes('private'));
  assert.equal(turns[1]!.role,'owner');assert.equal(turns[1]!.index,1);
  assert.deepEqual(normalizeCartesiaTranscript({...record,zdr_enabled:true}),[]);
  assert.deepEqual(normalizeCartesiaTranscript({...record,status:'started'}),[]);
  assert.deepEqual(normalizeCartesiaTranscript({...record,transcript:[{role:'unknown',text:'Yes'}]}),[]);
});
test('approved exact spoken compensation is retained without rounding or cap substitution',()=>{
  const {input,candidate}=fixture();assert.deepEqual(validateEasyGridVoiceCandidate(candidate,input),candidate);
  assert.equal(validateEasyGridVoiceCandidate({...candidate,acceptedCompensationCents:100000},input),null);
  const spoken=fixture('Yes.','We offer nine hundred eighty-nine dollars and forty-six cents. Does that work for you?');
  assert(validateEasyGridVoiceCandidate(spoken.candidate,spoken.input));
  const approximate=fixture('Yes.','We offer about $989.46. Does that work?');assert.equal(validateEasyGridVoiceCandidate(approximate.candidate,approximate.input),null);
  const fraction=fixture('Yes.','We offer $989.465. Does that work?');assert.equal(validateEasyGridVoiceCandidate(fraction.candidate,fraction.input),null);
});
test('simple explicit conditional agreement passes as a candidate, never proof the geometry was satisfied',()=>{
  const {input,candidate}=fixture('Yes, if you move the towers to the north edge of my property.');
  const conditional={...candidate,decision:'conditional',condition:{direction:'north',target:'edge'},reasonCode:'EXPLICIT_EDGE_CONDITION'};
  assert.deepEqual(validateEasyGridVoiceCandidate(conditional,input),conditional);
  assert.equal(validateEasyGridVoiceCandidate({...conditional,condition:{direction:'south',target:'edge'}},input),null);
  assert.equal(validateEasyGridVoiceCandidate({...conditional,decision:'accepted',condition:null},input),null);
});
for(const owner of ['Can you move the line to the north edge of my property?','Yes, if you move the towers to the north edge of my property and pay my taxes.','Yes, if you move the towers to the north edge of another property.','Yes, if you move it north.','Yes, but only if you pay $1200.','Yes, if you move it to the north or east edge of my property.','Yes, if you move the line to the north edge of my property.']){
  test(`unsupported/ambiguous condition stays unverified: ${owner}`,()=>{
    const {input,candidate}=fixture(owner);
    assert.equal(validateEasyGridVoiceCandidate({...candidate,decision:'conditional',condition:{direction:'north',target:'edge'}},input),null);
    assert.equal(validateEasyGridVoiceCandidate(candidate,input),null);
  });
}
test('complete owner quote, final response and latest actual offer prevent selective evidence',()=>{
  const {input,candidate}=fixture('Yes, actually no, I do not agree.');
  assert.equal(validateEasyGridVoiceCandidate({...candidate,evidenceQuote:'Yes'},input),null);
  assert.equal(validateEasyGridVoiceCandidate(candidate,input),null);
  const ordinary=fixture();ordinary.input.turns.push({id:'later',role:'owner',text:'Wait, no.',index:3});
  assert.equal(validateEasyGridVoiceCandidate(ordinary.candidate,ordinary.input),null);
  const different=fixture('Yes, I accept $1,200.');assert.equal(validateEasyGridVoiceCandidate(different.candidate,different.input),null);
  const hiddenDemand=fixture('Yes, and paint every tower green.');assert.equal(validateEasyGridVoiceCandidate(hiddenDemand.candidate,hiddenDemand.input),null);
});
test('refusal is grounded in actual owner speech, not technical completion',()=>{
  const {input,candidate}=fixture('No, I do not agree.');
  const refusal={...candidate,decision:'refused',acceptedCompensationCents:null,offerTurnId:null,offerQuote:null,reasonCode:'EXPLICIT_REFUSAL'};
  assert(validateEasyGridVoiceCandidate(refusal,input));
  const friendly=fixture('No problem.');assert.equal(validateEasyGridVoiceCandidate({...refusal,evidenceTurnId:friendly.input.turns[1]!.id,evidenceQuote:'No problem.'},friendly.input),null);
});
test('runtime reads existing call once, reviews only completed evidence and never redials after unknown',async()=>{
  let dials=0,reads=0,reviews=0;const {candidate}=fixture();
  const service={call:async()=>{dials++;throw Error('uncertain provider delivery');},getCall:async()=>{reads++;return call();},cancelCall:async()=>({cancelled:true})};
  const runtime=createEasyGridVoiceRuntime({service,agentId:'agent_fixture',fromNumberId:'number_fixture',reviewer:{review:async()=>{reviews++;return{ok:true,candidate};}}});
  await assert.rejects(runtime.start({toNumber:'+14155550123',openingCompensationCents:98946,maximumCompensationCents:118735,attemptSecret:'x'.repeat(40)}));
  const result=await runtime.inspect({callId:'call_fixture',approvedOfferCents:[98946]});
  assert.equal(result.candidate?.acceptedCompensationCents,98946);assert.equal(dials,1);assert.equal(reads,1);assert.equal(reviews,1);
  service.getCall=async()=>({...call(),status:'started'});assert.equal((await runtime.inspect({callId:'call_fixture',approvedOfferCents:[98946]})).status,'started');assert.equal(reviews,1);
  service.getCall=async()=>({...call(),agent_id:'other'});assert.equal((await runtime.inspect({callId:'call_fixture',approvedOfferCents:[98946]})).reasonCode,'CALL_BINDING_MISMATCH');
});
test('saved tool response is corroborated against real transcript without a second model or invented turn IDs',()=>{
  const {input}=fixture('Yes, if you move the towers to the north edge of my property.');
  const response={requestId:'response_1',decision:'conditional',acceptedCompensationCents:98946,conditionDirection:'north',conditionQuote:input.turns[1]!.text,evidenceQuote:input.turns[1]!.text};
  const reviewed=reviewEasyGridToolResponse(response,input);assert(reviewed.ok);assert.equal(reviewed.candidate.evidenceTurnId,input.turns[1]!.id);
  assert.equal(reviewEasyGridToolResponse({...response,acceptedCompensationCents:120000},input).ok,false);
  assert.equal(reviewEasyGridToolResponse({...response,evidenceQuote:'Yes.'},input).ok,false);
  assert.equal(reviewEasyGridToolResponse({...response,conditionQuote:'north edge'},input).ok,false);
});
test('authoritative evidence is saved before review and missing persistence cannot authorize acceptance',async()=>{
  const order:string[]=[],{candidate}=fixture();
  const service={call:async()=>{throw Error('No dial expected');},getCall:async()=>call(),cancelCall:async()=>({cancelled:true})};
  const runtime=createEasyGridVoiceRuntime({service,agentId:'agent_fixture',fromNumberId:'number_fixture',
    persistTranscript:async turns=>{assert.equal(turns[1]?.role,'owner');order.push('saved');},
    reviewer:{review:async()=>{order.push('reviewed');return{ok:true,candidate};}}});
  assert.equal((await runtime.inspect({callId:'call_fixture',approvedOfferCents:[98946]})).candidate?.acceptedCompensationCents,98946);
  assert.deepEqual(order,['saved','reviewed']);
  const unavailable=createEasyGridVoiceRuntime({service,agentId:'agent_fixture',fromNumberId:'number_fixture',
    persistTranscript:async()=>{throw Error('unconfirmed');},reviewer:{review:async()=>{throw Error('Must not review');}}});
  const result=await unavailable.inspect({callId:'call_fixture',approvedOfferCents:[98946]});
  assert.equal(result.reasonCode,'STATE_UNAVAILABLE');assert.equal(result.candidate,undefined);
});
test('tool definitions bind provider call and attempt authorization without model-selected identities',()=>{
  const definitions=easyGridVoiceToolDefinitions('https://voice.example.com');
  assert.equal(definitions[0]!.api_schema.request_headers.Authorization.name,'attempt_authorization');
  assert.equal(definitions[0]!.api_schema.request_headers['X-EasyGrid-Call'].name,'system__conversation_id');
  assert(!JSON.stringify(definitions).includes('ownerId'));assert(!JSON.stringify(definitions).includes('sessionId'));
  assert.throws(()=>easyGridVoiceToolDefinitions('http://localhost:3000'));
  assert.throws(()=>easyGridVoiceToolDefinitions('https://127.0.0.1'));
  const variables=buildEasyGridVoiceVariables({openingCompensationCents:98946,maximumCompensationCents:118735,attemptSecret:'x'.repeat(40)});
  assert.equal(variables.opening_compensation,'$989.46');assert(variables.attempt_authorization.startsWith('Bearer '));
});
test('tool provisioning checkpoints each new resource and does not retry an uncertain second create',async()=>{
  let requests=0;const saved:unknown[]=[];
  await assert.rejects(provisionEasyGridVoiceTools({apiKey:'synthetic-key',publicBaseUrl:'https://voice.example.com',onCreated:async(name,id)=>{saved.push({name,id});},fetch:async(_url,init)=>{
    requests++;if(requests===2)throw Error('network lost');const body=JSON.parse(String(init!.body));return Response.json({...body,id:'tool_counter'});
  }}));
  assert.equal(requests,2);assert.deepEqual(saved,[{name:'evaluate_counteroffer',id:'tool_counter'}]);
});
