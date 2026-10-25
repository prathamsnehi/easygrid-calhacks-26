import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceClient,validateVoiceEvent,voiceResultView} from '../src/voice-client.js';
import {settlementBinding} from '../src/settlement-controller.js';

const handoff={sourceMode:'fixture',sessionId:'private-session',routeVersion:1,userRole:{parcelId:'P1'},
  snapshot:{routes:[{id:'route',eligible:true}]},ownerHandoff:{routeId:'route',parcels:[{parcelId:'P1',terms:{monthlyRentCents:0,termsVersion:1}}]}};
const binding=settlementBinding(handoff);
const event=(extra={})=>({schemaVersion:1,kind:'easygrid-voice-result',attemptId:'attempt-1',eventId:'event-1',revision:2,
  saved:true,mode:'live',mapBinding:binding,localParcelId:'P1',status:'finished',outcome:'accepted',acceptedCompensationCents:123456,monthlyRentCents:0,
  reason:'The owner accepted the agreed amount.',termsVersion:2,...extra});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('voice requests keep participant data in POST only and reuse the request key after an uncertain response',async()=>{
  const requests=[];let fail=true;
  const client=createVoiceClient({getPlacements:()=>({substation:{x:0,z:0},datacenter:{x:1,z:1}}),makeRequestKey:()=> 'request-one',
    fetcher:async(url,options)=>{requests.push({url,options});if(fail)throw new Error('private provider detail');return {ok:true,json:async()=>({attemptId:'attempt-1',status:'negotiating'})};}});
  const input={handoff,participant:{alias:'Private name',phoneE164:'+12025550147',consent:true},signal:new AbortController().signal};
  await assert.rejects(client.requestCall(input),/saved call status/);
  fail=false;assert.equal((await client.requestCall(input)).attemptId,'attempt-1');
  assert(requests.every(r=>r.url==='/api/voice/calls'&&r.options.method==='POST'&&r.options.credentials==='same-origin'));
  const body=JSON.parse(requests[0].options.body);
  assert.deepEqual(body.participant,input.participant);assert.equal(body.requestKey,'request-one');
  assert.equal(JSON.parse(requests[1].options.body).requestKey,body.requestKey);
  assert(!JSON.stringify(body.context).includes(input.participant.phoneE164));
  assert.equal(Object.hasOwn(body,'acceptedCompensationCents'),false);
});

test('SSE restores saved state on reconnect, ignores stale routes and stops after cancellation without making a call',async()=>{
  const received=[],urls=[];let stream,unavailable=0,saved=event();
  const client=createVoiceClient({fetcher:async(url,options)=>{urls.push(url);assert.equal(options.method,undefined);return {ok:true,json:async()=>({attempt:saved})};},
    eventSourceFactory:url=>{urls.push(url);return stream={closed:false,close(){this.closed=true;}};},onResult:result=>received.push(result)});
  const controller=new AbortController();client.subscribe({mapBinding:binding,signal:controller.signal,onUnavailable:()=>unavailable++});await flush();
  assert.equal(received.length,1);assert.equal(received[0].acceptedCompensationCents,123456);
  stream.onmessage({data:JSON.stringify(event({mapBinding:{...binding,routeVersion:99}}))});await flush();assert.equal(received.length,1);
  stream.onerror();assert.equal(unavailable,1);stream.onopen();await flush();assert.equal(received.length,2);
  stream.onmessage({data:JSON.stringify(event({saved:false}))});await flush();assert.equal(unavailable,2);
  assert(urls.every(url=>/^\/api\/voice\/(?:attempt|events)\?sessionId=private-session$/.test(url)));
  controller.abort();stream.onmessage({data:JSON.stringify(saved)});await flush();assert.equal(received.length,2);assert(stream.closed);
});

test('voice display keeps exact accepted cents and review/refusal never invent accepted terms',()=>{
  const accepted=voiceResultView(event(),handoff);assert.equal(accepted.summary.agreedCents,123456);assert.equal(accepted.summary.offeredCents,123456);
  assert.equal(accepted.summary.mode,'live');assert.equal(accepted.summary.termsVersion,2);
  for(const outcome of ['refused','review_required']){
    const view=voiceResultView(event({outcome,acceptedCompensationCents:undefined}),handoff);
    assert.equal(view.summary.agreedCents,undefined);assert.equal(view.summary.nextAction,'stop');
  }
  assert.throws(()=>validateVoiceEvent(event({acceptedCompensationCents:1.5})),/amount/);
  assert.throws(()=>validateVoiceEvent(event({saved:false})),/Invalid/);
});
