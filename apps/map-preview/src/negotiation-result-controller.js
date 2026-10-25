import { settlementBinding } from './settlement-controller.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>Boolean(a&&b)&&['sessionId','routeId','routeVersion','proposalKey'].every(key=>a[key]===b[key]);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const cents=value=>Number.isSafeInteger(value)&&value>=0;
const reasons=['AGREED','PRICE_REJECTED','ACCESS_REFUSED','DO_NOT_CALL','UNCLEAR_RESPONSE','ADDITIONAL_CONDITIONS',
  'DISCONNECTED','NO_ANSWER','BUSY','SERVICE_UNAVAILABLE','CONNECTION_UNKNOWN','TRANSCRIPT_UNAVAILABLE',
  'MODEL_UNAVAILABLE','MODEL_TIMEOUT','MALFORMED_OUTPUT','CONFLICTING_EVIDENCE','TIME_LIMIT','BUDGET_CHANGED','TERMS_CHANGED'];

/** Display-only authenticated-host subscription. Never invokes CAL-35 rerouting or grants approval. */
export function createNegotiationResultController({getHandoff,onChange=()=>{}}){
  let source=null,abort=null,cleanup=null,generation=0,revision=-1,session=null,view=null,unavailable=false,superseded=false;
  const events=new Map();
  const handoff=()=>{try{return getHandoff();}catch{return null;}};
  const state=()=>copy({view,unavailable,superseded,installed:source!==null,terminal:view?.phase==='finished'});
  const emit=()=>onChange(state());
  // This is a display/reference projection. The contract service resolves the
  // committed reference independently; these amounts never authorize a payment.
  function getAcceptedTerms(){
    if(superseded||!same(view?.mapBinding,settlementBinding(handoff()))||view?.phase!=='finished'||view.summary.disposition!=='successful')return null;
    return copy({parcelId:view.localParcelId,agreedCents:view.summary.agreedCents,monthlyRentCents:view.summary.monthlyRentCents,
      termsVersion:view.summary.termsVersion,mode:view.mode,available:!unavailable,
      negotiationRef:{attemptId:view.summary.attemptId,eventId:view.eventId,revision:view.revision}});
  }
  function disconnect(){generation++;abort?.abort();abort=null;const previous=cleanup;cleanup=null;try{previous?.();}catch{/* no domain effect */}}
  function applyUpdate(raw,{voice=false}={}){
    const h=handoff(),binding=settlementBinding(h);
    if(!same(raw?.mapBinding,binding))return {status:'ignored'};
    if(raw?.schemaVersion!==1||raw.kind!=='easygrid-negotiation-result'||!id(raw.eventId)||
      !Number.isSafeInteger(raw.revision)||raw.revision<0||raw.saved!==true||
      !['negotiating','confirming','finished'].includes(raw.phase)||!['live','simulated'].includes(raw.mode)||
      !h.ownerHandoff.parcels.some(p=>p.parcelId===raw.localParcelId))throw new Error('Invalid saved negotiation result.');
    if(raw.phase==='finished'){
      const r=raw.summary;
      if(!r||!id(r.attemptId)||r.mode!==raw.mode||!reasons.includes(r.reason)||
        !['successful','unsuccessful','needs_review'].includes(r.disposition)||
        typeof r.explanation!=='string'||!r.explanation.length||r.explanation.length>800||
        (r.disposition==='successful'&&(r.reason!=='AGREED'||r.outcome!=='accepted'||r.nextAction!=='continue'))||
        (r.disposition!=='successful'&&r.nextAction!=='stop'))throw new Error('Invalid terminal negotiation summary.');
      if(r.disposition==='successful'){
        const parcel=h.ownerHandoff.parcels.find(p=>p.parcelId===raw.localParcelId);
        if(!cents(parcel.offerPolicy?.recommendedOfferCents)||!cents(parcel.offerCapCents)||
          r.accessConsent!=='allowed'||!cents(r.agreedCents)||r.offeredCents!==r.agreedCents||
          r.agreedCents<parcel.offerPolicy?.recommendedOfferCents||r.agreedCents>parcel.offerCapCents||
          !cents(r.monthlyRentCents)||r.monthlyRentCents!==(voice?0:parcel.terms?.monthlyRentCents)||
          !Number.isSafeInteger(r.termsVersion)||r.termsVersion<parcel.terms?.termsVersion)
          throw new Error('The saved agreed compensation does not match the current offer policy.');
      }else if(r.agreedCents!=null)throw new Error('Unconfirmed terms cannot claim agreed compensation.');
    }else if(raw.summary!==null)throw new Error('An unfinished call cannot assert a final summary.');
    const fingerprint=JSON.stringify(raw);
    if(events.has(raw.eventId)){
      if(events.get(raw.eventId)!==fingerprint)throw new Error('Conflicting negotiation event.');
      return {status:'duplicate'};
    }
    if(raw.revision<revision)return {status:'ignored'};
    if(view?.mode==='live'&&raw.mode==='simulated')throw new Error('A simulation cannot replace a live outcome.');
    if(view?.phase==='finished'){
      // Same-revision deliveries with another identity are not a replay either.
      // Keep the terminal call locked, but stop offering the old financial terms.
      superseded=true;revision=raw.revision;emit();return {status:'superseded'};
    }
    events.set(raw.eventId,fingerprint);revision=raw.revision;view=copy(raw);unavailable=false;emit();
    return {status:'applied'};
  }
  function applyVoiceUpdate(raw){
    if(raw?.mode!=='live'||raw.paymentSchedule!=='full-after-signatures')throw new Error('A saved full-payment voice projection is required.');
    return applyUpdate(raw,{voice:true});
  }
  function subscribe(){
    disconnect();const h=handoff();
    if(!h||session!==h.sessionId||(view&&!same(view.mapBinding,settlementBinding(h)))){session=h?.sessionId??null;view=null;revision=-1;events.clear();unavailable=false;superseded=false;}
    if(!h||!source)return;
    const ticket=generation,controller=new AbortController();abort=controller;
    const active=()=>ticket===generation&&!controller.signal.aborted;
    const onUnavailable=()=>{if(active()){unavailable=true;emit();}};
    try{
      const result=source({mapBinding:copy(settlementBinding(h)),signal:controller.signal,
        onUpdate:value=>active()?applyUpdate(value):{status:'ignored'},onUnavailable,
        onReady:()=>{if(active()){unavailable=false;emit();}}});
      Promise.resolve(result).then(fn=>{if(fn!=null&&typeof fn!=='function')throw new Error('Invalid subscription cleanup');
        if(!active()){fn?.();return;}cleanup=fn??null;}).catch(onUnavailable);
    }catch{onUnavailable();}
  }
  function setSource(next){
    if(next!==null&&typeof next!=='function')throw new TypeError('Result source must be a function or null.');
    if(view&&next===null){disconnect();source=null;unavailable=true;emit();return;}
    source=next;subscribe();emit();
  }
  function reset(){disconnect();session=null;view=null;revision=-1;events.clear();unavailable=false;superseded=false;emit();}
  return {setSource,applyUpdate:raw=>applyUpdate(raw),applyVoiceUpdate,getState:state,getAcceptedTerms,markUnavailable:()=>{unavailable=true;emit();},routeChanged:()=>{subscribe();emit();},reset};
}
