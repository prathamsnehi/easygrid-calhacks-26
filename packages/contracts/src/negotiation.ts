import { z } from 'zod';
import { Cents, Id, Version, NegotiationStatus, AccessConsent } from './schemas.ts';
import { OwnerHandoff, CurrentHandoffState, assertAgreementReady } from './owner-handoff.ts';
import { canonicalJson } from './policy.ts';

export const NEGOTIATION_CONNECTED_LIMIT_MS = 60_000;
export const NEGOTIATION_TARGET_SECONDS = [30, 45] as const;
export const NegotiationReason = z.enum([
  'AGREED', 'PRICE_REJECTED', 'ACCESS_REFUSED', 'DO_NOT_CALL', 'UNCLEAR_RESPONSE',
  'ADDITIONAL_CONDITIONS', 'DISCONNECTED', 'NO_ANSWER', 'BUSY', 'SERVICE_UNAVAILABLE',
  'CONNECTION_UNKNOWN', 'TRANSCRIPT_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MALFORMED_OUTPUT',
  'CONFLICTING_EVIDENCE', 'TIME_LIMIT', 'BUDGET_CHANGED', 'TERMS_CHANGED',
]);
export type NegotiationReason = z.infer<typeof NegotiationReason>;
export const NegotiationSummary = z.strictObject({
  attemptId: Id, sessionId: Id, projectId: Id, routeId: Id, routeVersion: Version,
  parcelId: Id, ownerId: Id, termsVersion: Version, mode: z.enum(['live', 'simulated']),
  outcome: NegotiationStatus, accessConsent: AccessConsent,
  disposition: z.enum(['successful', 'unsuccessful', 'needs_review']), reason: NegotiationReason,
  explanation: z.string().min(1).max(800), requestedCents: Cents.nullable(),
  offeredCents: Cents.nullable(), agreedCents: Cents.nullable(), monthlyRentCents: Cents,
  evidenceRefs: z.array(Id).max(100), nextAction: z.enum(['continue', 'stop']),
});
export type NegotiationSummary = z.infer<typeof NegotiationSummary>;
export const NegotiationTurn = z.strictObject({
  id: Id, role: z.enum(['agent', 'owner']), text: z.string().min(1).max(10_000),
  startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
}).refine(t => t.endMs >= t.startMs, 'Turn end precedes start');
export type NegotiationTurn = z.infer<typeof NegotiationTurn>;
// Technical call/review failures come from the host, never from model extraction.
export const NegotiationCandidate = z.strictObject({
  reason: z.enum(['AGREED', 'PRICE_REJECTED', 'ACCESS_REFUSED', 'DO_NOT_CALL',
    'UNCLEAR_RESPONSE', 'ADDITIONAL_CONDITIONS', 'CONFLICTING_EVIDENCE']), offerTurnId: Id.nullable(), ownerTurnId: Id.nullable(),
  compensationCents: Cents.nullable(), monthlyRentCents: Cents.nullable(),
});
export type NegotiationCandidate = z.infer<typeof NegotiationCandidate>;
export type NegotiationOffer = { termsVersion: number; compensationCents: number; monthlyRentCents: number; final: boolean };
export type NegotiationAttempt = {
  attemptId: string; sessionId: string; projectId: string; routeId: string; routeVersion: number;
  parcelId: string; ownerId: string; mode: 'live' | 'simulated';
  recommendationCents: number; capCents: number; monthlyRentCents: number;
  offers: NegotiationOffer[]; finalOfferUsed: boolean; requestedCents: number | null;
  phase: 'negotiating' | 'confirming' | 'finished';
  response: { kind: 'agree' | 'price_rejected' | 'unclear' | 'conditions'; turnId: string | null } | null;
  turns: NegotiationTurn[]; summary: NegotiationSummary | null;
};
/** A reducer snapshot, NOT a store. CAL-29 reads/writes this in one transaction. */
export type NegotiationState = {
  active: boolean; liveCallLocked: boolean; workflow: 'negotiating' | 'stopped';
  handoff: OwnerHandoff; current: CurrentHandoffState;
  attempts: Record<string, NegotiationAttempt>;
  receipts: Record<string, { fingerprint: string; result: NegotiationAttempt }>;
};
const Envelope = { attemptId: Id, requestId: Id, routeVersion: Version, termsVersion: Version };
export const NegotiationCommand = z.discriminatedUnion('kind', [
  z.strictObject({ ...Envelope, kind: z.literal('prepare'), parcelId: Id, mode: z.enum(['live', 'simulated']) }),
  z.strictObject({ ...Envelope, kind: z.literal('counteroffer'), requestedCents: Cents.nullable() }),
  z.strictObject({ ...Envelope, kind: z.literal('response'), response: z.enum(['agree', 'price_rejected', 'unclear', 'conditions']), turnId: Id.nullable().default(null) }),
  z.strictObject({ ...Envelope, kind: z.literal('refusal'), reason: z.enum(['ACCESS_REFUSED', 'DO_NOT_CALL']), turnId: Id.nullable().default(null) }),
  z.strictObject({ ...Envelope, kind: z.literal('finalize'), candidate: NegotiationCandidate }),
  z.strictObject({ ...Envelope, kind: z.literal('failure'), reason: z.enum([
    'DISCONNECTED', 'NO_ANSWER', 'BUSY', 'SERVICE_UNAVAILABLE', 'CONNECTION_UNKNOWN',
    'TRANSCRIPT_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MALFORMED_OUTPUT', 'TIME_LIMIT',
  ]) }),
]);
export type NegotiationCommand = z.infer<typeof NegotiationCommand>;
export class NegotiationError extends Error {
  constructor(publicCode: 'INVALID_INPUT' | 'STALE_VERSION' | 'BLOCKED_STATE' | 'IDEMPOTENCY_CONFLICT', message: string) {
    super(message); this.name = 'NegotiationError'; this.code = publicCode;
  }
  code: 'INVALID_INPUT' | 'STALE_VERSION' | 'BLOCKED_STATE' | 'IDEMPOTENCY_CONFLICT';
}
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new NegotiationError('BLOCKED_STATE', message);
}
function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new NegotiationError('INVALID_INPUT', 'Amount exceeds safe integer cents');
  return Number(value);
}
export function freezeNegotiationMonthlyTerms(input: OwnerHandoff): OwnerHandoff {
  const packet = structuredClone(OwnerHandoff.parse(input));
  for (const p of packet.parcels) {
    p.terms.comparisonRentTotalCents = safe(BigInt(p.terms.monthlyRentCents) * BigInt(packet.rentHorizonMonths));
    p.terms.monthlyRentIsApproximate = false;
  }
  return OwnerHandoff.parse(packet);
}
/** Reserves all other accepted/offered/baseline amounts, plus every fixed monthly fee. */
export function permittedNegotiationMaximum(input: OwnerHandoff, parcelId: string): number {
  const packet = OwnerHandoff.parse(input), parcel = packet.parcels.find(p => p.parcelId === parcelId);
  requireValue(parcel?.offerPolicy, 'A trusted fixed recommendation is required');
  let reserved = BigInt(packet.constructionCents);
  for (const p of packet.parcels) {
    reserved += BigInt(p.terms.monthlyRentCents) * BigInt(packet.rentHorizonMonths);
    if (p.parcelId !== parcelId) reserved += BigInt(Math.max(p.terms.compensationCents, p.offerPolicy?.recommendedOfferCents ?? p.terms.compensationCents));
  }
  const remaining = BigInt(packet.budgetCents) - reserved;
  return remaining <= 0n ? 0 : safe(remaining < BigInt(parcel.offerCapCents) ? remaining : BigInt(parcel.offerCapCents));
}
function assertCurrent(state: NegotiationState) {
  const p = OwnerHandoff.parse(state.handoff), c = CurrentHandoffState.parse(state.current);
  for (const key of ['sessionId', 'projectId', 'routeId', 'routeVersion', 'revision'] as const) {
    if (p[key] !== c[key]) throw new NegotiationError('STALE_VERSION', 'The authoritative route binding changed');
  }
  requireValue(state.active, 'This demo session is closed');
  requireValue(p.referenceBinding === 'canonical', 'Import and bind the map on the server before negotiating');
  requireValue(p.simulationChecksPassed, 'Parcel estimates need review before negotiation');
  requireValue(Object.keys(c.termsVersions).length === p.parcels.length && Object.keys(c.offerPolicies ?? {}).length === p.parcels.length,
    'The complete authoritative route policy is required');
  for (const parcel of p.parcels) {
    const trusted = c.offerPolicies?.[parcel.parcelId];
    requireValue(parcel.offerPolicy && trusted && trusted.policyId === parcel.offerPolicy.policyId &&
      trusted.basis === parcel.offerPolicy.basis && trusted.recommendedOfferCents === parcel.offerPolicy.recommendedOfferCents &&
      trusted.offerCapCents === parcel.offerCapCents && c.termsVersions[parcel.parcelId] === parcel.terms.termsVersion,
    'Route terms or fixed recommendation do not match authoritative state');
  }
}
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export function negotiationExplanation(reason: NegotiationReason, facts: {
  requestedCents: number | null; offeredCents: number | null; maximumCents: number; monthlyRentCents: number; finalOfferCommunicated?: boolean;
}): string {
  const { requestedCents: requested, offeredCents: offered } = facts;
  const offer = offered === null ? `the permitted maximum was ${money(facts.maximumCents)}` : `our ${facts.finalOfferCommunicated ? 'final ' : ''}offer was ${money(offered)}`;
  switch (reason) {
    case 'AGREED': return `Owner agreed to ${money(offered!)} plus ${money(facts.monthlyRentCents)}/month.`;
    case 'PRICE_REJECTED': return `${requested === null ? 'Owner declined the available price' : `Owner requested ${money(requested)}`}; ${offer}. Price too high.`;
    case 'ACCESS_REFUSED': return 'Owner declined transmission access across their land. Not interested.';
    case 'DO_NOT_CALL': return 'Owner requested no further calls. Conversation ended.';
    case 'DISCONNECTED': return `Call disconnected${offered === null ? '' : ` after the ${money(offered)} offer`}, before the owner confirmed. Agreement unknown.`;
    case 'NO_ANSWER': return 'The owner did not answer the call. No agreement was reached.';
    case 'BUSY': return 'The destination was busy. No conversation was confirmed.';
    case 'SERVICE_UNAVAILABLE': return 'The call service was unavailable. No agreement could be confirmed.';
    case 'CONNECTION_UNKNOWN': return 'The call request had an uncertain connection outcome. Check its status before another call.';
    case 'TRANSCRIPT_UNAVAILABLE': return 'The call ended, but its transcript was unavailable. Agreement could not be verified.';
    case 'MODEL_TIMEOUT': return 'The transcript review exceeded its time limit. Agreement could not be verified.';
    case 'MODEL_UNAVAILABLE': return 'The transcript review service did not finish. Agreement could not be verified.';
    case 'MALFORMED_OUTPUT': return 'The transcript review returned an invalid result. Agreement could not be verified.';
    case 'ADDITIONAL_CONDITIONS': return 'Owner requested additional conditions. No unconditional agreement was reached.';
    case 'CONFLICTING_EVIDENCE': return 'The recorded offer and owner responses did not support one clear agreement. Needs review.';
    case 'TIME_LIMIT': return 'The call reached its time limit before a clear agreement was confirmed. Needs review.';
    case 'BUDGET_CHANGED': return 'The remaining project budget no longer covers the offer. Agreement was not recorded.';
    case 'TERMS_CHANGED': return 'The route or payment terms changed during the call. The old offer cannot be accepted.';
    default: return `Owner’s response${offered === null ? '' : ` to the ${money(offered)} offer`} was unclear. Agreement could not be confirmed.`;
  }
}
function spokenOffer(attempt: NegotiationAttempt): NegotiationOffer | null {
  return [...attempt.offers].reverse().find(offer => attempt.turns.some(t => t.role === 'agent' && turnStatesOffer(t.text, offer))) ?? null;
}
/** Exact numeric money mentions; conservative by design, ambiguous speech needs review. */
const spokenNumbers: Record<string, number> = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90,
};
function spokenInteger(words: string): bigint {
  let total = 0n, group = 0n;
  for (const word of words.toLowerCase().split(/[ -]+/)) {
    if (word === 'and') continue;
    if (word === 'hundred') group *= 100n;
    else if (word === 'thousand' || word === 'million' || word === 'billion') {
      total += group * ({thousand:1000n,million:1_000_000n,billion:1_000_000_000n}[word]!); group = 0n;
    } else group += BigInt(spokenNumbers[word]!);
  }
  return total + group;
}
function moneyMentions(text: string): bigint[] {
  const mentions: { index: number; value: bigint }[] = [];
  for (const m of text.matchAll(/(?:\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:US\s*)?dollars?\b)/gi)) {
    const [whole, fraction = ''] = (m[1] ?? m[2]!).replaceAll(',', '').split('.');
    mentions.push({ index: m.index, value: BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) });
  }
  const word = `(?:${Object.keys(spokenNumbers).join('|')}|hundred|thousand|million|billion|and)`;
  const pattern = new RegExp(`\\b(${word}(?:[ -]+${word})*)\\s+dollars?\\b(?:\\s+and\\s+(${word}(?:[ -]+${word})*)\\s+cents?\\b)?`, 'gi');
  for (const m of text.matchAll(pattern)) {
    const cents = m[2] ? spokenInteger(m[2]) : 0n;
    if (cents < 100n) mentions.push({ index: m.index, value: spokenInteger(m[1]!) * 100n + cents });
  }
  return mentions.sort((a,b) => a.index - b.index).map(m => m.value);
}
export function turnStatesOffer(text: string, offer: Pick<NegotiationOffer, 'compensationCents' | 'monthlyRentCents'>): boolean {
  const amounts = moneyMentions(text);
  return !/(?:\b(?:cannot|can't|won't|unable to|not able to)\s+(?:\w+\s+){0,3}(?:offer|pay|agree|provide)|\bnot\s+(?:offering|paying|proposing)|\b(?:if|unless|provided that|conditional on)\b)/i.test(text) &&
    amounts.length === 2 && amounts[0] === BigInt(offer.compensationCents) && amounts[1] === BigInt(offer.monthlyRentCents) && /month/i.test(text);
}
function finish(state: NegotiationState, a: NegotiationAttempt, reason: NegotiationReason, refs: string[] = [], detail?: string) {
  const success = reason === 'AGREED', unsuccessful = ['PRICE_REJECTED', 'ACCESS_REFUSED', 'DO_NOT_CALL'].includes(reason);
  const last = a.offers.at(-1)!, spoken = spokenOffer(a);
  // Tool arguments can guide a bounded proposal, but cannot invent facts in its summary.
  const requested = a.requestedCents !== null && a.turns.some(t => t.role === 'owner' &&
    moneyMentions(t.text).some(value => value === BigInt(a.requestedCents!))) ? a.requestedCents : null;
  const access = reason === 'ACCESS_REFUSED' || reason === 'DO_NOT_CALL' ? 'refused' : success ? 'allowed' : 'unknown';
  const summary = NegotiationSummary.parse({
    ...Object.fromEntries(['attemptId', 'sessionId', 'projectId', 'routeId', 'routeVersion', 'parcelId', 'ownerId', 'mode'].map(k => [k, a[k as keyof NegotiationAttempt]])),
    termsVersion: last.termsVersion, outcome: success ? 'accepted' : unsuccessful ? 'refused' : 'review_required',
    accessConsent: access, disposition: success ? 'successful' : unsuccessful ? 'unsuccessful' : 'needs_review', reason,
    requestedCents: requested, offeredCents: spoken?.compensationCents ?? null,
    agreedCents: success ? last.compensationCents : null, monthlyRentCents: a.monthlyRentCents,
    explanation: detail ?? negotiationExplanation(reason, { requestedCents: requested, offeredCents: spoken?.compensationCents ?? null,
      maximumCents: permittedNegotiationMaximum(state.handoff, a.parcelId), monthlyRentCents: a.monthlyRentCents, finalOfferCommunicated: spoken?.final ?? false }),
    evidenceRefs: refs, nextAction: success ? 'continue' : 'stop',
  });
  a.phase = 'finished'; a.summary = summary;
  const parcel = state.handoff.parcels.find(p => p.parcelId === a.parcelId)!;
  Object.assign(parcel.terms, { outcome: summary.outcome, accessConsent: access, explicitConfirmation: success,
    confirmationRef: success ? refs.at(-1)! : null });
  if (access === 'refused' && a.mode === 'live') state.liveCallLocked = true;
  if (!success) state.workflow = 'stopped';
}
function corroboratesRefusal(reason: string, text: string) {
  return (reason === 'DO_NOT_CALL' ? /(?:stop calling|do not call|don.t call)/i : reason === 'ACCESS_REFUSED' ?
    /(?:not interested|no (?:transmission|land access)|(?:don.t want|do not want|refuse)[^.!?]{0,50}\b(?:transmission|land access|access|power lines?|towers?|on my (?:land|property))\b)/i :
    /(?:\bno\b(?!\s+(?:problem|worries|objection)\b)|decline|reject|too low|not enough|can.t accept|cannot accept)/i).test(text);
}
function validateCandidate(state: NegotiationState, a: NegotiationAttempt, candidate: NegotiationCandidate) {
  const offer = a.offers.at(-1)!;
  if (candidate.reason !== 'AGREED') {
    // Definitive refusals require their actual owner utterance, not just an extraction label.
    const owner = a.turns.find(t => t.id === candidate.ownerTurnId && t.role === 'owner');
    if (['ACCESS_REFUSED', 'DO_NOT_CALL', 'PRICE_REJECTED'].includes(candidate.reason) && (!owner || !corroboratesRefusal(candidate.reason, owner.text))) return finish(state, a, 'CONFLICTING_EVIDENCE');
    return finish(state, a, candidate.reason, owner ? [owner.id] : []);
  }
  if (offer.compensationCents > permittedNegotiationMaximum(state.handoff, a.parcelId)) return finish(state, a, 'BUDGET_CHANGED');
  const agentIndex = a.turns.findIndex(t => t.id === candidate.offerTurnId && t.role === 'agent');
  const ownerIndex = a.turns.findIndex(t => t.id === candidate.ownerTurnId && t.role === 'owner');
  const agent = a.turns[agentIndex], owner = a.turns[ownerIndex];
  const affirmative = owner && /^(?:yes(?: please)?|yeah|yep|sure|okay|ok|absolutely|i agree|i accept|agreed|that works|sounds good|let.s do it)(?:[,.! ]+(?:that works|that.s fine|that sounds good|i agree|i accept|thank you|thanks|sounds good|for me|please|to (?:that|the) offer))*[.! ]*$/i.test(owner.text.trim());
  if (!agent || !owner) return finish(state, a, 'CONFLICTING_EVIDENCE', [],
    'The review referenced an offer or owner response missing from the transcript. Agreement could not be verified.');
  if (!turnStatesOffer(agent.text, offer)) {
    const amounts = moneyMentions(agent.text);
    const detail = amounts.length === 2 && amounts.every(value => value <= BigInt(Number.MAX_SAFE_INTEGER))
      ? `Agent stated ${money(Number(amounts[0]!))} plus ${money(Number(amounts[1]!))}/month; approved terms were ${money(offer.compensationCents)} plus ${money(offer.monthlyRentCents)}/month. Terms did not match.`
      : 'The spoken payment amounts could not be matched to the approved offer. Agreement could not be verified.';
    return finish(state, a, 'CONFLICTING_EVIDENCE', [agent.id, owner.id], detail);
  }
  if (affirmative && a.turns.slice(ownerIndex + 1).some(t => t.role === 'owner' && corroboratesRefusal('PRICE_REJECTED', t.text))) {
    return finish(state, a, 'CONFLICTING_EVIDENCE', [agent.id, owner.id],
      'Owner initially agreed, then declined before the call ended. The final agreement was unclear.');
  }
  if (affirmative && a.response?.kind !== 'agree') return finish(state, a, 'CONFLICTING_EVIDENCE', [agent.id, owner.id],
    'The transcript suggested agreement, but no matching agreement event was recorded during the call. Needs review.');
  // A short yes to the stated offer suffices; never a yes to a different question.
  if (!agent || !owner || ownerIndex !== agentIndex + 1 || a.turns.slice(ownerIndex + 1).some(t => t.role === 'owner' || /[?]/.test(t.text) || moneyMentions(t.text).length > 0 || /\b(?:but|unless|condition|instead|cannot|can.t|won.t|change|offer|pay|payment|compensation|monthly|rent|dollars|terms|budget|agreement)\b/i.test(t.text)) ||
    !affirmative || !turnStatesOffer(agent.text, offer) || !/(?:does that work(?: for you)?|do you agree(?: to (?:that|the) offer)?|is that acceptable|would you accept(?: (?:that|the) offer)?|will you accept(?: (?:that|the) offer)?)\s*[?.!]*$/i.test(agent.text) ||
    candidate.compensationCents !== offer.compensationCents || candidate.monthlyRentCents !== a.monthlyRentCents ||
    a.response?.kind !== 'agree' || (a.response.turnId !== null && a.response.turnId !== owner.id)) return finish(state, a, 'CONFLICTING_EVIDENCE');
  finish(state, a, 'AGREED', [agent.id, owner.id]);
}

/**
 * Pure atomic reducer transition. The host authenticates first, loads authoritative rows,
 * supplies provider-authenticated transcript turns, then commits state + receipt together.
 * No network, local store, automatic reroute or redial is performed here.
 */
export function applyNegotiationCommand(input: NegotiationState, raw: unknown, providerTurns: NegotiationTurn[] = []) {
  const parsed = NegotiationCommand.safeParse(raw);
  if (!parsed.success) throw new NegotiationError('INVALID_INPUT', 'Invalid negotiation command');
  const command = parsed.data, state = structuredClone(input), fingerprint = canonicalJson(command);
  const key = JSON.stringify([state.handoff.sessionId, command.attemptId, command.requestId]);
  const prior = state.receipts[key];
  requireValue(state.active, 'This demo session is closed');
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new NegotiationError('IDEMPOTENCY_CONFLICT', 'Request key has different content');
    return { state, result: structuredClone(prior.result), replayed: true };
  }
  assertCurrent(state);
  if (command.routeVersion !== state.handoff.routeVersion) throw new NegotiationError('STALE_VERSION', 'Route changed');
  let attempt = Object.hasOwn(state.attempts, command.attemptId) ? state.attempts[command.attemptId] : undefined;
  if (command.kind === 'prepare') {
    if (attempt) throw new NegotiationError('IDEMPOTENCY_CONFLICT', 'Attempt already exists');
    requireValue(state.workflow === 'negotiating', 'The workflow is stopped');
    const parcel = state.handoff.parcels.find(p => p.parcelId === command.parcelId);
    requireValue(parcel?.offerPolicy && parcel.terms.outcome === 'pending' && parcel.terms.accessConsent !== 'refused', 'A current unaccepted parcel and policy are required');
    if (command.termsVersion !== parcel.terms.termsVersion) throw new NegotiationError('STALE_VERSION', 'Terms changed');
    requireValue(!Object.values(state.attempts).some(a => a.parcelId === parcel.parcelId), 'This parcel already has an attempt; no automatic retries');
    if (command.mode === 'live') {
      const owner = state.handoff.owners.find(o => o.ownerId === parcel.ownerId)!;
      requireValue(!state.liveCallLocked && state.handoff.userRole?.parcelId === parcel.parcelId &&
        state.handoff.userRole.ownerId === parcel.ownerId && owner.contact.registration === 'registered' &&
        owner.contact.callConsent && owner.contact.contactRef, 'Live calls require the original registered consenting participant');
    }
    state.handoff = freezeNegotiationMonthlyTerms(state.handoff);
    const maximum = permittedNegotiationMaximum(state.handoff, parcel.parcelId);
    requireValue(parcel.offerPolicy.recommendedOfferCents <= maximum, 'Opening offer exceeds the project budget');
    attempt = {
      attemptId: command.attemptId, sessionId: state.handoff.sessionId, projectId: state.handoff.projectId,
      routeId: state.handoff.routeId, routeVersion: state.handoff.routeVersion, parcelId: parcel.parcelId,
      ownerId: parcel.ownerId, mode: command.mode, recommendationCents: parcel.offerPolicy.recommendedOfferCents,
      capCents: parcel.offerCapCents, monthlyRentCents: parcel.terms.monthlyRentCents,
      offers: [{ termsVersion: parcel.terms.termsVersion, compensationCents: parcel.offerPolicy.recommendedOfferCents, monthlyRentCents: parcel.terms.monthlyRentCents, final: maximum === parcel.offerPolicy.recommendedOfferCents }],
      finalOfferUsed: maximum === parcel.offerPolicy.recommendedOfferCents, requestedCents: null,
      phase: 'negotiating', response: null, turns: [], summary: null,
    };
    state.attempts[command.attemptId] = attempt;
    state.handoff.parcels.find(p => p.parcelId === parcel.parcelId)!.terms.compensationCents = attempt.recommendationCents;
  } else {
    requireValue(attempt, 'Unknown server-owned call attempt');
    requireValue(attempt.sessionId === state.handoff.sessionId && attempt.routeId === state.handoff.routeId &&
      attempt.routeVersion === command.routeVersion && state.handoff.parcels.some(p => p.parcelId === attempt!.parcelId && p.ownerId === attempt!.ownerId), 'Attempt binding changed');
    const parcel = state.handoff.parcels.find(p => p.parcelId === attempt!.parcelId)!;
    const offer = attempt.offers.at(-1)!;
    requireValue(parcel.terms.compensationCents === offer.compensationCents && !parcel.terms.monthlyRentIsApproximate, 'Current compensation must match the approved offer');
    requireValue(parcel.offerPolicy?.recommendedOfferCents === attempt.recommendationCents && parcel.offerCapCents === attempt.capCents && parcel.terms.monthlyRentCents === attempt.monthlyRentCents, 'Fixed terms changed during the call');
    if (command.termsVersion !== offer.termsVersion || parcel.terms.termsVersion !== offer.termsVersion) throw new NegotiationError('STALE_VERSION', 'Terms changed');
    if (attempt.phase === 'finished') return { state, result: structuredClone(attempt), replayed: true };
    requireValue(state.workflow === 'negotiating' || command.kind === 'finalize' || command.kind === 'failure', 'The workflow is stopped');
    const turns = z.array(NegotiationTurn).max(200).parse(providerTurns);
    requireValue(new Set(turns.map(t => t.id)).size === turns.length && turns.every((t, i) => !i || t.startMs >= turns[i - 1]!.startMs), 'Transcript turn identities/order are invalid');
    // Partial snapshots may only grow; a provider revision cannot rewrite old evidence.
    if (turns.length) {
      requireValue(attempt.turns.every((t, i) => canonicalJson(t) === canonicalJson(turns[i] ?? null)), 'Transcript changed; do not overwrite existing evidence');
      attempt.turns = turns;
    }
    if (command.kind === 'counteroffer') {
      requireValue(attempt.phase === 'negotiating', 'An acceptance candidate is already under review');
      if (!attempt.finalOfferUsed) {
        attempt.requestedCents = command.requestedCents;
        const maximum = permittedNegotiationMaximum(state.handoff, attempt.parcelId);
        if (maximum < offer.compensationCents) finish(state, attempt, 'BUDGET_CHANGED');
        else {
          const amount = Math.max(offer.compensationCents, Math.min(command.requestedCents ?? maximum, maximum));
          attempt.finalOfferUsed = true;
          if (amount !== offer.compensationCents) {
            const version = Version.parse(offer.termsVersion + 1);
            attempt.offers.push({ termsVersion: version, compensationCents: amount, monthlyRentCents: attempt.monthlyRentCents, final: true });
            Object.assign(parcel.terms, { termsVersion: version, compensationCents: amount, outcome: 'counteroffer', accessConsent: 'unknown', explicitConfirmation: false, confirmationRef: null });
            state.current.termsVersions[parcel.parcelId] = version;
          } else offer.final = true;
        }
      }
    } else if (command.kind === 'response') {
      requireValue(command.turnId === null || attempt.turns.some(t => t.id === command.turnId && t.role === 'owner'), 'Owner response evidence is unavailable');
      attempt.response = { kind: command.response, turnId: command.turnId };
      attempt.phase = 'confirming';
      if (command.turnId === null) {
        // Authenticated tool claim only. Wait for completed transcript corroboration.
        if (command.response !== 'agree') state.workflow = 'stopped';
      } else if (command.response === 'conditions') finish(state, attempt, 'ADDITIONAL_CONDITIONS', [command.turnId]);
      else if (command.response === 'unclear') finish(state, attempt, 'UNCLEAR_RESPONSE', [command.turnId]);
      else if (command.response === 'price_rejected') finish(state, attempt, corroboratesRefusal('PRICE_REJECTED', attempt.turns.find(t => t.id === command.turnId)!.text) ? 'PRICE_REJECTED' : 'CONFLICTING_EVIDENCE', [command.turnId]);
    } else if (command.kind === 'refusal') {
      const ownerTurn = attempt.turns.find(t => t.id === command.turnId && t.role === 'owner');
      if (command.turnId === null) {
        // Lock immediately on a refusal candidate; never treat a tool claim as proof.
        attempt.phase = 'confirming'; attempt.response = null; state.workflow = 'stopped';
        if (attempt.mode === 'live') state.liveCallLocked = true;
      } else {
        requireValue(ownerTurn && corroboratesRefusal(command.reason, ownerTurn.text), 'Clear refusal evidence is required');
        finish(state, attempt, command.reason, [command.turnId]);
      }
    } else if (command.kind === 'finalize') {
      if (!attempt.turns.length) finish(state, attempt, 'TRANSCRIPT_UNAVAILABLE');
      else validateCandidate(state, attempt, command.candidate);
    } else finish(state, attempt, command.reason);
  }
  // Every consequential transition has a committed revision; receipts replay before checks.
  state.handoff.revision = safe(BigInt(state.handoff.revision) + 1n);
  state.current.revision = state.handoff.revision;
  state.receipts[key] = { fingerprint, result: structuredClone(attempt) };
  return { state, result: structuredClone(attempt), replayed: false };
}

export function negotiationAgreementPacket(state: NegotiationState) {
  assertCurrent(state);
  requireValue(state.workflow !== 'stopped', 'Negotiation stopped; agreements remain blocked');
  return assertAgreementReady({ ...state.handoff, routeStatus: 'ready_for_agreements' }, state.current);
}
