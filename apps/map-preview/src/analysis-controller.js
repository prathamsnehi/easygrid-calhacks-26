import { analyzeRouteParcels, chooseJudgeParcel } from './parcel-analysis.js';
import { createHandoff, validateDemoParticipant } from './handoff.js';

/** Local analysis and an explicit, contact-private integration boundary. No calls or storage. */
export function createAnalysisController({world,canvas,getPlacements,onFocusParcel=()=>{},onJudgeRoleChange=()=>{},onDemoReadyChange=()=>{}}) {
  const ids=['open-analysis','analysis-entry-status','analysis-panel','close-analysis','analysis-route-note','analysis-count','analysis-upfront',
    'analysis-rent-label','analysis-rent','analysis-consent-note','analysis-parcel-list','analysis-parcel-detail',
    'analysis-parcel-title','analysis-parcel-badge','analysis-parcel-copy','analysis-owner','analysis-contact','analysis-email',
    'analysis-land-use','analysis-line-length','analysis-foundation','analysis-offer','analysis-parcel-rent-label',
    'analysis-parcel-rent','analysis-negotiation','analysis-parcel-impact','focus-judge-parcel','judge-parcel-label',
    'judge-contact-status','judge-role-note','judge-form','judge-alias','judge-phone','judge-consent','save-judge',
    'clear-judge','judge-form-status','handoff-status-badge','handoff-connection-note','export-handoff','prepare-handoff',
    'handoff-result','handoff-budget-note','reset-plan','step-a','step-b','label-a','label-b','inspect-parcels',
    'demo-workspace','demo-onboarding','edit-participant','edit-analysis-participant',
    'registered-participant-name','registered-participant-contact','registered-participant-consent'];
  const el=Object.fromEntries(ids.map(id=>[id,document.querySelector(`#${id}`)]));
  const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
  const moneyOf=value=>money.format(value/100);
  const number=value=>new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(value);
  const write=(id,value)=>{el[id].textContent=String(value);};
  const sessionId=`map-${window.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`}`;
  let snapshot=null,analysis=null,judgeParcelId=null,priorJudgeParcelId=null,selectedParcelId=null;
  let participant=null,handler=null,pending=null,activeHandoff=null,revision=0,prepared=false,lastDemoReady=false;

  function feedback(id,message,kind='') {write(id,message);el[id].className=`analysis-feedback${kind?` ${kind}`:''}`;}
  function invalidateHandoff() {revision++;activeHandoff?.abort();activeHandoff=null;pending=null;prepared=false;}
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
      judgeParcelId,sessionId,routeVersion:snapshot.routeVersion});
  }
  function getParcelRole(parcelId) {
    const row=analysis?.parcels.find(item=>item.parcelId===parcelId);
    if(!participant||!row||parcelId!==judgeParcelId)return null;
    return {ownerAlias:participant?.alias??'Judge participant',
      phoneDisplay:`Phone ending in ${participant.phoneE164.slice(-4)} · demo participant`,
      email:'Not collected for demo participant',originalOwnerAlias:row.ownerAlias,roleplay:true};
  }
  function renderHandoff() {
    const current=getHandoff(),ready=current?.callPreparation.status==='ready-for-host-adapter';
    el['export-handoff'].disabled=!current;
    el['prepare-handoff'].disabled=!ready||!handler||Boolean(pending)||prepared;
    write('prepare-handoff',pending?'Preparing…':prepared?'Handoff prepared':'Prepare participant handoff');
    write('handoff-status-badge',prepared?'PREPARED':handler?'HOST CONNECTED':'LOCAL PREVIEW');
    el['handoff-status-badge'].className=`role-badge${prepared?' ready':''}`;
    write('handoff-connection-note',handler?
      'A host adapter is connected. Prepare sends the private participant contact and this route to that adapter; it does not place a call.':
      'The voice backend is not connected. Export the route package to review the integration.');
    write('handoff-budget-note',`Fixture budget: ${moneyOf(current?.snapshot.project.budgetCents??100000000)}. This is a demo limit, not an approved project budget.`);
    if(current?.callPreparation.status==='review-required')feedback('handoff-result','This route exceeds an offer cap or the demo budget, or contains a refusal. Review the proposal before preparing a participant handoff.','error');
  }
  function renderDetail() {
    const row=analysis?.parcels.find(item=>item.parcelId===selectedParcelId);
    el['analysis-parcel-detail'].hidden=!row;
    if(!row)return;
    const isJudge=row.parcelId===judgeParcelId,role=getParcelRole(row.parcelId);
    write('analysis-parcel-title',row.name);
    write('analysis-parcel-badge',isJudge?'JUDGE ROLEPLAY':'FICTIONAL OWNER');
    el['analysis-parcel-badge'].className=`role-badge${isJudge?' judge':''}`;
    write('analysis-parcel-copy',isJudge?
      `The judge plays the landowner for ${row.parcelId}. Fictional role: ${row.ownerAlias}.`:
      `${row.parcelId} · Synthetic owner and contact details for this simulation.`);
    write('analysis-owner',role?.ownerAlias??row.ownerAlias);
    write('analysis-contact',role?.phoneDisplay??row.phoneDisplay);
    write('analysis-email',isJudge?'Not collected for demo participant':row.email);
    write('analysis-land-use',row.landUse.replaceAll('-',' '));
    write('analysis-line-length',`${number(row.lineLengthTiles)} tiles${row.corridorOnly?' · corridor only':''}`);
    write('analysis-foundation',`${row.towerCount} / ${number(row.foundationAreaTiles)} tiles²`);
    write('analysis-offer',`${moneyOf(row.upfrontCents)} / ${moneyOf(row.offerCapCents)}${row.withinOfferCap?'':' · review needed'}`);
    write('analysis-parcel-rent-label',`Rent · ${analysis.rentHorizonMonths} months`);
    write('analysis-parcel-rent',moneyOf(row.rentTotalCents));
    write('analysis-negotiation',`${row.accessConsent} / ${row.negotiationStatus.replaceAll('_',' ')}`);
    write('analysis-parcel-impact',row.corridorOnly?
      'The conductor corridor touches this parcel. It has no modeled centerline length or foundation charge, but owner review is still required.':
      `The proposal includes ${number(row.lineLengthTiles)} centerline tiles and ${number(row.foundationAreaTiles)} foundation tiles². Land access is separate from consent to a demo call.`);
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
      title.textContent=row.parcelId===judgeParcelId?(participant?.alias??'Judge participant'):row.ownerAlias;
      const code=document.createElement('small');code.textContent=row.parcelId;title.appendChild(code);
      const cost=document.createElement('span');cost.className='analysis-row-cost';cost.textContent=moneyOf(row.upfrontCents);
      const meta=document.createElement('span');meta.className='analysis-row-meta';
      meta.textContent=`${number(row.lineLengthTiles)} tiles · ${row.towerCount} ${row.towerCount===1?'pylon':'pylons'} · ${row.landUse.replaceAll('-',' ')}${row.withinOfferCap?'':' · offer cap exceeded'}`;
      button.appendChild(title);button.appendChild(cost);button.appendChild(meta);
      if(row.parcelId===judgeParcelId){
        const badge=document.createElement('span');badge.className='analysis-row-role';
        badge.textContent=participant?'JUDGE ROLE · PARTICIPANT READY':'JUDGE ROLE · CONTACT NEEDED';button.appendChild(badge);
      }
      button.addEventListener('click',()=>selectParcel(row.parcelId));return button;
    });
    el['analysis-parcel-list'].replaceChildren(...rows);
  }
  function renderParticipant() {
    write('judge-parcel-label',judgeParcelId??'No route selected');
    write('judge-contact-status',participant?'PARTICIPANT READY':'CONTACT NEEDED');
    el['judge-contact-status'].className=`role-badge${participant?' ready':''}`;
    const row=analysis?.parcels.find(item=>item.parcelId===judgeParcelId);
    write('judge-role-note',row?`Fictional role: ${row.ownerAlias}. This assignment does not claim real ownership.`:'A role in this fictional simulation, not a claim of real ownership.');
    el['focus-judge-parcel'].disabled=!judgeParcelId;
    canvas.dataset.judgeParcelId=judgeParcelId??'';
    canvas.dataset.participantReady=String(Boolean(participant));
    write('registered-participant-name',participant?.alias??'Participant required');
    write('registered-participant-contact',participant?`Phone ending in ${participant.phoneE164.slice(-4)}`:'Contact required');
    write('registered-participant-consent',participant?'AI roleplay call consent recorded for this page.':'AI roleplay call consent required.');
    el['open-analysis'].disabled=!participant||!snapshot||!analysis;
    renderRows();renderDetail();renderHandoff();onJudgeRoleChange();syncDemoGate();
  }
  function close({restoreFocus=true}={}) {
    const wasOpen=!el['analysis-panel'].hidden;
    el['analysis-panel'].hidden=true;el['open-analysis'].setAttribute('aria-expanded','false');
    canvas.dataset.analysisOpen='false';onFocusParcel(null);
    if(wasOpen&&restoreFocus)el['open-analysis'].focus({preventScroll:true});
  }
  function open() {
    if(!participant||!snapshot||!analysis)return;
    el['analysis-panel'].hidden=false;el['open-analysis'].setAttribute('aria-expanded','true');canvas.dataset.analysisOpen='true';
    selectParcel(selectedParcelId??judgeParcelId);el['close-analysis'].focus({preventScroll:true});
  }
  function setRoute(next) {
    invalidateHandoff();snapshot=null;analysis=null;judgeParcelId=null;selectedParcelId=null;
    el['open-analysis'].disabled=true;
    write('analysis-entry-status','');el['analysis-entry-status'].hidden=true;
    feedback('handoff-result','Export includes the selected route, owner roles and proposal amounts. Personal contact details stay private.');
    if(!next){close({restoreFocus:false});renderParticipant();return;}
    try {
      const computed=analyzeRouteParcels(world,next.route,next.assumptions);
      snapshot=next;analysis=computed;judgeParcelId=chooseJudgeParcel(computed,priorJudgeParcelId);priorJudgeParcelId=judgeParcelId;
      selectedParcelId=judgeParcelId;getHandoff();
      write('analysis-route-note',`${next.route.label} · route version ${next.routeVersion} · ${number(next.route.lengthTiles)} demo tiles`);
      write('analysis-count',analysis.parcels.length);write('analysis-upfront',moneyOf(analysis.totals.upfrontCents));
      write('analysis-rent-label',`Rent · ${analysis.rentHorizonMonths} months`);write('analysis-rent',moneyOf(analysis.totals.rentTotalCents));
      const pendingCount=analysis.parcels.filter(row=>row.accessConsent!=='allowed').length;
      write('analysis-consent-note',`${pendingCount} pending land consent`);
      el['open-analysis'].disabled=false;renderParticipant();
      if(!el['analysis-panel'].hidden)onFocusParcel(selectedParcelId);
    } catch {
      snapshot=null;analysis=null;judgeParcelId=null;selectedParcelId=null;close({restoreFocus:false});renderParticipant();
      feedback('handoff-result','The parcel analysis could not be verified against this route. Recalculate the connection.','error');
      write('analysis-route-note','Parcel analysis is unavailable. Recalculate the connection.');
      write('analysis-entry-status','Parcel analysis is unavailable. Recalculate the connection.');el['analysis-entry-status'].hidden=false;
    }
  }
  function clearParticipant(message='Participant contact cleared. Enter your details and confirm consent to begin.',focus=true) {
    invalidateHandoff();participant=null;el['judge-alias'].value='';el['judge-phone'].value='';el['judge-consent'].checked=false;
    feedback('judge-form-status',message);feedback('handoff-result','Personal contact details are excluded from the route export.');renderParticipant();
    for(const id of ['judge-alias','judge-phone','judge-consent'])el[id].setAttribute('aria-invalid','false');
    if(focus)el['judge-alias'].focus({preventScroll:true});
  }
  function resetParticipant() {priorJudgeParcelId=null;clearParticipant();}
  function editParticipant() {
    invalidateHandoff();participant=null;el['judge-consent'].checked=false;
    feedback('judge-form-status','Update your details and confirm consent to resume the demo.');
    feedback('handoff-result','The participant handoff is paused until you confirm your details again.');
    renderParticipant();el['judge-alias'].focus({preventScroll:true});
  }
  function setHandoffHandler(next) {
    if(next!==null&&typeof next!=='function')throw new TypeError('The handoff handler must be a function or null.');
    invalidateHandoff();handler=next;feedback('handoff-result',next?'The host adapter is available. Start the demo, select a route, then prepare the handoff.':'The host adapter is disconnected. You can still export the selected route package after starting the demo.');renderHandoff();
  }
  el['open-analysis'].setAttribute('aria-controls','analysis-panel');el['open-analysis'].setAttribute('aria-expanded','false');
  el['open-analysis'].addEventListener('click',open);
  el['close-analysis'].addEventListener('click',()=>close());
  for(const id of ['step-a','step-b','label-a','label-b','inspect-parcels'])el[id].addEventListener('click',()=>{
    if(!el['analysis-panel'].hidden)close({restoreFocus:false});
  });
  el['focus-judge-parcel'].addEventListener('click',()=>selectParcel(judgeParcelId));
  document.addEventListener('keydown',event=>{
    if(!isDemoReady()){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation?.();return;}
      if(event.key==='Tab'){
        const focusable=['judge-alias','judge-phone','judge-consent','save-judge','clear-judge'].map(id=>el[id]);
        const current=focusable.indexOf(document.activeElement);
        if(current<0||(event.shiftKey&&current===0)||(!event.shiftKey&&current===focusable.length-1)){
          event.preventDefault();focusable[event.shiftKey?focusable.length-1:0].focus({preventScroll:true});
        }
      }
      return;
    }
    if(event.key==='Escape'&&!el['analysis-panel'].hidden){event.preventDefault();close();}
  });
  for(const id of ['judge-alias','judge-phone','judge-consent'])el[id].addEventListener('input',()=>{
    invalidateHandoff();participant=null;el[id].setAttribute('aria-invalid','false');
    feedback('judge-form-status','Enter your name and phone number, then confirm consent to begin.');
    feedback('handoff-result','Start the demo before preparing a private contact handoff.');renderParticipant();
  });
  el['judge-form'].addEventListener('submit',event=>{
    event.preventDefault();invalidateHandoff();
    const validation=validateDemoParticipant({alias:el['judge-alias'].value,phone:el['judge-phone'].value,consent:el['judge-consent'].checked});
    participant=validation.participant;
    feedback('judge-form-status',validation.valid?'Demo started. No call has been placed.':validation.errors.join(' '),validation.valid?'success':'error');
    if(participant){el['judge-alias'].value=participant.alias;el['judge-phone'].value=participant.phoneE164;}
    feedback('handoff-result','Export remains contact-free. A connected host is required to prepare the participant handoff.');renderParticipant();
    const name=el['judge-alias'].value.trim(),phone=el['judge-phone'].value.trim().replace(/[\s().-]/g,'');
    const fields=[['judge-alias',Boolean(name)&&name.length<=80&&!/[\u0000-\u001f\u007f]/.test(name)],
      ['judge-phone',/^\+[1-9]\d{7,14}$/.test(phone)],['judge-consent',el['judge-consent'].checked===true]];
    for(const [id,valid] of fields)el[id].setAttribute('aria-invalid',String(!valid));
    if(participant)(getPlacements().substation?canvas:el['step-a']).focus({preventScroll:true});
    else el[fields.find(([,valid])=>!valid)?.[0]??'judge-alias'].focus({preventScroll:true});
  });
  el['edit-participant'].addEventListener('click',editParticipant);
  el['edit-analysis-participant'].addEventListener('click',editParticipant);
  el['clear-judge'].addEventListener('click',()=>clearParticipant());
  el['reset-plan'].addEventListener('click',resetParticipant);
  window.addEventListener('pagehide',()=>clearParticipant('Participant contact cleared. Enter your details again to begin.',false));
  el['export-handoff'].addEventListener('click',()=>{
    let objectUrl=null,anchor=null;
    try {
      const handoff=getHandoff();if(!handoff)return;
      objectUrl=URL.createObjectURL(new Blob([JSON.stringify(handoff,null,2)+'\n'],{type:'application/json'}));
      anchor=document.createElement('a');anchor.href=objectUrl;anchor.download=`easygrid-handoff-v${handoff.routeVersion}.json`;
      document.body.appendChild(anchor);anchor.click();
      feedback('handoff-result','Handoff JSON exported. The participant name and phone number are not included.','success');
    } catch {feedback('handoff-result','The export could not be downloaded in this browser. The host can still read the contact-free handoff.','error');}
    finally {anchor?.remove();if(objectUrl)setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);}
  });
  el['prepare-handoff'].addEventListener('click',async()=>{
    if(!handler||!participant||pending||prepared)return;
    let handoff;
    try {handoff=getHandoff();}catch {feedback('handoff-result','The handoff is stale. Recalculate the route.','error');return;}
    if(handoff?.callPreparation.status!=='ready-for-host-adapter')return;
    activeHandoff?.abort();
    const ticket=revision,controller=new AbortController();activeHandoff=controller;pending=controller;renderHandoff();
    feedback('handoff-result','Preparing the selected route and private participant contact with the host…');
    try {
      await handler({handoff,participant:{...participant},signal:controller.signal});
      if(ticket!==revision||controller.signal.aborted)return;
      pending=null;prepared=true;feedback('handoff-result','The host received the handoff. No call was placed by this map.','success');renderHandoff();
    } catch {
      if(ticket!==revision||controller.signal.aborted)return;
      pending=null;feedback('handoff-result','The host could not confirm preparation. Check its status before trying again; no automatic retry was made.','error');renderHandoff();
    }
  });
  renderParticipant();el['judge-alias'].focus({preventScroll:true});
  return {setRoute,getHandoff,getParcelRole,setHandoffHandler,resetParticipant,isDemoReady,open,close};
}
