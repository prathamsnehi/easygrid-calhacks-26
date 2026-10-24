/** CAL-13 integration fixtures; synthetic and never legally binding. */
import { NegotiationResult } from './schemas.ts';
const negotiation = NegotiationResult.parse({
  schemaVersion: 1, sourceMode: 'fixture', evidenceRefs: ['fixture:consent-P2'],
  id: 'terms-P2', projectId: 'demo-project', parcelId: 'P2', routeVersion: 1,
  termsVersion: 1, sessionId: 'demo-call-P2', outcome: 'accepted',
  accessConsent: 'allowed', explicitConfirmation: true,
  upfrontCents: 100000, depositCents: 20000,
  depositCreditPolicy: 'credited_to_upfront', monthlyRentCents: 5000,
  termMonths: 2, conditions: ['Daytime access only'],
});
export const acceptedTermsEasement = {
  id: 'contract-P2', projectId: 'demo-project', routeId: 'direct', parcelId: 'P2',
  contractVersion: 1, templateVersion: 'demo-v1', ownerAlias: 'Synthetic owner P2',
  operatorAlias: 'Demo grid operator', corridorDescription: 'Synthetic corridor through P2',
  accessConditions: ['Daytime access only'], effectiveStartDate: '2026-11-01',
  effectiveEndDate: '2026-12-31', negotiation, offerCapCents: 100000,
  currentRouteVersion: 1, currentTermsVersion: 1,
};
export const missingTermsEasement = {
  ...acceptedTermsEasement, id: 'contract-P2-missing',
  corridorDescription: '', accessConditions: [],
};
