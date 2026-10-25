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
import {createContractWorkflow, createDemoBank, createWorkflowState, paymentMayHaveBeenAttempted} from './contract-workflow.mjs';
import {agreementFromNegotiation, validateNegotiationRef} from './negotiated-contracts.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const requireState = (condition, message) => {if (!condition) throw new Error(message);};

function validatePublicContext(context) {
  const keys = ['sessionId','routeId','routeVersion','userParcelId','substation','datacenter','mapBinding'];
  requireState(context && keys.every(key => Object.hasOwn(context,key)) && Object.keys(context).every(key => keys.includes(key) || key === 'routingConstraints') &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(context.sessionId) && typeof context.routeId === 'string' &&
    Number.isSafeInteger(context.routeVersion) && context.routeVersion > 0, 'A valid public map context is required.');
  for (const kind of ['substation','datacenter']) requireState(context[kind] && Object.keys(context[kind]).length === 2 &&
    ['x','z'].every(key => Number.isInteger(context[kind][key]) && Math.abs(context[kind][key]) < 1000), 'Invalid facility placement.');
  const supplied = context.routingConstraints ?? {};
  requireState(supplied && typeof supplied === 'object' && !Array.isArray(supplied) && Object.keys(supplied).every(key => ['blockedParcelIds','blockedTowerParcelIds','exclusionZones'].includes(key)), 'Invalid public routing restrictions.');
}

/** Recompute from the team's trusted geometry/prices, never from browser-provided money. */
export function reconstructMapProposal(context, world = createWorld()) {
  validatePublicContext(context);
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
export async function createMapContractService({stateURL, bank:configuredBank, resolveNegotiation, resolveProposal, now = () => new Date().toISOString(), stateStore}) {
  const bankMode = configuredBank?.mode ?? 'simulation';
  const bankIdentity = configuredBank?.storageNamespace ?? null;
  requireState(['simulation','nessie-sandbox'].includes(bankMode), 'Unsupported map payment provider.');
  requireState(resolveProposal == null || typeof resolveProposal === 'function','The proposal resolver must be a trusted server function.');
  let state;
  try {state = stateStore ? await stateStore.read(stateURL) : JSON.parse(await readFile(stateURL,'utf8'));}
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
    if (stateStore) return stateStore.write(stateURL,state);
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
    ...(record.negotiationRef ? {approvalMode:'negotiated',negotiationRef:record.negotiationRef} : {}),
    // This labels the approval source only. Geometry, click signatures and bank
    // simulation remain separately identified in the source/workflow/provider.
    simulated:!record.negotiationRef,bankMode,demoScope:record.demoScope ?? null,demoParcelId:record.demoParcelId ?? null,demoTarget:record.demoTarget ?? (record.demoScope === 'single-owner' ? 'representative' : null),paymentSemantics:configuredBank?.paymentSemantics ?? 'simulated-transfer',amountIncrementCents:configuredBank?.amountIncrementCents ?? 1,paymentsEnabled:configuredBank?.canTransfer !== false});
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
      initialState:record.ledger,demoParcelId:record.demoParcelId ?? null,persist:async ledger => {record.ledger=ledger;await save();},now}));
    return workers.get(record.packageId);
  };
  function scopeFor(source, demoScope, demoTarget, context) {
    requireState(demoScope === undefined || demoScope === null || demoScope === 'single-owner','Unknown contract demo scope.');
    requireState(demoTarget === undefined || demoTarget === null || demoTarget === 'representative' || demoTarget === 'participant','Unknown contract demo target.');
    requireState(demoTarget == null || demoScope === 'single-owner','A demo target requires a single-owner contract scope.');
    if (demoScope !== 'single-owner') return {demoScope:null,demoParcelId:null,demoTarget:null};
    const target = demoTarget ?? 'representative';
    let parcel;
    if (target === 'participant') {
      // The public context is already reconstructed and binding-checked. A refused
      // participant may remain in that context, but cannot approve the rerouted land.
      parcel = source.parcels.find(parcel => parcel.parcelId === context.userParcelId);
      requireState(parcel && !(context.routingConstraints?.blockedParcelIds ?? []).includes(parcel.parcelId),
        'The current participant must be an unblocked landowner on the approved route.');
    } else parcel = source.parcels.find(parcel => parcel.parcelId === 'L017') ?? source.parcels.find(parcel => parcel.compensationCents % 100 === 0) ?? source.parcels[0];
    requireState(parcel,'The approved route has no demo landowner.');
    return {demoScope:'single-owner',demoParcelId:parcel.parcelId,demoTarget:target};
  }
  function assertScopePreservesAttempts(record, scope) {
    if (!scope.demoParcelId) return;
    const journalIds = new Set(record.ledger.journal.map(row => row.obligationId));
    const attempts = Object.entries(record.ledger.obligations).filter(([id,payment]) => paymentMayHaveBeenAttempted({...payment,id:payment.id ?? id},record.ledger.journal));
    requireState(!attempts.some(([id,payment]) => payment.parcelId !== scope.demoParcelId) &&
      [...journalIds].every(id => record.ledger.obligations[id]?.parcelId === scope.demoParcelId),
      'Other landowner payment attempts require review before switching this package to a single-owner demo. Preserve the current package and reconcile those outcomes.');
  }
  async function resolveAgreement(context, handoff, reference) {
    const negotiationRef = validateNegotiationRef(reference);
    requireState(typeof resolveNegotiation === 'function','The authoritative negotiation source is not connected. The saved result cannot yet authorize a contract.');
    let trusted;
    try {trusted = await resolveNegotiation({context:copy(context),negotiationRef:copy(negotiationRef)});}
    catch {throw new Error('The authoritative negotiation could not be confirmed. Reconnect before continuing.');}
    return agreementFromNegotiation(trusted,handoff,negotiationRef);
  }
  async function proposalFor(context) {
    if (!resolveProposal) return reconstructMapProposal(context,world);
    validatePublicContext(context);
    normalizeRoutingConstraints(world,context.routingConstraints ?? {});
    let resolved;
    try {resolved = await resolveProposal(copy(context));}
    catch {throw new Error('The authoritative map proposal could not be confirmed. Reopen the current route before continuing.');}
    // The trusted coordinator may also return route/placement evidence for its UI.
    // Only its verified handoff enters contract authoring, never browser geometry.
    const handoff = resolved?.handoff ?? resolved, binding = settlementBinding(handoff);
    requireState(handoff?.snapshot?.routes?.[0]?.eligible === true && handoff.ownerHandoff?.simulationChecksPassed === true &&
      matchesContractBinding(binding,context?.mapBinding) && ['sessionId','routeId','routeVersion'].every(key=>context[key] === binding[key]) &&
      handoff.userRole?.parcelId === context.userParcelId,
      'The authoritative proposal no longer matches this route, participant or payment binding.');
    return handoff;
  }
  return {
    approve: (context, {demoScope,demoTarget,negotiationRef} = {}) => serial(async () => {
      const handoff = await proposalFor(context), mapBinding = settlementBinding(handoff);
      const packageId = `map-contract-${digest(mapBinding).slice(0,40)}`, previous = state.packages[state.current[context.sessionId]];
      const negotiated = negotiationRef !== undefined;
      const reference = negotiated ? validateNegotiationRef(negotiationRef) : null;
      requireState(typeof resolveNegotiation !== 'function' || negotiated,'This server uses authoritative negotiation results. A saved result reference is required; simulation cannot replace it.');
      requireState(!negotiated || demoScope === 'single-owner' && demoTarget === 'participant','A saved negotiation requires the current participant contract scope.');
      const resolvedAgreement = negotiated ? await resolveAgreement(context,handoff,reference) : null;
      const resolvedSource = resolvedAgreement ? contractSourceFromAgreement(resolvedAgreement,handoff) : null;
      if (previous?.packageId === packageId) {
        requireState(!previous.negotiationRef || negotiated,'This package uses saved negotiated terms. Reopen its current saved result; simulation cannot replace it.');
        const scope = scopeFor(resolvedSource ?? previous.source,demoScope,demoTarget,context);
        assertScopePreservesAttempts(previous,scope);
        const negotiatedChanged = resolvedSource && (digest(resolvedSource) !== digest(previous.source) || digest(reference) !== digest(previous.negotiationRef ?? null));
        requireState(!negotiatedChanged || (!Object.values(previous.ledger.obligations).some(p => paymentMayHaveBeenAttempted(p,previous.ledger.journal)) && !previous.ledger.journal.length),
          'This session already has a payment attempt. Preserve and reconcile it before changing the agreed terms.');
        const sourceChanged = negotiatedChanged || previous.source.paymentSchedule !== 'full-after-signatures' || previous.source.project.developerName !== 'EasyGrid';
        const scopeChanged = (previous.demoScope ?? null) !== scope.demoScope || (previous.demoParcelId ?? null) !== scope.demoParcelId || (previous.demoTarget ?? null) !== scope.demoTarget;
        if (sourceChanged || scopeChanged) {
          const priorSource = previous.source, priorScope = {demoScope:previous.demoScope,demoParcelId:previous.demoParcelId,demoTarget:previous.demoTarget}, priorAgreement = previous.agreement,
            priorRef = previous.negotiationRef, priorContext = previous.negotiationContext;
          previous.source = resolvedSource ?? {...priorSource,paymentSchedule:'full-after-signatures',project:{...priorSource.project,developerName:'EasyGrid'}};
          if (resolvedAgreement) {previous.agreement=resolvedAgreement;previous.negotiationRef=validateNegotiationRef(negotiationRef);previous.negotiationContext=copy(context);}
          Object.assign(previous,scope);
          try {await save();}
          catch (error) {previous.source=priorSource;previous.agreement=priorAgreement;previous.negotiationRef=priorRef;previous.negotiationContext=priorContext;Object.assign(previous,priorScope);throw error;}
          // approve and execute share this queue, so no in-flight worker is evicted.
          workers.delete(previous.packageId);
        }
        return response(previous);
      }
      requireState(!previous || (!Object.values(previous.ledger.obligations).some(p => paymentMayHaveBeenAttempted(p,previous.ledger.journal)) && !previous.ledger.journal.length), 'This session already has a payment attempt. Reconcile it before changing the route or package.');
      requireState(!previous || context.routeVersion > previous.source.route.version, 'A changed proposal requires a newer route version.');
      const agreement = resolvedAgreement ?? simulatedMapAgreement(handoff,{negotiationId:`neg-${digest(mapBinding).slice(0,32)}`,approvedAt:now()});
      const source = resolvedSource ?? contractSourceFromAgreement(agreement,handoff);
      const record = {packageId,source,agreement,...scopeFor(source,demoScope,demoTarget,context),recipientBindingVersion:2,ledger:createWorkflowState(),
        ...(negotiated ? {negotiationRef:validateNegotiationRef(negotiationRef),negotiationContext:copy(context)} : {})};
      state.packages[packageId]=record;state.current[context.sessionId]=packageId;
      try {await save();}
      catch (error) {
        delete state.packages[packageId];
        if (previous) state.current[context.sessionId]=previous.packageId;else delete state.current[context.sessionId];
        throw error;
      }
      return response(record);
    }),
    execute: (packageId, action, {demoScope = null,demoParcelId = null,reconciliation = false} = {}) => serial(async () => {
      const record = Object.hasOwn(state.packages,packageId) ? state.packages[packageId] : null;
      requireState(record && state.current[record.source.sessionId] === packageId, 'The approved map package is missing or superseded. Approve the current route first.');
      requireState((record.demoScope ?? null) === demoScope && (record.demoParcelId ?? null) === demoParcelId, 'The contract demo scope changed. Reopen the approved package before continuing.');
      if (record.negotiationRef && !reconciliation) {
        const handoff = await proposalFor(record.negotiationContext);
        const currentAgreement = await resolveAgreement(record.negotiationContext,handoff,record.negotiationRef);
        requireState(digest(contractSourceFromAgreement(currentAgreement,handoff)) === digest(record.source), 'The agreed terms changed. Reopen the current saved negotiation before continuing.');
      }
      const workflow = worker(record), result = await action(workflow);
      // Even idempotent replays must durably save a previous interrupted write.
      record.ledger = workflow.snapshot();await save();return {...result,packageId};
    }),
  };
}
