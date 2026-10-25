import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractWorkflow, createWorkflowState, createDemoBank, paymentMayHaveBeenAttempted, DEMO_ACTORS} from './contract-workflow.mjs';
import {createNessieSandboxBank} from './nessie-sandbox.mjs';
import {createMapContractService} from './map-contracts.mjs';

export async function createContractAPI({environment = process.env, stateURL = new URL('../.local/full-contract-ledger.json', import.meta.url), fetcher = fetch, resolveNegotiation, resolveProposal} = {}) {
  const port = Number(environment.EASYGRID_PREVIEW_PORT ?? 4177);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port.');
  const provider = environment.EASYGRID_PAYMENT_PROVIDER ?? 'simulation';
  if (!['simulation','nessie'].includes(provider)) throw new Error('Unknown development payment provider.');
  let bank;
  if (provider === 'nessie') {
    bank = createNessieSandboxBank({apiKey:environment.NESSIE_API_KEY, baseUrl:environment.NESSIE_API_ORIGIN,
      payerId:environment.NESSIE_PAYER_ACCOUNT_ID, recipients:JSON.parse(environment.NESSIE_OWNER_RECIPIENTS ?? '{}'),
      allowTransfers:environment.NESSIE_ALLOW_SANDBOX_TRANSFERS === 'yes',fetcher});
  } else bank = createDemoBank();
  // Providers use separate ledgers so a local simulated payment cannot be mistaken for Nessie evidence.
  const target = new URL(provider === 'nessie' ? 'nessie-full-contract-ledger.json' : 'full-contract-ledger.json', stateURL);
  if (provider === 'nessie') {
    // The full-payment fixture has a new session ID. Changing its filename must
    // never conceal an earlier external side effect for these same demo owners.
    let legacy;
    try { legacy = JSON.parse(await readFile(new URL('nessie-contract-ledger.json',stateURL),'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('The legacy Nessie ledger could not be loaded. Preserve it for review before using full payments.'); }
    if (legacy !== undefined) {
      if (!legacy || legacy.schemaVersion !== 1 || !legacy.obligations || typeof legacy.obligations !== 'object' || Array.isArray(legacy.obligations) || !Array.isArray(legacy.journal)) throw new Error('The legacy Nessie ledger is invalid. Preserve it for review before using full payments.');
      if (legacy.journal.length || Object.entries(legacy.obligations).some(([id,payment]) => !payment || paymentMayHaveBeenAttempted({...payment,id:payment.id ?? id},legacy.journal))) {
        throw new Error('The legacy Nessie fixture has a payment attempt. Preserve and reconcile that ledger before starting full compensation payments.');
      }
    }
  }
  let initialState;
  try { initialState = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The local development ledger could not be loaded. Preserve it for review.'); initialState = createWorkflowState(); }
  if (initialState.bankMode && initialState.bankMode !== bank.mode) throw new Error('The contract ledger belongs to a different payment provider.');
  if (!initialState.bankMode && bank.mode !== 'simulation' && (Object.keys(initialState.documents ?? {}).length || Object.keys(initialState.obligations ?? {}).length)) throw new Error('An untagged contract ledger cannot establish Nessie payment evidence.');
  const bankIdentity = bank.storageNamespace ?? null;
  if (initialState.bankIdentity !== undefined && initialState.bankIdentity !== bankIdentity) throw new Error('The contract ledger belongs to a different bank identity. Preserve it and use the original bank configuration.');
  if (initialState.bankIdentity === undefined && bankIdentity !== null && (Object.keys(initialState.documents ?? {}).length || Object.keys(initialState.obligations ?? {}).length)) throw new Error('The contract ledger has no verified bank identity. Preserve it for review.');
  initialState.bankMode = bank.mode;
  initialState.bankIdentity = bankIdentity;
  const workflow = createContractWorkflow({source:createContractExample(), bank, initialState, persist:async state => {
    await mkdir(new URL('./', target), {recursive:true});
    const temporary = new URL(`${target.pathname.split('/').at(-1)}.tmp`, target);
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {mode:0o600});
    await rename(temporary, target);
  }});
  const mapService = await createMapContractService({
    resolveNegotiation,resolveProposal,
    stateURL:new URL(provider === 'nessie' ? 'nessie-map-contracts.json' : 'map-contracts.json',stateURL),
    ...(provider === 'nessie' ? {bank} : {}),
  });
  const reply = (res, status, data) => res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}).end(JSON.stringify(data));
  const handler = async (req, res, pathname) => {
    if (!pathname.startsWith('/api/contracts/')) return false;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { reply(res,403,{error:'Local development host required.'}); return true; }
    if (req.method === 'GET' && pathname === '/api/contracts/example') {
      reply(res,200,{simulated:true,source:createContractExample()}); return true;
    }
    if (req.method === 'GET' && pathname === '/api/contracts/config') {
      reply(res,200,{bankMode:bank.mode,paymentSemantics:bank.paymentSemantics,amountIncrementCents:bank.amountIncrementCents,paymentsEnabled:bank.canTransfer !== false,actorMode:'distinct simulated roles; no production authentication', storage:'local development ledger; not SpacetimeDB', agentMode:'rule-based-event-worker'}); return true;
    }
    if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json') || req.headers['x-easygrid-demo'] !== '1' ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) { reply(res,403,{error:'Same-origin development requests are required.'}); return true; }
    let input;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 256000) throw new Error('Too large.'); chunks.push(chunk); }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { reply(res,400,{error:'Invalid contract request.'}); return true; }
    try {
      if (pathname === '/api/contracts/approve-map') {
        if (Object.keys(input).some(key => !['context','demoScope','demoTarget','negotiationRef'].includes(key))) throw new Error('Contract approval accepts route context and a saved reference, never browser-approved money.');
        const approved = await handler.approveMap(input.context,{demoScope:input.demoScope,demoTarget:input.demoTarget,negotiationRef:input.negotiationRef}); reply(res,200,approved); return true;
      }
      const dispatch = async workflow => {
        let result;
        if (pathname === '/api/contracts/state') result = await workflow.inspect(input.draft);
        else if (pathname === '/api/contracts/sign/utility') result = await workflow.sign(input.draft, 'utility', DEMO_ACTORS.utility);
        else if (pathname === '/api/contracts/sign/landowner') result = await workflow.sign(input.draft, 'landowner', DEMO_ACTORS.landowner);
        else if (pathname === '/api/contracts/submit') {
          if (!['normal','recipient-changed','bank-mismatch','insufficient-funds'].includes(input.scenario ?? 'normal')) throw new Error('Unknown development scenario.');
          result = await workflow.submit(input.draft, DEMO_ACTORS.requester, {scenario:input.scenario ?? 'normal', stage:input.stage ?? 'full'});
        }
        else if (pathname === '/api/contracts/construction-complete') result = await workflow.completeConstruction(input.draft, input.completion, DEMO_ACTORS.construction);
        else if (pathname === '/api/contracts/reconcile') result = await workflow.reconcile(input.draft, DEMO_ACTORS.requester, {stage:input.stage ?? 'full'});
        else if (pathname === '/api/contracts/reject') result = await workflow.reject(input.draft, DEMO_ACTORS.utility, {stage:input.stage ?? 'full'});
        else throw new Error('Unknown contract operation.');
        return result;
      };
      if (input.packageId !== undefined && (typeof input.packageId !== 'string' || !/^map-contract-[a-f0-9]{40}$/.test(input.packageId))) throw new Error('Invalid approved map package.');
      if (!input.packageId && (input.demoScope != null || input.demoParcelId != null)) throw new Error('A single-owner demo requires its approved map package.');
      const result = input.packageId ? await mapService.execute(input.packageId,dispatch,{demoScope:input.demoScope ?? null,demoParcelId:input.demoParcelId ?? null,reconciliation:pathname === '/api/contracts/reconcile'}) : await dispatch(workflow);
      reply(res,200,{...result,paymentsEnabled:bank.canTransfer !== false});
    } catch (error) {
      // Only our own validation messages are returned; upstream keys, URLs and raw payloads never cross this boundary.
      reply(res,409,{error:error.message?.startsWith('Nessie') ? 'The sandbox could not confirm this operation.' : error.message ?? 'The contract operation was rejected.'});
    }
    return true;
  };
  // In-process coordinators use exactly the HTTP approval service and ledger queue.
  handler.approveMap = (context, options) => mapService.approve(context,options);
  return handler;
}
