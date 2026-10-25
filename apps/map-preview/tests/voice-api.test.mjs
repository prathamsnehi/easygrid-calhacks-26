import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createVoiceAPI} from '../server/voice-api.mjs';
import {createConfiguredVoiceService} from '../server/voice-service.mjs';

async function server(t, options={}) {
  const api=createVoiceAPI({port:4177,secret:'test-only-private-secret-at-least-32-characters',pollIntervalMs:0,...options});
  t.after(()=>api.close());
  const request=async(path,options={})=>{
    const req=new EventEmitter();
    Object.assign(req,{method:options.method??'GET',url:path,headers:{host:'127.0.0.1:4177',...options.headers},
      async *[Symbol.asyncIterator](){if(options.body)yield Buffer.from(options.body);}});
    const headers=new Map(),chunks=[];let status=0;
    const res={headersSent:false,setHeader(key,value){headers.set(key,value);},
      writeHead(code,values){status=code;this.headersSent=true;for(const [key,value]of Object.entries(values??{}))headers.set(key,value);return this;},
      write(value){chunks.push(value);},end(value){if(value)chunks.push(value);},flushHeaders(){}};
    await api(req,res,path.split('?')[0]);
    return {status,headers,json:async()=>JSON.parse(chunks.join('')),chunks,close:()=>req.emit('close')};
  };
  return {api,request};
}
function coordinator() {
  const starts=[],reads=[],tools=[];
  return {starts,reads,tools,close(){},listPendingIds:async()=>[],refresh:async()=>null,
    start:async input=>{starts.push(input);return{attemptId:'voice-123',status:'negotiating'};},
    getResult:async input=>{reads.push(input);return{attemptId:'voice-123',saved:true};},
    subscribe:async (_input,callback)=>{callback({attemptId:'voice-123',saved:true});return()=>{};},
    tool:async input=>{tools.push(input);return{allowedCompensationCents:10000};}};
}
test('disabled configuration is honest and cannot place a call',async t=>{
  const {request}=await server(t);
  assert.equal((await (await request('/api/voice/config')).json()).enabled,false);
  assert.equal((await request('/api/voice/calls',{method:'POST'})).status,503);
});
test('signed browser identity survives refresh; tampered cookie cannot choose another identity',async t=>{
  const host=coordinator(),{request}=await server(t,{coordinator:host});
  const config=await request('/api/voice/config'),cookie=config.headers.get('set-cookie').split(';')[0];
  assert.match(config.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const call=await request('/api/voice/calls',{method:'POST',headers:{cookie,'content-type':'application/json','x-easygrid-demo':'1'},
    body:JSON.stringify({context:{sessionId:'session-1'},participant:{phone:'+15555550100'},requestKey:'request-1'})});
  assert.equal(call.status,200);
  const receipt=await call.json();assert.deepEqual(receipt,{attemptId:'voice-123',status:'negotiating'});
  assert.equal(JSON.stringify(receipt).includes('+15555550100'),false);
  await request('/api/voice/attempt?sessionId=session-1',{headers:{cookie}});
  assert.equal(host.starts[0].clientId,host.reads[0].clientId);
  await request('/api/voice/attempt?sessionId=session-1',{headers:{cookie:cookie+'x'}});
  assert.notEqual(host.reads[1].clientId,host.starts[0].clientId);
});
test('cross-origin browser requests and browser-approved money are rejected before dispatch',async t=>{
  const host=coordinator(),{request}=await server(t,{coordinator:host});
  for(const [headers,body] of [[{'origin':'https://other.example'},{context:{}}],[{}, {context:{},acceptedCompensationCents:1}]]) {
    const result=await request('/api/voice/calls',{method:'POST',headers:{'content-type':'application/json','x-easygrid-demo':'1',...headers},body:JSON.stringify(body)});
    assert.ok([403,409].includes(result.status));
  }
  assert.equal(host.starts.length,0);
});
test('ordinary multi-owner map binding fits while oversized call requests stay bounded',async t=>{
  const host=coordinator(),{request}=await server(t,{coordinator:host});
  const send=size=>request('/api/voice/calls',{method:'POST',headers:{'content-type':'application/json','x-easygrid-demo':'1'},
    body:JSON.stringify({context:{sessionId:'session-1',mapBinding:{proposalKey:'x'.repeat(size)}},participant:{},requestKey:'request-1'})});
  assert.equal((await send(60000)).status,200);
  assert.equal((await send(256000)).status,409);
  assert.equal(host.starts.length,1);
});
test('public provider route requires scoped bearer and carries no browser identity',async t=>{
  const host=coordinator(),{request}=await server(t,{coordinator:host});
  assert.equal((await request('/api/voice/tools/response',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  const response=await request('/api/voice/tools/counteroffer',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+'a'.repeat(64),'x-easygrid-call':'call-1'},body:JSON.stringify({requestId:'tool-1',requestedCompensationCents:10000})});
  assert.equal(response.status,200);assert.equal(host.tools[0].providerCallId,'call-1');
  assert.equal(host.tools[0].clientId,undefined);assert.equal(response.headers.has('set-cookie'),false);
});
test('SSE sends saved projection using ordinary data frames',async t=>{
  const {request}=await server(t,{coordinator:coordinator()});
  const response=await request('/api/voice/events?sessionId=session-1',{});
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  assert.match(response.chunks.join(''),/data: \{"attemptId":"voice-123","saved":true\}\n\n/);
  response.close();
});
test('startup fails closed with missing configuration without opening providers',async()=>{
  const result=await createConfiguredVoiceService({environment:{EASYGRID_VOICE_ENABLED:'yes'}});
  assert.equal(result.enabled,false);assert.equal(result.coordinator,null);result.api.close();
});

test('an isolated deployment rejects another database before opening either provider',async t=>{
  const opened=[],environment={EASYGRID_VOICE_ENABLED:'yes',
    SPACETIMEDB_DATABASE:'collaborator-database',SPACETIMEDB_EXPECTED_DATABASE:'isolated-test-database',
    SPACETIMEDB_TOKEN:'test-worker-token',CARTESIA_API_KEY:'test-provider-key',
    CARTESIA_AGENT_ID:'test-agent',CARTESIA_FROM_NUMBER_ID:'test-number',
    EASYGRID_VOICE_SECRET:'test-private-secret-at-least-32-characters',
    EASYGRID_VOICE_PUBLIC_URL:'https://voice.example.com'};
  const dependencies=[
    {createVoiceStore:async config=>{opened.push({database:config.databaseName});return{close(){}};}},
    {createCartesiaService:()=>{opened.push({provider:true});return{};}},
    {createVoiceCoordinator:()=>coordinator()},
  ];
  const verifyProvider=async()=>{opened.push({verification:true});};
  const blocked=await createConfiguredVoiceService({environment,dependencies,verifyProvider});
  t.after(()=>blocked.api.close());
  assert.equal(blocked.enabled,false);assert.match(blocked.reason,/isolated database/);
  assert.deepEqual(opened,[],'no database connection or Cartesia request is allowed on a target mismatch');
  const ready=await createConfiguredVoiceService({environment:{...environment,
    SPACETIMEDB_DATABASE:' isolated-test-database '},dependencies,verifyProvider});
  t.after(()=>ready.api.close());
  assert.equal(ready.enabled,true);
  assert.deepEqual(opened,[{verification:true},{database:'isolated-test-database'},{provider:true}]);
});
