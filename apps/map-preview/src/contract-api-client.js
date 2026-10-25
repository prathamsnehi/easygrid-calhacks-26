/** Same-origin development adapter. Replace this boundary when the shared service is ready. */
export function createContractAPIClient({fetcher = globalThis.fetch, packageId = null, demoScope = null, demoParcelId = null} = {}) {
  return async (operation, draft, extra = {}) => {
    if (!['state','sign/utility','sign/landowner','submit','reconcile','reject','construction-complete'].includes(operation)) throw new Error('Unknown contract operation.');
    let response;
    try { response = await fetcher(`/api/contracts/${operation}`, {method:'POST', headers:{'content-type':'application/json','x-easygrid-demo':'1'},
      body:JSON.stringify({draft, ...extra, ...(packageId ? {packageId} : {}), ...(demoScope === 'single-owner' ? {demoScope,demoParcelId} : {})})}); }
    catch { throw new Error('The contract service is unavailable. Use the local development server to sign and submit.'); }
    let result;
    try { result = await response.json(); } catch { throw new Error('The contract service returned an invalid response.'); }
    if (!response.ok) throw new Error(result.error ?? 'The contract operation was rejected.');
    if (result.draftId !== draft.id || typeof result.documentHash !== 'string' || !result.signatures || !Array.isArray(result.audit)) throw new Error('The contract service returned an unbound result.');
    if (packageId && result.packageId !== packageId) throw new Error('The contract service returned a different map package.');
    if (demoScope === 'single-owner' && (result.demoScope !== demoScope || result.demoParcelId !== demoParcelId)) throw new Error('The service did not confirm the representative demo contract. Refresh the updated local server.');
    return result;
  };
}

export async function approveMapContracts(context, {fetcher = globalThis.fetch, signal} = {}) {
  let response;
  try {response = await fetcher('/api/contracts/approve-map',{method:'POST',headers:{'content-type':'application/json','x-easygrid-demo':'1'},body:JSON.stringify({context,demoScope:'single-owner'}),signal});}
  catch {throw new Error('The development approval service is unavailable. Open the app through its local server.');}
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'The map negotiation could not be approved.');
  if (result.simulated !== true || !/^map-contract-[a-f0-9]{40}$/.test(result.packageId)) throw new Error('The development service returned an invalid approved package.');
  if (result.demoScope !== 'single-owner' || typeof result.demoParcelId !== 'string' || !result.input?.parcels?.some(parcel => parcel.parcelId === result.demoParcelId)) throw new Error('The local server does not support the representative contract demo yet. Open the updated server and try again.');
  return result;
}
