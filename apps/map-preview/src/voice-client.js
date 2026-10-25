import {mapContractRequest, matchesContractBinding} from './contract-handoff.js';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** Only same-origin saved results enter this adapter. Participant data is POST-only. */
export function createVoiceClient({fetcher=globalThis.fetch,eventSourceFactory=url=>new EventSource(url),
  getPlacements,getRoutingOptions=()=>({}),onResult=()=>{},makeRequestKey=()=>globalThis.crypto.randomUUID()}={}) {
  const requestKeys=new Map();
  async function json(path,options={}) {
    try {
      const response=await fetcher(path,{credentials:'same-origin',...options});
      if(!response.ok)throw new Error('Service unavailable');
      return await response.json();
    } catch {throw new Error('The voice service could not confirm the request. Check the saved call status.');}
  }
  async function requestCall({handoff,participant,signal}) {
    const context=mapContractRequest(handoff,getPlacements(),getRoutingOptions());
    const bindingKey=JSON.stringify(context.mapBinding);
    if(!requestKeys.has(bindingKey))requestKeys.set(bindingKey,makeRequestKey());
    const result=await json('/api/voice/calls',{method:'POST',signal,
      headers:{'content-type':'application/json','x-easygrid-demo':'1'},
      body:JSON.stringify({context,participant,requestKey:requestKeys.get(bindingKey)})});
    if(!id(result.attemptId)||typeof result.status!=='string')throw new Error('The voice service returned an invalid call receipt.');
    return {attemptId:result.attemptId,status:result.status};
  }
  function subscribe({mapBinding,signal,onReady=()=>{},onUnavailable=()=>{}}) {
    const query=`?sessionId=${encodeURIComponent(mapBinding.sessionId)}`;
    let closed=false,queue=Promise.resolve();
    const active=()=>!closed&&!signal.aborted;
    const deliver=raw=>{
      if(!active()||raw===null||raw===undefined)return;
      queue=queue.then(async()=>{
        if(!active()||!matchesContractBinding(raw.mapBinding,mapBinding))return;
        validateVoiceEvent(raw);
        await onResult(raw);
      }).catch(()=>{if(active())onUnavailable();});
      return queue;
    };
    const restore=async()=>{
      try {const snapshot=await json(`/api/voice/attempt${query}`,{signal});if(active()){onReady();await deliver(snapshot.attempt);}}
      catch {if(active())onUnavailable();}
    };
    const stream=eventSourceFactory(`/api/voice/events${query}`);
    stream.onopen=()=>{restore();};
    stream.onmessage=message=>{try{deliver(JSON.parse(message.data));}catch{if(active())onUnavailable();}};
    stream.onerror=()=>{if(active())onUnavailable();};
    const close=()=>{closed=true;stream.close();signal.removeEventListener('abort',close);};
    signal.addEventListener('abort',close,{once:true});
    if(signal.aborted)close();else restore();
    return close;
  }
  return {getConfig:()=>json('/api/voice/config'),getActive:()=>json('/api/voice/active'),requestCall,subscribe};
}

export function validateVoiceEvent(value) {
  if(value?.schemaVersion!==1||value.kind!=='easygrid-voice-result'||value.saved!==true||value.mode!=='live'||
    !id(value.attemptId)||!id(value.eventId)||!id(value.localParcelId)||!Number.isSafeInteger(value.revision)||value.revision<0||
    !['negotiating','confirming','finished','review_required'].includes(value.status)||
    typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>800)throw new Error('Invalid saved voice result.');
  if(['finished','review_required'].includes(value.status)&&!['accepted','refused','review_required'].includes(value.outcome))throw new Error('Invalid final voice outcome.');
  if(value.outcome==='accepted'&&(!Number.isSafeInteger(value.acceptedCompensationCents)||value.acceptedCompensationCents<0))throw new Error('The accepted amount is missing.');
  if(value.outcome==='accepted'&&value.monthlyRentCents!==0)throw new Error('Voice acceptance must contain one full payment and no monthly obligation.');
  return value;
}

/** CAL-34 display shape; routing and approval are separately bound to the saved voice result. */
export function voiceResultView(raw,handoff) {
  validateVoiceEvent(raw);
  const terminal=['finished','review_required'].includes(raw.status),accepted=raw.outcome==='accepted';
  const approved=raw.contractApproval?.input?.parcels?.find(p=>p.parcelId===raw.localParcelId);
  return {schemaVersion:1,kind:'easygrid-negotiation-result',eventId:raw.eventId,revision:raw.revision,saved:true,
    mapBinding:raw.mapBinding,localParcelId:raw.localParcelId,mode:'live',paymentSchedule:'full-after-signatures',phase:terminal?'finished':raw.status,
    summary:terminal?{attemptId:raw.attemptId,mode:'live',disposition:accepted?'successful':raw.outcome==='refused'?'unsuccessful':'needs_review',
      reason:accepted?'AGREED':raw.outcome==='refused'?'ACCESS_REFUSED':'ADDITIONAL_CONDITIONS',outcome:raw.outcome,
      nextAction:accepted?'continue':'stop',explanation:raw.reason,
      ...(accepted?{accessConsent:'allowed',agreedCents:raw.acceptedCompensationCents,offeredCents:raw.acceptedCompensationCents,
        monthlyRentCents:raw.monthlyRentCents,termsVersion:raw.termsVersion??approved?.termsVersion}: {})}:null};
}
