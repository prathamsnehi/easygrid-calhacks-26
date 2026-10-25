import { ScheduleAt, SenderError } from 'spacetimedb/server';
import { publishRoute, startSession, type Db } from './logic.ts';

/** Keep this text identical to NEGOTIATION_VOICE_PROMPT in @easygrid/contracts. */
export const VOICE_PROMPT = `You are a calm, brief AI roleplay demo agent for EasyGrid.
Aim for a complete successful conversation in 30–45 seconds. Never pressure an owner.
Speak only the backend-approved opening_compensation, the one permitted final_compensation, and the fixed monthly_fee. Do not offer, accept, or mention any other amount.
Say: "Hi, I'm EasyGrid's AI demo agent. Our proposal is {{opening_compensation}} plus {{monthly_fee}} per month for transmission access across this parcel. Does that work for you?"
Explain that the map recommendation is this demo's estimated fair allowance for this route's impact, not a verified market appraisal.
If the owner objects to the opening price, you may make one final offer of {{final_compensation}} plus the same {{monthly_fee}} per month. Say that it is the final available offer and ask "Does that work for you?"
If the owner names any other amount, do not agree. Say you can only offer the opening amount or the one final amount, then end the call.
A requested amount is not acceptance. Wait for a short yes to the amount you just stated. Then thank them and end; no formal readback or second confirmation.
If the owner rejects land access, is not interested, or asks you to stop calling, end politely. Do not try another price.
After the final price is declined, thank them and end.
Do not discuss banking, signing, payment schedules, or settlement logistics. Do not reroute or redial. Ending the call is not the same as an agreement.
When the conversation is finished, end the call.`;

export const CHECK_LIMIT = 36;
const FIRST_CHECK_MICROS = 20_000_000n;
const NEXT_CHECK_MICROS = 5_000_000n;

export interface PrepareInput {
  sessionId: string;
  phone: string;
  consent: boolean;
  projectBudgetCents: number;
  requestKey: string;
  parcelId: string;
  ownerAlias: string;
  towerCount: number;
  lineLengthMillis: number;
  recommendedOfferCents: number;
  offerCapCents: number;
  monthlyRentCents: number;
}

export interface ReviewCandidate {
  reason: string;
  offerTurnId: string;
  ownerTurnId: string;
  compensationCents: number | null;
  monthlyRentCents: number | null;
}

export interface StoredTurn {
  id: string;
  role: string;
  text: string;
}

export interface ReviewDecision {
  outcome: 'accepted' | 'refused' | 'pending';
  disposition: 'successful' | 'unsuccessful' | 'needs_review';
  reason: string;
  explanation: string;
  nextAction: 'continue' | 'stop';
  agreedCents: number;
  lockLiveCalls: boolean;
}

function fail(code: string, message: string): never {
  throw new SenderError(`${code}: ${message}`);
}

function text(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) fail('INVALID_INPUT', `${label} must be 1 to ${max} characters.`);
  return trimmed;
}

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail('INVALID_INPUT', `${label} must be a nonnegative integer cent amount.`);
  }
  return value;
}

export function money(centsAmount: number): string {
  const negative = centsAmount < 0;
  const abs = Math.abs(centsAmount);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${body}.${String(rem).padStart(2, '0')}`;
}

export function speechVariables(openingCents: number, finalCents: number, monthlyRentCents: number): Record<string, string> {
  return {
    opening_compensation: money(openingCents),
    final_compensation: money(finalCents),
    monthly_fee: money(monthlyRentCents),
  };
}

function attempts(ctx: Db, sessionId: string) {
  return [...ctx.db.callAttempt.bySession.filter(sessionId)];
}

export function turnsFor(ctx: Db, attemptId: string): StoredTurn[] {
  return [...ctx.db.callTurn.byAttempt.filter(attemptId)]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(row => ({ id: row.id, role: row.role, text: row.text }));
}

function syncSummary(ctx: Db, attemptId: string): void {
  const row = ctx.db.callAttempt.attemptId.find(attemptId);
  if (!row) return;
  const summary = {
    attemptId: row.attemptId,
    sessionId: row.sessionId,
    parcelId: row.parcelId,
    mode: row.mode,
    phase: row.phase,
    lifecycle: row.lifecycle,
    revision: row.revision,
    outcome: row.outcome,
    disposition: row.disposition,
    reason: row.reason,
    explanation: row.explanation,
    nextAction: row.nextAction,
    openingCents: row.openingCents,
    finalCents: row.finalCents,
    monthlyRentCents: row.monthlyRentCents,
    agreedCents: row.agreedCents,
  };
  if (ctx.db.negotiationSummary.attemptId.find(attemptId)) ctx.db.negotiationSummary.attemptId.update(summary);
  else ctx.db.negotiationSummary.insert(summary);
}

function scheduleCheck(ctx: Db, attemptId: string, first: boolean): void {
  const delay = first ? FIRST_CHECK_MICROS : NEXT_CHECK_MICROS;
  ctx.db.callCheck.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(ctx.timestamp.toMillis() * 1000n + delay),
    attemptId,
  });
}

function senderHex(ctx: Db): string {
  return ctx.sender.toHexString();
}

export function prepareCall(ctx: Db, input: PrepareInput): { status: 'exists' | 'ready'; attemptId: string } {
  if (input.consent !== true) fail('INVALID_INPUT', 'A live call requires the participant consent checkbox.');
  const sessionId = text(input.sessionId, 'Session id', 128);
  const phone = text(input.phone, 'Phone', 32);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) fail('INVALID_INPUT', 'The dial target must be an international phone number.');
  const requestKey = text(input.requestKey, 'Request key', 120);
  const parcelId = text(input.parcelId, 'Parcel id', 128);
  const ownerAlias = text(input.ownerAlias, 'Owner alias', 128);
  if (attempts(ctx, sessionId).some(row => row.reason === 'ACCESS_REFUSED' || row.reason === 'DO_NOT_CALL')) {
    fail('BLOCKED_STATE', 'No further live call will be placed for this participant.');
  }
  const existing = attempts(ctx, sessionId)[0];
  if (existing) return { status: 'exists', attemptId: existing.attemptId };

  const current = ctx.db.session.sessionId.find(sessionId);
  if (current && senderHex(ctx) !== current.operatorIdentity) fail('FORBIDDEN', 'This identity cannot change the session.');
  const parcel = {
    parcelId,
    ownerAlias,
    towerCount: cents(input.towerCount, 'Tower count'),
    lineLengthMillis: cents(input.lineLengthMillis, 'Line length'),
    recommendedOfferCents: cents(input.recommendedOfferCents, 'Recommended offer'),
    offerCapCents: cents(input.offerCapCents, 'Offer cap'),
    monthlyRentCents: cents(input.monthlyRentCents, 'Monthly fee'),
  };
  if (!current) {
    startSession(ctx, { sessionId, phone, projectBudgetCents: cents(input.projectBudgetCents, 'Project budget'), requestKey: `s:${requestKey}` });
  } else {
    const contact = ctx.db.contact.sessionId.find(sessionId);
    if (!contact) fail('NOT_FOUND', 'The session has no private contact.');
    if (contact.phone !== phone) ctx.db.contact.sessionId.update({ ...contact, phone });
  }
  const session = ctx.db.session.sessionId.find(sessionId);
  if (!session) fail('NOT_FOUND', 'No session exists with that id.');
  if (session.status === 'awaiting_route') {
    publishRoute(ctx, {
      sessionId,
      expectedRevision: session.revision,
      requestKey: `r:${requestKey}`,
      parcels: [parcel],
    });
  }
  const published = ctx.db.session.sessionId.find(sessionId);
  if (!published || published.status !== 'negotiating' || published.liveParcelId !== parcelId) {
    fail('BLOCKED_STATE', 'The registered parcel is not the live parcel on the current route.');
  }
  const live = ctx.db.routeParcel.id.find(JSON.stringify([sessionId, published.routeVersion, parcelId]));
  if (!live || live.role !== 'live' || live.outcome !== 'pending') {
    fail('BLOCKED_STATE', 'The live negotiation is no longer pending.');
  }
  const attemptId = `c${ctx.newUuidV7().toHexString()}`;
  ctx.db.callAttempt.insert({
    attemptId,
    sessionId,
    parcelId,
    routeVersion: published.routeVersion,
    providerCallId: '',
    lifecycle: 'requested',
    mode: 'live',
    phase: 'negotiating',
    openingCents: live.recommendedOfferCents,
    finalCents: live.offerCapCents,
    monthlyRentCents: live.monthlyRentCents,
    revision: 1,
    checks: 0,
    dialClaimed: true,
    reviewClaimed: false,
    outcome: '',
    disposition: '',
    reason: '',
    explanation: '',
    nextAction: '',
    agreedCents: 0,
  });
  scheduleCheck(ctx, attemptId, true);
  return { status: 'ready', attemptId };
}

export function markDialFailure(ctx: Db, attemptId: string): void {
  const row = ctx.db.callAttempt.attemptId.find(attemptId);
  if (!row || row.phase === 'finished') return;
  ctx.db.callAttempt.attemptId.update({
    ...row,
    lifecycle: 'failed',
    mode: 'simulated',
    phase: 'finished',
    revision: row.revision + 1,
    outcome: 'pending',
    disposition: 'needs_review',
    reason: 'SERVICE_UNAVAILABLE',
    explanation: 'The phone provider did not place a call. This is a labeled simulation, not a completed phone call.',
    nextAction: 'stop',
    agreedCents: 0,
  });
  syncSummary(ctx, attemptId);
}

export function rememberProviderCall(ctx: Db, attemptId: string, providerCallId: string): 'saved' | 'cancel' | 'ignored' {
  const row = ctx.db.callAttempt.attemptId.find(attemptId);
  if (!row) return 'ignored';
  const id = text(providerCallId, 'Provider call id', 128);
  if (row.phase === 'finished' && row.reason === 'SUPERSEDED') {
    if (row.providerCallId) return 'ignored';
    ctx.db.callAttempt.attemptId.update({ ...row, providerCallId: id });
    return 'cancel';
  }
  if (row.phase === 'finished' || row.providerCallId) return 'ignored';
  ctx.db.callAttempt.attemptId.update({ ...row, providerCallId: id, lifecycle: 'requested', mode: 'live' });
  syncSummary(ctx, attemptId);
  return 'saved';
}

/** Stop one demo call so a later click can dial a new session. This does not redial. */
export function supersedeCall(ctx: Db, sessionId: string): { providerCallId: string } {
  const id = text(sessionId, 'Session id', 128);
  const session = ctx.db.session.sessionId.find(id);
  if (!session) fail('NOT_FOUND', 'No session exists with that id.');
  if (senderHex(ctx) !== session.operatorIdentity) fail('FORBIDDEN', 'This identity cannot change the session.');
  const rows = attempts(ctx, id);
  if (rows.some(row => row.reason === 'ACCESS_REFUSED' || row.reason === 'DO_NOT_CALL')) {
    fail('BLOCKED_STATE', 'No further live call will be placed for this participant.');
  }
  let providerCallId = '';
  const attemptIds = new Set(rows.map(row => row.attemptId));
  for (const row of rows) {
    if (row.phase === 'finished') continue;
    if (row.providerCallId) providerCallId = row.providerCallId;
    ctx.db.callAttempt.attemptId.update({
      ...row,
      lifecycle: 'cancelled',
      phase: 'finished',
      revision: row.revision + 1,
      outcome: 'pending',
      disposition: 'needs_review',
      reason: 'SUPERSEDED',
      explanation: 'The previous demo call was replaced before a new call.',
      nextAction: 'stop',
      agreedCents: 0,
    });
    syncSummary(ctx, row.attemptId);
  }
  for (const check of [...ctx.db.callCheck.iter()].filter(row => attemptIds.has(row.attemptId))) ctx.db.callCheck.delete(check);
  return { providerCallId };
}

export function loadAttempt(ctx: Db, attemptId: string) {
  return ctx.db.callAttempt.attemptId.find(attemptId);
}

function moneyMentions(textValue: string): bigint[] {
  const mentions: { index: number; value: bigint }[] = [];
  for (const match of textValue.matchAll(/(?:\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:US\s*)?dollars?\b)/gi)) {
    const [whole, fraction = ''] = (match[1] ?? match[2]!).replaceAll(',', '').split('.');
    mentions.push({ index: match.index ?? 0, value: BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) });
  }
  return mentions.sort((a, b) => a.index - b.index).map(item => item.value);
}

function statesOffer(spoken: string, compensationCents: number, monthlyRentCents: number): boolean {
  const amounts = moneyMentions(spoken);
  return !/(?:\b(?:cannot|can't|won't|unable to|not able to)\s+(?:\w+\s+){0,3}(?:offer|pay|agree|provide)|\bnot\s+(?:offering|paying|proposing)|\b(?:if|unless|provided that|conditional on)\b)/i.test(spoken)
    && amounts.length === 2
    && amounts[0] === BigInt(compensationCents)
    && amounts[1] === BigInt(monthlyRentCents)
    && /month/i.test(spoken)
    && /does that work(?: for you)?/i.test(spoken);
}

function affirmative(spoken: string): boolean {
  return /^(?:yes(?: please)?|yeah|yep|sure|okay|ok|absolutely|i agree|i accept|agreed|that works|sounds good|let's do it|lets do it)(?:[,.! ]+(?:that works|that's fine|that sounds good|i agree|i accept|thank you|thanks|sounds good|for me|please|to (?:that|the) offer))*[.! ]*$/i.test(spoken.trim());
}

function corroborates(reason: string, spoken: string): boolean {
  if (reason === 'DO_NOT_CALL') return /(?:stop calling|do not call|don't call|do not call me)/i.test(spoken);
  if (reason === 'ACCESS_REFUSED') {
    return /(?:not interested|no (?:transmission|land access)|(?:don't want|do not want|refuse)[^.!?]{0,50}\b(?:transmission|land access|access|power lines?|towers?|on my (?:land|property))\b)/i.test(spoken);
  }
  return /(?:\bno\b(?!\s+(?:problem|worries|objection)\b)|decline|reject|too low|not enough|can't accept|cannot accept)/i.test(spoken);
}

function pending(reason: string, explanation: string): ReviewDecision {
  return {
    outcome: 'pending', disposition: 'needs_review', reason, explanation, nextAction: 'stop', agreedCents: 0, lockLiveCalls: false,
  };
}

export function decideReview(input: {
  openingCents: number;
  finalCents: number;
  monthlyRentCents: number;
  turns: readonly StoredTurn[];
  candidate: ReviewCandidate | null;
  failureReason: string;
}): ReviewDecision {
  if (input.failureReason) {
    const explanations: Record<string, string> = {
      SERVICE_UNAVAILABLE: 'The phone provider reported a failed call. No agreement was saved, and it was not redialed.',
      NO_ANSWER: 'The phone was not answered. No agreement was saved, and the same provider call was not redialed.',
      BUSY: 'The phone was busy. No agreement was saved, and the same provider call was not redialed.',
      DISCONNECTED: 'The call disconnected before a verified agreement. No agreement was saved.',
      CONNECTION_UNKNOWN: 'The provider call did not produce a verified result. It was left on the same call id and was not redialed.',
      TRANSCRIPT_UNAVAILABLE: 'The call ended without a transcript. Agreement could not be verified.',
      MODEL_UNAVAILABLE: 'The transcript review service was unavailable. Agreement was not saved.',
      MODEL_TIMEOUT: 'The transcript review did not return in time. Agreement was not saved.',
      MALFORMED_OUTPUT: 'The transcript review could not be read. Agreement was not saved.',
    };
    return pending(input.failureReason, explanations[input.failureReason] ?? 'The call result could not be verified. Agreement was not saved.');
  }
  const candidate = input.candidate;
  if (!candidate) return pending('MALFORMED_OUTPUT', 'The transcript review could not be read. Agreement was not saved.');
  const owners = input.turns.filter(turn => turn.role === 'owner');
  const namedOwner = candidate.ownerTurnId ? owners.find(turn => turn.id === candidate.ownerTurnId) : undefined;
  if (candidate.reason === 'AGREED') {
    const compensation = candidate.compensationCents;
    const monthly = candidate.monthlyRentCents;
    if (compensation === null || monthly === null || (compensation !== input.openingCents && compensation !== input.finalCents) || monthly !== input.monthlyRentCents) {
      return pending('CONFLICTING_EVIDENCE', 'The spoken agreement was not the opening amount or the one permitted final amount. It was left pending.');
    }
    const agentIndex = input.turns.findIndex(turn => turn.role === 'agent' && statesOffer(turn.text, compensation, monthly));
    const owner = input.turns.slice(agentIndex + 1).find(turn => turn.role === 'owner');
    const laterRefusal = owner ? input.turns.slice(input.turns.indexOf(owner) + 1).some(turn => turn.role === 'owner' && corroborates('PRICE_REJECTED', turn.text)) : false;
    if (agentIndex < 0 || !owner || !affirmative(owner.text) || laterRefusal || (candidate.ownerTurnId !== '' && owner.id !== candidate.ownerTurnId)) {
      return pending('CONFLICTING_EVIDENCE', 'A short yes after the allowed offer was not in the transcript. Agreement was not saved.');
    }
    return {
      outcome: 'accepted',
      disposition: 'successful',
      reason: 'AGREED',
      explanation: `Owner agreed to ${money(compensation)} plus ${money(input.monthlyRentCents)} per month. This saved demo result is not a payment.`,
      nextAction: 'continue',
      agreedCents: compensation,
      lockLiveCalls: false,
    };
  }
  if (candidate.reason === 'ACCESS_REFUSED' || candidate.reason === 'DO_NOT_CALL' || candidate.reason === 'PRICE_REJECTED') {
    const evidence = namedOwner ?? owners.find(turn => corroborates(candidate.reason, turn.text));
    if (!evidence || !corroborates(candidate.reason, evidence.text)) {
      return pending('CONFLICTING_EVIDENCE', 'The review label did not match the owner’s words. The result was left pending.');
    }
    const lock = candidate.reason === 'ACCESS_REFUSED' || candidate.reason === 'DO_NOT_CALL';
    return {
      outcome: 'refused',
      disposition: 'unsuccessful',
      reason: candidate.reason,
      explanation: candidate.reason === 'PRICE_REJECTED'
        ? 'The owner declined the offered price. No agreement was saved.'
        : candidate.reason === 'DO_NOT_CALL'
          ? 'The owner asked not to be called. No further live call will be placed for this session.'
          : 'The owner refused access. No further live call will be placed for this session.',
      nextAction: 'stop',
      agreedCents: 0,
      lockLiveCalls: lock,
    };
  }
  if (['UNCLEAR_RESPONSE', 'ADDITIONAL_CONDITIONS', 'CONFLICTING_EVIDENCE'].includes(candidate.reason)) {
    return pending(candidate.reason, candidate.reason === 'ADDITIONAL_CONDITIONS'
      ? 'The owner added conditions. Those conditions were not accepted.'
      : 'The owner’s response was not a clear agreement. The result was left pending.');
  }
  return pending('MALFORMED_OUTPUT', 'The transcript review could not be read. Agreement was not saved.');
}

export function applyDecision(ctx: Db, attemptId: string, decision: ReviewDecision, lifecycle: string): void {
  const row = ctx.db.callAttempt.attemptId.find(attemptId);
  if (!row || row.phase === 'finished') return;
  ctx.db.callAttempt.attemptId.update({
    ...row,
    lifecycle,
    phase: 'finished',
    revision: row.revision + 1,
    reviewClaimed: true,
    outcome: decision.outcome,
    disposition: decision.disposition,
    reason: decision.reason,
    explanation: decision.explanation.slice(0, 800),
    nextAction: decision.nextAction,
    agreedCents: decision.agreedCents,
  });
  syncSummary(ctx, attemptId);
}

export function commitStoredReview(ctx: Db, attemptId: string, candidate: ReviewCandidate | null, failureReason: string): void {
  const row = ctx.db.callAttempt.attemptId.find(text(attemptId, 'Attempt id', 128));
  if (!row || row.phase === 'finished') return;
  const decision = decideReview({
    openingCents: row.openingCents,
    finalCents: row.finalCents,
    monthlyRentCents: row.monthlyRentCents,
    turns: turnsFor(ctx, row.attemptId),
    candidate,
    failureReason,
  });
  applyDecision(ctx, row.attemptId, decision, row.providerCallId ? 'completed' : 'failed');
}

export interface ProviderSnapshot {
  status: string;
  endReason: string;
  turns: { role: string; text: string; startMs: number; endMs: number }[];
}

export function providerFailureReason(status: string, endReason: string): string {
  const blob = `${status} ${endReason}`.toLowerCase();
  if (blob.includes('busy')) return 'BUSY';
  if (blob.includes('no_answer') || blob.includes('no-answer') || blob.includes('no answer') || blob.includes('unanswered')) return 'NO_ANSWER';
  if (blob.includes('disconnect') || blob.includes('hangup') || blob.includes('hang up')) return 'DISCONNECTED';
  if (status === 'failed') return 'SERVICE_UNAVAILABLE';
  return 'CONNECTION_UNKNOWN';
}

function storeTurns(ctx: Db, attemptId: string, turns: ProviderSnapshot['turns']): void {
  if ([...ctx.db.callTurn.byAttempt.filter(attemptId)].length > 0) return;
  turns.slice(0, 200).forEach((turn, ordinal) => {
    const role = /owner|user|human|customer|caller/i.test(turn.role) ? 'owner' : 'agent';
    const spoken = turn.text.trim();
    if (!spoken) return;
    ctx.db.callTurn.insert({
      id: `${attemptId}-${ordinal}`,
      attemptId,
      role,
      text: spoken.slice(0, 4000),
      startMs: Math.max(0, Math.min(turn.startMs, 0xffff_ffff)),
      endMs: Math.max(0, Math.min(Math.max(turn.endMs, turn.startMs), 0xffff_ffff)),
      ordinal,
    });
  });
}

/** Advance one provider snapshot. Returns the transcript when Claude should be called once. */
export function advanceCall(ctx: Db, attemptId: string, snapshot: ProviderSnapshot | null): { review: boolean } {
  const row = ctx.db.callAttempt.attemptId.find(attemptId);
  if (!row || row.phase === 'finished') return { review: false };
  if (!row.providerCallId) {
    const checks = row.checks + 1;
    if (checks >= 3) {
      markDialFailure(ctx, attemptId);
      return { review: false };
    }
    ctx.db.callAttempt.attemptId.update({ ...row, checks });
    scheduleCheck(ctx, attemptId, false);
    return { review: false };
  }
  if (!snapshot) {
    const checks = row.checks + 1;
    if (checks >= CHECK_LIMIT) {
      applyDecision(ctx, attemptId, pending('CONNECTION_UNKNOWN', 'The provider call did not produce a verified result. It was left on the same call id and was not redialed.'), 'unknown');
      return { review: false };
    }
    ctx.db.callAttempt.attemptId.update({ ...row, checks, lifecycle: 'unknown' });
    scheduleCheck(ctx, attemptId, false);
    return { review: false };
  }
  const terminal = snapshot.status === 'completed' || snapshot.status === 'failed';
  const lifecycle = snapshot.status === 'failed' ? 'failed' : snapshot.status === 'completed' ? 'completed' : snapshot.status === 'started' ? 'connected' : 'requested';
  if (!terminal) {
    const checks = row.checks + 1;
    if (checks >= CHECK_LIMIT) {
      applyDecision(ctx, attemptId, pending('CONNECTION_UNKNOWN', 'The provider call did not produce a verified result. It was left on the same call id and was not redialed.'), 'unknown');
      return { review: false };
    }
    ctx.db.callAttempt.attemptId.update({ ...row, checks, lifecycle });
    scheduleCheck(ctx, attemptId, false);
    return { review: false };
  }
  if (snapshot.status === 'failed') {
    const reason = providerFailureReason(snapshot.status, snapshot.endReason);
    applyDecision(ctx, attemptId, decideReview({
      openingCents: row.openingCents, finalCents: row.finalCents, monthlyRentCents: row.monthlyRentCents,
      turns: [], candidate: null, failureReason: reason,
    }), 'failed');
    return { review: false };
  }
  if (snapshot.turns.length === 0) {
    applyDecision(ctx, attemptId, pending('TRANSCRIPT_UNAVAILABLE', 'The call ended without a transcript. Agreement could not be verified.'), 'completed');
    return { review: false };
  }
  storeTurns(ctx, attemptId, snapshot.turns);
  const current = ctx.db.callAttempt.attemptId.find(attemptId)!;
  if (current.reviewClaimed) {
    if (current.phase !== 'finished') {
      applyDecision(ctx, attemptId, pending('MODEL_UNAVAILABLE', 'The transcript review service was unavailable. Agreement was not saved.'), 'completed');
    }
    return { review: false };
  }
  ctx.db.callAttempt.attemptId.update({ ...current, reviewClaimed: true, lifecycle: 'completed', checks: current.checks + 1 });
  return { review: true };
}
