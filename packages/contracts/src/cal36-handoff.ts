/**
 * CAL-36 bridge: validates a CAL-27-style final-route handoff and produces
 * a versioned, simulation-only agreement package for approval.
 *
 * Deliberately does NOT interpret legacy depositCents/upfrontCents as the
 * revised total compensation. Accepted compensation is explicit in the handoff.
 * This boundary is independent of the still-v1 shared HTTP API and is NOT a
 * deployed service endpoint.
 */
import { z } from 'zod';
import { buildAgreementPackage, demoSignAgreement, supersedePackage,
  type AgreementPackage, type AgreedParcel, FinanceError } from './finance-demo.ts';

const Id = z.string().min(1);
const Cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Version = z.number().int().min(1);
const Accepted = z.strictObject({
  parcelId: Id, ownerId: Id, ownerAlias: Id,
  termsVersion: Version, outcome: z.literal('accepted'),
  explicitConfirmation: z.literal(true),
  evidenceRefs: z.array(Id).min(1),
  compensationCents: Cents, monthlyRentCents: Cents,
  corridorDescription: Id, accessConditions: z.array(Id).min(1),
  paymentRecipientRef: Id,
});
export const FinalRouteHandoff = z.strictObject({
  sessionId: Id, projectId: Id, routeId: Id, routeVersion: Version,
  routeStatus: z.literal('final_agreement_ready'),
  operatorAlias: Id,
  finalParcelIds: z.array(Id).min(1),
  parcels: z.array(Accepted).min(1),
});
export type FinalRouteHandoff = z.infer<typeof FinalRouteHandoff>;
export type AgreementHandoff = {
  package: AgreementPackage;
  recipients: Record<string, { ownerId: string; paymentRecipientRef: string }>;
  simulation: true;
};

/** Fail closed: no partial package when any final-route parcel is missing. */
export function createCal36AgreementHandoff(raw: unknown): AgreementHandoff {
  const parsed = FinalRouteHandoff.safeParse(raw);
  if (!parsed.success) throw new FinanceError('INVALID_HANDOFF', parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join('; '));
  const input = parsed.data;
  if (new Set(input.finalParcelIds).size !== input.finalParcelIds.length)
    throw new FinanceError('DUPLICATE_PARCEL','Final route contains repeated parcel IDs');
  const byParcel = new Map(input.parcels.map(p=>[p.parcelId,p]));
  if (byParcel.size !== input.parcels.length)
    throw new FinanceError('DUPLICATE_PARCEL','Accepted terms contain repeated parcels');
  if (byParcel.size !== input.finalParcelIds.length ||
      input.finalParcelIds.some(id=>!byParcel.has(id)))
    throw new FinanceError('MISSING_TERMS','Exactly one accepted terms record required per final-route parcel');
  const owners = new Map<string,string>();
  for (const p of input.parcels) {
    const prior = owners.get(p.ownerId);
    if (prior && prior !== p.paymentRecipientRef)
      throw new FinanceError('RECIPIENT_MISMATCH','One owner cannot have conflicting payout destinations');
    owners.set(p.ownerId,p.paymentRecipientRef);
  }
  const parcels: AgreedParcel[] = input.parcels.map(p=>({
    parcelId:p.parcelId,ownerAlias:p.ownerAlias,termsVersion:p.termsVersion,
    outcome:p.outcome,explicitConfirmation:p.explicitConfirmation,
    evidenceRefs:p.evidenceRefs,compensationCents:p.compensationCents,
    monthlyRentCents:p.monthlyRentCents,accessConditions:p.accessConditions,
    corridorDescription:p.corridorDescription
  }));
  const pkg = buildAgreementPackage({
    sessionId:input.sessionId,projectId:input.projectId,routeId:input.routeId,
    routeVersion:input.routeVersion,finalParcelIds:input.finalParcelIds,
    parcels,operatorAlias:input.operatorAlias
  });
  const recipients = Object.fromEntries(input.parcels.map(p=>[
    p.parcelId,{ownerId:p.ownerId,paymentRecipientRef:p.paymentRecipientRef}
  ]));
  return {package:pkg,recipients,simulation:true};
}
/** All signatures must match immutable hashes and current package versions. */
export function signCal36Handoff(handoff: AgreementHandoff, parcelId: string,
  signerAlias: string, at: string): AgreementHandoff {
  return {...handoff,package:demoSignAgreement(handoff.package,parcelId,signerAlias,at)};
}
export function replaceCal36Handoff(previous: AgreementHandoff, next: unknown):
  {superseded: AgreementHandoff; current: AgreementHandoff} {
  const current = createCal36AgreementHandoff(next);
  if (previous.package.sessionId !== current.package.sessionId ||
      previous.package.projectId !== current.package.projectId)
    throw new FinanceError('STALE_SESSION','Agreement revision must remain in the same demo session');
  if (previous.package.packageHash === current.package.packageHash)
    throw new FinanceError('DUPLICATE_VERSION','Replacement must change agreement content');
  return {superseded:{...previous,package:supersedePackage(previous.package)},current};
}
