const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const copy=value=>JSON.parse(JSON.stringify(value));
const validId=value=>typeof value==='string'&&ID.test(value);

/** Exact public proposal identity, not a signature or payment authorization. */
export function settlementBinding(handoff){
  if(!handoff?.snapshot?.routes?.[0]||!handoff.ownerHandoff)return null;
  return {sessionId:handoff.sessionId,routeId:handoff.ownerHandoff.routeId,routeVersion:handoff.routeVersion,
    proposalKey:JSON.stringify({snapshot:handoff.snapshot,ownerHandoff:handoff.ownerHandoff,
      coordinateTransform:handoff.coordinateTransform,costModel:handoff.costModel})};
}
function sameBinding(a,b){return Boolean(a&&b)&&['sessionId','routeId','routeVersion','proposalKey'].every(key=>a[key]===b[key]);}

/** UI gate only. The host owns approval, authorization and simulated ledger writes. */
export function createSettlementController({getHandoff}){
  const button=document.querySelector('#settle-payment'),status=document.querySelector('#settlement-status');
  const feedback=document.querySelector('#settlement-feedback'),overviewButton=document.querySelector('#overview-settlement');
  let handler=null,approval=null,active=null,generation=0,demoAgreement=null,contractNavigation=null;
  let onDemoProceed=()=>{},onContractProceed=()=>{},demoBusy=false;
  // Keep a stable key across uncertain retries; a second key must not bypass host deduplication.
  const attempts=new Map();
  let sequence=0;
  function current(){try{return getHandoff();}catch{return null;}}
  function eligible(handoff){return handoff?.snapshot?.routes?.[0]?.eligible===true&&handoff.ownerHandoff.simulationChecksPassed===true;}
  function attemptId(receipt){return JSON.stringify([receipt.mapBinding.sessionId,receipt.approvalId,receipt.packageHash]);}
  function matching(handoff){return approval&&eligible(handoff)&&sameBinding(approval.mapBinding,settlementBinding(handoff));}
  function stop(){generation++;active?.abort();active=null;demoBusy=false;}
  function render(){
    const handoff=current(),valid=matching(handoff),attempt=valid?attempts.get(attemptId(approval)):null;
    if(approval&&!valid){stop();approval=null;}
    const sent=attempt?.status==='sent',uncertain=attempt?.status==='unknown';
    if(demoAgreement&&!sameBinding(demoAgreement.mapBinding,settlementBinding(handoff)))demoAgreement=null;
    if(contractNavigation&&(!eligible(handoff)||!sameBinding(contractNavigation.mapBinding,settlementBinding(handoff))||contractNavigation.parcelId!==handoff.userRole.parcelId))contractNavigation=null;
    const ready=Boolean((contractNavigation||demoAgreement)&&!demoBusy||valid&&handler&&!active&&!sent&&!uncertain);
    button.disabled=!ready;
    button.classList.toggle('settlement-ready',ready);
    button.textContent=demoBusy?'Preparing contracts…':active?'Sending…':sent?'Request sent':contractNavigation?'Open approved contract':'Continue to contract & settlement';
    if(overviewButton){overviewButton.disabled=button.disabled;overviewButton.classList.toggle('settlement-ready',ready);overviewButton.textContent=button.textContent;}
    status.textContent=contractNavigation?'Owner approved · demo':demoAgreement?'Approved · demo':active?'Sending':sent?'Requested':uncertain?'Check status':valid?'Approved':'Awaiting approval';
    status.className=`role-badge${valid||demoAgreement||contractNavigation?' ready':''}`;
    if(!active&&!sent&&!uncertain&&!feedback.textContent&&valid&&!handler)feedback.textContent='Settlement not connected.';
  }
  function invalidate(){stop();approval=null;demoAgreement=null;contractNavigation=null;document.querySelector('#demo-settlement-summary')?.setAttribute('hidden','');feedback.textContent='';render();}
  function getBinding(){return settlementBinding(current());}
  function setApproval(next){
    // Repeated subscription delivery of the same approval must not cancel its request.
    if(next?.simulated===true&&approval&&next.approvalId===approval.approvalId&&next.packageHash===approval.packageHash&&
      sameBinding(next.mapBinding,approval.mapBinding)&&matching(current()))return;
    // Invalid updates revoke any prior approval rather than leaving a stale button enabled.
    stop();approval=null;feedback.textContent='';
    if(next===null){render();return;}
    const handoff=current();
    if(next?.simulated!==true||!validId(next.approvalId)||typeof next.packageHash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(next.packageHash)||
      !eligible(handoff)||!sameBinding(next.mapBinding,settlementBinding(handoff))){
      render();throw new Error('Settlement approval must match the current simulated proposal.');
    }
    approval=copy({approvalId:next.approvalId,packageHash:next.packageHash,simulated:true,mapBinding:settlementBinding(handoff)});
    render();
  }
  function setHandler(next){
    if(next!==null&&typeof next!=='function')throw new TypeError('The settlement handler must be a function or null.');
    if(next===handler)return;
    stop();handler=next;feedback.textContent='';render();
  }
  button.addEventListener('click',async()=>{
    const handoff=current();
    const navigation=contractNavigation??demoAgreement;
    if(navigation&&sameBinding(navigation.mapBinding,settlementBinding(handoff))){
      if(demoBusy)return;
      const ticket=++generation;demoBusy=true;feedback.textContent='';render();
      try{await (contractNavigation?onContractProceed:onDemoProceed)(copy(navigation));}
      catch(error){if(ticket===generation)feedback.textContent=error.message||'Contracts could not be opened. Try again.';}
      finally{if(ticket===generation){demoBusy=false;render();}}
      return;
    }
    if(!handler||active||!matching(handoff)){render();return;}
    const receipt=copy(approval),key=attemptId(receipt),prior=attempts.get(key);
    if(prior?.status==='sent'||prior?.status==='unknown'){render();return;}
    const requestKey=prior?.requestKey??`${receipt.mapBinding.sessionId}:settle:${++sequence}`;
    attempts.set(key,{requestKey,status:'unknown'});
    const controller=new AbortController(),ticket=++generation;active=controller;feedback.textContent='';render();
    try{
      const result=await handler({handoff:copy(handoff),approval:receipt,stage:'full',paymentSchedule:'full-after-signatures',requestKey,signal:controller.signal});
      // Completion from an old route, participant or revoked approval must never restore UI state.
      if(ticket!==generation||controller.signal.aborted)return;
      if(!matching(current())){invalidate();return;}
      if(result?.status!=='submitted'||result.approvalId!==receipt.approvalId||result.requestKey!==requestKey||!validId(result.requestId))throw new Error('Unconfirmed settlement request.');
      attempts.set(key,{requestKey,status:'sent'});active=null;
      feedback.textContent='Settlement request sent.';render();
    }catch{
      if(ticket!==generation||controller.signal.aborted)return;
      if(!matching(current())){invalidate();return;}
      active=null;feedback.textContent='Check settlement status before retrying.';render();
    }
  });
  /** Host reconciliation only: permit an explicit retry after confirming no request was accepted. */
  function resolveAttempt({approvalId,packageHash,requestKey,status:nextStatus}={}){
    const handoff=current();
    if(active||!matching(handoff)||approval.approvalId!==approvalId||approval.packageHash!==packageHash||!['submitted','not-submitted'].includes(nextStatus))throw new Error('Settlement reconciliation does not match the current approval.');
    const key=attemptId(approval),attempt=attempts.get(key);
    if(!attempt||attempt.requestKey!==requestKey||attempt.status!=='unknown')throw new Error('No matching uncertain settlement attempt.');
    attempts.set(key,{requestKey,status:nextStatus==='submitted'?'sent':'retry'});
    feedback.textContent=nextStatus==='submitted'?'Settlement request sent.':'';render();
  }
  render();
  return {getBinding,setApproval,setHandler,resolveAttempt,invalidate,
    setContractNavigation(value,onProceed=()=>{}){
      const handoff=current();
      contractNavigation=value&&eligible(handoff)&&sameBinding(value.mapBinding,getBinding())&&value.parcelId===handoff.userRole.parcelId&&handoff.snapshot.routes[0].parcelIds.includes(value.parcelId)?copy({mapBinding:value.mapBinding,parcelId:value.parcelId}):null;
      onContractProceed=onProceed;render();
    },
    setDemoAgreement(value,onProceed=()=>{}){
      demoAgreement=value?.sourceMode==='mock'&&sameBinding(value.mapBinding,getBinding())?copy(value):null;
      onDemoProceed=onProceed;render();
    }};
}
