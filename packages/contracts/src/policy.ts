import { z } from 'zod';
import { ContractError } from './api.ts';
import * as s from './schemas.ts';

/** Port of the existing Gridline cents conversion: reject fractional cents, never silently round. */
export function dollarsToCents(dollars: number): number {
  const value = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(value) || value / 100 !== dollars)
    throw new ContractError('INVALID_INPUT', 'Dollars must convert exactly to safe integer cents');
  return value;
}
function sum(values: number[]): number {
  return values.reduce((total, v) => {
    s.Cents.parse(v);
    const next = total + v;
    if (!Number.isSafeInteger(next)) throw new ContractError('INVALID_INPUT', 'Cost exceeds safe integer range');
    return next;
  }, 0);
}
export function assertRevision(current: number, expected: number): void {
  s.Revision.parse(current); s.Revision.parse(expected);
  if (current !== expected) throw new ContractError('STALE_REVISION', 'Reload the project and reevaluate the command');
}
export function assertVersion(current: number, expected: number): void {
  s.Version.parse(current); s.Version.parse(expected);
  if (current !== expected) throw new ContractError('STALE_VERSION', 'The referenced route, terms or contract version is stale');
}
/** Same canonical ordering as the existing Convex request-fingerprint helper; JSON values only. */
export function canonicalJson(value: unknown): string {
  const parsed = z.json().parse(value);
  function canonical(v: z.infer<ReturnType<typeof z.json>>): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k]!)}`).join(',')}}`;
    return JSON.stringify(v);
  }
  return canonical(parsed);
}
export type IdempotencyRecord<T> = { fingerprint: string; response: T };
/** Run BEFORE stale-revision checks. Persist this record atomically with the mutation in SpacetimeDB. */
export function replay<T>(record: IdempotencyRecord<T> | undefined, request: unknown): T | undefined {
  if (!record) return undefined;
  if (record.fingerprint !== canonicalJson(request))
    throw new ContractError('IDEMPOTENCY_CONFLICT', 'Key already used with different command content');
  return structuredClone(record.response);
}
export function deduplicateEvents(events: z.infer<typeof s.AuditEvent>[]) {
  const seen = new Map<string, z.infer<typeof s.AuditEvent>>();
  for (const raw of events) {
    const event = s.AuditEvent.parse(raw), prior = seen.get(event.eventId);
    if (prior && canonicalJson(prior) !== canonicalJson(event))
      throw new ContractError('IDEMPOTENCY_CONFLICT', 'Event ID reused with different content');
    seen.set(event.eventId, event);
  }
  return [...seen.values()];
}
export function validateTerms(terms: z.infer<z.ZodObject<typeof s.Terms>>): void {
  z.strictObject(s.Terms).parse(terms);
  if (terms.depositCreditPolicy === 'credited_to_upfront' && terms.depositCents > terms.upfrontCents)
    throw new ContractError('INVALID_INPUT', 'Credited deposit cannot exceed upfront compensation');
}
export function validateNegotiation(raw: unknown, offerCapCents: number): s.NegotiationResult {
  const value = s.NegotiationResult.parse(raw);
  const { upfrontCents, depositCents, depositCreditPolicy, monthlyRentCents, termMonths } = value;
  validateTerms({ upfrontCents, depositCents, depositCreditPolicy, monthlyRentCents, termMonths });
  s.Cents.parse(offerCapCents);
  if (value.outcome === 'accepted' && (value.accessConsent !== 'allowed' || !value.explicitConfirmation ||
      value.evidenceRefs.length === 0 || sum([upfrontCents, depositCreditPolicy === 'separate_charge' ? depositCents : 0]) > offerCapCents))
    throw new ContractError('BLOCKED_STATE', 'Acceptance requires verified consent, evidence, confirmation and terms within the upfront offer cap');
  if (value.outcome === 'refused' && value.accessConsent !== 'refused')
    throw new ContractError('INVALID_INPUT', 'Refusal must record refused access');
  return value;
}
export type ParcelTerms = z.infer<z.ZodObject<typeof s.Terms>> & { parcelId: string };
export function calculateCost(constructionCents: number, terms: ParcelTerms[], rentHorizonMonths: number) {
  z.number().int().min(1).max(1200).parse(rentHorizonMonths);
  const unique = new Map<string, ParcelTerms>();
  for (const item of terms) {
    s.Id.parse(item.parcelId);
    const { parcelId, ...amounts } = item; validateTerms(amounts);
    const prior = unique.get(parcelId);
    if (prior && canonicalJson(prior) !== canonicalJson(item))
      throw new ContractError('INVALID_INPUT', 'Conflicting terms for one parcel');
    unique.set(parcelId, item);
  }
  const all = [...unique.values()];
  const upfrontCompensationCents = sum(all.map(v => v.upfrontCents));
  const recurringRentTotalCents = sum(all.map(v => v.monthlyRentCents * Math.min(v.termMonths, rentHorizonMonths)));
  const separateDepositTotalCents = sum(all.map(v => v.depositCreditPolicy === 'separate_charge' ? v.depositCents : 0));
  return { constructionCents, upfrontCompensationCents, recurringRentTotalCents, separateDepositTotalCents,
    totalCostCents: sum([constructionCents, upfrontCompensationCents, recurringRentTotalCents, separateDepositTotalCents]) };
}
/** Inputs must come from the authoritative store, never from client-supplied derived flags. */
export function assertApprovable(project: s.Project, route: s.RouteCandidate, contracts: s.Easement[],
  results: s.NegotiationResult[], parcels: s.Parcel[]): void {
  s.Project.parse(project); s.RouteCandidate.parse(route);
  if (route.projectId !== project.id || project.selectedRouteId !== route.id || !route.eligible || !route.readyToApprove ||
      route.totalCostCents > project.budgetCents || route.regulatoryChecks.length === 0 || route.regulatoryChecks.some(c => c.outcome !== 'pass' || c.missingEvidence.length > 0))
    throw new ContractError('BLOCKED_STATE', 'Current route, consent and preliminary screening must be complete');
  if (contracts.length !== route.parcelIds.length || new Set(contracts.map(c => c.parcelId)).size !== contracts.length)
    throw new ContractError('BLOCKED_STATE', 'Require one current signed contract per crossed parcel');
  for (const parcelId of route.parcelIds) {
    const c = contracts.find(c => c.parcelId === parcelId), p = parcels.find(p => p.id === parcelId);
    const n = results.find(n => n.parcelId === parcelId);
    if (!c || !p || !n) throw new ContractError('BLOCKED_STATE', 'Missing current parcel, terms or contract');
    s.Easement.parse(c); s.Parcel.parse(p); validateNegotiation(n, p.offerCapCents);
    if (c.projectId !== project.id || p.projectId !== project.id || n.projectId !== project.id ||
        c.routeId !== route.id || c.routeVersion !== route.version || n.routeVersion !== route.version ||
        c.termsVersion !== n.termsVersion || c.status !== 'demo_signed' || !c.signedAt ||
        n.outcome !== 'accepted' || p.accessConsent !== 'allowed' || p.negotiationStatus !== 'accepted' ||
        c.effectiveEndDate <= c.effectiveStartDate || c.signedAt > c.effectiveEndDate + 'T23:59:59Z')
      throw new ContractError('BLOCKED_STATE', 'Consent, current terms and demo signatures are distinct required gates');
    for (const key of Object.keys(s.Terms) as (keyof typeof s.Terms)[]) {
      if (c[key] !== n[key]) throw new ContractError('STALE_VERSION', 'Contract does not match agreed terms');
    }
  }
  const computed = calculateCost(route.constructionCents, contracts.map(c => ({ parcelId: c.parcelId,
    upfrontCents: c.upfrontCents, depositCents: c.depositCents, depositCreditPolicy: c.depositCreditPolicy,
    monthlyRentCents: c.monthlyRentCents, termMonths: c.termMonths })), project.rentHorizonMonths);
  if (Object.entries(computed).some(([key, value]) => route[key as keyof s.RouteCandidate] !== value))
    throw new ContractError('BLOCKED_STATE', 'Route cost must match the current immutable terms');
}
export function paymentAmount(contract: s.Easement, approval: s.Approval, kind: 'deposit' | 'rent', installmentPeriod?: string): number {
  s.Easement.parse(contract); s.Approval.parse(approval);
  if (!approval.valid || contract.status !== 'demo_signed' || !contract.signedAt ||
      contract.projectId !== approval.projectId || contract.routeId !== approval.routeId ||
      contract.routeVersion !== approval.routeVersion || !approval.contractIds.includes(contract.id) ||
      approval.contractVersions[contract.id] !== contract.contractVersion || approval.termsVersions[contract.parcelId] !== contract.termsVersion)
    throw new ContractError('BLOCKED_STATE', 'Payment requires the currently approved, demo-signed contract version');
  if (kind === 'deposit') {
    if (installmentPeriod !== undefined) throw new ContractError('INVALID_INPUT', 'Deposit has no rent installment period');
    return contract.depositCents;
  }
  // v1 demo rent: full calendar months, no proration. The start date must be the first of a month.
  if (!installmentPeriod || !/^\d{4}-(0[1-9]|1[0-2])$/.test(installmentPeriod) || !contract.effectiveStartDate.endsWith('-01'))
    throw new ContractError('INVALID_INPUT', 'Rent requires a valid calendar installment and month-aligned contract');
  const month = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));
  const offset = month(installmentPeriod) - month(contract.effectiveStartDate);
  if (offset < 0 || offset >= contract.termMonths || installmentPeriod > contract.effectiveEndDate.slice(0, 7))
    throw new ContractError('BLOCKED_STATE', 'Installment is outside the contract term');
  return contract.monthlyRentCents;
}
