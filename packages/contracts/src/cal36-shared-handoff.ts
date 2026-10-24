/**
 * CAL-36 shared handoff boundary, based on CAL-27's documented Theo -> Pratham
 * -> Stella example. This is a validated application adapter, NOT an API v1
 * endpoint or evidence that CAL-27's authoritative revised schema is deployed.
 */
import { z } from 'zod';
import { createDemoAgreements, type DemoAgreementPackage, type FinalRoute, EasementError } from './cal36-easement.ts';
const Id=z.string().min(1).max(128);
const Cents=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Version=z.number().int().min(1);
const Accepted=z.strictObject({
  parcelId:Id,ownerId:Id,ownerAlias:Id.optional(),termsVersion:Version,
  outcome:z.literal('accepted'),confirmationRef:Id,
  compensationCents:Cents,monthlyFeeCents:Cents,paymentRecipientRef:Id,
  corridorDescription:Id.optional(),accessConditions:z.array(Id).min(1).optional(),
});
export const Cal36HandoffSchema=z.strictObject({
  sessionId:Id,projectId:Id,routeId:Id,routeVersion:Version,
  routeStatus:z.literal('ready_for_agreements'),
  currency:z.literal('USD'),operatorAlias:Id,
  finalParcelIds:z.array(Id).min(1),acceptedTerms:z.array(Accepted).min(1),
  // Enrichment supplied by the authoritative parcel/owner registry, not the LLM.
  parcelDetails:z.array(z.strictObject({parcelId:Id,ownerId:Id,ownerAlias:Id,
    corridorDescription:Id,accessConditions:z.array(Id).min(1)})).optional(),
  totalCompensationCents:Cents,totalMonthlyFeeCents:Cents,
});
export type Cal36Handoff=z.infer<typeof Cal36HandoffSchema>;
export type Cal36ApprovalPackage={
  agreementPackage:DemoAgreementPackage; packageHash:string; readyForApproval:boolean;
  ownerRecipients:ReadonlyArray<{parcelId:string;ownerId:string;paymentRecipientRef:string}>;
  simulated:true;
};
export function buildCal36ApprovalPackage(input:unknown):Cal36ApprovalPackage {
  const parsed=Cal36HandoffSchema.safeParse(input);
  if (!parsed.success) throw new EasementError('INVALID_INPUT',parsed.error.message);
  const x=parsed.data;
  if(new Set(x.finalParcelIds).size!==x.finalParcelIds.length ||
     new Set(x.acceptedTerms.map(t=>t.parcelId)).size!==x.acceptedTerms.length ||
     x.acceptedTerms.length!==x.finalParcelIds.length ||
     x.acceptedTerms.some(t=>!x.finalParcelIds.includes(t.parcelId)))
    throw new EasementError('MISSING_TERMS','Exactly one accepted record required for each final parcel');
  const sum=(items:number[])=>items.reduce((n,v)=>{
    const next=n+v;
    if(!Number.isSafeInteger(next)) throw new EasementError('INVALID_AMOUNT','Unsafe aggregate amount');
    return next;
  },0);
  if(sum(x.acceptedTerms.map(t=>t.compensationCents))!==x.totalCompensationCents ||
     sum(x.acceptedTerms.map(t=>t.monthlyFeeCents))!==x.totalMonthlyFeeCents)
    throw new EasementError('INVALID_AMOUNT','Handoff totals disagree with accepted parcel terms');
  const details=new Map((x.parcelDetails??[]).map(p=>[p.parcelId,p]));
  if(details.size!==(x.parcelDetails??[]).length) throw new EasementError('INVALID_INPUT','Duplicate parcel details');
  for(const t of x.acceptedTerms){
    const d=details.get(t.parcelId);
    if(d && d.ownerId!==t.ownerId) throw new EasementError('INVALID_INPUT','Parcel owner mismatch');
    if(!(t.ownerAlias??d?.ownerAlias) || !(t.corridorDescription??d?.corridorDescription) ||
      !(t.accessConditions??d?.accessConditions)?.length)
      throw new EasementError('MISSING_TERMS','Parcel owner/corridor/access context required');
  }
  const owners=new Map<string,string>();
  for(const t of x.acceptedTerms){
    const prev=owners.get(t.ownerId);
    if(prev && prev!==t.paymentRecipientRef)
      throw new EasementError('INVALID_RECIPIENT','One fictional owner has conflicting mock recipients');
    owners.set(t.ownerId,t.paymentRecipientRef);
  }
  const route:FinalRoute={
    sessionId:x.sessionId,projectId:x.projectId,routeId:x.routeId,
    routeVersion:x.routeVersion,status:'ready_for_agreements',operatorAlias:x.operatorAlias,
    parcelIds:x.finalParcelIds,
    terms:x.acceptedTerms.map(t=>({
      parcelId:t.parcelId,ownerId:t.ownerId,ownerAlias:t.ownerAlias??details.get(t.parcelId)!.ownerAlias,termsVersion:t.termsVersion,
      outcome:'accepted',explicitConfirmation:true,evidenceRefs:[t.confirmationRef],
      confirmationRef:t.confirmationRef,paymentRecipientRef:t.paymentRecipientRef,
      compensationCents:t.compensationCents,monthlyRentCents:t.monthlyFeeCents,
      corridorDescription:t.corridorDescription??details.get(t.parcelId)!.corridorDescription,
      accessConditions:t.accessConditions??details.get(t.parcelId)!.accessConditions
    }))
  };
  const agreementPackage=createDemoAgreements(route);
  return {
    agreementPackage,packageHash:agreementPackage.packageHash,
    readyForApproval:false, // only becomes true after all simulated signatures
    ownerRecipients:x.acceptedTerms.map(t=>({
      parcelId:t.parcelId,ownerId:t.ownerId,paymentRecipientRef:t.paymentRecipientRef
    })),
    simulated:true
  };
}

/**
 * Canonical CAL-27 integration: consume Theo's actual OwnerHandoff packet and
 * independently sourced current-state binding, not a second invented wire schema.
 * The host is responsible for loading authoritative current state.
 */
import { assertAgreementReady, type CurrentHandoffState } from './owner-handoff.ts';
export function buildCal36FromOwnerHandoff(
  packetInput: unknown,
  currentStateInput: CurrentHandoffState,
  operatorAlias: string,
): Cal36ApprovalPackage {
  // Includes strict schema validation, exact current session/route/revision/
  // terms versions, accepted consent, budget/cap and simulation readiness.
  const packet=assertAgreementReady(packetInput,currentStateInput);
  if (!operatorAlias.trim()) throw new EasementError('INVALID_INPUT','Operator alias required');
  const owners=new Map(packet.owners.map(o=>[o.ownerId,o]));
  const route:FinalRoute={
    sessionId:packet.sessionId,projectId:packet.projectId,routeId:packet.routeId,
    routeVersion:packet.routeVersion,status:'ready_for_agreements',
    operatorAlias,parcelIds:packet.parcels.map(p=>p.parcelId),
    terms:packet.parcels.map(p=>{
      const owner=owners.get(p.ownerId);
      if(!owner) throw new EasementError('MISSING_TERMS','Missing owner');
      return {
        parcelId:p.parcelId,ownerId:p.ownerId,ownerAlias:owner.alias,
        termsVersion:p.terms.termsVersion,outcome:'accepted' as const,
        explicitConfirmation:p.terms.explicitConfirmation,
        evidenceRefs:p.terms.confirmationRef?[p.terms.confirmationRef]:[],
        confirmationRef:p.terms.confirmationRef??undefined,
        paymentRecipientRef:owner.banking.paymentRecipientRef,
        compensationCents:p.terms.compensationCents,
        monthlyRentCents:p.terms.monthlyRentCents,
        corridorDescription:p.landUse+'; '+p.impact.towerCount+' tower(s), '+p.impact.wireLengthMeters+'m wire',
        accessConditions:['Owner accepted access', 'Affected parcel '+p.parcelId],
      };
    }),
  };
  const agreementPackage=createDemoAgreements(route);
  return {agreementPackage,packageHash:agreementPackage.packageHash,
    readyForApproval:false,simulated:true,
    ownerRecipients:packet.parcels.map(p=>({
      parcelId:p.parcelId,ownerId:p.ownerId,
      paymentRecipientRef:owners.get(p.ownerId)!.banking.paymentRecipientRef
    }))};
}
