import test from 'node:test';
import assert from 'node:assert/strict';
import {approveMapContracts,createContractAPIClient} from '../src/contract-api-client.js';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractDraft} from '../src/contract-authoring.js';
const packageId=`map-contract-${'a'.repeat(40)}`;
const approval={input:createContractExample(),simulated:true,packageId,demoScope:'single-owner',demoParcelId:'P-009'};

test('map approval explicitly requests one representative contract and rejects older server responses', async () => {
  let body;
  const result=await approveMapContracts({sessionId:'fixture'}, {fetcher:async (_url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>approval};}});
  assert.equal(body.demoScope,'single-owner'); assert.equal(result.demoParcelId,'P-009');
  for (const bad of [{...approval,demoScope:undefined},{...approval,demoParcelId:'not-on-route'}]) {
    await assert.rejects(approveMapContracts({}, {fetcher:async()=>({ok:true,json:async()=>bad})}),/does not support the representative contract demo/);
  }
});

test('scoped operations preserve full draft inputs and require matching server scope', async () => {
  const source=createContractExample(), draft=createContractDraft(source,'P-009');
  let body, responseScope={demoScope:'single-owner',demoParcelId:'P-009'};
  const api=createContractAPIClient({packageId,demoScope:'single-owner',demoParcelId:'P-009',fetcher:async (_url,options)=>{
    body=JSON.parse(options.body);
    return {ok:true,json:async()=>({draftId:draft.id,documentHash:'b'.repeat(64),signatures:{},audit:[],packageId,...responseScope})};
  }});
  await api('state',draft);
  assert.equal(body.demoScope,'single-owner'); assert.equal(body.demoParcelId,'P-009'); assert.equal(body.packageId,packageId);
  assert.equal(body.draft.sourceKey,draft.sourceKey); assert.equal(JSON.parse(body.draft.sourceKey).parcels.length,2);
  for (const scope of [{},{demoScope:'single-owner',demoParcelId:'P-004'}]) {
    responseScope=scope; await assert.rejects(api('state',draft),/did not confirm the representative demo contract/);
  }
});


test('participant approval explicitly targets the current call parcel and rejects a substituted owner', async () => {
  const context={userParcelId:'P-004'};let body;
  const selected={...approval,demoTarget:'participant',demoParcelId:'P-004'};
  await approveMapContracts(context,{demoTarget:'participant',fetcher:async(_url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>selected};}});
  assert.equal(body.demoTarget,'participant');assert.equal(body.context.userParcelId,'P-004');
  for(const bad of [{...selected,demoTarget:'representative'},{...selected,demoParcelId:'P-009'}]){
    await assert.rejects(approveMapContracts(context,{demoTarget:'participant',fetcher:async()=>({ok:true,json:async()=>bad})}),/did not approve the current call target/);
  }
});

test('a non-JSON approval response is treated as a missing approval service',async()=>{
  await assert.rejects(approveMapContracts({sessionId:'fixture'},{fetcher:async()=>({ok:false,json:async()=>{throw new Error('Unexpected token');}})}),/approval service is unavailable/);
});

test('negotiated approval sends only a committed reference and rejects a simulated fallback',async()=>{
  const context={userParcelId:'P-004'},negotiationRef={attemptId:'attempt-1',eventId:'event-4',revision:4};let body;
  const verified={...approval,demoTarget:'participant',demoParcelId:'P-004',approvalMode:'negotiated',negotiationRef,
    input:{...approval.input,approvalScope:{kind:'single-owner',parcelId:'P-004'}}};
  await approveMapContracts(context,{demoTarget:'participant',negotiationRef:{...negotiationRef,agreedCents:12345},fetcher:async(_url,options)=>{
    body=JSON.parse(options.body);return {ok:true,json:async()=>verified};
  }});
  assert.deepEqual(body.negotiationRef,negotiationRef);assert(!JSON.stringify(body).includes('agreedCents'));
  for(const bad of [{...verified,approvalMode:undefined},{...verified,negotiationRef:{...negotiationRef,revision:3}},{...verified,input:approval.input}]){
    await assert.rejects(approveMapContracts(context,{demoTarget:'participant',negotiationRef,fetcher:async()=>({ok:true,json:async()=>bad})}),/did not verify/);
  }
});
