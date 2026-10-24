import {createContractWorkspace} from './contract-workspace.js';
import {createContractExample} from './contract-fixtures.js';

let storage;
try { storage = window.localStorage; } catch { storage = null; }
const workspace = createContractWorkspace({storage});
const picker = document.querySelector('#cg-example-status');
let approvedExample = null;
workspace.open(createContractExample('pending'), {demo: true});
picker.disabled = true;
document.querySelector('#cg-gate-title').textContent = 'Loading your example agreement…';
document.querySelector('#cg-gate-copy').textContent = 'Fetching the approved fictional terms from the local demo service.';
async function loadExample() {
  try {
    const response = await fetch('/api/contracts/example');
    const result = await response.json();
    if (!response.ok || result.simulated !== true || result.source?.negotiation?.status !== 'approved') throw new Error('Invalid example.');
    approvedExample = result.source;
    workspace.setSource(approvedExample);
    picker.value = 'approved'; picker.disabled = false;
    workspace.review();
  } catch {
    document.querySelector('#cg-gate-title').textContent = 'The example service is unavailable.';
    document.querySelector('#cg-gate-copy').textContent = 'Start the QuickGrid development server, then refresh this page to load the approved example.';
  }
}
loadExample();
picker.addEventListener('change', event => {
  if (!approvedExample) return;
  const source = JSON.parse(JSON.stringify(approvedExample)), status = event.target.value;
  source.negotiation.status = status;
  source.negotiation.approvedAt = status === 'approved' ? approvedExample.negotiation.approvedAt : null;
  for (const parcel of source.parcels) parcel.accepted = status === 'approved';
  workspace.setSource(source);
  if (status === 'approved') workspace.review();
});
window.easygridContractDemo = Object.freeze({
  setExample: input => workspace.setSource(input),
  setConstructionHandler: handler => workspace.setConstructionHandler(handler),
  reportConstructionComplete: result => workspace.reportConstructionComplete(result),
});
