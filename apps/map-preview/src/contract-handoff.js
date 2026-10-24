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

/** Consume THEO's ready-for-agreements owner packet; selection or call consent is insufficient. */
export function contractSourceFromAgreement(agreement, handoff) {
  const binding = settlementBinding(handoff), packet = agreement?.ownerHandoff;
  requireState(sameBinding(binding, agreement?.mapBinding) && handoff.snapshot.routes[0].eligible === true, 'The approved negotiation does not match the displayed route.');
  requireState(packet?.kind === 'easygrid-owner-handoff' && packet.sourceMode === 'fixture' && packet.routeStatus === 'ready_for_agreements' && packet.referenceBinding === 'local-fixture', 'A complete approved development agreement packet is required.');
  const proposal = handoff.ownerHandoff;
  requireState(['sessionId','projectId','routeId','routeVersion'].every(key => packet[key] === proposal[key]) && packet.parcels.length === proposal.parcels.length && new Set(packet.parcels.map(p => p.parcelId)).size === proposal.parcels.length, 'The agreement must cover exactly the current route parcels.');
  const source = {sourceMode:'fixture', sessionId:packet.sessionId,
    project:{name:'Valley transmission project',developerName:'Cal Power',signerName:'Ethan Cole'},
    route:{id:packet.routeId,version:packet.routeVersion,name:`Selected corridor / ${packet.routeId}`},
    negotiation:{id:agreement.negotiationId,version:agreement.negotiationVersion,status:'approved',approvedAt:agreement.approvedAt},
    parcels:packet.parcels.map(parcel => {
      const original = proposal.parcels.find(p => p.parcelId === parcel.parcelId);
      const owner = packet.owners.find(o => o.ownerId === parcel.ownerId);
      const originalOwner = proposal.owners.find(o => o.ownerId === parcel.ownerId);
      requireState(original && owner?.synthetic === true && original.ownerId === parcel.ownerId && owner.alias === originalOwner?.alias &&
        owner.banking?.ownerId === owner.ownerId && owner.banking.mode === 'simulated' &&
        owner.banking.paymentRecipientRef === originalOwner.banking.paymentRecipientRef &&
        owner.banking.accountDisplay === originalOwner.banking.accountDisplay,
        'The approved parcel must preserve its original fictional owner and mock recipient.');
      requireState(parcel.terms?.outcome === 'accepted' && parcel.terms.accessConsent === 'allowed' && parcel.terms.explicitConfirmation === true &&
        typeof parcel.terms.confirmationRef === 'string' && parcel.terms.confirmationRef.length > 0 &&
        Number.isSafeInteger(parcel.terms.compensationCents) && parcel.terms.compensationCents >= 0 && parcel.terms.compensationCents <= original.offerCapCents &&
        Number.isSafeInteger(parcel.terms.termsVersion) && parcel.terms.termsVersion >= original.terms.termsVersion,
        'Every final-route owner requires explicit accepted terms within the approved offer limit.');
      return {parcelId:parcel.parcelId,ownerId:parcel.ownerId,ownerName:owner.alias,accepted:true,termsVersion:parcel.terms.termsVersion,
        compensationCents:parcel.terms.compensationCents,
        landDescription:`Fictional ${original.landUse.replaceAll('-', ' ')} parcel ${parcel.parcelId}. The selected route uses ${original.impact.towerCount} tower foundations and ${original.impact.wireLengthMeters.toFixed(1)} m of overhead corridor.`,
        accessTerms:'Use only the selected fictional corridor and tower foundations. Coordinate access with the fictional landowner and restore disturbed ground.'};
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
  return {kind:'easygrid-simulated-agreement',schemaVersion:1,sourceMode:'mock', mapBinding:settlementBinding(handoff),
    ownerHandoff:packet,negotiationId,negotiationVersion:1,approvedAt};
}
