import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudflarePreview} from '../server/cloudflare-preview.mjs';
import {fakeDatabase} from './helpers/fake-d1.mjs';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractDraft} from '../src/contract-authoring.js';

const origin = 'https://easygrid.us';
const assets = {'/index.html':{type:'text/html',body:'demo'},'/contracts.html':{type:'text/html',body:'contracts'}};
const request = (path, {cookie, body, headers={}, method=body ? 'POST':'GET'}={}) => new Request(`${origin}${path}`,{
  method, headers:{...(cookie ? {cookie}:{}),...(body ? {origin,'content-type':'application/json','x-easygrid-demo':'1'}:{}),...headers},
  ...(body ? {body:JSON.stringify(body)}:{})});
async function start(handler) {
  const response = await handler(request('/'));
  assert.equal(response.status,200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie,/^__Host-easygrid-demo=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400$/);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  return cookie.split(';')[0];
}

test('public demo rejects spoofed identity headers and malformed or duplicate cookies without touching D1', async()=>{
  const database=fakeDatabase(), handler=createCloudflarePreview({database,assets});
  const token='a'.repeat(64);
  for (const cookie of [undefined,'__Host-easygrid-demo=invalid',`__Host-easygrid-demo=${token}; __Host-easygrid-demo=${token}`]) {
    const result=await handler(request('/api/contracts/config',{cookie,headers:{'oai-authenticated-user-id':'victim'}}));
    assert.equal(result.status,401); assert.equal(result.headers.get('set-cookie'),null);
  }
  assert.equal(database.reads,0); assert.equal(database.writes,0);
  assert.equal((await handler(new Request('http://easygrid.us/'))).status,400);
  assert.equal((await handler(request('/missing'))).headers.get('set-cookie'),null);
  assert.equal((await handler(request('/',{method:'HEAD'}))).headers.get('set-cookie'),null);
});

test('two browser sessions keep separate durable ledgers; spoofed platform headers cannot switch ownership', async()=>{
  const database=fakeDatabase(), handler=createCloudflarePreview({database,assets});
  const first=await start(handler), second=await start(handler);
  assert.notEqual(first,second);
  const draft=createContractDraft(createContractExample(),'P-004',{id:'public-browser'});
  const call=async(path,cookie,body,headers={})=>{
    const result=await createCloudflarePreview({database,assets})(request(`/api/contracts/${path}`,{cookie,body,headers}));
    assert.equal(result.status,200,await result.clone().text()); return result.json();
  };
  await call('sign/utility',first,{draft},{'oai-authenticated-user-id':second});
  const stranger=await call('state',second,{draft});
  assert.deepEqual(stranger.signatures,{});
  await call('sign/landowner',first,{draft});
  for (const parcel of createContractExample().parcels.filter(p=>p.parcelId!=='P-004')) {
    const other=createContractDraft(createContractExample(),parcel.parcelId,{id:`public-${parcel.parcelId}`});
    await call('sign/utility',first,{draft:other}); await call('sign/landowner',first,{draft:other});
  }
  const [paid,repeated]=await Promise.all([call('submit',first,{draft}),call('submit',first,{draft})]);
  assert.equal(paid.payment.status,'paid'); assert.equal(repeated.journal.length,1);
  assert.equal(paid.payment.amountCents,createContractExample().parcels.find(p=>p.parcelId==='P-004').compensationCents);
  for(const key of database.rows.keys()) {
    assert.match(key,/^easygrid:browser:[a-f0-9]{64}$/);
    assert(!key.includes(first.split('=')[1]));
  }
  const config=await call('config',first);
  assert.match(config.storage,/browser-scoped/); assert.equal(config.liveVoiceEnabled,false);
  assert.equal((await handler(request('/',{cookie:first}))).headers.get('set-cookie'),null);
});

test('public session does not bypass same-origin checks or enable live providers', async()=>{
  const database=fakeDatabase(), handler=createCloudflarePreview({database,assets}), cookie=await start(handler);
  for(const headers of [{origin:'https://other.example'},{origin:''},{'sec-fetch-site':'cross-site'}]) {
    assert.equal((await handler(request('/api/contracts/submit',{cookie,body:{},headers}))).status,403);
  }
  assert.equal(database.reads,0);
  const voice=await handler(request('/api/voice/calls',{cookie,body:{}}));
  assert.equal(voice.status,503); assert.equal(database.writes,0);
});
