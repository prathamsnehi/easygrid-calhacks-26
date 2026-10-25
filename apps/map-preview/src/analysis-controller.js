import { analyzeRouteParcels, chooseUserParcel } from './parcel-analysis.js';
import { createHandoff, validateDemoParticipant, normalizeDemoPhone } from './handoff.js';
import { DEMO_METERS_PER_TILE } from './cost-model.js';
import { createNegotiationResultController } from './negotiation-result-controller.js';
import { createSettlementController } from './settlement-controller.js';

/** Local analysis and an explicit call-request boundary. No direct network or contact storage. */
export function createAnalysisController({world,canvas,getPlacements,onFocusParcel=()=>{},onUserRoleChange=()=>{},onDemoReadyChange=()=>{},onContextChange=()=>{},onNegotiationResultChange=()=>{}}) {
  const ids=['open-analysis','analysis-entry-status','analysis-panel','close-analysis','analysis-route-note','analysis-count','analysis-upfront-label','analysis-upfront',
    'analysis-rent-label','analysis-rent','analysis-consent-note','analysis-parcel-list','analysis-parcel-detail',
    'analysis-parcel-title','analysis-parcel-badge','focus-analysis-parcel','analysis-parcel-copy','analysis-owner',
    'analysis-land-use','analysis-line-length','analysis-foundation','analysis-offer','analysis-limit','analysis-agreed','analysis-parcel-rent-label',
    'analysis-parcel-rent','analysis-negotiation','analysis-parcel-impact','focus-user-parcel','user-parcel-label',
    'user-form','user-alias','user-phone','user-consent','save-user',
    'clear-user','user-form-status','handoff-status-badge','agent-call',
    'handoff-result','reset-plan','step-a','step-b','label-a','label-b','inspect-parcels',
    'demo-workspace','demo-onboarding','edit-participant','edit-analysis-participant',
    'registered-participant-name','registered-participant-contact'];
  const el=Object.fromEntries(ids.map(id=>[id,document.querySelector(`#${id}`)]));
  const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
  const moneyOf=value=>money.format(value/100);
  const number=value=>new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(value);
  const distance=tiles=>`${number(tiles*DEMO_METERS_PER_TILE)} m`;
  const write=(id,value)=>{el[id].textContent=String(value);};
  let sessionSequence=0;
  const newSessionId=()=>`map-${window.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`}-${++sessionSequence}`;
  let sessionId=newSessionId();
  let snapshot=null,analysis=null,userParcelId=null,selectedParcelId=null,liveCallLocked=false;
  let negotiationDisplay=new Map();
  let participant=null,handler=null,pending=null,activeHandoff=null,revision=0,callRequested=false,lastDemoReady=false;
  const settlement=createSettlementController({getHandoff});
  const negotiationResults=createNegotiationResultController({getHandoff,onChange:state=>{
    if(state.view?.phase!=='finished'||state.view.summary?.disposition!=='successful')settlement.invalidate();
    onContextChange();renderHandoff();renderRows();renderDetail();renderConsent();onNegotiationResultChange(state);
  }});
  el['demo-workspace'].dataset.analysisOpen='false';

  function feedback(id,message,kind='') {write(id,message);el[id].className=`analysis-feedback${kind?` ${kind}`:''}`;}
  function invalidateHandoff() {revision++;activeHandoff?.abort();activeHandoff=null;pending=null;callRequested=false;settlement.invalidate();onContextChange();}
  function isDemoReady() {return Boolean(participant);}
  function syncDemoGate() {
    const ready=isDemoReady();
    el['demo-workspace'].inert=!ready;el['demo-workspace'].setAttribute('aria-hidden',String(!ready));
    el['demo-onboarding'].hidden=ready;canvas.dataset.demoReady=String(ready);
    if(!ready&&!el['analysis-panel'].hidden)close({restoreFocus:false});
    // Set this before notifying the host: routing invalidation can synchronously call setRoute(null).
    if(ready!==lastDemoReady){lastDemoReady=ready;onDemoReadyChange(ready);}
  }
  function getHandoff() {
    if(!participant||!snapshot||!analysis)return null;
    return createHandoff({world,route:snapshot.route,analysis,placements:getPlacements(),participant,
      userParcelId,sessionId,routeVersion:snapshot.routeVersion,liveCallLocked});
  }
  function getOriginalRole() {
    const parcel=userParcelId&&world.parcelById.get(userParcelId);
    return parcel?{sessionId,parcelId:parcel.id,ownerId:parcel.ownerId,
      roleOnRoute:Boolean(snapshot?.route.parcelIds.includes(parcel.id)),liveCallLocked}:null;
  }
  function setLiveCallLockout(value=true) {
    if(value!==true)throw new TypeError('Only a new demo can clear the live-call lock.');
    if(liveCallLocked)return;
    liveCallLocked=true;invalidateHandoff();renderHandoff();
  }
  function displayedOutcome(parcelId) {
    const accepted=negotiationResults.getAcceptedTerms();
    if(accepted?.parcelId===parcelId)return `Agreed${accepted.mode==='simulated'?' · simulated':''}${accepted.available?'':' · offline'}`;
    const value=negotiationDisplay.get(parcelId);
    if(!value)return null;
    const label={accepted:'Accepted',refused:'Declined',counteroffer:'Counteroffer',pending:'Pending',review_required:'Review needed'}[value.outcome];
    return `${label}${value.sourceMode==='live'?'':' · simulated'}`;
  }
  function renderConsent() {
    if(!analysis)return;
    const accepted=negotiationResults.getAcceptedTerms();
    const pendingCount=analysis.parcels.filter(row=>accepted?.parcelId!==row.parcelId&&negotiationDisplay.get(row.parcelId)?.outcome!=='accepted'&&row.accessConsent!=='allowed').length;
    const reviewCount=analysis.parcels.filter(row=>row.recommendationStatus==='review-required').length;
    write('analysis-upfront-label',reviewCount?'Priced subtotal':'Recommended total');
    write('analysis-consent-note',`${pendingCount} pending${reviewCount?` · ${reviewCount} need pricing`:''}`);
  }
  // Display projection only: this does not change proposed terms or create approval.
  function setNegotiationDisplay(value) {
    if(value===null){negotiationDisplay=new Map();renderRows();renderDetail();renderConsent();return true;}
    if(!snapshot||value?.routeVersion!==snapshot.routeVersion)return false;
    if(!Array.isArray(value.outcomes)||value.outcomes.length>analysis.parcels.length)throw new TypeError('Invalid negotiation display.');
    const next=new Map();
    for(const row of value.outcomes){
      if(!row||!analysis.parcels.some(parcel=>parcel.parcelId===row.parcelId)||next.has(row.parcelId)||
        !['accepted','refused','counteroffer','pending','review_required'].includes(row.outcome)||
        !['mock','fixture','sandbox','live'].includes(row.sourceMode))throw new TypeError('Invalid negotiation display.');
      next.set(row.parcelId,{outcome:row.outcome,sourceMode:row.sourceMode});
    }
    negotiationDisplay=next;renderRows();renderDetail();renderConsent();return true;
  }
  function getParcelRole(parcelId) {
    const parcel=world.parcelById.get(parcelId),owner=parcel&&world.ownerById.get(parcel.ownerId);
    if(!participant||!owner||parcelId!==userParcelId)return null;
    return {ownerAlias:participant?.alias??'User participant',
      phoneDisplay:`Phone ending in ${participant.phoneE164.slice(-4)} · demo participant`,
      email:'Not collected for demo participant',originalOwnerAlias:owner.alias,roleplay:true};
  }
  function renderHandoff() {
    const current=getHandoff(),ready=current?.callPreparation.status==='ready-for-host-adapter';
    const saved=negotiationResults.getState(),result=saved.view;
    if(result||saved.unavailable){
      el['agent-call'].disabled=true;
      if(saved.superseded){
        write('handoff-status-badge','TERMS CHANGED');
        feedback('handoff-result','A newer saved negotiation revision supersedes the earlier result. Contract preparation is locked until the current terms are verified.','error');return;
      }
      const label=saved.unavailable&&result?.phase!=='finished'?'STATE UNAVAILABLE':result.phase==='finished'?{successful:'SUCCESSFUL',unsuccessful:'UNSUCCESSFUL',needs_review:'NEEDS REVIEW'}[result.summary.disposition]:result.phase==='confirming'?'CONFIRMING RESULT':'NEGOTIATING';
      write('handoff-status-badge',`${label}${result?.mode==='simulated'?' · SIMULATED':''}${saved.unavailable&&result?.phase==='finished'?' · OFFLINE':''}`);
      feedback('handoff-result',saved.unavailable?(result?.phase==='finished'?`${result.summary.explanation} Shared state unavailable; showing the last saved result.`:'Shared state unavailable. The result could not be confirmed as saved.'):result.phase==='finished'?result.summary.explanation:result.phase==='confirming'?'Confirming result…':'Negotiation in progress…',result?.summary?.disposition==='successful'?'success':'');
      return;
    }
    el['agent-call'].disabled=liveCallLocked||!ready||!handler||Boolean(pending)||callRequested;
    write('agent-call',pending?'Requesting call…':'Agent call');
    write('handoff-status-badge',liveCallLocked?'DECLINED':current?.userRole.roleOnRoute===false?'OFF ROUTE':callRequested?'REQUEST SENT':pending?'REQUESTING':!handler?'OFFLINE':ready?'READY':'REVIEW');
    el['handoff-status-badge'].className=`role-badge${callRequested?' ready':''}`;
    if(liveCallLocked)feedback('handoff-result','No further calls to this participant.');
    else if(current?.userRole.roleOnRoute===false)feedback('handoff-result','Your original parcel is outside this route.');
    else if(current?.callPreparation.status==='review-required')feedback('handoff-result','Review parcel estimates, access and budget before calling.','error');
  }
  function renderDetail() {
    const row=analysis?.parcels.find(item=>item.parcelId===selectedParcelId);
    el['analysis-parcel-detail'].hidden=!row;
    el['focus-analysis-parcel'].disabled=!row;
    if(!row)return;
    const isUser=row.parcelId===userParcelId,role=getParcelRole(row.parcelId),needsEstimate=row.recommendationStatus==='review-required';
    write('analysis-parcel-title',row.parcelId);
    write('analysis-parcel-badge','DEMO ROLE');
    el['analysis-parcel-badge'].hidden=!isUser;
    el['analysis-parcel-badge'].className=`role-badge${isUser?' user':''}`;
    write('analysis-parcel-copy',isUser?
      `${row.parcelId}: you play ${row.ownerAlias} for the demo call.`:
      `${row.parcelId}: fictional owner ${row.ownerAlias}.`);
    write('analysis-owner',role?.ownerAlias??row.ownerAlias);
    write('analysis-land-use',row.landUse.replaceAll('-',' '));
    write('analysis-line-length',row.corridorOnly?'Corridor only':distance(row.lineLengthTiles));
    write('analysis-foundation',row.towerCount);
    const accepted=negotiationResults.getAcceptedTerms(),agreed=accepted?.parcelId===row.parcelId?accepted:null;
    write('analysis-offer',needsEstimate?'Review required':moneyOf(row.recommendedOfferCents));
    write('analysis-limit',needsEstimate?'Review required':moneyOf(row.offerCapCents));
    write('analysis-agreed',agreed?moneyOf(agreed.agreedCents):'Not agreed');
    write('analysis-parcel-rent-label','Monthly fee');
    write('analysis-parcel-rent',`${!agreed&&row.monthlyRentIsApproximate?'≈ ':''}${moneyOf(agreed?.monthlyRentCents??row.monthlyRentCents)}`);
    const status=row.accessConsent==='refused'||row.negotiationStatus==='refused'?'Declined':needsEstimate?'Review required':
      row.accessConsent==='allowed'&&row.negotiationStatus==='accepted'?'Agreed':
      row.negotiationStatus==='counteroffer'?'Counteroffer':row.negotiationStatus==='review_required'?'Review needed':'Pending';
    write('analysis-negotiation',displayedOutcome(row.parcelId)??status);
    const breakdown=row.compensationBreakdown;
    const components=breakdown?`Line allowance: ${moneyOf(breakdown.lineCents)}. Tower pad allowance: ${moneyOf(breakdown.foundationCents)}. `:'';
    write('analysis-parcel-impact',`${components}${row.corridorOnly?'Corridor contact requires owner review. ':''}Maximum compensation: recommended compensation × 1.2, rounded down to cents; available budget can reduce the final offer. ${analysis.rentHorizonMonths}-month fees: ${moneyOf(row.rentTotalCents)}.`);
  }
  function selectParcel(parcelId,focus=true) {
    if(!analysis?.parcels.some(row=>row.parcelId===parcelId))return;
    selectedParcelId=parcelId;
    for(const button of el['analysis-parcel-list'].children)button.setAttribute('aria-pressed',String(button.dataset.parcelId===parcelId));
    renderDetail();if(focus)onFocusParcel(parcelId);
  }
  function renderRows() {
    const rows=(analysis?.parcels??[]).map(row=>{
      const button=document.createElement('button');button.type='button';button.className='analysis-parcel-row';
      button.dataset.parcelId=row.parcelId;button.setAttribute('aria-pressed',String(row.parcelId===selectedParcelId));
      const title=document.createElement('span');title.className='analysis-row-title';
      title.textContent=row.parcelId===userParcelId?(participant?.alias??'User participant'):row.ownerAlias;
      const code=document.createElement('small');code.textContent=row.parcelId;title.appendChild(code);
      const accepted=negotiationResults.getAcceptedTerms(),agreed=accepted?.parcelId===row.parcelId?accepted:null;
      const cost=document.createElement('span');cost.className='analysis-row-cost';cost.textContent=agreed?`${moneyOf(agreed.agreedCents)} agreed`:row.recommendationStatus==='review-required'?'Review required':`${moneyOf(row.recommendedOfferCents)} – ${moneyOf(row.offerCapCents)}`;
      const meta=document.createElement('span');meta.className='analysis-row-meta';
      meta.textContent=`${row.towerCount} ${row.towerCount===1?'tower':'towers'} · ${row.corridorOnly?'corridor only':distance(row.lineLengthTiles)}${row.withinOfferCap?'':' · review needed'}${displayedOutcome(row.parcelId)?` · ${displayedOutcome(row.parcelId)}`:''}`;
      button.appendChild(title);button.appendChild(cost);button.appendChild(meta);
      if(row.parcelId===userParcelId){
        const badge=document.createElement('span');badge.className='analysis-row-role';
        badge.textContent='DEMO CALL';button.appendChild(badge);
      }
      button.addEventListener('click',()=>selectParcel(row.parcelId));return button;
    });
    el['analysis-parcel-list'].replaceChildren(...rows);
  }
  function renderParticipant() {
    write('user-parcel-label',userParcelId?`${userParcelId}${snapshot&&!snapshot.route.parcelIds.includes(userParcelId)?' · off route':''}`:'No route selected');
    el['focus-user-parcel'].disabled=!userParcelId;
    canvas.dataset.userParcelId=userParcelId??'';
    canvas.dataset.participantReady=String(Boolean(participant));
    write('registered-participant-name',participant?.alias??'Participant required');
    write('registered-participant-contact',participant?`Phone ending in ${participant.phoneE164.slice(-4)}`:'Contact required');
    el['open-analysis'].disabled=!participant||!snapshot||!analysis;
    renderRows();renderDetail();renderHandoff();onUserRoleChange();syncDemoGate();
  }
  function close({restoreFocus=true}={}) {
    const wasOpen=!el['analysis-panel'].hidden;
    el['analysis-panel'].hidden=true;el['open-analysis'].setAttribute('aria-expanded','false');
    canvas.dataset.analysisOpen='false';el['demo-workspace'].dataset.analysisOpen='false';onFocusParcel(null);
    if(wasOpen&&restoreFocus)el['open-analysis'].focus({preventScroll:true});
  }
  function open() {
    if(!participant||!snapshot||!analysis)return;
    el['demo-workspace'].dataset.analysisOpen='true';
    el['analysis-panel'].hidden=false;el['open-analysis'].setAttribute('aria-expanded','true');canvas.dataset.analysisOpen='true';
    selectParcel(selectedParcelId??userParcelId);el['close-analysis'].focus({preventScroll:true});
  }
  function setRoute(next) {
    invalidateHandoff();snapshot=null;analysis=null;selectedParcelId=null;negotiationDisplay=new Map();
    el['open-analysis'].disabled=true;
    write('analysis-entry-status','');el['analysis-entry-status'].hidden=true;
    feedback('handoff-result','');
    if(!next){close({restoreFocus:false});renderParticipant();negotiationResults.routeChanged();return;}
    try {
      const computed=analyzeRouteParcels(world,next.route,next.assumptions);
      snapshot=next;analysis=computed;userParcelId??=chooseUserParcel(computed);
      selectedParcelId=computed.parcels.some(row=>row.parcelId===userParcelId)?userParcelId:computed.parcels[0]?.parcelId;getHandoff();
      write('analysis-route-note',`${distance(next.route.lengthTiles)} connection`);
      write('analysis-count',analysis.parcels.length);write('analysis-upfront',moneyOf(analysis.totals.upfrontCents));
      write('analysis-rent-label',`Fees · ${analysis.rentHorizonMonths} months`);write('analysis-rent',moneyOf(analysis.totals.rentTotalCents));
      renderConsent();
      el['open-analysis'].disabled=false;renderParticipant();
      if(!el['analysis-panel'].hidden)onFocusParcel(selectedParcelId);
      negotiationResults.routeChanged();
    } catch {
      snapshot=null;analysis=null;selectedParcelId=null;close({restoreFocus:false});renderParticipant();
      feedback('handoff-result','The parcel analysis could not be verified against this route. Recalculate the connection.','error');
      write('analysis-route-note','Parcel analysis is unavailable. Recalculate the connection.');
      write('analysis-entry-status','Parcel analysis is unavailable. Recalculate the connection.');el['analysis-entry-status'].hidden=false;
    }
  }
  function clearParticipant(message='Details cleared.',focus=true) {
    invalidateHandoff();participant=null;el['user-alias'].value='';el['user-phone'].value='';el['user-consent'].checked=false;
    feedback('user-form-status',message);feedback('handoff-result','');renderParticipant();
    for(const id of ['user-alias','user-phone','user-consent'])el[id].setAttribute('aria-invalid','false');
    if(focus)el['user-alias'].focus({preventScroll:true});
  }
  function resetParticipant() {
    negotiationResults.reset();sessionId=newSessionId();userParcelId=null;liveCallLocked=false;snapshot=null;analysis=null;selectedParcelId=null;negotiationDisplay=new Map();
    clearParticipant();
  }
  function editParticipant() {
    invalidateHandoff();participant=null;el['user-consent'].checked=false;
    feedback('user-form-status','Update your details and confirm consent to resume the demo.');
    feedback('handoff-result','Confirm your details again before requesting a call.');
    renderParticipant();el['user-alias'].focus({preventScroll:true});
  }
  function setHandoffHandler(next) {
    if(next!==null&&typeof next!=='function')throw new TypeError('The handoff handler must be a function or null.');
    invalidateHandoff();handler=next;feedback('handoff-result','');renderHandoff();
  }
  el['open-analysis'].setAttribute('aria-controls','analysis-panel');el['open-analysis'].setAttribute('aria-expanded','false');
  el['open-analysis'].addEventListener('click',open);
  el['close-analysis'].addEventListener('click',()=>close());
  for(const id of ['step-a','step-b','label-a','label-b','inspect-parcels'])el[id].addEventListener('click',()=>{
    if(!el['analysis-panel'].hidden)close({restoreFocus:false});
  });
  el['focus-user-parcel'].addEventListener('click',()=>{
    if(analysis?.parcels.some(row=>row.parcelId===userParcelId))selectParcel(userParcelId);
    else if(userParcelId)onFocusParcel(userParcelId);
  });
  el['focus-analysis-parcel'].addEventListener('click',()=>selectParcel(selectedParcelId));
  document.addEventListener('keydown',event=>{
    if(!isDemoReady()){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation?.();return;}
      if(event.key==='Tab'){
        const focusable=['user-alias','user-phone','user-consent','save-user','clear-user'].map(id=>el[id]);
        const current=focusable.indexOf(document.activeElement);
        if(current<0||(event.shiftKey&&current===0)||(!event.shiftKey&&current===focusable.length-1)){
          event.preventDefault();focusable[event.shiftKey?focusable.length-1:0].focus({preventScroll:true});
        }
      }
      return;
    }
    if(event.key==='Escape'&&!el['analysis-panel'].hidden){event.preventDefault();close();}
  });
  for(const id of ['user-alias','user-phone','user-consent'])el[id].addEventListener('input',()=>{
    invalidateHandoff();participant=null;el[id].setAttribute('aria-invalid','false');
    feedback('user-form-status','');
    feedback('handoff-result','');renderParticipant();
  });
  el['user-form'].addEventListener('submit',event=>{
    event.preventDefault();invalidateHandoff();
    const validation=validateDemoParticipant({alias:el['user-alias'].value,phone:el['user-phone'].value,consent:el['user-consent'].checked});
    participant=validation.participant;
    feedback('user-form-status',validation.valid?'Demo started. No call has been placed.':validation.errors.join(' '),validation.valid?'success':'error');
    if(participant){el['user-alias'].value=participant.alias;el['user-phone'].value=participant.phoneE164;}
    feedback('handoff-result','');renderParticipant();
    const name=el['user-alias'].value.trim(),phone=normalizeDemoPhone(el['user-phone'].value);
    const fields=[['user-alias',Boolean(name)&&name.length<=80&&!/[\u0000-\u001f\u007f]/.test(name)],
      ['user-phone',Boolean(phone)],['user-consent',el['user-consent'].checked===true]];
    for(const [id,valid] of fields)el[id].setAttribute('aria-invalid',String(!valid));
    if(participant)(getPlacements().substation?canvas:el['step-a']).focus({preventScroll:true});
    else el[fields.find(([,valid])=>!valid)?.[0]??'user-alias'].focus({preventScroll:true});
  });
  el['edit-participant'].addEventListener('click',editParticipant);
  el['edit-analysis-participant'].addEventListener('click',editParticipant);
  el['clear-user'].addEventListener('click',()=>clearParticipant());
  el['reset-plan'].addEventListener('click',resetParticipant);
  window.addEventListener('pagehide',()=>clearParticipant('Participant contact cleared. Enter your details again to begin.',false));
  el['agent-call'].addEventListener('click',async()=>{
    if(negotiationResults.getState().view||negotiationResults.getState().unavailable||liveCallLocked||!handler||!participant||pending||callRequested)return;
    let handoff;
    try {handoff=getHandoff();}catch {feedback('handoff-result','The route changed. Recalculate before requesting a call.','error');return;}
    if(handoff?.callPreparation.status!=='ready-for-host-adapter')return;
    activeHandoff?.abort();
    const ticket=revision,controller=new AbortController();activeHandoff=controller;pending=controller;renderHandoff();
    feedback('handoff-result','Sending call request…');
    try {
      await handler({handoff,participant:{...participant},signal:controller.signal});
      if(ticket!==revision||controller.signal.aborted)return;
      pending=null;callRequested=true;if(!negotiationResults.getState().view)feedback('handoff-result','Call request sent to the agent.','success');renderHandoff();
    } catch {
      if(ticket!==revision||controller.signal.aborted)return;
      pending=null;if(negotiationResults.getState().installed)callRequested=true;feedback('handoff-result','The agent could not confirm the request. Check its status before trying again.','error');renderHandoff();
    }
  });
  renderParticipant();el['user-alias'].focus({preventScroll:true});
  return {setRoute,getHandoff,getParcelRole,setHandoffHandler,resetParticipant,isDemoReady,open,close,settlement,
    getOriginalRole,setLiveCallLockout,getSessionId:()=>sessionId,setNegotiationDisplay,negotiationResults};
}
