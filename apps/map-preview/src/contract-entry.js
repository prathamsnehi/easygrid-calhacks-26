import {contractSourceKey, normalizeContractSource} from './contract-authoring.js';
import {createContractWorkspace} from './contract-workspace.js';
import {settlementBinding} from './settlement-controller.js';
import {contractSourceFromAgreement, mapContractRequest, matchesContractBinding, participantAgreementFromAcceptance} from './contract-handoff.js';
import {approveMapContracts, createContractAPIClient} from './contract-api-client.js';

/** Browser stand-in for Stella's contract workspace when the approval service cannot see a hosted call. */
function createLocalAgreementExecution({packageId, demoParcelId, amountCents}) {
  const signatures = {}, audit = [], journal = [];
  let payment = null;
  return async (operation, draft) => {
    if (!draft || draft.parcelId !== demoParcelId) throw new Error('This saved agreement only covers the current landowner.');
    if (operation === 'sign/utility' || operation === 'sign/landowner') {
      const side = operation.slice(5);
      if (!signatures[side]) {
        signatures[side] = {simulated:true, signedAt:new Date().toISOString()};
        audit.push({action:operation, reason:'Simulated signature for the saved agreement.', actorId:side === 'utility' ? 'demo-utility-controller' : 'demo-landowner'});
      }
    } else if (operation === 'submit') {
      if (!signatures.utility || !signatures.landowner) throw new Error('Both signatures are required before payment.');
      if (!payment) {
        payment = {status:'paid', amountCents, reason:'Simulated full payment complete. No real money moves.', transactionRef:`SIM-${packageId.slice(-8).toUpperCase()}`};
        journal.push({obligationId:`${demoParcelId}:full`, debitCents:amountCents, creditCents:amountCents});
        audit.push({action:'submit', reason:payment.reason, actorId:'demo-accounts-payable-agent'});
      }
    } else if (!['state','reconcile','reject'].includes(operation)) throw new Error('Unknown contract operation.');
    const both = Boolean(signatures.utility && signatures.landowner);
    return {draftId:draft.id, documentHash:'e'.repeat(64), signatures:{...signatures}, audit:[...audit], journal:[...journal],
      packageId, demoScope:'single-owner', demoParcelId, paymentReady:both, packageReady:false, bankMode:'simulation',
      paymentSemantics:'simulated-transfer', amountIncrementCents:1, paymentsEnabled:true, ...(payment ? {payment} : {}),
      agreementProgress:{signedCount:both ? 1 : 0, totalCount:1, nextUnsignedParcelId:null}};
  };
}

/** Local contract navigation; the service independently validates every payment gate. */
export function createContractEntry({getHandoff, getPlacements = () => null, getRoutingOptions = () => null,
  canSimulate = () => true, getAcceptedTerms = () => null, onOpen = () => {}, requestApproval = approveMapContracts, apiFactory = createContractAPIClient}) {
  const button = document.querySelector('#contract-proceed'), status = document.querySelector('#contract-entry-status');
  const simulate = document.querySelector('#contract-simulate-approval');
  let approved = null, workspace = null, constructionHandler = null, active = null, generation = 0, busy = false;
  const handoff = () => {try {return getHandoff();} catch {return null;}};
  const binding = () => settlementBinding(handoff());
  const sameReference=(a,b)=>Boolean(a&&b)&&['attemptId','eventId','revision'].every(key=>a[key]===b[key]);
  const matching = () => approved && matchesContractBinding(approved.mapBinding,binding()) &&
    (approved.approvalMode !== 'negotiated' || (getAcceptedTerms()?.available && sameReference(approved.negotiationRef,getAcceptedTerms()?.negotiationRef)));
  const write = message => {if (status) status.textContent = message;};
  function refresh() {
    if (simulate) {
      simulate.disabled = busy || !canSimulate() || handoff()?.snapshot?.routes?.[0]?.eligible !== true;
      simulate.textContent = busy ? 'Approving demo terms…' : matching() ? 'Demo negotiation approved' : 'Simulate approved negotiation';
    }
    if (button) button.disabled = busy || !matching();
  }
  function invalidate() {
    generation++;active?.abort();active = null;busy = false;approved = null;
    write('Awaiting approved negotiation');workspace?.invalidate();refresh();
  }
  function setNegotiation(value) {
    if (!value) {invalidate();return;}
    try {
      const current = binding(), input = normalizeContractSource(value.input), packet = handoff()?.ownerHandoff;
      if (!current || handoff()?.snapshot?.routes?.[0]?.eligible !== true || !matchesContractBinding(value.mapBinding,current)) throw new Error('The negotiation does not match the displayed route.');
      if (input.sessionId !== packet.sessionId || input.route.id !== packet.routeId || input.route.version !== packet.routeVersion ||
        input.parcels.length !== packet.parcels.length || input.parcels.some(parcel => {
          const original = packet.parcels.find(p => p.parcelId === parcel.parcelId);
          return !original || original.ownerId !== parcel.ownerId || parcel.compensationCents > original.offerCapCents;
        })) throw new Error('The contract inputs must preserve the selected route and affected owners.');
      if (value.agreement && contractSourceKey(contractSourceFromAgreement(value.agreement,handoff())) !== contractSourceKey(input)) throw new Error('The contract source differs from the approved negotiation package.');
      if (approved && (contractSourceKey(input) !== contractSourceKey(approved.input) || !matchesContractBinding(current,approved.mapBinding))) workspace?.invalidate();
      if (value.demoScope === 'single-owner' && !input.parcels.some(parcel => parcel.parcelId === value.demoParcelId)) throw new Error('The representative demo contract is not part of the approved route.');
      if (input.approvalScope && (value.demoScope !== 'single-owner' || value.demoParcelId !== input.approvalScope.parcelId)) throw new Error('The editor must preserve the approved landowner scope.');
      const local = value.local === true;
      approved = {input,mapBinding:{...current},packageId:value.packageId,simulated:value.simulated === true,demoScope:value.demoScope,demoParcelId:value.demoParcelId,demoTarget:value.demoTarget ?? 'representative',approvalMode:value.approvalMode,negotiationRef:value.negotiationRef,local,
        execution:local ? createLocalAgreementExecution({packageId:value.packageId,demoParcelId:value.demoParcelId,amountCents:input.parcels.find(parcel => parcel.parcelId === value.demoParcelId).compensationCents}) : null};
      write(value.approvalMode === 'negotiated' ? 'Agreed compensation verified · draft ready' : value.simulated ? 'Demo negotiation approved · no call was placed' : 'Negotiation approved · draft ready');refresh();
    } catch (error) {invalidate();throw error;}
  }
  function open({review = false} = {}) {
    if (!matching()) {invalidate();throw new Error('Approve the current route before opening contracts.');}
    let storage;try {storage = window.localStorage;} catch {storage = null;}
    if (!workspace) {
      workspace = createContractWorkspace({storage,isCurrent:() => Boolean(matching()),api:(...args) => {
        if (!matching()) return Promise.reject(new Error('The map approval changed.'));
        if (approved.local) return approved.execution(...args);
        return apiFactory({packageId:approved.packageId,demoScope:approved.demoScope,demoParcelId:approved.demoParcelId})(...args);
      }});
      workspace.setConstructionHandler(constructionHandler);
    }
    onOpen();workspace.open(approved.input,{simulationControls:approved.simulated,demoParcelId:approved.demoScope === 'single-owner' ? approved.demoParcelId : null});
    if (review) workspace.review();
  }
  async function prepareAndOpen({review = false, demoTarget = 'representative'} = {}) {
    if (!canSimulate()) throw new Error('Demo approval is unavailable while a call result is active. Start a new demo to simulate.');
    if (busy) return false;
    if (!['representative','participant'].includes(demoTarget)) throw new Error('Unknown demo approval target.');
    if (matching() && approved.demoTarget === demoTarget) {open({review});return true;}
    const context = mapContractRequest(handoff(),getPlacements(),getRoutingOptions()), ticket = ++generation;
    const controller = new AbortController();active = controller;busy = true;refresh();
    write('Preparing the representative example agreement…');
    try {
      const result = await requestApproval(context,{signal:controller.signal,demoTarget});
      if (ticket !== generation || controller.signal.aborted) return false;
      if (!matchesContractBinding(result.mapBinding,binding())) throw new Error('The route changed before approval arrived.');
      if (result.demoScope !== 'single-owner' || !result.input?.parcels?.some(parcel => parcel.parcelId === result.demoParcelId)) throw new Error('The local server does not support the representative contract demo yet. Open the updated server and try again.');
      if (demoTarget === 'participant' && (result.demoTarget !== 'participant' || result.demoParcelId !== context.userParcelId)) throw new Error('The service did not approve the current call target. The contract was not opened.');
      setNegotiation(result);open({review});return true;
    } catch (error) {
      if (ticket === generation) {approved = null;write(error.message);throw error;}
    } finally {if (ticket === generation) {busy = false;active = null;refresh();}}
  }
  async function prepareAcceptedAndOpen() {
    const accepted=getAcceptedTerms();
    if (!accepted?.available || accepted.parcelId !== handoff()?.userRole.parcelId) throw new Error('A current confirmed agreement is required.');
    if (busy) return false;
    if (matching() && approved.approvalMode === 'negotiated' && sameReference(approved.negotiationRef,accepted.negotiationRef)) {open({review:true});return true;}
    const context=mapContractRequest(handoff(),getPlacements(),getRoutingOptions()),ticket=++generation;
    const controller=new AbortController();active=controller;busy=true;refresh();write('Verifying the saved agreed compensation…');
    try {
      // Only this opaque reference crosses the boundary. The service loads the
      // committed agreement; a browser summary cannot authorize financial terms.
      const result=await requestApproval(context,{signal:controller.signal,demoTarget:'participant',negotiationRef:accepted.negotiationRef});
      if (ticket!==generation || controller.signal.aborted) return false;
      const current=getAcceptedTerms(),parcel=result.input?.parcels?.find(p=>p.parcelId===accepted.parcelId);
      if (!current?.available || !sameReference(current.negotiationRef,accepted.negotiationRef) || !matchesContractBinding(result.mapBinding,binding())) throw new Error('The saved negotiation changed before verification finished.');
      if (result.approvalMode!=='negotiated' || !sameReference(result.negotiationRef,accepted.negotiationRef) || result.demoScope!=='single-owner' || result.demoTarget!=='participant' || result.demoParcelId!==accepted.parcelId || result.input?.approvalScope?.kind!=='single-owner' || result.input.approvalScope.parcelId!==accepted.parcelId || parcel?.accepted!==true || parcel.compensationCents!==accepted.agreedCents || parcel.termsVersion!==accepted.termsVersion) throw new Error('The service did not verify the exact saved agreed compensation.');
      setNegotiation(result);open({review:true});return true;
    } catch(error) {
      if(ticket===generation){approved=null;write(error.message);throw error;}
    } finally {if(ticket===generation){busy=false;active=null;refresh();}}
  }
  function serviceCannotSeeSavedAgreement(error) {
    return /unavailable|not connected|could not be confirmed/i.test(error?.message ?? '');
  }
  function savedPackageId(reference) {
    const text = JSON.stringify([reference.attemptId,reference.eventId,reference.revision]);
    let hex = '';
    for (let index = 0; index < 40; index++) hex += ((text.charCodeAt(index % text.length) + index * 17) & 15).toString(16);
    return `map-contract-${hex}`;
  }
  function openLocalSavedAgreement() {
    const accepted = getAcceptedTerms(), current = handoff();
    if (!accepted?.available || accepted.parcelId !== current?.userRole.parcelId) throw new Error('A current confirmed agreement is required.');
    const agreement = participantAgreementFromAcceptance(current, accepted);
    const input = contractSourceFromAgreement(agreement, current);
    setNegotiation({input,agreement,mapBinding:binding(),packageId:savedPackageId(accepted.negotiationRef),simulated:false,
      approvalMode:'negotiated',negotiationRef:accepted.negotiationRef,demoScope:'single-owner',demoTarget:'participant',demoParcelId:accepted.parcelId,local:true});
    open({review:true});
    return true;
  }
  async function openAgreedContract() {
    try {return await prepareAcceptedAndOpen();}
    catch (error) {
      if (!serviceCannotSeeSavedAgreement(error)) throw error;
      return openLocalSavedAgreement();
    }
  }
  function openVerifiedAcceptance(result,{openDocument=true}={}) {
    const accepted=getAcceptedTerms(),parcel=result?.input?.parcels?.find(p=>p.parcelId===accepted?.parcelId);
    if(!accepted?.available||result?.approvalMode!=='negotiated'||result.simulated!==false||
      !sameReference(result.negotiationRef,accepted.negotiationRef)||!matchesContractBinding(result.mapBinding,binding())||
      result.demoScope!=='single-owner'||result.demoTarget!=='participant'||result.demoParcelId!==accepted.parcelId||
      result.input?.approvalScope?.kind!=='single-owner'||result.input.approvalScope.parcelId!==accepted.parcelId||
      parcel?.accepted!==true||parcel.compensationCents!==accepted.agreedCents||parcel.termsVersion!==accepted.termsVersion)
      throw new Error('The saved voice approval does not match the exact agreed compensation.');
    setNegotiation(result);
    if(openDocument)open({review:true});
    return true;
  }
  button?.addEventListener('click',() => {try {open();} catch (error) {write(error.message);}});
  simulate?.addEventListener('click',() => {prepareAndOpen().catch(error => write(error.message));});
  invalidate();
  return {getBinding:binding,setNegotiation,invalidate,refresh,open,prepareAndOpen,prepareAcceptedAndOpen,openAgreedContract,openVerifiedAcceptance,
    setAgreement(value) {setNegotiation({...value,input:contractSourceFromAgreement(value.agreement,handoff())});},
    setConstructionHandler(handler) {
      if (handler !== null && typeof handler !== 'function') throw new Error('Construction handler must be a function or null.');
      constructionHandler = handler;workspace?.setConstructionHandler(handler);
    },
    reportConstructionComplete:result => workspace ? workspace.reportConstructionComplete(result) : Promise.reject(new Error('Open the current contract package first.')),
    close:() => workspace?.close()};
}
