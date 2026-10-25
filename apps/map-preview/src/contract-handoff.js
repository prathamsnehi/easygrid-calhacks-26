import {normalizeContractSource} from './contract-authoring.js';
import {settlementBinding} from './settlement-controller.js';

const copy = value => JSON.parse(JSON.stringify(value));
const requireState = (condition, message) => {if (!condition) throw new Error(message);};
const sameBinding = (a, b) => Boolean(a && b) && ['sessionId','routeId','routeVersion','proposalKey'].every(key => a[key] === b[key]);

/** Public fixture correlation only. Never includes the entered participant or contact. */
export function mapContractRequest(handoff, placements, routingConstraints = null) {
  const binding = settlementBinding(handoff);
  requireState(binding && handoff.sourceMode === 'fixture' && handoff.snapshot.routes[0].eligible === true, 'Select an eligible route before preparing contracts.');
  const point = kind => {
    const value = placements?.[kind];
    requireState(Number.isInteger(value?.x) && Number.isInteger(value?.z), 'Both valid facility placements are required.');
    return {x:value.x,z:value.z};
  };
  return {sessionId:binding.sessionId, routeId:binding.routeId, routeVersion:binding.routeVersion,
    userParcelId:handoff.userRole.parcelId, substation:point('substation'), datacenter:point('datacenter'), mapBinding:binding,
    ...(routingConstraints ? {routingConstraints:copy(routingConstraints)} : {})};
}

/** Consume explicit negotiated acceptance; a scoped approval does not approve the other route parcels. */
export function contractSourceFromAgreement(agreement, handoff) {
  const binding = settlementBinding(handoff), packet = agreement?.ownerHandoff, scope = agreement?.approvalScope;
  requireState(sameBinding(binding, agreement?.mapBinding) && handoff.snapshot.routes[0].eligible === true, 'The approved negotiation does not match the displayed route.');
  requireState(scope === undefined || (scope?.kind === 'single-owner' && typeof scope.parcelId === 'string' && scope.parcelId.length > 0), 'The approval scope must identify one current parcel.');
  requireState(packet?.kind === 'easygrid-owner-handoff' && packet.sourceMode === 'fixture' &&
    (packet.routeStatus === 'ready_for_agreements' || (scope && packet.routeStatus === 'selected_for_negotiation')) &&
    packet.referenceBinding === 'local-fixture', 'A complete approved development agreement packet is required.');
  // Local agreement metadata preserves the exact source of previously signed drafts.
  const contractTermsVersion = agreement.contractTermsVersion === undefined ? 1 : agreement.contractTermsVersion;
  requireState(contractTermsVersion === 1 || contractTermsVersion === 2, 'Unsupported development contract terms version.');
  const accessTerms = contractTermsVersion === 2
    ? 'Use the approved corridor and tower sites. Coordinate access and restore the land.'
    : 'Use only the selected fictional corridor and tower foundations. Coordinate access with the fictional landowner and restore disturbed ground.';
  const proposal = handoff.ownerHandoff;
  requireState(['sessionId','projectId','routeId','routeVersion'].every(key => packet[key] === proposal[key]) &&
    Array.isArray(packet.parcels) && packet.parcels.length === proposal.parcels.length && new Set(packet.parcels.map(p => p.parcelId)).size === proposal.parcels.length,
    'The agreement must cover exactly the current route parcels.');
  requireState(Array.isArray(packet.owners) && packet.owners.length === proposal.owners.length &&
    new Set(packet.owners.map(owner => owner.ownerId)).size === proposal.owners.length,
    'The agreement must preserve every current fictional owner.');
  requireState(scope === undefined || packet.parcels.some(parcel => parcel.parcelId === scope.parcelId), 'The approved parcel must be on the current route.');
  const source = {sourceMode:'fixture', sessionId:packet.sessionId, paymentSchedule:'full-after-signatures',
    project:{name:'Valley transmission project',developerName:'EasyGrid',signerName:'Ethan Cole'},
    route:{id:packet.routeId,version:packet.routeVersion,name:`Selected corridor / ${packet.routeId}`},
    negotiation:{id:agreement.negotiationId,version:agreement.negotiationVersion,status:'approved',approvedAt:agreement.approvedAt},
    ...(scope ? {approvalScope:{kind:'single-owner',parcelId:scope.parcelId}} : {}),
    parcels:packet.parcels.map(parcel => {
      const original = proposal.parcels.find(p => p.parcelId === parcel.parcelId);
      const owner = packet.owners.find(o => o.ownerId === parcel.ownerId);
      const originalOwner = proposal.owners.find(o => o.ownerId === parcel.ownerId);
      requireState(original && originalOwner && owner?.synthetic === true && original.ownerId === parcel.ownerId && owner.alias === originalOwner.alias &&
        owner.banking?.ownerId === owner.ownerId && owner.banking.mode === 'simulated' &&
        owner.banking.paymentRecipientRef === originalOwner.banking.paymentRecipientRef &&
        owner.banking.accountDisplay === originalOwner.banking.accountDisplay &&
        owner.banking.accountHolderAlias === originalOwner.banking.accountHolderAlias && owner.banking.bankDisplay === originalOwner.banking.bankDisplay,
        'The approved parcel must preserve its original fictional owner and mock recipient.');
      const terms = parcel.terms;
      requireState(terms && ['pending','accepted','refused','counteroffer','review_required'].includes(terms.outcome) &&
        ['unknown','allowed','refused'].includes(terms.accessConsent) && typeof terms.explicitConfirmation === 'boolean' &&
        (terms.confirmationRef === null || (typeof terms.confirmationRef === 'string' && terms.confirmationRef.length > 0)) &&
        Number.isSafeInteger(terms.compensationCents) && terms.compensationCents >= 0 && terms.compensationCents <= original.offerCapCents &&
        Number.isSafeInteger(terms.termsVersion) && terms.termsVersion >= original.terms.termsVersion,
        'Every current-route parcel requires valid versioned terms within the approved offer limit.');
      const accepted = terms.outcome === 'accepted' && terms.accessConsent === 'allowed' && terms.explicitConfirmation === true &&
        typeof parcel.terms.confirmationRef === 'string' && parcel.terms.confirmationRef.length > 0 &&
        !terms.hasUnresolvedConditions;
      requireState(terms.outcome !== 'accepted' || accepted, 'An accepted parcel requires explicit confirmed access terms.');
      requireState(accepted || (scope && scope.parcelId !== parcel.parcelId), 'Every parcel in the approval scope requires explicit accepted terms within the approved offer limit.');
      return {parcelId:parcel.parcelId,ownerId:parcel.ownerId,ownerName:owner.alias,accepted,termsVersion:parcel.terms.termsVersion,
        compensationCents:parcel.terms.compensationCents,
        landDescription:`Fictional ${original.landUse.replaceAll('-', ' ')} parcel ${parcel.parcelId}. The selected route uses ${original.impact.towerCount} tower foundations and ${original.impact.wireLengthMeters.toFixed(1)} m of overhead corridor.`,
        accessTerms};
    })};
  return normalizeContractSource(source);
}

export function matchesContractBinding(a, b) {return sameBinding(a, b);}

/** Explicit operator-approved fixture scenario, separate from registration and calls. */
export function simulatedMapAgreement(handoff, {negotiationId, approvedAt}) {
  const packet = copy(handoff.ownerHandoff);
  packet.routeStatus = 'ready_for_agreements';
  for (const parcel of packet.parcels) parcel.terms = {...parcel.terms, outcome:'accepted', accessConsent:'allowed',
    explicitConfirmation:true, confirmationRef:`${negotiationId}:${parcel.parcelId}`};
  return {kind:'easygrid-simulated-agreement',schemaVersion:1,sourceMode:'mock',contractTermsVersion:2, mapBinding:settlementBinding(handoff),
    ownerHandoff:packet,negotiationId,negotiationVersion:1,approvedAt};
}
