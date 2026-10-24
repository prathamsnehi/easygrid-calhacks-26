/**
 * CAL-36–39: deterministic, simulation-only agreement and finance domain.
 * Does not modify CAL-27's authoritative schema or claim persistence.
 * The SpacetimeDB command handler MUST enforce authorization, atomicity and
 * durable uniqueness of obligationId. This pure adapter is a testable boundary.
 */
import { createHash } from 'node:crypto';

export type AgreedParcel = {
  parcelId: string; ownerAlias: string; termsVersion: number;
  outcome: 'accepted' | 'refused' | 'pending' | 'counteroffer';
  explicitConfirmation: boolean; evidenceRefs: string[];
  compensationCents: number; monthlyRentCents: number;
  accessConditions: string[]; corridorDescription: string;
};
export type Agreement = {
  id: string; parcelId: string; routeId: string; routeVersion: number;
  termsVersion: number; contractVersion: number; ownerAlias: string;
  operatorAlias: string; compensationCents: number; contractTrancheCents: number;
  completionTrancheCents: number; monthlyRentCents: number;
  contentHash: string; preview: string; signature?: Signature;
  status: 'draft' | 'demo_signed' | 'superseded';
};
export type Signature = {
  simulation: true; agreementId: string; contractVersion: number;
  routeVersion: number; termsVersion: number; contentHash: string;
  signerAlias: string; signedAt: string;
};
export type AgreementPackage = {
  sessionId: string; projectId: string; routeId: string; routeVersion: number;
  agreements: Agreement[]; packageHash: string;
};
export type Approval = {
  id: string; sessionId: string; packageHash: string;
  approverId: string; requestedBy: string; approvedAt: string;
};
export type LedgerEntry = {
  obligationId: string; sessionId: string; agreementId: string;
  kind: 'contract_20' | 'completion_80' | 'monthly_rent';
  period?: string; expectedCents: number; paidCents: number;
  status: 'matched' | 'mismatch'; simulated: true; at: string;
  evidence: string[]; journal: { account: string; debitCents: number; creditCents: number }[];
};
export type FinanceState = {
  package: AgreementPackage; approval?: Approval;
  completionAt?: string; ledger: LedgerEntry[]; audit: Audit[];
};
export type Audit = { action: string; actor: string; at: string; reason: string; evidence: string[] };
export class FinanceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'FinanceError'; }
}
const assert = (ok: unknown, code: string, message: string): asserts ok => {
  if (!ok) throw new FinanceError(code, message);
};
const cents = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const nonblank = (s: string): boolean => typeof s === 'string' && s.trim().length > 0;
const hash = (x: unknown): string => 'sha256:' + createHash('sha256').update(JSON.stringify(x)).digest('hex');
const usd = (n: number): string => '$' + (n / 100).toFixed(2);
/** Half-up rounding for nonnegative integer cents: floor((cents*20 + 50)/100).
 * Use quotient/remainder to avoid multiplication exceeding safe integer range. */
export function splitCompensation(totalCents: number): { contractCents: number; completionCents: number } {
  assert(cents(totalCents), 'INVALID_AMOUNT', 'Compensation must be nonnegative safe integer cents');
  const contractCents = Math.floor(totalCents / 5) + (totalCents % 5 >= 3 ? 1 : 0);
  return { contractCents, completionCents: totalCents - contractCents };
}
export function buildAgreementPackage(input: {
  sessionId: string; projectId: string; routeId: string; routeVersion: number;
  finalParcelIds: string[]; parcels: AgreedParcel[]; operatorAlias: string;
  contractVersions?: Record<string, number>;
}): AgreementPackage {
  assert([input.sessionId,input.projectId,input.routeId,input.operatorAlias].every(nonblank),
    'MISSING_TERMS','Session, project, route and operator are required');
  assert(Number.isSafeInteger(input.routeVersion) && input.routeVersion > 0, 'STALE_VERSION','Route version required');
  assert(input.finalParcelIds.length > 0 && new Set(input.finalParcelIds).size === input.finalParcelIds.length,
    'INVALID_ROUTE','Final route must contain unique parcels');
  assert(new Set(input.parcels.map(p => p.parcelId)).size === input.parcels.length,
    'DUPLICATE_PARCEL','Duplicate negotiated parcel');
  const byId = new Map(input.parcels.map(p => [p.parcelId,p]));
  const agreements = input.finalParcelIds.map(parcelId => {
    const p = byId.get(parcelId);
    assert(p, 'MISSING_TERMS', 'No accepted terms for final-route parcel ' + parcelId);
    assert(p.outcome === 'accepted' && p.explicitConfirmation && p.evidenceRefs.length > 0,
      'UNACCEPTED_TERMS','Explicitly confirmed acceptance and evidence required: ' + parcelId);
    assert(nonblank(p.ownerAlias) && nonblank(p.corridorDescription) &&
      p.accessConditions.length > 0 && p.accessConditions.every(nonblank),
      'MISSING_TERMS','Required agreement content missing: ' + parcelId);
    assert(Number.isSafeInteger(p.termsVersion) && p.termsVersion > 0,
      'STALE_VERSION','Valid terms version required');
    assert(cents(p.compensationCents) && cents(p.monthlyRentCents),
      'INVALID_AMOUNT','Invalid compensation or monthly rent');
    const contractVersion = input.contractVersions?.[parcelId] ?? 1;
    assert(Number.isSafeInteger(contractVersion) && contractVersion > 0,
      'STALE_VERSION','Invalid contract version');
    const split = splitCompensation(p.compensationCents);
    const content = {
      sessionId: input.sessionId, projectId: input.projectId, routeId: input.routeId,
      routeVersion: input.routeVersion, parcelId, termsVersion: p.termsVersion,
      contractVersion, ownerAlias: p.ownerAlias, operatorAlias: input.operatorAlias,
      corridorDescription: p.corridorDescription, accessConditions: p.accessConditions,
      compensationCents: p.compensationCents, ...split, monthlyRentCents: p.monthlyRentCents
    };
    const contentHash = hash(content);
    const id = input.sessionId + ':' + parcelId + ':v' + contractVersion;
    const preview = [
      'SIMULATED EASEMENT — NOT LEGALLY EXECUTED',
      'Agreement: ' + id + ' | Route: ' + input.routeId + ' v' + input.routeVersion,
      'Parties: ' + input.operatorAlias + ' / ' + p.ownerAlias,
      'Parcel: ' + parcelId + ' | Corridor: ' + p.corridorDescription,
      'Access: ' + p.accessConditions.join('; '),
      'Terms v' + p.termsVersion + ' | Contract v' + contractVersion,
      'Total one-time compensation: ' + usd(p.compensationCents),
      'At contract approval (20%): ' + usd(split.contractCents),
      'At simulated completion (remaining 80%): ' + usd(split.completionCents),
      'Monthly rent: ' + usd(p.monthlyRentCents) + ' (first due one calendar month after completion)',
      'No separate deposit. No real transfer, notarization or legal signature.',
      'Content hash: ' + contentHash
    ].join('\n');
    return {
      id, parcelId, routeId: input.routeId, routeVersion: input.routeVersion,
      termsVersion: p.termsVersion, contractVersion, ownerAlias: p.ownerAlias,
      operatorAlias: input.operatorAlias, compensationCents: p.compensationCents,
      contractTrancheCents: split.contractCents, completionTrancheCents: split.completionCents,
      monthlyRentCents: p.monthlyRentCents, contentHash, preview, status: 'draft' as const
    };
  });
  return {
    sessionId: input.sessionId, projectId: input.projectId, routeId: input.routeId,
    routeVersion: input.routeVersion, agreements,
    packageHash: hash(agreements.map(a => [a.id,a.contentHash]))
  };
}
export function demoSignAgreement(pkg: AgreementPackage, parcelId: string,
  signerAlias: string, signedAt: string): AgreementPackage {
  assert(nonblank(signerAlias) && nonblank(signedAt), 'MISSING_SIGNATURE','Signer and timestamp required');
  const target = pkg.agreements.find(a => a.parcelId === parcelId);
  assert(target && target.status === 'draft', 'BLOCKED_STATE','Only unsigned draft can be signed');
  assert(target.ownerAlias === signerAlias, 'UNAUTHORIZED','Signer must match synthetic owner');
  return { ...pkg, agreements: pkg.agreements.map(a => a.parcelId !== parcelId ? a : {
    ...a, status: 'demo_signed' as const,
    signature: {
      simulation: true as const, agreementId: a.id, contractVersion: a.contractVersion,
      routeVersion: a.routeVersion, termsVersion: a.termsVersion,
      contentHash: a.contentHash, signerAlias, signedAt
    }
  }) };
}
export function supersedePackage(pkg: AgreementPackage): AgreementPackage {
  return { ...pkg, agreements: pkg.agreements.map(a => ({ ...a, status: 'superseded' as const, signature: undefined })) };
}
function validPackage(pkg: AgreementPackage): boolean {
  return pkg.agreements.length > 0 && pkg.agreements.every(a =>
    a.status === 'demo_signed' && a.signature?.contentHash === a.contentHash &&
    a.signature?.routeVersion === pkg.routeVersion &&
    a.signature?.termsVersion === a.termsVersion &&
    a.signature?.contractVersion === a.contractVersion);
}
export function initialFinanceState(pkg: AgreementPackage): FinanceState {
  return { package: pkg, ledger: [], audit: [] };
}
export function approvePackage(state: FinanceState, input: {
  approverId: string; requestedBy: string; approvalId: string; at: string;
  expectedPackageHash: string
}): FinanceState {
  assert(validPackage(state.package), 'UNSIGNED','Every final-route agreement must be signed');
  assert(state.package.packageHash === input.expectedPackageHash, 'STALE_VERSION','Agreement package changed');
  assert(input.approverId !== input.requestedBy && nonblank(input.approverId) &&
    nonblank(input.requestedBy), 'SEGREGATION_OF_DUTIES','Requester cannot approve');
  assert(!state.approval, 'DUPLICATE_APPROVAL','Package already approved');
  const approval: Approval = {
    id: input.approvalId, sessionId: state.package.sessionId,
    packageHash: state.package.packageHash, approverId: input.approverId,
    requestedBy: input.requestedBy, approvedAt: input.at
  };
  return { ...state, approval, audit: [...state.audit, {
    action: 'approval', actor: input.approverId, at: input.at,
    reason: 'All current final-route agreements signed', evidence: [state.package.packageHash]
  }] };
}
function requireApproval(state: FinanceState): void {
  assert(validPackage(state.package) && state.approval &&
    state.approval.packageHash === state.package.packageHash &&
    state.approval.sessionId === state.package.sessionId,
    'STALE_APPROVAL','Current signed package and matching manager approval required');
}
function obligation(state: FinanceState, agreement: Agreement, kind: LedgerEntry['kind'], period?: string): string {
  return [state.package.sessionId, agreement.id, kind, period ?? '-'].join(':');
}
function post(state: FinanceState, a: Agreement, kind: LedgerEntry['kind'],
  expectedCents: number, paidCents: number, at: string, actor: string, period?: string): FinanceState {
  assert(cents(paidCents), 'INVALID_AMOUNT','Paid amount must be safe integer cents');
  const obligationId = obligation(state,a,kind,period);
  assert(!state.ledger.some(e => e.obligationId === obligationId),
    'DUPLICATE_OBLIGATION','Already posted for this business obligation');
  const journal = [
    { account: 'easement_expense', debitCents: paidCents, creditCents: 0 },
    { account: 'simulated_cash', debitCents: 0, creditCents: paidCents }
  ];
  const entry: LedgerEntry = {
    obligationId, sessionId: state.package.sessionId, agreementId: a.id, kind,
    ...(period ? {period} : {}), expectedCents, paidCents,
    status: paidCents === expectedCents ? 'matched' : 'mismatch',
    simulated: true, at, evidence: [a.contentHash, state.approval?.id ?? ''],
    journal
  };
  return { ...state, ledger: [...state.ledger,entry], audit: [...state.audit, {
    action: kind, actor, at, reason: 'Simulated posting; no real funds transferred',
    evidence: [obligationId,a.contentHash]
  }] };
}
export function payContractTranches(state: FinanceState, actor: string, at: string): FinanceState {
  requireApproval(state);
  let next = state;
  for (const a of state.package.agreements) next = post(next,a,'contract_20',a.contractTrancheCents,a.contractTrancheCents,at,actor);
  return next;
}
export function simulateCompletion(state: FinanceState, actor: string, at: string): FinanceState {
  requireApproval(state);
  assert(!state.completionAt, 'DUPLICATE_COMPLETION','Completion already recorded');
  assert(state.package.agreements.every(a => state.ledger.some(e =>
    e.obligationId === obligation(state,a,'contract_20') && e.status === 'matched')),
    'PAYMENT_REQUIRED','All 20% tranches must settle first');
  let next: FinanceState = { ...state, completionAt: at };
  for (const a of state.package.agreements)
    next = post(next,a,'completion_80',a.completionTrancheCents,a.completionTrancheCents,at,actor);
  return next;
}
function plusCalendarMonths(iso: string, months: number): string {
  const d = new Date(iso);
  assert(!Number.isNaN(d.getTime()), 'INVALID_DATE','Valid ISO completion time required');
  const originalDay = d.getUTCDate();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  first.setUTCDate(Math.min(originalDay,lastDay));
  return first.toISOString().slice(0,10);
}
export function rentDueDate(completionAt: string, monthNumber: number): string {
  assert(Number.isInteger(monthNumber) && monthNumber > 0, 'INVALID_PERIOD','Positive month required');
  return plusCalendarMonths(completionAt,monthNumber);
}
export function postMonthlyRent(state: FinanceState, input: {
  monthNumber: number; demoDate: string; actor: string; at: string;
  paidByParcel?: Record<string, number>
}): FinanceState {
  requireApproval(state);
  assert(state.completionAt, 'NOT_COMPLETED','No rent before completion');
  const dueDate = rentDueDate(state.completionAt,input.monthNumber);
  assert(input.demoDate >= dueDate, 'NOT_DUE','Full monthly rent not due yet');
  const period = String(input.monthNumber);
  let next = state;
  for (const a of state.package.agreements) {
    const paid = input.paidByParcel?.[a.parcelId] ?? a.monthlyRentCents;
    next = post(next,a,'monthly_rent',a.monthlyRentCents,paid,input.at,input.actor,period);
  }
  return next;
}
export function reconciliation(state: FinanceState): {
  expectedCents: number; paidCents: number; unmatchedCents: number;
  mismatches: LedgerEntry[]; balanced: boolean
} {
  const expectedCents = state.ledger.reduce((s,e) => s+e.expectedCents,0);
  const paidCents = state.ledger.reduce((s,e) => s+e.paidCents,0);
  return {
    expectedCents, paidCents, unmatchedCents: expectedCents-paidCents,
    mismatches: state.ledger.filter(e => e.status === 'mismatch'),
    balanced: state.ledger.every(e =>
      e.journal.reduce((s,j)=>s+j.debitCents-j.creditCents,0) === 0)
  };
}
/** Pure demo reset; backend must issue a new session and reject late callbacks from prior sessions. */
export function resetDemo(newPackage: AgreementPackage): FinanceState {
  return initialFinanceState(newPackage);
}
