import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {createWorld} from '../src/world.js';
import {createHandoff,validateDemoParticipant} from '../src/handoff.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {relocateWithinParcel} from '../src/conditional-relocation.js';
import {matchesContractBinding} from '../src/contract-handoff.js';
import {settlementBinding} from '../src/settlement-controller.js';
import {permittedNegotiationMaximum} from '../../../packages/contracts/src/negotiation.ts';
import {applyOriginalVoicePolicies,voiceCommitReference,voiceCommitApprovedAt,agreementFromSavedVoice} from './voice-contracts.mjs';

const copy=structuredClone,terminal=new Set(['accepted','refused','review_required']);
const check=(ok,message='The saved voice operation could not be verified.')=>{if(!ok)throw new Error(message);};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100);

/** Provider writes require a durable DB claim. Cached IDs and local queues supply no mutation authority. */
export function createVoiceCoordinator({store,runtimeFactory,createProposal,world=createWorld(),secret,approveMap=null,
  now=()=>new Date().toISOString(),relocate=relocateWithinParcel,maxConnectedMs=60_000}={}) {
  check(store&&typeof runtimeFactory==='function'&&typeof createProposal==='function'&&typeof secret==='string'&&secret.length>=32,
    'The voice coordinator requires an authoritative store, provider, proposal builder and private server secret.');
  check(maxConnectedMs===null||Number.isSafeInteger(maxConnectedMs)&&maxConnectedMs>=1000,'The connected call deadline is invalid.');
  const ids=new Map(),queues=new Map(),listeners=new Set();let closed=false;
  const hmac=value=>createHmac('sha256',secret).update(value).digest('hex');
  const attemptId=(clientId,sessionId)=>`voice-${hmac(JSON.stringify([clientId,sessionId])).slice(0,40)}`;
  const credential=id=>`v1_${id}_${hmac(`voice-tool:${id}`)}`;
  const serial=(id,action)=>{const result=(queues.get(id)??Promise.resolve()).then(action);queues.set(id,result.catch(()=>{}));return result;};
  const canonical=a=>{let value;try{value=JSON.parse(a.canonicalJson);}catch{throw new Error('The original saved voice proposal is unavailable.');}
    check(value?.handoff&&value.route&&value.placements&&value.context&&typeof value.clientId==='string');return value;};
  const ownerParcel=a=>canonical(a).handoff.ownerHandoff.parcels.find(p=>p.parcelId===a.parcelId);
  const stored=async id=>{check(!closed,'The voice service is closed.');return await store.getAttempt(id);};
  const find=async sessionId=>{const id=ids.get(sessionId);return id?stored(id):null;};
  const owned=(a,clientId)=>check(a&&canonical(a).clientId===clientId,'The voice session is unavailable.');
  function stableProposal(a) {
    const c=canonical(a),initial=c.handoff;
    check(matchesContractBinding(settlementBinding(initial),a.mapBinding)&&initial.sessionId===a.sessionId&&initial.userRole.parcelId===a.parcelId);
    return c;
  }
  function finalProposal(a) {
    const c=stableProposal(a);
    if(a.candidate?.decision!=='conditional')return {...c,handoff:copy(c.handoff),relocation:null};
    const packet=c.handoff.ownerHandoff,accepted=a.candidate.acceptedCompensationCents;
    const currentTotalCents=packet.constructionCents+packet.parcels.reduce((n,p)=>n+(p.parcelId===a.parcelId?accepted:p.terms.compensationCents)+p.terms.monthlyRentCents*packet.rentHorizonMonths,0);
    const relocation=relocate({world,route:copy(c.route),placements:copy(c.placements),assumptions:copy(c.assumptions??{}),
      parcelId:a.parcelId,condition:copy(a.candidate.condition),budgetCents:packet.budgetCents,currentTotalCents,
      agreedTermsByParcel:Object.fromEntries(packet.parcels.map(p=>[p.parcelId,{compensationCents:p.parcelId===a.parcelId?accepted:p.terms.compensationCents,monthlyRentCents:p.terms.monthlyRentCents}]))});
    check(relocation.status==='applied','The location condition could not be verified within the original parcel.');
    const handoff=applyOriginalVoicePolicies(createHandoff({world,route:relocation.route,placements:c.placements,
      analysis:analyzeRouteParcels(world,relocation.route,c.assumptions),sessionId:a.sessionId,routeVersion:c.handoff.routeVersion+1,
      userParcelId:a.parcelId,budgetCents:packet.budgetCents}),c.handoff);
    const binding=settlementBinding(handoff);
    return {...c,route:relocation.route,handoff,relocation,context:{...copy(c.context),routeId:binding.routeId,routeVersion:binding.routeVersion,mapBinding:binding}};
  }
  function trustedRecord(a) {
    check(a?.status==='accepted'&&a.outcome?.status==='accepted','The voice attempt has no committed acceptance.');
    const proposal=finalProposal(a),trusted={kind:'easygrid-voice-commit',attempt:copy(a),
      ...(a.candidate.decision==='conditional'?{resultingRoute:proposal.route}:{})};
    // Validate the saved proof against a fresh geometry reconstruction before every projection or contract operation.
    agreementFromSavedVoice(trusted,proposal.handoff,voiceCommitReference(a));
    return {proposal,trusted};
  }
  async function project(a) {
    if(!a)return null;
    stableProposal(a);
    const finished=terminal.has(a.status),accepted=a.status==='accepted',parcel=ownerParcel(a);
    let reason=finished?(accepted?`The owner agreed to ${money(a.outcome.acceptedCompensationCents)} in full compensation.`:
      a.status==='refused'?'The owner declined. No contract was approved.':'The call needs review. No contract was approved.'):
      a.status==='unknown'||a.status==='dispatching'?'The call status is not yet confirmed. A second call will not be placed.':
      a.status==='completed'?'The completed call is being checked against its saved evidence.':'The consented roleplay call is in progress.';
    const event={schemaVersion:1,kind:'easygrid-voice-result',saved:true,mode:'live',attemptId:a.id,eventId:`voice-${a.id}-${a.revision}`,
      revision:a.revision,localParcelId:a.parcelId,mapBinding:copy(a.mapBinding),
      status:finished?(a.status==='review_required'?'review_required':'finished'):a.status==='completed'?'confirming':'negotiating',
      outcome:finished?a.status:null,acceptedCompensationCents:accepted?a.outcome.acceptedCompensationCents:null,reason,
      ...(accepted?{approvedAt:voiceCommitApprovedAt(a),termsVersion:parcel.terms.termsVersion+1,monthlyRentCents:0,paymentSchedule:'full-after-signatures'}: {})};
    if(accepted) {
      const {proposal}=trustedRecord(a);
      if(proposal.relocation) {
        event.reason=`The owner agreed to ${money(a.outcome.acceptedCompensationCents)} if the tower moved to the ${a.candidate.condition.direction} edge. That condition was verified within the original parcel.`;
        event.relocation={status:'applied',mapBinding:settlementBinding(proposal.handoff),
          snapshot:{route:copy(proposal.route),assumptions:copy(proposal.assumptions),routeVersion:proposal.handoff.routeVersion},
          originalHandoff:copy(canonical(a).handoff)};
      }
      if(approveMap) event.contractApproval=await approveMap(copy(proposal.context),{demoScope:'single-owner',demoTarget:'participant',negotiationRef:voiceCommitReference(a)});
    }
    return event;
  }
  async function getResult({clientId,sessionId}) {
    check(typeof clientId==='string'&&clientId.length>0&&validId(sessionId));
    const a=await stored(attemptId(clientId,sessionId));if(!a)return null;owned(a,clientId);return project(a);
  }
  async function getActive({clientId}) {
    check(typeof clientId==='string'&&clientId.length>0);
    const attempts=await Promise.all([...new Set(ids.values())].map(id=>stored(id)));
    const ownedAttempts=attempts.filter(a=>{try{return a&&canonical(a).clientId===clientId;}catch{return false;}});
    const created=a=>/^\d+$/.test(a.createdAtMicros??'')?BigInt(a.createdAtMicros):0n;
    ownedAttempts.sort((a,b)=>created(a)>created(b)?-1:created(a)<created(b)?1:0);
    const a=ownedAttempts[0];if(!a)return null;
    const c=stableProposal(a),point=kind=>({x:c.context[kind].x,z:c.context[kind].z});
    // Restore the original route first; the saved conditional event installs its verified final geometry.
    return {record:{sessionId:a.sessionId,routeId:a.mapBinding.routeId,routeVersion:a.mapBinding.routeVersion,
      userParcelId:a.parcelId,mapBinding:copy(a.mapBinding)},facilities:{substation:point('substation'),datacenter:point('datacenter')}};
  }
  async function start({clientId,context,participant,requestKey}) {
    check(typeof clientId==='string'&&clientId.length>0&&clientId.length<=200&&validId(context?.sessionId)&&validId(requestKey));
    const validated=validateDemoParticipant({...participant,phone:participant?.phoneE164??participant?.phone});check(validated.valid,'A consenting roleplay participant and valid telephone number are required.');
    const id=attemptId(clientId,context.sessionId);
    return serial(id,async()=>{
      let a=await stored(id);
      if(a){owned(a,clientId);check(matchesContractBinding(a.mapBinding,context.mapBinding),'This session already has its original call binding.');}
      else {
        const p=await createProposal(copy(context)),h=p?.handoff,parcel=h?.ownerHandoff?.parcels.find(item=>item.parcelId===context.userParcelId);
        check(parcel&&matchesContractBinding(settlementBinding(h),context.mapBinding)&&h.snapshot.routes[0].eligible===true&&h.userRole.parcelId===parcel.parcelId,
          'The current participant and route must be verified before a call.');
        const maximum=Math.min(parcel.offerCapCents,permittedNegotiationMaximum(h.ownerHandoff,parcel.parcelId));
        check(maximum>=parcel.offerPolicy.recommendedOfferCents,'The project budget does not cover the opening offer.');
        const input={id,sessionId:context.sessionId,requestKey,parcelId:parcel.parcelId,ownerId:parcel.ownerId,mapBinding:copy(context.mapBinding),
          canonicalJson:JSON.stringify({context:copy(context),handoff:h,route:p.route,placements:p.placements,assumptions:p.assumptions,clientId}),
          privateContact:{name:validated.participant.alias,phone:validated.participant.phoneE164},consent:true,consentAt:now(),
          bearerTokenHash:hash(credential(id)),offerCents:parcel.offerPolicy.recommendedOfferCents,capCents:parcel.offerCapCents,maxOfferCents:maximum};
        try{a=(await store.reserveAttempt(input)).attempt;}
        catch{a=await stored(id);if(!a)throw new Error('The call reservation could not be confirmed. Check saved status before trying again.');owned(a,clientId);check(matchesContractBinding(a.mapBinding,context.mapBinding));}
      }
      ids.set(a.sessionId,a.id);
      if(a.status!=='reserved')return project(a);
      const claim=await store.claimAttempt({id});a=claim.attempt;
      if(!claim.claimed)return project(a);
      let providerId;
      try {
        const runtime=await runtimeFactory(a),call=await runtime.start({toNumber:a.privateContact.phone,openingCompensationCents:a.offerCents,
          maximumCompensationCents:a.maxOfferCents??a.capCents,attemptSecret:credential(a.id)});
        check(validId(call?.id),'The provider did not return a bound call identifier.');providerId=call.id;
        a=await store.markAttempt({id,claimId:a.claimId,status:'submitted',providerCallId:providerId});
      } catch {
        try{a=await store.markAttempt({id,claimId:a.claimId,status:'unknown',...(providerId?{providerCallId:providerId}:{}),evidence:{reasonCode:'DISPATCH_UNCONFIRMED'}});}
        catch{throw new Error('The call may have been submitted. Saved confirmation is unavailable; do not redial.');}
      }
      return project(a);
    });
  }
  async function refresh(id) {
    check(validId(id));return serial(id,async()=>{
      let a=await stored(id);if(!a)return null;if(terminal.has(a.status)||!a.providerCallId)return project(a);
      try {
        if(['cancelled','failed'].includes(a.status)) {
          a=await store.saveOutcome({id,claimId:a.claimId,outcome:{status:'review_required',parcelId:a.parcelId,acceptedCompensationCents:null,originalMapBinding:a.mapBinding}});
          return project(a);
        }
        const connected=a.evidence?.find(item=>typeof item.connectedAt==='string')?.connectedAt;
        if(maxConnectedMs!==null&&connected&&Date.parse(now())-Date.parse(connected)>=maxConnectedMs&&['connected','unknown'].includes(a.status)) {
          // Persist the stop before the provider write. A restart must not resume or redial this call.
          a=await store.markAttempt({id,claimId:a.claimId,status:'cancelled',providerCallId:a.providerCallId,evidence:{reasonCode:'CONNECTED_DEADLINE'}});
          try{await(await runtimeFactory(a)).cancel(a.providerCallId);}catch{/* Preserve the stopped outcome even if cancellation acknowledgement is unavailable. */}
          a=await store.saveOutcome({id,claimId:a.claimId,outcome:{status:'review_required',parcelId:a.parcelId,acceptedCompensationCents:null,originalMapBinding:a.mapBinding}});
          return project(a);
        }
        if(!a.candidate) {
          const runtime=await runtimeFactory(a),inspection=await runtime.inspect({callId:a.providerCallId,approvedOfferCents:[a.currentOfferCents??a.offerCents]});
          const status={created:'submitted',started:'connected',unknown:'unknown',completed:'completed',failed:'failed'}[inspection.status]??'unknown';
          a=await store.markAttempt({id,claimId:a.claimId,status,providerCallId:a.providerCallId,
            evidence:inspection.turns?{turns:inspection.turns}:status==='connected'&&!connected?{connectedAt:now()}:{reasonCode:inspection.reasonCode??'PROVIDER_PENDING'}});
          if(status!=='completed'&&status!=='failed')return project(a);
          if(inspection.candidate)a=await store.saveCandidate({id,claimId:a.claimId,candidate:inspection.candidate});
        }
        const c=a.candidate;let outcome={status:'review_required',parcelId:a.parcelId,acceptedCompensationCents:null,originalMapBinding:a.mapBinding};
        if(c?.decision==='refused')outcome.status='refused';
        else if(c&&['accepted','conditional'].includes(c.decision)) {
          const proposal=finalProposal(a),binding=settlementBinding(proposal.handoff);
          outcome={...outcome,status:'accepted',acceptedCompensationCents:c.acceptedCompensationCents,resultingMapBinding:binding};
          if(c.decision==='conditional')outcome.relocationVerification={verified:true,condition:copy(c.condition),parcelId:a.parcelId,
            acceptedCompensationCents:c.acceptedCompensationCents,originalMapBinding:a.mapBinding,resultingMapBinding:binding,
            geometryHash:hash(proposal.route),conditionEvidence:copy(proposal.relocation.conditionEvidence)};
        }
        a=await store.saveOutcome({id,claimId:a.claimId,outcome});
      } catch {
        // A write may have committed despite a lost acknowledgement. Never overwrite a final result.
        const current=await stored(id);if(terminal.has(current?.status))return project(current);
        if(current?.status==='completed'&&current.candidate) {
          try{a=await store.saveOutcome({id,claimId:current.claimId,outcome:{status:'review_required',parcelId:current.parcelId,acceptedCompensationCents:null,originalMapBinding:current.mapBinding}});}
          catch{throw new Error('The saved call review could not be confirmed.');}
        } else throw new Error('The provider or saved call state could not be confirmed.');
      }
      return project(a);
    });
  }
  async function verifyToolAuthorization(authorization,providerCallId) {
    const token=String(authorization??'').replace(/^Bearer\s+/i,''),match=/^v1_(voice-[a-f0-9]{40})_([a-f0-9]{64})$/.exec(token);
    check(match,'The call tool is not authorized.');
    const expected=credential(match[1]);check(token.length===expected.length&&timingSafeEqual(Buffer.from(token),Buffer.from(expected)),'The call tool is not authorized.');
    const a=await stored(match[1]);check(a&&hash(token)===a.bearerTokenHash&&a.claimId&&(!providerCallId||!a.providerCallId||providerCallId===a.providerCallId),
      'The call tool is not authorized.');return a;
  }
  async function tool({authorization,input,kind,providerCallId}) {
    const a=await verifyToolAuthorization(authorization,providerCallId);
    check(['dispatching','submitted','ringing','connected'].includes(a.status),'The call no longer accepts decision tools.');
    const requestId=input?.requestId,raw=input?.payload??Object.fromEntries(Object.entries(input??{}).filter(([key])=>key!=='requestId'));
    const payload=kind==='counteroffer'?{requestedCents:raw?.requestedCents??raw?.requestedCompensationCents??null}:raw;
    check(validId(requestId)&&['counteroffer','response'].includes(kind)&&typeof store.recordTool==='function','The saved call tool is unavailable.');
    const result=await store.recordTool({id:a.id,claimId:a.claimId,requestId,kind,payload});
    return kind==='counteroffer'?{compensationCents:result.receipt.compensationCents,finalOffer:result.receipt.finalOffer,paymentSchedule:'full-after-signatures'}:
      {recorded:true,agreementConfirmed:false};
  }
  async function resolveProposal(context) {
    const a=await find(context?.sessionId);if(!a)return(await createProposal(copy(context))).handoff;
    const c=stableProposal(a);
    if(matchesContractBinding(context.mapBinding,a.mapBinding))return copy(c.handoff);
    if(a.status==='accepted') {const {proposal}=trustedRecord(a);if(matchesContractBinding(context.mapBinding,settlementBinding(proposal.handoff)))return copy(proposal.handoff);}
    throw new Error('The requested map differs from the saved voice proposal.');
  }
  async function resolveNegotiation({context,negotiationRef}) {
    const a=await find(context?.sessionId);check(a,'The saved voice attempt is unavailable.');
    const ref=voiceCommitReference(a);check(negotiationRef&&['attemptId','eventId','revision'].every(key=>negotiationRef[key]===ref[key]),'The saved voice reference is stale.');
    const {proposal,trusted}=trustedRecord(a);check(matchesContractBinding(context.mapBinding,settlementBinding(proposal.handoff)),'The saved acceptance belongs to another route.');return trusted;
  }
  const unsubscribe=store.subscribeResults(rows=>{
    for(const row of rows)ids.set(row.sessionId,row.id);
    for(const sub of listeners) {const row=rows.find(r=>r.sessionId===sub.sessionId);if(!row)continue;
      getResult(sub).then(value=>{if(!closed&&listeners.has(sub))sub.listener(value);}).catch(()=>{if(!closed&&listeners.has(sub))sub.onUnavailable?.();});}
  });
  return {start,getResult,get:getResult,getActive,refresh,project,resolveProposal,resolveNegotiation,tool,verifyToolAuthorization,
    setApproveMap(fn){check(fn===null||typeof fn==='function');approveMap=fn;},
    subscribe({clientId,sessionId,onUnavailable},listener){check(typeof listener==='function');const sub={clientId,sessionId,onUnavailable,listener};listeners.add(sub);
      getResult(sub).then(value=>{if(listeners.has(sub))listener(value);}).catch(()=>onUnavailable?.());return()=>listeners.delete(sub);},
    async listPendingIds(){return(await store.listPending()).filter(a=>a.providerCallId).map(a=>a.id);},
    close(){closed=true;listeners.clear();unsubscribe?.();}};
}
