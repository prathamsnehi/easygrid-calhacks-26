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
  parcelId:Id,ownerId:Id,ownerAlias:Id,termsVersion:Version,
  outcome:z.literal('accepted'),confirmationRef:Id,
  compensationCents:Cents,monthlyFeeCents:Cents,paymentRecipientRef:Id,
  corridorDescription:Id,accessConditions:z.array(Id).min(1),
});
export const Cal36HandoffSchema=z.strictObject({
  sessionId:Id,projectId:Id,routeId:Id,routeVersion:Version,
  routeStatus:z.literal('ready_for_agreements'),
  currency:z.literal('USD'),operatorAlias:Id,
  finalParcelIds:z.array(Id).min(1),acceptedTerms:z.array(Accepted).min(1),
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
      parcelId:t.parcelId,ownerId:t.ownerId,ownerAlias:t.ownerAlias,termsVersion:t.termsVersion,
      outcome:'accepted',explicitConfirmation:true,evidenceRefs:[t.confirmationRef],
      confirmationRef:t.confirmationRef,paymentRecipientRef:t.paymentRecipientRef,
      compensationCents:t.compensationCents,monthlyRentCents:t.monthlyFeeCents,
      corridorDescription:t.corridorDescription,accessConditions:t.accessConditions
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
