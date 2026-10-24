import {createContractWorkspace} from './contract-workspace.js';
import {createContractExample} from './contract-fixtures.js';

let storage;
try { storage = window.localStorage; } catch { storage = null; }
const workspace = createContractWorkspace({storage});
workspace.open(createContractExample(), {demo: true});
document.querySelector('#cg-example-status').addEventListener('change', event => workspace.setSource(createContractExample(event.target.value)));
window.easygridContractDemo = Object.freeze({
  /** Temporary fixture boundary; deliberately rejects non-fixture sources. */
  setExample: input => workspace.setSource(input),
});
