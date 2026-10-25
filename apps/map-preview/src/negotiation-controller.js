import { settlementBinding } from './settlement-controller.js';
import { DEMO_COORDINATE_TRANSFORM } from './handoff.js';
import { normalizeRoutingConstraints } from './routing-constraints.js';
import { createSimulatedAgreement } from './demo-agreements.js';

const copy=value=>JSON.parse(JSON.stringify(value));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const cents=value=>Number.isSafeInteger(value)&&value>=0;
const same=(a,b)=>Boolean(a&&b)&&['sessionId','routeId','routeVersion','proposalKey'].every(key=>a[key]===b[key]);
const stable=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]))):value;
const summary=h=>h?{routeVersion:h.routeVersion,routeId:h.ownerHandoff.routeId,
  geometry:copy(h.snapshot.routes[0].geometry),parcelIds:[...h.snapshot.routes[0].parcelIds],
  totalCostCents:h.snapshot.routes[0].totalCostCents}:null;

/** Public projection only. Authentication and canonical-to-map binding are host responsibilities. */
function validateUpdate(value){
  const keys=['schemaVersion','kind','eventId','mapBinding','parcelId','sourceMode','outcome','accessConsent',
    'explicitConfirmation','evidenceRefs','termsVersion','terms','hasUnresolvedConditions','exclusionGeometry'];
  if(!value||typeof value!=='object'||Object.keys(value).some(key=>!keys.includes(key))||
    value.schemaVersion!==1||value.kind!=='easygrid-map-negotiation'||!id(value.eventId)||!id(value.parcelId)||
    !['fixture','live','sandbox','mock'].includes(value.sourceMode)||
    !['accepted','refused','counteroffer','pending','review_required'].includes(value.outcome)||
    !['unknown','allowed','refused'].includes(value.accessConsent)||typeof value.explicitConfirmation!=='boolean'||
    typeof value.hasUnresolvedConditions!=='boolean'||!Number.isSafeInteger(value.termsVersion)||value.termsVersion<1||
    !Array.isArray(value.evidenceRefs)||value.evidenceRefs.length>100||value.evidenceRefs.some(ref=>typeof ref!=='string'||!ref.length||ref.length>2000))throw new Error('Invalid negotiation update.');
  const t=value.terms,termKeys=['upfrontCents','depositCents','depositCreditPolicy','monthlyRentCents','termMonths'];
  if(!t||Object.keys(t).length!==termKeys.length||Object.keys(t).some(key=>!termKeys.includes(key))||
    !cents(t.upfrontCents)||!cents(t.depositCents)||!cents(t.monthlyRentCents)||
    !['credited_to_upfront','separate_charge'].includes(t.depositCreditPolicy)||
    (t.depositCreditPolicy==='credited_to_upfront'&&t.depositCents>t.upfrontCents)||
    !Number.isSafeInteger(t.termMonths)||t.termMonths<1||t.termMonths>1200)throw new Error('Invalid negotiation terms.');
  return copy(value);
}

function localExclusion(handoff,update){
  const transform=handoff.coordinateTransform,t=DEMO_COORDINATE_TRANSFORM;
  if(!transform||Object.keys(t).some(key=>transform[key]!==t[key]))throw new Error('Unknown coordinate transform.');
  const polygon=update.exclusionGeometry;
  if(polygon?.type!=='Polygon'||!Array.isArray(polygon.coordinates)||polygon.coordinates.length!==1||
    !Array.isArray(polygon.coordinates[0])||polygon.coordinates[0].length<4||polygon.coordinates[0].length>129)throw new Error('A single verified exclusion polygon is required.');
  const radians=Math.PI/180;
  const ring=polygon.coordinates[0].map(point=>{
    if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>90)throw new Error('Invalid exclusion coordinates.');
    return [(point[0]-t.originLongitude)*radians*t.earthRadiusMeters*Math.cos(t.originLatitude*radians)/t.metersPerTile,
      (t.originLatitude-point[1])*radians*t.earthRadiusMeters/t.metersPerTile];
  });
  return {parcelId:update.parcelId,ring};
}

/** Local post-call planning. This does not replace persisted CAL-29 state or authorization. */
export function createNegotiationController({world,getHandoff,getSessionId,onReroute,onChange=()=>{},
  invalidateApproval=()=>{},lockLiveCall=()=>{},onNextOwner=()=>false,scheduleTask=fn=>setTimeout(fn,650),cancelTask=clearTimeout}){
  let sessionId=getSessionId(),constraints={blockedParcelIds:[],blockedTowerParcelIds:[],exclusionZones:[]};
  let phase='idle',reason='',previous=null,next=null,agreement=null,awaitingReroute=false,holdForNextCall=false,task=null;
  let source=null,sourceAbort=null,sourceCleanup=null,sourceGeneration=0,connected=false;
  const events=new Map(),outcomes=new Map(),termsVersions=new Map();
  function current(){try{return getHandoff();}catch{return null;}}
  function getBinding(){return settlementBinding(current());}
  function getState(){return copy({phase,reason,connected,sessionId,previous,next,
    costDeltaCents:previous&&next?next.totalCostCents-previous.totalCostCents:null,
    blockedParcelIds:constraints.blockedParcelIds,outcomes:[...outcomes.values()],
    simulated:agreement!==null||phase==='negotiating'||(phase==='approved'&&[...outcomes.values()].every(row=>row.sourceMode!=='live')),agreementReady:Boolean(agreement)});}
  function emit(){onChange(getState());}
  function stopTask(){if(task!==null)cancelTask(task);task=null;agreement=null;}
  function disconnect(){sourceGeneration++;sourceAbort?.abort();sourceAbort=null;const cleanup=sourceCleanup;sourceCleanup=null;connected=false;try{cleanup?.();}catch{/* Cleanup cannot prevent session invalidation. */}}
  function reset(){stopTask();disconnect();sessionId=getSessionId();constraints={blockedParcelIds:[],blockedTowerParcelIds:[],exclusionZones:[]};
    events.clear();outcomes.clear();termsVersions.clear();phase='idle';reason='';previous=null;next=null;awaitingReroute=false;holdForNextCall=false;emit();}
  function synchronizeSession(){if(sessionId!==getSessionId())reset();}
  function subscribe(){
    disconnect();const mapBinding=getBinding();if(!source||!mapBinding)return;
    const ticket=sourceGeneration,controller=new AbortController();sourceAbort=controller;
    const active=()=>ticket===sourceGeneration&&!controller.signal.aborted;
    const unavailable=()=>{if(!active())return;connected=false;invalidateApproval();reason='Result connection unavailable';emit();};
    try{
      const cleanup=source({mapBinding:copy(mapBinding),signal:controller.signal,
        onReady:()=>{if(active()){connected=true;emit();}},onUnavailable:unavailable,
        onUpdate:update=>active()?applyUpdate(update):{status:'ignored'}});
      Promise.resolve(cleanup).then(fn=>{if(typeof fn!=='function'&&fn!=null)throw new Error('Invalid source cleanup.');if(!active()){fn?.();return;}sourceCleanup=fn??null;}).catch(unavailable);
    }catch{unavailable();}
  }
  function setSource(nextSource){
    if(nextSource!==null&&typeof nextSource!=='function')throw new TypeError('Negotiation source must be a function or null.');
    source=nextSource;subscribe();emit();
  }
  function routeChanged(){
    synchronizeSession();const handoff=current();stopTask();outcomes.clear();termsVersions.clear();
    if(!handoff){disconnect();if(!awaitingReroute){phase='idle';reason='';previous=null;next=null;}emit();return;}
    const continuingRefusal=constraints.blockedParcelIds.includes(handoff.userRole.parcelId);
    if(awaitingReroute||continuingRefusal){
      if(!awaitingReroute)previous=null;
      awaitingReroute=false;next=summary(handoff);
      const continueCall=holdForNextCall;
      holdForNextCall=false;
      if(!handoff.snapshot.routes[0].eligible){phase='review_required';reason='New route needs budget or parcel review';}
      else if(handoff.snapshot.routes[0].parcelIds.includes(handoff.userRole.parcelId)){
        phase='review_required';reason='Updated route needs owner confirmation';
      }else if(continueCall){
        // A live disagreement updates the line, then the same phone calls the next owner.
        let advanced=false;
        try{advanced=onNextOwner(copy(constraints.blockedParcelIds))===true;}catch{advanced=false;}
        phase=advanced?'awaiting_owners':'review_required';
        reason=advanced?'Call the next owner on this connection':'No further owner can be called on this connection';
      }else{
        phase='negotiating';reason='Other owners · simulated';
        const binding=getBinding();
        task=scheduleTask(()=>{
          task=null;if(!same(binding,getBinding()))return;
          try{agreement=createSimulatedAgreement(current(),{blockedParcelIds:constraints.blockedParcelIds});
            outcomes.clear();for(const result of agreement.negotiations)outcomes.set(result.parcelId,{parcelId:result.parcelId,outcome:'accepted',sourceMode:'mock'});
            phase='confirmed';reason='Route confirmed · simulated owners';
          }catch{agreement=null;phase='review_required';reason='New route needs budget or parcel review';}
          emit();
        });
      }
    }else{phase='idle';reason='';previous=null;next=null;}
    subscribe();emit();
  }
  function noRoute(){if(!awaitingReroute)return;awaitingReroute=false;holdForNextCall=false;phase='no_route';reason='No feasible route under the current constraints';next=null;agreement=null;emit();}
  function applyUpdate(raw){
    synchronizeSession();const update=validateUpdate(raw),serialized=JSON.stringify(stable(update));
    const key=`${update.mapBinding?.sessionId}:${update.eventId}`;
    if(events.has(key)){if(events.get(key)!==serialized)throw new Error('Conflicting negotiation event.');return {status:'duplicate'};}
    const handoff=current();if(!same(update.mapBinding,settlementBinding(handoff)))throw new Error('Stale negotiation result.');
    const parcel=handoff.ownerHandoff.parcels.find(p=>p.parcelId===update.parcelId);
    if(!parcel||update.termsVersion<Math.max(parcel.terms.termsVersion,termsVersions.get(update.parcelId)??0))throw new Error('Negotiation parcel or terms are stale.');
    const confirmed=update.explicitConfirmation&&update.evidenceRefs.length>0;
    let revised=constraints,reroute=false;
    if(update.outcome==='refused'){
      if(update.accessConsent!=='refused'||!confirmed)throw new Error('Refusal requires verified owner evidence.');
      revised=normalizeRoutingConstraints(world,{...constraints,blockedParcelIds:[...new Set([...constraints.blockedParcelIds,update.parcelId])]});reroute=true;
    }else if(update.exclusionGeometry){
      if(!update.evidenceRefs.length||update.hasUnresolvedConditions)throw new Error('Spatial conditions need verification.');
      revised=normalizeRoutingConstraints(world,{...constraints,exclusionZones:[...constraints.exclusionZones,localExclusion(handoff,update)]});reroute=true;
    }else if(update.outcome==='accepted'){
      const upfront=BigInt(update.terms.upfrontCents)+(update.terms.depositCreditPolicy==='separate_charge'?BigInt(update.terms.depositCents):0n);
      if(!confirmed||update.accessConsent!=='allowed'||update.hasUnresolvedConditions||upfront>BigInt(parcel.offerCapCents)||
        update.terms.termMonths!==handoff.ownerHandoff.rentHorizonMonths)throw new Error('Accepted terms need current confirmed amounts.');
    }
    events.set(key,serialized);termsVersions.set(update.parcelId,update.termsVersion);stopTask();invalidateApproval();
    if(update.outcome==='refused'&&update.parcelId===handoff.userRole.parcelId&&!holdForNextCall)lockLiveCall();
    outcomes.set(update.parcelId,{parcelId:update.parcelId,outcome:update.outcome,sourceMode:update.sourceMode});
    if(reroute){constraints=revised;previous=summary(handoff);next=null;awaitingReroute=true;phase='rerouting';
      reason=update.outcome==='refused'?`${update.parcelId} declined`:`${update.parcelId} route condition`;
      emit();try{onReroute(copy(constraints));}catch{noRoute();}
    }else{phase=update.outcome==='accepted'?'awaiting_owners':'review_required';reason=update.outcome==='accepted'?'Waiting for remaining owners':'Owner terms need review';emit();}
    return {status:'applied',rerouteNeeded:reroute};
  }
  function runApprovalDemo(){
    const h=current();
    if(source||!h||h.userRole.liveCallLocked||h.snapshot.routes[0].eligible!==true||!h.snapshot.routes[0].parcelIds.includes(h.userRole.parcelId))throw new Error('Select an eligible current demo route with the call target first.');
    const p=h.ownerHandoff.parcels.find(parcel=>parcel.parcelId===h.userRole.parcelId);
    if(!p)throw new Error('The current call target is not part of the approved route.');
    if(phase==='approved'&&outcomes.get(p.parcelId)?.outcome==='accepted'&&outcomes.get(p.parcelId)?.sourceMode==='mock')return {status:'duplicate',rerouteNeeded:false};
    if(phase!=='idle')throw new Error('Start this approval from the original current route.');
    const result=applyUpdate({schemaVersion:1,kind:'easygrid-map-negotiation',eventId:`demo-approval-${h.routeVersion}`,mapBinding:getBinding(),
      parcelId:p.parcelId,sourceMode:'mock',outcome:'accepted',accessConsent:'allowed',explicitConfirmation:true,
      evidenceRefs:[`mock:approval-${p.parcelId}`],termsVersion:p.terms.termsVersion,hasUnresolvedConditions:false,
      terms:{upfrontCents:p.terms.compensationCents,depositCents:0,depositCreditPolicy:'credited_to_upfront',monthlyRentCents:p.terms.monthlyRentCents,termMonths:h.ownerHandoff.rentHorizonMonths}});
    phase='approved';reason='Current landowner approved · simulated';emit();return result;
  }
  function runRefusalDemo(){
    // Refusing access does not require a priced or budget-approved proposal.
    // The replacement route still passes the agreement checks in routeChanged.
    const h=current();if(source||!h||h.userRole.liveCallLocked||!h.snapshot.routes[0].parcelIds.includes(h.userRole.parcelId))throw new Error('Select a current demo route first.');
    const p=h.ownerHandoff.parcels.find(p=>p.parcelId===h.userRole.parcelId);
    return applyUpdate({schemaVersion:1,kind:'easygrid-map-negotiation',eventId:`demo-refusal-${h.routeVersion}`,mapBinding:getBinding(),
      parcelId:p.parcelId,sourceMode:'mock',outcome:'refused',accessConsent:'refused',explicitConfirmation:true,
      evidenceRefs:[`mock:refusal-${p.parcelId}`],termsVersion:p.terms.termsVersion,hasUnresolvedConditions:false,
      terms:{upfrontCents:p.terms.compensationCents,depositCents:0,depositCreditPolicy:'credited_to_upfront',monthlyRentCents:p.terms.monthlyRentCents,termMonths:h.ownerHandoff.rentHorizonMonths}});
  }
  function applySavedVoiceResult(result){
    const h=current(),parcel=h?.ownerHandoff.parcels.find(p=>p.parcelId===result.localParcelId);
    if(result?.saved!==true||result.mode!=='live'||result.kind!=='easygrid-voice-result'||!id(result.attemptId)||!id(result.eventId)||
      !same(result.mapBinding,getBinding())||!parcel||parcel.parcelId!==h.userRole.parcelId||
      !['accepted','refused','review_required'].includes(result.outcome))throw new Error('A current saved voice result is required.');
    const accepted=result.outcome==='accepted',refused=result.outcome==='refused';
    if(accepted&&result.monthlyRentCents!==0)throw new Error('Voice acceptance cannot create a monthly obligation.');
    if(refused)holdForNextCall=true;
    let applied;
    try{applied=applyUpdate({schemaVersion:1,kind:'easygrid-map-negotiation',eventId:result.eventId,mapBinding:result.mapBinding,
      parcelId:parcel.parcelId,sourceMode:'live',outcome:result.outcome,accessConsent:accepted?'allowed':refused?'refused':'unknown',
      explicitConfirmation:accepted||refused,evidenceRefs:[`saved-voice:${result.attemptId}:${result.eventId}`],
      termsVersion:result.termsVersion??result.contractApproval?.input?.parcels?.find(p=>p.parcelId===parcel.parcelId)?.termsVersion??parcel.terms.termsVersion,
      hasUnresolvedConditions:!accepted&&!refused,terms:{upfrontCents:accepted?result.acceptedCompensationCents:parcel.terms.compensationCents,
        depositCents:0,depositCreditPolicy:'credited_to_upfront',monthlyRentCents:accepted?0:parcel.terms.monthlyRentCents,termMonths:h.ownerHandoff.rentHorizonMonths}});}
    catch(error){holdForNextCall=false;throw error;}
    if(applied.status!=='applied')holdForNextCall=false;
    if(accepted&&applied.status==='applied'){phase='approved';reason='Current landowner approved · live call';emit();}
    return applied;
  }
  return {getBinding,getState,applyUpdate,applySavedVoiceResult,setSource,routeChanged,noRoute,reset,runRefusalDemo,runApprovalDemo,
    getRoutingOptions:()=>{synchronizeSession();return copy(constraints);},
    getAgreement:()=>agreement&&same(agreement.mapBinding,getBinding())?copy(agreement):null,
    hasSource:()=>source!==null};
}
