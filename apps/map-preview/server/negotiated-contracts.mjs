import {OwnerHandoff, CurrentHandoffState} from '../../../packages/contracts/src/owner-handoff.ts';
import {NegotiationSummary, permittedNegotiationMaximum} from '../../../packages/contracts/src/negotiation.ts';
import {settlementBinding} from '../src/settlement-controller.js';
import {matchesContractBinding} from '../src/contract-handoff.js';

const requireState = (value, message) => {if (!value) throw new Error(message);};
const copy = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);

export function validateNegotiationRef(value) {
  requireState(value && Object.keys(value).length === 3 && id(value.attemptId) && id(value.eventId) && Number.isSafeInteger(value.revision) && value.revision >= 0,
    'A saved negotiation reference is required; browser amounts are not accepted.');
  return {attemptId:value.attemptId,eventId:value.eventId,revision:value.revision};
}

/** Only a server-injected authorized host may supply this committed state. */
export function agreementFromNegotiation(trusted, handoff, reference) {
  const ref = validateNegotiationRef(reference), baseline = handoff.ownerHandoff;
  requireState(trusted && matchesContractBinding(trusted.mapBinding,settlementBinding(handoff)) &&
    ['attemptId','eventId','revision'].every(key => trusted[key] === ref[key]), 'The saved negotiation reference is stale or belongs to another route.');
  const state = trusted.state;
  requireState(state?.active === true && state.workflow === 'negotiating', 'The current negotiation is not approved for a contract.');
  const packet = OwnerHandoff.parse(state.handoff), current = CurrentHandoffState.parse(state.current);
  requireState(packet.referenceBinding === 'canonical' && packet.simulationChecksPassed === true && packet.revision === ref.revision,
    'An authoritative current negotiation revision is required.');
  for (const key of ['sessionId','projectId','routeId','routeVersion']) requireState(packet[key] === baseline[key], 'The negotiated route binding changed.');
  for (const key of ['sessionId','projectId','routeId','routeVersion','revision']) requireState(current[key] === packet[key], 'The current negotiation terms are stale.');
  for (const key of ['constructionCents','budgetCents','rentHorizonMonths']) requireState(packet[key] === baseline[key], 'The approved project policy changed.');
  requireState(packet.parcels.length === baseline.parcels.length && Object.keys(current.termsVersions).length === baseline.parcels.length &&
    Object.keys(current.offerPolicies ?? {}).length === baseline.parcels.length, 'The complete current route policy is required.');
  for (const parcel of packet.parcels) {
    const original = baseline.parcels.find(item => item.parcelId === parcel.parcelId), policy = current.offerPolicies?.[parcel.parcelId];
    const owner = packet.owners.find(item => item.ownerId === parcel.ownerId), originalOwner = baseline.owners.find(item => item.ownerId === parcel.ownerId);
    requireState(original && parcel.ownerId === original.ownerId && parcel.offerCapCents === original.offerCapCents &&
      owner?.synthetic === true && owner.alias === originalOwner?.alias && owner.banking.ownerId === originalOwner.banking.ownerId &&
      owner.banking.paymentRecipientRef === originalOwner.banking.paymentRecipientRef && owner.banking.accountDisplay === originalOwner.banking.accountDisplay &&
      parcel.offerPolicy?.recommendedOfferCents === original.offerPolicy?.recommendedOfferCents &&
      parcel.offerPolicy?.policyId === original.offerPolicy?.policyId && parcel.offerPolicy?.basis === original.offerPolicy?.basis &&
      policy?.policyId === original.offerPolicy?.policyId && policy?.basis === original.offerPolicy?.basis &&
      policy?.recommendedOfferCents === original.offerPolicy?.recommendedOfferCents && policy?.offerCapCents === original.offerCapCents &&
      parcel.terms.monthlyRentCents === original.terms.monthlyRentCents && parcel.terms.monthlyRentIsApproximate === false &&
      current.termsVersions[parcel.parcelId] === parcel.terms.termsVersion && parcel.terms.termsVersion >= original.terms.termsVersion &&
      parcel.terms.compensationCents <= original.offerCapCents, 'The negotiated money, owner or fixed policy does not match the current route.');
  }
  const parcel = packet.parcels.find(item => item.parcelId === trusted.localParcelId), attempt = state.attempts?.[ref.attemptId];
  requireState(parcel && parcel.parcelId === baseline.userRole?.parcelId && parcel.ownerId === baseline.userRole?.ownerId &&
    packet.userRole?.parcelId === parcel.parcelId && packet.userRole?.ownerId === parcel.ownerId, 'The saved negotiation must belong to the current participant.');
  requireState(attempt?.phase === 'finished' && attempt.attemptId === ref.attemptId, 'Negotiation review must finish before creating a contract.');
  const summary = NegotiationSummary.parse(attempt.summary), offer = attempt.offers?.at(-1);
  for (const key of ['sessionId','projectId','routeId','routeVersion']) requireState(attempt[key] === packet[key] && summary[key] === packet[key], 'The accepted result belongs to a different route.');
  requireState(summary.attemptId === ref.attemptId && summary.parcelId === parcel.parcelId && summary.ownerId === parcel.ownerId &&
    attempt.parcelId === parcel.parcelId && attempt.ownerId === parcel.ownerId && summary.mode === attempt.mode &&
    summary.outcome === 'accepted' && summary.accessConsent === 'allowed' && summary.disposition === 'successful' && summary.reason === 'AGREED' && summary.nextAction === 'continue' &&
    parcel.terms.outcome === 'accepted' && parcel.terms.accessConsent === 'allowed' && parcel.terms.explicitConfirmation === true &&
    summary.evidenceRefs.includes(parcel.terms.confirmationRef) && summary.termsVersion === parcel.terms.termsVersion &&
    summary.agreedCents === parcel.terms.compensationCents && summary.offeredCents === parcel.terms.compensationCents &&
    summary.monthlyRentCents === parcel.terms.monthlyRentCents && offer?.termsVersion === parcel.terms.termsVersion &&
    offer?.compensationCents === parcel.terms.compensationCents && offer?.monthlyRentCents === parcel.terms.monthlyRentCents &&
    attempt.recommendationCents === parcel.offerPolicy.recommendedOfferCents && attempt.capCents === parcel.offerCapCents &&
    attempt.monthlyRentCents === parcel.terms.monthlyRentCents && parcel.terms.compensationCents >= parcel.offerPolicy.recommendedOfferCents &&
    parcel.terms.compensationCents <= permittedNegotiationMaximum(packet,parcel.parcelId),
    'Only the exact current accepted offer within the approved policy and project budget can become a contract.');
  requireState(typeof trusted.approvedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(trusted.approvedAt) && Number.isFinite(Date.parse(trusted.approvedAt)), 'The committed negotiation needs an approval time.');
  // Keep trusted local geometry and mock recipient associations; copy only the
  // validated current terms. No private canonical contact or transcript escapes.
  const redacted = copy(baseline);
  redacted.revision = packet.revision;
  for (const item of redacted.parcels) item.terms = copy(packet.parcels.find(p => p.parcelId === item.parcelId).terms);
  return {kind:'easygrid-negotiated-agreement',schemaVersion:1,sourceMode:'mock',contractTermsVersion:2,
    approvalScope:{kind:'single-owner',parcelId:parcel.parcelId},mapBinding:settlementBinding(handoff),ownerHandoff:redacted,
    negotiationId:ref.attemptId,negotiationVersion:ref.revision + 1,approvedAt:trusted.approvedAt};
}
