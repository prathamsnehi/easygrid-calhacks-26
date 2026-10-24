/** CAL-36 only. Synthetic, versioned easement agreements. No payment execution. */
import { createHash } from 'node:crypto';

export type AcceptedTerms = {
  parcelId: string; ownerId: string; ownerAlias: string;
  termsVersion: number; outcome: 'accepted'|'pending'|'refused'|'counteroffer'|'review_required';
  explicitConfirmation: boolean; evidenceRefs: string[];
  compensationCents: number; monthlyRentCents: number;
  corridorDescription: string; accessConditions: string[];
};
export type FinalRoute = {
  sessionId: string; projectId: string; routeId: string; routeVersion: number;
  status: 'final_agreement_ready'|'selected_for_negotiation';
  operatorAlias: string; parcelIds: string[]; terms: AcceptedTerms[];
};
export type DemoSignature = {
  simulated: true; signerAlias: string; signedAt: string; agreementId: string;
  routeVersion: number; termsVersion: number; contractVersion: number; contentHash: string;
};
export type DemoAgreement = {
  id: string; parcelId: string; ownerId: string; routeVersion: number; termsVersion: number;
  contractVersion: number; compensationCents: number; contract20Cents: number;
  completion80Cents: number; monthlyRentCents: number; contentHash: string;
  preview: string; status: 'draft'|'demo_signed'|'superseded'; signature?: DemoSignature;
};
export type DemoAgreementPackage = {
  sessionId: string; projectId: string; routeId: string; routeVersion: number;
  packageHash: string; agreements: DemoAgreement[]; simulated: true;
};
export class EasementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code=code; this.name='EasementError'; }
}
function check(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new EasementError(code,message);
}
const nonempty = (v: string) => typeof v === 'string' && v.trim().length > 0;
const positiveVersion = (v: number) => Number.isSafeInteger(v) && v > 0;
const cents = (v: number) => Number.isSafeInteger(v) && v >= 0;
const digest = (value: unknown) => 'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
const usd = (v: number) => '$'+(v/100).toFixed(2);
export function compensationTranches(total: number) {
  check(cents(total),'INVALID_AMOUNT','Compensation must be nonnegative integer cents');
  const first = Math.floor(total/5) + (total%5>=3?1:0);
  return {contract20Cents:first,completion80Cents:total-first};
}
/** Only final routes with one confirmed accepted-terms record per affected parcel are ready. */
export function createDemoAgreements(route: FinalRoute, versions: Record<string,number>={}): DemoAgreementPackage {
  check(nonempty(route.sessionId)&&nonempty(route.projectId)&&nonempty(route.routeId)&&
    nonempty(route.operatorAlias)&&positiveVersion(route.routeVersion),'INVALID_ROUTE','Missing route identity or version');
  check(route.status==='final_agreement_ready','NOT_FINAL','Route must be finalized for agreements');
  check(route.parcelIds.length>0&&new Set(route.parcelIds).size===route.parcelIds.length,'INVALID_ROUTE','Unique affected parcels required');
  check(route.terms.length===route.parcelIds.length&&new Set(route.terms.map(t=>t.parcelId)).size===route.terms.length,
    'MISSING_TERMS','Exactly one accepted record required per affected parcel');
  const terms = new Map(route.terms.map(t=>[t.parcelId,t]));
  const agreements = route.parcelIds.map(parcelId=>{
    const t=terms.get(parcelId);
    check(t,'MISSING_TERMS','Missing accepted terms for '+parcelId);
    check(t.outcome==='accepted'&&t.explicitConfirmation&&t.evidenceRefs.length>0&&t.evidenceRefs.every(nonempty),
      'NOT_ACCEPTED','Confirmed accepted terms with evidence required');
    check(nonempty(t.ownerId)&&nonempty(t.ownerAlias)&&nonempty(t.corridorDescription)&&
      t.accessConditions.length>0&&t.accessConditions.every(nonempty),'MISSING_TERMS','Required agreement details missing');
    check(positiveVersion(t.termsVersion)&&cents(t.compensationCents)&&cents(t.monthlyRentCents),
      'INVALID_TERMS','Invalid terms version or amount');
    const contractVersion=versions[parcelId]??1;
    check(positiveVersion(contractVersion),'STALE_VERSION','Invalid contract version');
    const split=compensationTranches(t.compensationCents);
    const id=route.sessionId+':'+route.routeId+':'+parcelId+':v'+contractVersion;
    const body={id,sessionId:route.sessionId,projectId:route.projectId,routeId:route.routeId,
      routeVersion:route.routeVersion,parcelId,ownerId:t.ownerId,ownerAlias:t.ownerAlias,
      operatorAlias:route.operatorAlias,termsVersion:t.termsVersion,contractVersion,
      compensationCents:t.compensationCents,...split,monthlyRentCents:t.monthlyRentCents,
      corridorDescription:t.corridorDescription,accessConditions:t.accessConditions,evidenceRefs:t.evidenceRefs};
    const contentHash=digest(body);
    const preview=[
      'SIMULATED EASEMENT — NOT A LEGALLY EXECUTED AGREEMENT',
      'Agreement '+id+' | Route '+route.routeId+' v'+route.routeVersion,
      'Parties: '+route.operatorAlias+' / '+t.ownerAlias+' ('+t.ownerId+')',
      'Parcel '+parcelId+' | Corridor: '+t.corridorDescription,
      'Access: '+t.accessConditions.join('; '),
      'Terms v'+t.termsVersion+' | Contract v'+contractVersion,
      'Total compensation: '+usd(t.compensationCents),
      'At contract approval (20%): '+usd(split.contract20Cents),
      'After simulated completion (remaining balance): '+usd(split.completion80Cents),
      'Monthly fee: '+usd(t.monthlyRentCents)+' (starts after completion)',
      'No separate deposit. No real signature or payment.',
      'Evidence: '+t.evidenceRefs.join(', '),'Content hash: '+contentHash
    ].join('\n');
    return {id,parcelId,ownerId:t.ownerId,routeVersion:route.routeVersion,
      termsVersion:t.termsVersion,contractVersion,compensationCents:t.compensationCents,
      ...split,monthlyRentCents:t.monthlyRentCents,contentHash,preview,status:'draft' as const};
  });
  return {sessionId:route.sessionId,projectId:route.projectId,routeId:route.routeId,
    routeVersion:route.routeVersion,agreements,
    packageHash:digest(agreements.map(a=>[a.id,a.contentHash])),simulated:true};
}
export function signDemoAgreement(pkg: DemoAgreementPackage, parcelId: string, signerAlias: string, at: string,
  expectedPackageHash: string): DemoAgreementPackage {
  check(pkg.packageHash===expectedPackageHash,'STALE_VERSION','Package hash changed');
  check(nonempty(signerAlias)&&nonempty(at)&&!Number.isNaN(Date.parse(at)),'INVALID_SIGNATURE','Signer and timestamp required');
  const agreement=pkg.agreements.find(a=>a.parcelId===parcelId);
  check(agreement&&agreement.status==='draft','BLOCKED_STATE','Unsigned draft required');
  // Signer identity must be checked by the caller; this is a simulated owner alias receipt only.
  const signature: DemoSignature={simulated:true,signerAlias,signedAt:at,agreementId:agreement.id,
    routeVersion:agreement.routeVersion,termsVersion:agreement.termsVersion,
    contractVersion:agreement.contractVersion,contentHash:agreement.contentHash};
  return {...pkg,agreements:pkg.agreements.map(a=>a.parcelId===parcelId?
    {...a,status:'demo_signed' as const,signature}:a)};
}
export function supersedeDemoAgreements(pkg: DemoAgreementPackage): DemoAgreementPackage {
  return {...pkg,agreements:pkg.agreements.map(a=>({...a,status:'superseded' as const,signature:undefined}))};
}
export function isAgreementPackageReady(pkg: DemoAgreementPackage): boolean {
  return pkg.agreements.length>0&&pkg.agreements.every(a=>a.status==='demo_signed'&&
    a.signature?.simulated===true&&a.signature.agreementId===a.id&&
    a.signature.contentHash===a.contentHash&&a.signature.routeVersion===pkg.routeVersion&&
    a.signature.termsVersion===a.termsVersion&&a.signature.contractVersion===a.contractVersion);
}
