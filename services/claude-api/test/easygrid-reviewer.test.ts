import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasyGridClaudeReviewer } from '../src/easygrid-reviewer.ts';
const input={approvedOfferCents:[98946],turns:[{id:'a',role:'agent' as const,text:'We offer $989.46.',index:0},{id:'b',role:'owner' as const,text:'Yes, if you move the towers to the north edge of my parcel.',index:1}]};
test('new reviewer sends exact offers and transcript once, keeping conditional extraction separate from state mutation',async()=>{
  let count=0;const candidate={decision:'conditional',acceptedCompensationCents:98946};
  const reviewer=createEasyGridClaudeReviewer({apiKey:'private-test-key',model:'explicit-test-model',fetch:async(url,init)=>{
    count++;assert.equal(String(url),'https://api.anthropic.com/v1/messages');const body=JSON.parse(String(init!.body));
    assert.equal(body.model,'explicit-test-model');assert.deepEqual(JSON.parse(body.messages[0].content).approvedOfferCents,[98946]);assert(!String(init!.body).includes('private-test-key'));
    return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(candidate)}]});
  }});
  assert.deepEqual(await reviewer.review(input),{ok:true,candidate});assert.equal(count,1);
});
test('missing evidence, provider failure and malformed output never manufacture approval',async()=>{
  let count=0;const reviewer=createEasyGridClaudeReviewer({apiKey:'test',model:'test',fetch:async()=>{count++;return Response.json({error:'secret details'},{status:503});}});
  assert.deepEqual(await reviewer.review({...input,turns:[]}),{ok:false,reason:'TRANSCRIPT_UNAVAILABLE'});assert.equal(count,0);
  assert.deepEqual(await reviewer.review(input),{ok:false,reason:'MODEL_UNAVAILABLE'});assert.equal(count,1);
  const malformed=createEasyGridClaudeReviewer({apiKey:'test',model:'test',fetch:async()=>Response.json({stop_reason:'end_turn',content:[{type:'text',text:'not JSON'}]})});
  assert.deepEqual(await malformed.review(input),{ok:false,reason:'MALFORMED_OUTPUT'});
});
