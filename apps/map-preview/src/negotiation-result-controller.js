import { settlementBinding } from './settlement-controller.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>Boolean(a&&b)&&['sessionId','routeId','routeVersion','proposalKey'].every(key=>a[key]===b[key]);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const reasons=['AGREED','PRICE_REJECTED','ACCESS_REFUSED','DO_NOT_CALL','UNCLEAR_RESPONSE','ADDITIONAL_CONDITIONS',
  'DISCONNECTED','NO_ANSWER','BUSY','SERVICE_UNAVAILABLE','CONNECTION_UNKNOWN','TRANSCRIPT_UNAVAILABLE',
  'MODEL_UNAVAILABLE','MODEL_TIMEOUT','MALFORMED_OUTPUT','CONFLICTING_EVIDENCE','TIME_LIMIT','BUDGET_CHANGED','TERMS_CHANGED'];

/** Display-only authenticated-host subscription. Never invokes CAL-35 rerouting or grants approval. */
export function createNegotiationResultController({getHandoff,onChange=()=>{}}){
  let source=null,abort=null,cleanup=null,generation=0,revision=-1,session=null,view=null,unavailable=false;
  const events=new Map();
  const handoff=()=>{try{return getHandoff();}catch{return null;}};
  const state=()=>copy({view,unavailable,installed:source!==null,terminal:view?.phase==='finished'});
  const emit=()=>onChange(state());
  function disconnect(){generation++;abort?.abort();abort=null;const previous=cleanup;cleanup=null;try{previous?.();}catch{/* no domain effect */}}
  function applyUpdate(raw){
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
    }else if(raw.summary!==null)throw new Error('An unfinished call cannot assert a final summary.');
    const fingerprint=JSON.stringify(raw);
    if(events.has(raw.eventId)){
      if(events.get(raw.eventId)!==fingerprint)throw new Error('Conflicting negotiation event.');
      return {status:'duplicate'};
    }
    if(raw.revision<revision||view?.phase==='finished')return {status:'ignored'};
    if(view?.mode==='live'&&raw.mode==='simulated')throw new Error('A simulation cannot replace a live outcome.');
    events.set(raw.eventId,fingerprint);revision=raw.revision;view=copy(raw);unavailable=false;emit();
    return {status:'applied'};
  }
  function subscribe(){
    disconnect();const h=handoff();if(!h||!source)return;
    if(session!==h.sessionId){session=h.sessionId;view=null;revision=-1;events.clear();unavailable=false;}
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
  function reset(){disconnect();session=null;view=null;revision=-1;events.clear();unavailable=false;emit();}
  return {setSource,applyUpdate,getState:state,routeChanged:()=>{subscribe();emit();},reset};
}
