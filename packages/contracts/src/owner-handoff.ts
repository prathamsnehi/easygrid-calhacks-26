import { z } from 'zod';
import { Id, Cents, Version, Revision, Text, Polygon, AccessConsent, NegotiationStatus, DateOnly } from './schemas.ts';

/** Independent, additive fixture contract. This is not an API v1 request or a live service. */
export const MockBanking = z.strictObject({
  ownerId: Id, paymentRecipientRef: Id.regex(/^mock-/), mode: z.literal('simulated'),
  accountHolderAlias: Text, bankDisplay: Text, accountDisplay: z.string().regex(/^\*{4}\d{4}$/),
});
export const HandoffOwner = z.strictObject({
  ownerId: Id, alias: Text, synthetic: z.literal(true),
  contact: z.strictObject({ contactRef: Id.nullable(),
    registration: z.enum(['unregistered', 'registered', 'simulation']), callConsent: z.boolean() }),
  banking: MockBanking,
});
export const HandoffTerms = z.strictObject({
  termsVersion: Version, outcome: NegotiationStatus, accessConsent: AccessConsent,
  explicitConfirmation: z.boolean(), confirmationRef: Id.nullable(),
  compensationCents: Cents, monthlyRentCents: Cents, comparisonRentTotalCents: Cents,
  monthlyRentIsApproximate: z.boolean(),
});
/** A route recommendation is a fixed negotiation basis, not the current counteroffer. */
export const HandoffOfferPolicy = z.strictObject({
  policyId: z.literal('recommended-times-1.2-v1'), basis: z.literal('route-impact-v1'),
  recommendedOfferCents: Cents,
  multiplierNumerator: z.literal(6), multiplierDenominator: z.literal(5),
  rounding: z.literal('floor-cent'),
});
export const HandoffParcel = z.strictObject({
  parcelId: Id, ownerId: Id, landUse: Text, geometry: Polygon,
  areaSqM: z.number().positive().finite(),
  impact: z.strictObject({ towerCount: z.number().int().min(0).max(100000), wireLengthMeters: z.number().min(0).finite() }),
  offerCapCents: Cents, offerPolicy: HandoffOfferPolicy.optional(), terms: HandoffTerms,
});
export const OwnerHandoff = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('easygrid-owner-handoff'), sourceMode: z.literal('fixture'),
  sessionId: Id, projectId: Id, routeId: Id, routeVersion: Version, revision: Revision,
  referenceBinding: z.enum(['local-fixture', 'canonical']), currency: z.literal('USD'),
  routeStatus: z.enum(['selected_for_negotiation', 'ready_for_agreements']),
  rentHorizonMonths: z.number().int().min(1).max(1200), constructionCents: Cents, budgetCents: Cents,
  simulationChecksPassed: z.boolean(), owners: z.array(HandoffOwner).min(1).max(1000),
  parcels: z.array(HandoffParcel).min(1).max(1000),
  userRole: z.strictObject({ ownerId: Id, parcelId: Id }).nullable(),
}).superRefine((packet, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const ownerIds = packet.owners.map(o => o.ownerId), parcelIds = packet.parcels.map(p => p.parcelId);
  if (new Set(ownerIds).size !== ownerIds.length || new Set(parcelIds).size !== parcelIds.length) fail('Owner and parcel IDs must be unique');
  if (new Set(packet.owners.map(o => o.banking.paymentRecipientRef)).size !== packet.owners.length) fail('A mock recipient must belong to exactly one owner');
  for (const owner of packet.owners) {
    if (owner.banking.ownerId !== owner.ownerId) fail('Banking recipient belongs to a different owner');
    if (owner.contact.registration === 'registered' && (!owner.contact.contactRef || !owner.contact.callConsent)) fail('Registered demo contact requires a reference and explicit consent');
    if (owner.contact.registration !== 'registered' && owner.contact.callConsent) fail('An unregistered or simulated reference cannot assert registered call consent');
    if (packet.referenceBinding === 'local-fixture' && owner.contact.registration === 'registered') fail('A local fixture cannot assert canonical contact registration');
  }
  for (const parcel of packet.parcels) {
    if (!ownerIds.includes(parcel.ownerId)) fail('Every parcel must reference an existing owner');
    if (parcel.offerPolicy && Number.isSafeInteger(parcel.offerPolicy.recommendedOfferCents) && parcel.offerPolicy.recommendedOfferCents >= 0) {
      const expectedCap = BigInt(parcel.offerPolicy.recommendedOfferCents) * 6n / 5n;
      if (expectedCap > BigInt(Number.MAX_SAFE_INTEGER)) fail('The 120 percent offer cap exceeds safe integer cents');
      else if (Number.isSafeInteger(parcel.offerCapCents) && BigInt(parcel.offerCapCents) !== expectedCap) fail('The offer cap must be 120 percent of the fixed recommendation, rounded down to cents');
    }
    const exactRent = BigInt(parcel.terms.monthlyRentCents) * BigInt(packet.rentHorizonMonths);
    if (!parcel.terms.monthlyRentIsApproximate && exactRent !== BigInt(parcel.terms.comparisonRentTotalCents)) fail('Exact monthly rent must reconcile to the comparison horizon');
    if (parcel.terms.outcome === 'accepted' && (!parcel.terms.explicitConfirmation || !parcel.terms.confirmationRef || parcel.terms.accessConsent !== 'allowed' || parcel.terms.monthlyRentIsApproximate)) fail('Accepted terms require confirmed access and exact agreed monthly rent');
    if (parcel.terms.outcome === 'refused' && parcel.terms.explicitConfirmation && (!parcel.terms.confirmationRef || parcel.terms.accessConsent !== 'refused')) fail('Confirmed refusal needs refusal evidence and refused access');
    if (!['accepted', 'refused'].includes(parcel.terms.outcome) && parcel.terms.explicitConfirmation) fail('Pending, counteroffer or ambiguous outcomes cannot assert final confirmation');
  }
  if (packet.userRole) {
    const current = packet.parcels.find(p => p.parcelId === packet.userRole!.parcelId);
    if (!ownerIds.includes(packet.userRole.ownerId) || (current && current.ownerId !== packet.userRole.ownerId)) fail('User role must preserve its fictional owner association');
    // A role may be historical after a reroute. Absence from this route never binds a new owner.
  }
});
export type OwnerHandoff = z.infer<typeof OwnerHandoff>;

export const CurrentOfferPolicy = z.strictObject({
  policyId: z.literal('recommended-times-1.2-v1'), basis: z.literal('route-impact-v1'),
  recommendedOfferCents: Cents, offerCapCents: Cents,
});
export const CurrentHandoffState = z.strictObject({
  sessionId: Id, projectId: Id, routeId: Id, routeVersion: Version, revision: Revision,
  termsVersions: z.record(Id, Version),
  offerPolicies: z.record(Id, CurrentOfferPolicy).optional(),
});
export type CurrentHandoffState = z.infer<typeof CurrentHandoffState>;
export const SettlementStage = z.enum(['contract_tranche', 'completion_balance', 'monthly_fee']);
export type SettlementStage = z.infer<typeof SettlementStage>;
export const SettlementContext = z.strictObject({
  current: CurrentHandoffState, approvalId: Id, approved: z.boolean(),
  approvedPackage: z.strictObject({
    sessionId: Id, projectId: Id, routeId: Id, routeVersion: Version,
    termsVersions: z.record(Id, Version), contractVersions: z.record(Id, Version),
  }),
  contracts: z.array(z.strictObject({
    sessionId: Id, projectId: Id, routeId: Id, routeVersion: Version,
    parcelId: Id, ownerId: Id, contractId: Id, contractVersion: Version, termsVersion: Version,
    demoSigned: z.boolean(), paymentRecipientRef: Id.regex(/^mock-/), compensationCents: Cents, monthlyRentCents: Cents,
    rentHorizonMonths: z.number().int().min(1).max(1200),
  })).min(1).max(1000),
  stage: SettlementStage, asOfDate: DateOnly,
  completion: z.strictObject({ completionId: Id, sessionId: Id, projectId: Id, routeId: Id,
    routeVersion: Version, approvalId: Id, completedOn: DateOnly }).nullable(),
  monthlyIndex: z.number().int().min(1).max(1200).optional(),
  settledObligations: z.array(z.strictObject({
    obligationId: z.string().min(1).max(500), sessionId: Id, projectId: Id, routeId: Id, routeVersion: Version,
    parcelId: Id, ownerId: Id, paymentRecipientRef: Id.regex(/^mock-/), termsVersion: Version,
    compensationCents: Cents, monthlyRentCents: Cents, amountCents: Cents,
    rentHorizonMonths: z.number().int().min(1).max(1200), completionId: Id.nullable(), completedOn: DateOnly.nullable(),
  })).max(10000),
});
export type SettlementContext = z.infer<typeof SettlementContext>;

export class HandoffError extends Error {
  code: 'INVALID_INPUT' | 'STALE_VERSION' | 'BLOCKED_STATE';
  constructor(code: HandoffError['code'], message: string) { super(message); this.name = 'HandoffError'; this.code = code; }
}
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HandoffError('INVALID_INPUT', result.error.issues.map(i => i.message).join('; '));
  return result.data;
}
function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HandoffError('BLOCKED_STATE', message);
}
function safeSum(values: number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(parse(Cents, value)), 0n);
  requireState(total <= BigInt(Number.MAX_SAFE_INTEGER), 'The aggregate amount exceeds safe integer cents');
  return Number(total);
}
/** Floor exactly one fifth in integer cents; the second tranche is the exact balance. */
export function splitCompensation(totalCents: number) {
  parse(Cents, totalCents);
  const contractTrancheCents = Number(BigInt(totalCents) / 5n);
  return { contractTrancheCents, completionBalanceCents: totalCents - contractTrancheCents };
}
/** Monthly anniversaries are anchored to completion, with month-end clamping, never drifting. */
export function monthlyFeeDueDate(completedOn: string, monthlyIndex: number): string {
  parse(DateOnly, completedOn); parse(z.number().int().min(1).max(1200), monthlyIndex);
  const [year, month, day] = completedOn.split('-').map(Number) as [number, number, number];
  const monthNumber = year * 12 + month - 1 + monthlyIndex;
  const targetYear = Math.floor(monthNumber / 12), targetMonth = monthNumber % 12 + 1;
  requireState(targetYear <= 9999, 'Due date exceeds the supported calendar');
  const leap = targetYear % 4 === 0 && (targetYear % 100 !== 0 || targetYear % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][targetMonth - 1]!;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, days)).padStart(2, '0')}`;
}
/** JSON tuple avoids delimiter collisions; contract regeneration does not change the obligation. */
export function settlementObligationId(sessionId: string, parcelId: string, stage: SettlementStage, period?: string): string {
  parse(Id, sessionId); parse(Id, parcelId); parse(SettlementStage, stage);
  if (stage === 'monthly_fee') parse(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), period);
  else if (period !== undefined) throw new HandoffError('INVALID_INPUT', 'Only monthly fees have a period');
  return JSON.stringify([sessionId, parcelId, stage, period ?? null]);
}
/**
 * Current state, including fixed offer policies, must come from the authoritative service.
 * Packet arithmetic is not authorization: never populate trusted policies from a submitted
 * counteroffer or allow the calling model to replace the stored recommendation and cap.
 */
export function assertAgreementReady(input: unknown, currentInput: unknown): OwnerHandoff {
  const packet = parse(OwnerHandoff, input), current = parse(CurrentHandoffState, currentInput);
  for (const key of ['sessionId', 'projectId', 'routeId', 'routeVersion', 'revision'] as const) {
    if (packet[key] !== current[key]) throw new HandoffError('STALE_VERSION', `Current ${key} does not match the packet`);
  }
  const ids = packet.parcels.map(p => p.parcelId);
  if (Object.keys(current.termsVersions).length !== ids.length || packet.parcels.some(p => current.termsVersions[p.parcelId] !== p.terms.termsVersion)) throw new HandoffError('STALE_VERSION', 'Current parcel terms versions do not match the complete route');
  const policyParcels = packet.parcels.filter(p => p.offerPolicy), trustedPolicies = current.offerPolicies ?? {};
  if (Object.keys(trustedPolicies).length !== policyParcels.length || policyParcels.some(parcel => {
    const trusted = trustedPolicies[parcel.parcelId], policy = parcel.offerPolicy!;
    return !trusted || trusted.policyId !== policy.policyId || trusted.basis !== policy.basis ||
      trusted.recommendedOfferCents !== policy.recommendedOfferCents || trusted.offerCapCents !== parcel.offerCapCents;
  })) throw new HandoffError('STALE_VERSION', 'Fixed offer policies do not match the authoritative route recommendation');
  requireState(packet.routeStatus === 'ready_for_agreements', 'Route is still selected for negotiation');
  requireState(packet.simulationChecksPassed, 'Simulation constraints have not passed');
  requireState(packet.parcels.every(p => p.terms.outcome === 'accepted'), 'Every affected parcel must have accepted current terms');
  requireState(packet.parcels.every(p => p.terms.compensationCents <= p.offerCapCents), 'An accepted amount exceeds its parcel cap');
  const total = safeSum([packet.constructionCents, ...packet.parcels.flatMap(p => [p.terms.compensationCents, p.terms.comparisonRentTotalCents])]);
  requireState(total <= packet.budgetCents, 'The accepted route exceeds the project budget');
  return packet;
}

/** Read-only calling context: never contains banking or an actual phone number, never dials. */
export function createVoiceHandoff(input: unknown) {
  const packet = parse(OwnerHandoff, input);
  const roleOnRoute = !!packet.userRole && packet.parcels.some(p => p.parcelId === packet.userRole!.parcelId && p.ownerId === packet.userRole!.ownerId);
  return {
    schemaVersion: 1 as const, kind: 'easygrid-voice-context' as const, sourceMode: 'fixture' as const,
    sessionId: packet.sessionId, projectId: packet.projectId, routeId: packet.routeId,
    routeVersion: packet.routeVersion, revision: packet.revision, referenceBinding: packet.referenceBinding,
    simulationChecksPassed: packet.simulationChecksPassed,
    currency: packet.currency, userRole: packet.userRole, roleOnRoute,
    parcels: packet.parcels.map(p => {
      const owner = packet.owners.find(o => o.ownerId === p.ownerId)!;
      return { parcelId: p.parcelId, ownerId: p.ownerId, ownerAlias: owner.alias,
        contact: { ...owner.contact }, offerCapCents: p.offerCapCents,
        ...(p.offerPolicy ? { offerPolicy: { ...p.offerPolicy } } : {}),
        impact: { ...p.impact }, terms: { ...p.terms } };
    }),
    note: 'Context only. The host must verify current session, role, consent and contact registration before any call.',
  };
}

/** Pure plan over trusted fixture inputs. No provider, persistence, authorization or payment execution. */
export function createSettlementPlan(input: unknown, contextInput: unknown) {
  const context = parse(SettlementContext, contextInput), packet = assertAgreementReady(input, context.current);
  requireState(context.approved, 'Operator approval is required');
  requireState(['sessionId', 'projectId', 'routeId', 'routeVersion'].every(key => context.approvedPackage[key as 'sessionId' | 'projectId' | 'routeId' | 'routeVersion'] === packet[key as 'sessionId' | 'projectId' | 'routeId' | 'routeVersion']), 'Approval belongs to a stale session or route');
  requireState(Object.keys(context.approvedPackage.termsVersions).length === packet.parcels.length && packet.parcels.every(p => context.approvedPackage.termsVersions[p.parcelId] === p.terms.termsVersion), 'Approval does not bind the complete current terms');
  requireState(context.contracts.length === packet.parcels.length && new Set(context.contracts.map(c => c.parcelId)).size === packet.parcels.length && new Set(context.contracts.map(c => c.contractId)).size === context.contracts.length, 'Approval must cover exactly one current contract for every affected parcel');
  requireState(Object.keys(context.approvedPackage.contractVersions).length === context.contracts.length && context.contracts.every(c => context.approvedPackage.contractVersions[c.contractId] === c.contractVersion), 'Approval does not bind the current contract versions');
  for (const parcel of packet.parcels) {
    const contract = context.contracts.find(c => c.parcelId === parcel.parcelId);
    const owner = packet.owners.find(o => o.ownerId === parcel.ownerId)!;
    requireState(contract && contract.sessionId === packet.sessionId && contract.projectId === packet.projectId && contract.routeId === packet.routeId && contract.routeVersion === packet.routeVersion && contract.ownerId === parcel.ownerId && contract.termsVersion === parcel.terms.termsVersion && contract.demoSigned && contract.paymentRecipientRef === owner.banking.paymentRecipientRef && contract.compensationCents === parcel.terms.compensationCents && contract.monthlyRentCents === parcel.terms.monthlyRentCents && contract.rentHorizonMonths === packet.rentHorizonMonths, 'Contract binding, signature, approved terms or banking association does not match the current parcel');
  }
  const settled = new Map(context.settledObligations.map(record => [record.obligationId, record]));
  requireState(settled.size === context.settledObligations.length, 'Settled obligation IDs must be unique');
  let settledRentPeriods: Set<string> | undefined;
  // Once money is settled, the demo freezes its route, owner and agreed amount basis.
  // Changes need a separate adjustment/refund workflow, which this planner does not implement.
  for (const record of settled.values()) {
    const parcel = packet.parcels.find(p => p.parcelId === record.parcelId);
    requireState(parcel, 'Settled records from another route require reconciliation before further settlement');
    const owner = packet.owners.find(o => o.ownerId === parcel.ownerId)!;
    requireState(record.sessionId === packet.sessionId && record.projectId === packet.projectId && record.routeId === packet.routeId && record.routeVersion === packet.routeVersion && record.ownerId === parcel.ownerId && record.termsVersion === parcel.terms.termsVersion && record.compensationCents === parcel.terms.compensationCents && record.monthlyRentCents === parcel.terms.monthlyRentCents && record.paymentRecipientRef === owner.banking.paymentRecipientRef && record.rentHorizonMonths === packet.rentHorizonMonths, 'Already settled terms, route, horizon or recipient changed; an adjustment workflow is required');
    const parts = splitCompensation(parcel.terms.compensationCents);
    const initialId = settlementObligationId(packet.sessionId, parcel.parcelId, 'contract_tranche');
    const balanceId = settlementObligationId(packet.sessionId, parcel.parcelId, 'completion_balance');
    let expectedAmount: number;
    if (record.obligationId === initialId) {
      requireState(record.completionId === null && record.completedOn === null, 'Contract tranche must not claim completion');
      expectedAmount = parts.contractTrancheCents;
    }
    else if (record.obligationId === balanceId) expectedAmount = parts.completionBalanceCents;
    else {
      let tuple: unknown;
      try { tuple = JSON.parse(record.obligationId); } catch { throw new HandoffError('BLOCKED_STATE', 'Unknown settled business obligation'); }
      requireState(Array.isArray(tuple) && tuple.length === 4 && tuple[0] === packet.sessionId && tuple[1] === parcel.parcelId && tuple[2] === 'monthly_fee' && typeof tuple[3] === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(tuple[3]) && record.obligationId === settlementObligationId(packet.sessionId, parcel.parcelId, 'monthly_fee', tuple[3]), 'Unknown settled business obligation');
      requireState(context.completion, 'Settled monthly obligation requires its completion event');
      settledRentPeriods ??= new Set(Array.from({ length: packet.rentHorizonMonths }, (_, index) => monthlyFeeDueDate(context.completion!.completedOn, index + 1).slice(0, 7)));
      requireState(settledRentPeriods.has(tuple[3]), 'Settled monthly obligation is outside the completion-anchored horizon');
      expectedAmount = parcel.terms.monthlyRentCents;
    }
    if (record.obligationId !== initialId) {
      requireState(context.completion && record.completionId !== null && record.completedOn !== null && record.completionId === context.completion.completionId && record.completedOn === context.completion.completedOn, 'Settled completion identity or date changed; an adjustment workflow is required');
    }
    requireState(record.amountCents === expectedAmount, 'Settled amount does not match the approved obligation');
  }
  let dueOn = context.asOfDate;
  if (context.stage !== 'monthly_fee' && context.monthlyIndex !== undefined) throw new HandoffError('INVALID_INPUT', 'Only monthly fees accept a monthly index');
  if (context.stage !== 'contract_tranche') {
    const completion = context.completion;
    requireState(completion, 'Completion is required before balance or monthly payment');
    requireState(completion.sessionId === packet.sessionId && completion.projectId === packet.projectId && completion.routeId === packet.routeId && completion.routeVersion === packet.routeVersion && completion.approvalId === context.approvalId, 'Completion belongs to a stale route or approval');
    requireState(completion.completedOn <= context.asOfDate, 'Completion has not occurred on the demo clock');
    requireState(packet.parcels.every(p => settled.has(settlementObligationId(packet.sessionId, p.parcelId, 'contract_tranche'))), 'All contract tranches must settle before the completion balance');
    dueOn = completion.completedOn;
    if (context.stage === 'monthly_fee') {
      requireState(context.monthlyIndex !== undefined, 'Monthly fee requires its period index');
      requireState(context.monthlyIndex <= packet.rentHorizonMonths, 'Monthly index exceeds the contracted example horizon');
      requireState(packet.parcels.every(p => settled.has(settlementObligationId(packet.sessionId, p.parcelId, 'completion_balance'))), 'All completion balances must settle before monthly fees');
      dueOn = monthlyFeeDueDate(completion.completedOn, context.monthlyIndex);
      requireState(dueOn <= context.asOfDate, 'The monthly fee is not yet due');
    }
  }
  const alreadySettledObligationIds: string[] = [];
  const entries = packet.parcels.flatMap(parcel => {
    const contract = context.contracts.find(c => c.parcelId === parcel.parcelId)!;
    const parts = splitCompensation(parcel.terms.compensationCents);
    const amountCents = context.stage === 'contract_tranche' ? parts.contractTrancheCents : context.stage === 'completion_balance' ? parts.completionBalanceCents : parcel.terms.monthlyRentCents;
    const obligationId = settlementObligationId(packet.sessionId, parcel.parcelId, context.stage, context.stage === 'monthly_fee' ? dueOn.slice(0, 7) : undefined);
    if (settled.has(obligationId)) { alreadySettledObligationIds.push(obligationId); return []; }
    return [{ parcelId: parcel.parcelId, ownerId: parcel.ownerId, contractId: contract.contractId,
      contractVersion: contract.contractVersion, termsVersion: contract.termsVersion,
      paymentRecipientRef: contract.paymentRecipientRef, obligationId, amountCents, dueOn,
      rentHorizonMonths: packet.rentHorizonMonths,
      completionId: context.stage === 'contract_tranche' ? null : context.completion!.completionId,
      completedOn: context.stage === 'contract_tranche' ? null : context.completion!.completedOn }];
  });
  requireState(entries.length > 0, 'Every business obligation in this stage is already settled');
  return { mode: 'simulated' as const, status: 'planned' as const, sessionId: packet.sessionId,
    projectId: packet.projectId, routeId: packet.routeId, routeVersion: packet.routeVersion,
    approvalId: context.approvalId, stage: context.stage, currency: packet.currency,
    entries, alreadySettledObligationIds, totalCents: safeSum(entries.map(e => e.amountCents)) };
}

export const ownerHandoffSchemas = { OwnerHandoff, CurrentHandoffState, SettlementContext } as const;
