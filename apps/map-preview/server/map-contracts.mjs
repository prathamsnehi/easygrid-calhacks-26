import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorld} from '../src/world.js';
import {createPlacement} from '../src/placement.js';
import {computeTransmissionRoutes} from '../src/routing.js';
import {normalizeRoutingConstraints} from '../src/routing-constraints.js';
import {analyzeRouteParcels} from '../src/parcel-analysis.js';
import {createHandoff} from '../src/handoff.js';
import {settlementBinding} from '../src/settlement-controller.js';
import {contractSourceFromAgreement, simulatedMapAgreement, matchesContractBinding} from '../src/contract-handoff.js';
import {createContractWorkflow, createDemoBank, createWorkflowState} from './contract-workflow.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const requireState = (condition, message) => {if (!condition) throw new Error(message);};

/** Recompute from the team's trusted geometry/prices, never from browser-provided money. */
export function reconstructMapProposal(context, world = createWorld()) {
  const keys = ['sessionId','routeId','routeVersion','userParcelId','substation','datacenter','mapBinding'];
  requireState(context && keys.every(key => Object.hasOwn(context,key)) && Object.keys(context).every(key => keys.includes(key) || key === 'routingConstraints') &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(context.sessionId) && typeof context.routeId === 'string' &&
    Number.isSafeInteger(context.routeVersion) && context.routeVersion > 0, 'A valid public map context is required.');
  for (const kind of ['substation','datacenter']) requireState(context[kind] && Object.keys(context[kind]).length === 2 &&
    ['x','z'].every(key => Number.isInteger(context[kind][key]) && Math.abs(context[kind][key]) < 1000), 'Invalid facility placement.');
  const substation = createPlacement(world,'substation',context.substation.x,context.substation.z);
  const datacenter = createPlacement(world,'datacenter',context.datacenter.x,context.datacenter.z,{substation});
  requireState(substation && datacenter, 'Facility placements do not match the map fixture.');
  const supplied = context.routingConstraints ?? {};
  requireState(supplied && typeof supplied === 'object' && !Array.isArray(supplied) && Object.keys(supplied).every(key => ['blockedParcelIds','blockedTowerParcelIds','exclusionZones'].includes(key)), 'Invalid public routing restrictions.');
  const restrictions = normalizeRoutingConstraints(world,supplied);
  const placements = {substation,datacenter}, result = computeTransmissionRoutes(world,placements,restrictions);
  const route = result.candidates?.find(r => r.id === context.routeId);
  requireState(result.status === 'ok' && route && (route.parcelIds.includes(context.userParcelId) ||
    restrictions.blockedParcelIds.includes(context.userParcelId) && computeTransmissionRoutes(world,placements).candidates.some(candidate => candidate.parcelIds.includes(context.userParcelId))), 'Select a current route with its original affected participant parcel.');
  requireState(!route.parcelIds.some(id => restrictions.blockedParcelIds.includes(id)), 'A refused parcel cannot receive a contract.');
  const handoff = createHandoff({world,route,placements,analysis:analyzeRouteParcels(world,route,result.assumptions),
    sessionId:context.sessionId,routeVersion:context.routeVersion,userParcelId:context.userParcelId});
  requireState(handoff.snapshot.routes[0].eligible === true && matchesContractBinding(settlementBinding(handoff), context.mapBinding), 'The route, costs, owners or recipient data changed. Recalculate before approval.');
  return handoff;
}

/** Local fixture registry. Production replaces this boundary with Pratham's atomic shared store. */
export async function createMapContractService({stateURL, bank:configuredBank, now = () => new Date().toISOString()}) {
  const bankMode = configuredBank?.mode ?? 'simulation';
  const bankIdentity = configuredBank?.storageNamespace ?? null;
  requireState(['simulation','nessie-sandbox'].includes(bankMode), 'Unsupported map payment provider.');
  let state;
  try {state = JSON.parse(await readFile(stateURL,'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw new Error('Preserve the unreadable map contract ledger for review.');state = {schemaVersion:2,bankMode,bankIdentity,packages:{},current:{}};}
  // Untagged registries predate provider integration and contain local simulation only.
  if (state.schemaVersion === 1 && !state.bankMode && bankMode === 'simulation') {
    for (const record of Object.values(state.packages ?? {})) record.recipientBindingVersion = 1;
    state = {...state,schemaVersion:2,bankMode,bankIdentity};
  }
  requireState(state.schemaVersion === 2 && state.packages && state.current, 'Invalid map contract registry.');
  requireState(state.bankMode === bankMode, 'The map ledger belongs to a different payment provider. Preserve it and use a separate ledger.');
  requireState((state.bankIdentity ?? null) === bankIdentity, 'The map ledger belongs to a different bank identity. Preserve it and use the original bank configuration.');
  const world = createWorld(), workers = new Map(); let queue = Promise.resolve();
  const serial = action => {const result = queue.then(action);queue = result.catch(() => {});return result;};
  const save = async () => {
    await mkdir(new URL('./',stateURL),{recursive:true});
    const temporary = new URL(`${stateURL.pathname.split('/').at(-1)}.tmp`,stateURL);
    await writeFile(temporary,JSON.stringify(state) + '\n',{mode:0o600});
    // Windows sync/indexing tools may briefly lock the existing destination.
    for (let attempt = 0; ; attempt++) {
      try {await rename(temporary,stateURL);break;}
      catch (error) {if (!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 5) throw error;await delay(25 * 2 ** attempt);}
    }
  };
  const response = record => copy({packageId:record.packageId,input:record.source,mapBinding:record.agreement.mapBinding,agreement:record.agreement,
    simulated:true,bankMode,paymentsEnabled:configuredBank?.canTransfer !== false});
  const worker = record => {
    if (workers.has(record.packageId)) return workers.get(record.packageId);
    const bank = configuredBank ?? createDemoBank();
    const recipients = new Map(record.agreement.ownerHandoff.owners.map(owner => [owner.ownerId,owner.banking.paymentRecipientRef]));
    const boundBank = {...bank,recipientBinding:ownerId => {
      requireState(recipients.has(ownerId),'The approved fictional owner has no recipient.');
      if (record.recipientBindingVersion === 1 && bankMode === 'simulation') return digest([ownerId,recipients.get(ownerId)]);
      return digest([ownerId,recipients.get(ownerId),bank.recipientBinding(ownerId)]);
    }};
    workers.set(record.packageId,createContractWorkflow({source:record.source,bank:boundBank,
      initialState:record.ledger,persist:async ledger => {record.ledger=ledger;await save();},now}));
    return workers.get(record.packageId);
  };
  return {
    approve: context => serial(async () => {
      const handoff = reconstructMapProposal(context,world), mapBinding = settlementBinding(handoff);
      const packageId = `map-contract-${digest(mapBinding).slice(0,40)}`, previous = state.packages[state.current[context.sessionId]];
      if (previous?.packageId === packageId) return response(previous);
      requireState(!previous || !Object.values(previous.ledger.obligations).some(p => !['held','rejected'].includes(p.status)), 'This session already has a payment attempt. Reconcile it before changing the route or package.');
      requireState(!previous || context.routeVersion > previous.source.route.version, 'A changed proposal requires a newer route version.');
      const agreement = simulatedMapAgreement(handoff,{negotiationId:`neg-${digest(mapBinding).slice(0,32)}`,approvedAt:now()});
      const source = contractSourceFromAgreement(agreement,handoff);
      const record = {packageId,source,agreement,recipientBindingVersion:2,ledger:createWorkflowState()};
      state.packages[packageId]=record;state.current[context.sessionId]=packageId;
      try {await save();}
      catch (error) {
        delete state.packages[packageId];
        if (previous) state.current[context.sessionId]=previous.packageId;else delete state.current[context.sessionId];
        throw error;
      }
      return response(record);
    }),
    execute: (packageId, action) => serial(async () => {
      const record = Object.hasOwn(state.packages,packageId) ? state.packages[packageId] : null;
      requireState(record && state.current[record.source.sessionId] === packageId, 'The approved map package is missing or superseded. Approve the current route first.');
      const workflow = worker(record), result = await action(workflow);
      // Even idempotent replays must durably save a previous interrupted write.
      record.ledger = workflow.snapshot();await save();return {...result,packageId};
    }),
  };
}
