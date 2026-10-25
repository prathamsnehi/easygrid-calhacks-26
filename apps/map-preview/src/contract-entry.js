import {contractSourceKey, normalizeContractSource} from './contract-authoring.js';
import {createContractWorkspace} from './contract-workspace.js';
import {settlementBinding} from './settlement-controller.js';
import {contractSourceFromAgreement, mapContractRequest, matchesContractBinding} from './contract-handoff.js';
import {approveMapContracts, createContractAPIClient} from './contract-api-client.js';

/** Local contract navigation; the service independently validates every payment gate. */
export function createContractEntry({getHandoff, getPlacements = () => null, getRoutingOptions = () => null,
  canSimulate = () => true, onOpen = () => {}, requestApproval = approveMapContracts, apiFactory = createContractAPIClient}) {
  const button = document.querySelector('#contract-proceed'), status = document.querySelector('#contract-entry-status');
  const simulate = document.querySelector('#contract-simulate-approval');
  let approved = null, workspace = null, constructionHandler = null, active = null, generation = 0, busy = false;
  const handoff = () => {try {return getHandoff();} catch {return null;}};
  const binding = () => settlementBinding(handoff());
  const matching = () => approved && matchesContractBinding(approved.mapBinding,binding());
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
      approved = {input,mapBinding:{...current},packageId:value.packageId,simulated:value.simulated === true,demoScope:value.demoScope,demoParcelId:value.demoParcelId,demoTarget:value.demoTarget ?? 'representative'};
      write(value.simulated ? 'Demo negotiation approved · no call was placed' : 'Negotiation approved · draft ready');refresh();
    } catch (error) {invalidate();throw error;}
  }
  function open({review = false} = {}) {
    if (!matching()) {invalidate();throw new Error('Approve the current route before opening contracts.');}
    let storage;try {storage = window.localStorage;} catch {storage = null;}
    if (!workspace) {
      workspace = createContractWorkspace({storage,isCurrent:() => Boolean(matching()),api:(...args) => {
        if (!matching()) return Promise.reject(new Error('The map approval changed.'));
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
  button?.addEventListener('click',() => {try {open();} catch (error) {write(error.message);}});
  simulate?.addEventListener('click',() => {prepareAndOpen().catch(error => write(error.message));});
  invalidate();
  return {getBinding:binding,setNegotiation,invalidate,refresh,open,prepareAndOpen,
    setAgreement(value) {setNegotiation({...value,input:contractSourceFromAgreement(value.agreement,handoff())});},
    setConstructionHandler(handler) {
      if (handler !== null && typeof handler !== 'function') throw new Error('Construction handler must be a function or null.');
      constructionHandler = handler;workspace?.setConstructionHandler(handler);
    },
    reportConstructionComplete:result => workspace ? workspace.reportConstructionComplete(result) : Promise.reject(new Error('Open the current contract package first.')),
    close:() => workspace?.close()};
}
