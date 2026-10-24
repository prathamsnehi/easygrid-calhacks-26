import {contractSourceKey, normalizeContractSource} from './contract-authoring.js';
import {createContractWorkspace} from './contract-workspace.js';
import {settlementBinding} from './settlement-controller.js';

/** Fixture-only integration hook. The final authoritative negotiation schema is intentionally deferred. */
export function createContractEntry({getHandoff}) {
  const button = document.querySelector('#contract-proceed'), status = document.querySelector('#contract-entry-status');
  let approved = null, workspace = null;
  const binding = () => settlementBinding(getHandoff());
  const matching = () => approved && JSON.stringify(approved.mapBinding) === JSON.stringify(binding());
  function invalidate() { approved = null; button.disabled = true; status.textContent = 'Awaiting approved negotiation'; workspace?.invalidate(); }
  function setNegotiation(value) {
    if (!value) { invalidate(); return; }
    try {
      const current = binding(), input = normalizeContractSource(value.input);
      if (!current || getHandoff()?.snapshot?.routes?.[0]?.eligible !== true ||
        !['sessionId','routeId','routeVersion','proposalKey'].every(key => value.mapBinding?.[key] === current[key])) throw new Error('The negotiation does not match the displayed route.');
      const changed = approved && (contractSourceKey(input) !== contractSourceKey(approved.input) || JSON.stringify(current) !== JSON.stringify(approved.mapBinding));
      if (changed) workspace?.invalidate();
      approved = {input, mapBinding: {...current}}; button.disabled = false; status.textContent = 'Negotiation approved · draft ready';
    } catch (error) { invalidate(); throw error; }
  }
  button.addEventListener('click', () => {
    if (!matching()) { invalidate(); return; }
    let storage; try { storage = window.localStorage; } catch { storage = null; }
    workspace ??= createContractWorkspace({storage, isCurrent: () => Boolean(matching())});
    workspace.open(approved.input);
  });
  invalidate();
  return {getBinding: binding, setNegotiation, invalidate};
}
