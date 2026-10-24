import {contractSourceKey, normalizeContractSource} from './contract-authoring.js';
import {createContractWorkspace} from './contract-workspace.js';
import {settlementBinding} from './settlement-controller.js';
import {contractSourceFromAgreement, mapContractRequest, matchesContractBinding} from './contract-handoff.js';
import {approveMapContracts, createContractAPIClient} from './contract-api-client.js';

/** Fixture-only integration hook. The final authoritative negotiation schema is intentionally deferred. */
export function createContractEntry({getHandoff, getPlacements = () => null, requestApproval = approveMapContracts, apiFactory = createContractAPIClient}) {
  const button = document.querySelector('#contract-proceed'), status = document.querySelector('#contract-entry-status');
  const simulate = document.querySelector('#contract-simulate-approval');
  let approved = null, workspace = null, constructionHandler = null, active = null, generation = 0, busy = false;
  const handoff = () => {try {return getHandoff();} catch {return null;}};
  const binding = () => settlementBinding(handoff());
  const matching = () => approved && matchesContractBinding(approved.mapBinding,binding());
  function refresh() {
    const current = handoff();
    simulate.disabled = busy || current?.snapshot?.routes?.[0]?.eligible !== true;
    button.disabled = busy || !matching();
    simulate.textContent = busy ? 'Approving demo terms…' : matching() ? 'Demo negotiation approved' : 'Simulate approved negotiation';
  }
  function invalidate() {
    generation++;active?.abort();active = null;busy = false;approved = null;
    button.disabled = true; status.textContent = 'Awaiting approved negotiation'; workspace?.invalidate();refresh();
  }
  function setNegotiation(value) {
    if (!value) { invalidate(); return; }
    try {
      const current = binding(), input = normalizeContractSource(value.input);
      const packet = handoff()?.ownerHandoff;
      if (!current || handoff()?.snapshot?.routes?.[0]?.eligible !== true ||
        !['sessionId','routeId','routeVersion','proposalKey'].every(key => value.mapBinding?.[key] === current[key])) throw new Error('The negotiation does not match the displayed route.');
      if (input.sessionId !== packet.sessionId || input.route.id !== packet.routeId || input.route.version !== packet.routeVersion ||
        input.parcels.length !== packet.parcels.length || input.parcels.some(parcel => {
          const original = packet.parcels.find(p => p.parcelId === parcel.parcelId);
          return !original || original.ownerId !== parcel.ownerId || parcel.compensationCents > original.offerCapCents;
        })) throw new Error('The contract inputs must preserve the selected route and affected owners.');
      if (value.agreement && contractSourceKey(contractSourceFromAgreement(value.agreement,handoff())) !== contractSourceKey(input)) throw new Error('The contract source differs from the approved negotiation package.');
      const changed = approved && (contractSourceKey(input) !== contractSourceKey(approved.input) || JSON.stringify(current) !== JSON.stringify(approved.mapBinding));
      if (changed) workspace?.invalidate();
      approved = {input, mapBinding: {...current}, packageId:value.packageId, simulated:value.simulated === true};
      status.textContent = value.simulated ? 'Demo negotiation approved · no call was placed' : 'Negotiation approved · draft ready';refresh();
    } catch (error) { invalidate(); throw error; }
  }
  button.addEventListener('click', () => {
    if (!matching()) { invalidate(); return; }
    let storage; try { storage = window.localStorage; } catch { storage = null; }
    if (!workspace) {
      workspace = createContractWorkspace({storage, isCurrent: () => Boolean(matching()),api:(...args) => {
        if (!matching()) return Promise.reject(new Error('The map approval changed.'));
        return apiFactory({packageId:approved.packageId})(...args);
      }});
      workspace.setConstructionHandler(constructionHandler);
    }
    workspace.open(approved.input,{simulationControls:approved.simulated});
  });
  simulate.addEventListener('click',async () => {
    if (busy || simulate.disabled) return;
    const current = handoff(), context = mapContractRequest(current,getPlacements()), ticket = ++generation;
    const controller = new AbortController();active = controller;busy = true;refresh();
    status.textContent = 'Validating this route and its fictional owner terms…';
    try {
      const result = await requestApproval(context,{signal:controller.signal});
      if (ticket !== generation || controller.signal.aborted) return;
      if (!matchesContractBinding(result.mapBinding,binding())) throw new Error('The route changed before approval arrived.');
      setNegotiation(result);
    } catch (error) {
      if (ticket === generation) {approved = null;status.textContent = error.message;}
    } finally {if (ticket === generation) {busy = false;active = null;refresh();}}
  });
  invalidate();
  return {getBinding: binding, setNegotiation, invalidate, refresh,
    setAgreement(value) {const current = handoff();setNegotiation({...value,input:contractSourceFromAgreement(value.agreement,current)});},
    setConstructionHandler(handler) {
      if (handler !== null && typeof handler !== 'function') throw new Error('Construction handler must be a function or null.');
      constructionHandler = handler; workspace?.setConstructionHandler(handler);
    },
    reportConstructionComplete: result => workspace ? workspace.reportConstructionComplete(result) : Promise.reject(new Error('Open the current contract package first.')),
    close: () => workspace?.close()};
}
