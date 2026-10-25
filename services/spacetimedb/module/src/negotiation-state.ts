import { SenderError, type ViewCtx, type InferSchema } from 'spacetimedb/server';
import {
  Id, OwnerHandoff, NegotiationCommand, NegotiationTurn, canonicalJson,
  applyNegotiationCommand, negotiationAgreementPacket, createNegotiationResultUpdate,
  type NegotiationState, type NegotiationAttempt,
} from '@easygrid/contracts';
import { spacetimedb } from './tables.ts';
import type { Db } from './logic.ts';

type Reader = Pick<ViewCtx<InferSchema<typeof spacetimedb>>, 'db' | 'sender'>;
type MapBinding = { sessionId: string; routeId: string; routeVersion: number; proposalKey: string };
export const REVIEW_LEASE_MICROS = 30_000_000n;
const MAX_JSON_LENGTH = 4_000_000;
const pair = (sessionId: string, attemptId: string) => JSON.stringify([sessionId, attemptId]);

function fail(code: string, message: string): never { throw new SenderError(`${code}: ${message}`); }
function requireState(value: unknown, message: string): asserts value {
  if (!value) fail('BLOCKED_STATE', message);
}
function json(input: string): unknown {
  if (input.length > MAX_JSON_LENGTH) fail('INVALID_INPUT', 'The state payload is too large.');
  try { return JSON.parse(input); } catch { return fail('INVALID_INPUT', 'Invalid state payload.'); }
}
function encoded(input: unknown): string {
  const result = JSON.stringify(input);
  if (result.length > MAX_JSON_LENGTH) fail('INVALID_INPUT', 'The state payload is too large.');
  return result;
}
function valid<T>(parse: () => T): T {
  try { return parse(); } catch { return fail('INVALID_INPUT', 'The input does not match the shared contract.'); }
}
function binding(input: string): MapBinding {
  const value = json(input) as MapBinding;
  requireState(value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'proposalKey,routeId,routeVersion,sessionId', 'A complete local map binding is required.');
  valid(() => Id.parse(value.sessionId)); valid(() => Id.parse(value.routeId));
  requireState(Number.isSafeInteger(value.routeVersion) && value.routeVersion > 0 &&
    typeof value.proposalKey === 'string' && value.proposalKey.length > 0 && value.proposalKey.length <= 2_000_000,
  'The local map binding is invalid.');
  return value;
}
function session(ctx: Reader, sessionId: string) {
  const row = ctx.db.session.sessionId.find(sessionId);
  if (!row) fail('NOT_FOUND', 'The session does not exist.');
  return row;
}
/** Auth precedes replay, parsing of trusted evidence and all reads of private state. */
function worker(ctx: Reader, sessionId: string) {
  const row = session(ctx, sessionId);
  if (!row.workerIdentity || row.workerIdentity !== ctx.sender.toHexString()) fail('FORBIDDEN', 'The registered session worker is required.');
  return row;
}
function snapshot(ctx: Reader, sessionId: string) {
  const row = ctx.db.negotiationSession.sessionId.find(sessionId);
  if (!row) fail('NOT_FOUND', 'The map has not been bound to negotiation state.');
  return { row, state: JSON.parse(row.stateJson) as NegotiationState };
}
export function canReadNegotiation(ctx: Reader, sessionId: string): boolean {
  const row = ctx.db.session.sessionId.find(sessionId), sender = ctx.sender.toHexString();
  return !!row && (row.operatorIdentity === sender || row.workerIdentity === sender);
}

/** Only the registered backend worker may submit its reconstructed trusted map packet.
 * Never expose this reducer as an HTTP pass-through for a browser/model packet. */
export function bindNegotiation(ctx: Db, input: {
  sessionId: string; expectedRevision: number; requestKey: string; handoffJson: string; mapBindingJson: string;
}): void {
  const current = worker(ctx, input.sessionId);
  valid(() => Id.parse(input.requestKey));
  const packet = valid(() => OwnerHandoff.parse(json(input.handoffJson))), map = binding(input.mapBindingJson);
  const fingerprint = canonicalJson({ requestKey: input.requestKey, expectedRevision: input.expectedRevision, packet, map });
  const existing = ctx.db.negotiationSession.sessionId.find(input.sessionId);
  if (existing) {
    if (existing.importFingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'This session already has its original map and participant binding.');
    return;
  }
  if (current.revision !== input.expectedRevision) fail('STALE_REVISION', 'The session revision changed.');
  requireState(current.routeVersion === 0 && current.status === 'awaiting_route', 'Legacy route/outcome state cannot be migrated implicitly.');
  requireState(packet.sessionId === input.sessionId && packet.revision === current.revision &&
    packet.budgetCents === current.projectBudgetCents && packet.referenceBinding === 'canonical' &&
    packet.routeStatus === 'selected_for_negotiation' && packet.simulationChecksPassed,
  'The packet must match the registered session, budget and current revision.');
  requireState(packet.userRole && packet.parcels.some(p => p.parcelId === packet.userRole!.parcelId && p.ownerId === packet.userRole!.ownerId),
    'The original participant must be bound to one affected fictional parcel.');
  const participant = packet.owners.find(o => o.ownerId === packet.userRole!.ownerId)!;
  requireState(participant.contact.registration === 'registered' && participant.contact.callConsent && participant.contact.contactRef,
    'The backend must register the original participant and explicit call consent.');
  requireState(packet.owners.every(o => o.ownerId === participant.ownerId || o.contact.registration === 'simulation'),
    'Other fictional owners must remain simulated.');
  requireState(packet.parcels.every(p => p.offerPolicy && p.terms.outcome === 'pending' &&
    p.terms.accessConsent === 'unknown' && !p.terms.explicitConfirmation && !p.terms.confirmationRef &&
    p.terms.compensationCents === p.offerPolicy.recommendedOfferCents),
  'Import must start with unaccepted recommended terms for every affected parcel.');
  packet.revision = current.revision + 1;
  const state: NegotiationState = {
    active: true, liveCallLocked: false, workflow: 'negotiating', handoff: packet,
    current: { sessionId: packet.sessionId, projectId: packet.projectId, routeId: packet.routeId,
      routeVersion: packet.routeVersion, revision: packet.revision,
      termsVersions: Object.fromEntries(packet.parcels.map(p => [p.parcelId, p.terms.termsVersion])),
      offerPolicies: Object.fromEntries(packet.parcels.map(p => [p.parcelId, { policyId: p.offerPolicy!.policyId,
        basis: p.offerPolicy!.basis, recommendedOfferCents: p.offerPolicy!.recommendedOfferCents, offerCapCents: p.offerCapCents }])),
    }, attempts: {}, receipts: {},
  };
  ctx.db.negotiationSession.insert({ sessionId: input.sessionId, importRequestId: input.requestKey,
    importFingerprint: fingerprint, mapBindingJson: encoded(map), stateJson: encoded(state) });
  ctx.db.session.sessionId.update({ ...current, revision: packet.revision, routeVersion: packet.routeVersion,
    liveParcelId: packet.userRole!.parcelId, publishedRouteCount: 1, status: 'negotiating' });
}

function commitCommand(ctx: Db, input: { sessionId: string; commandJson: string; providerTurnsJson: string }, review = false): void {
  worker(ctx, input.sessionId);
  const { row, state } = snapshot(ctx, input.sessionId);
  const command = valid(() => NegotiationCommand.parse(json(input.commandJson)));
  if (command.kind === 'finalize' && !review) fail('BLOCKED_STATE', 'Final review requires its durable claim.');
  const claim = ctx.db.negotiationReview.id.find(pair(input.sessionId, command.attemptId));
  const receipt = state.receipts[JSON.stringify([input.sessionId, command.attemptId, command.requestId])];
  if (!review && !receipt && claim && !claim.completed && claim.leaseUntilMicros > ctx.timestamp.microsSinceUnixEpoch) {
    // Stop signals remain safe during review; new offers/answers cannot change its evidence.
    requireState(command.kind === 'failure' || command.kind === 'refusal', 'The attempt is being reviewed.');
  }
  const turns = valid(() => NegotiationTurn.array().max(200).parse(json(input.providerTurnsJson)));
  let transition: ReturnType<typeof applyNegotiationCommand>;
  try { transition = applyNegotiationCommand(state, command, turns); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'INVALID_INPUT';
    return fail(code, 'The negotiation transition was rejected.');
  }
  if (transition.replayed) return;
  persist(ctx, row, transition.state, transition.result);
}

function persist(ctx: Db, row: ReturnType<typeof snapshot>['row'], next: NegotiationState, result: NegotiationAttempt): void {
  const current = session(ctx, row.sessionId), revision = next.current.revision;
  // The legacy session uses u32 revisions. Reject before writes instead of overflowing.
  requireState(revision <= 0xffff_ffff, 'The session revision limit was reached.');
  const stateJson = encoded(next), id = pair(row.sessionId, result.attemptId);
  const update = createNegotiationResultUpdate({ attempt: result, eventId: `negotiation-${revision}`,
    revision, mapBinding: JSON.parse(row.mapBindingJson) as MapBinding, localParcelId: result.parcelId });
  let status = next.workflow === 'stopped' ? 'needs_review' : 'negotiating';
  if (next.workflow !== 'stopped') {
    try { negotiationAgreementPacket(next); status = 'agreement_ready'; } catch { /* Unaccepted parcels remain blocked. */ }
  }
  ctx.db.negotiationSession.sessionId.update({ ...row, stateJson });
  const publicRow = { id, sessionId: row.sessionId, attemptId: result.attemptId, revision, updateJson: encoded(update) };
  if (ctx.db.negotiationResult.id.find(id)) ctx.db.negotiationResult.id.update(publicRow);
  else ctx.db.negotiationResult.insert(publicRow);
  ctx.db.session.sessionId.update({ ...current, revision, status,
    explanation: result.summary?.explanation ?? '' });
}

export function executeNegotiation(ctx: Db, input: { sessionId: string; commandJson: string; providerTurnsJson: string }): void {
  commitCommand(ctx, input);
}

/** CAL-33 supplies authenticated provider turns before invoking the external reviewer.
 * This persists completed evidence even when no decision tool was delivered. */
export function recordNegotiationTranscript(ctx: Db, input: {
  sessionId: string; attemptId: string; requestId: string; providerTurnsJson: string;
}): void {
  worker(ctx, input.sessionId); valid(() => Id.parse(input.requestId));
  const { row, state } = snapshot(ctx, input.sessionId);
  const attempt = Object.hasOwn(state.attempts, input.attemptId) ? state.attempts[input.attemptId] : null;
  requireState(state.active && attempt, 'An active session and bound attempt are required.');
  const turns = valid(() => NegotiationTurn.array().max(200).parse(json(input.providerTurnsJson)));
  const key = JSON.stringify([input.sessionId, input.attemptId, 'transcript', input.requestId]), fingerprint = canonicalJson(turns);
  const prior = state.receipts[key];
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'This transcript receipt has different content.');
    return;
  }
  requireState(attempt.phase !== 'finished', 'The attempt already has a final result.');
  const claim = ctx.db.negotiationReview.id.find(pair(input.sessionId, input.attemptId));
  requireState(!claim || (!claim.completed && claim.leaseUntilMicros <= ctx.timestamp.microsSinceUnixEpoch), 'Transcript evidence is frozen during its review lease.');
  requireState(new Set(turns.map(t => t.id)).size === turns.length && turns.every((t, i) => i === 0 || t.startMs >= turns[i - 1]!.startMs) &&
    attempt.turns.every((t, i) => canonicalJson(t) === canonicalJson(turns[i] ?? null)),
  'Transcript identities/order changed or earlier evidence was rewritten.');
  attempt.turns = turns; attempt.phase = 'confirming';
  state.current.revision++; state.handoff.revision = state.current.revision;
  state.receipts[key] = { fingerprint, result: structuredClone(attempt) };
  persist(ctx, row, state, attempt);
}

export function claimNegotiationReview(ctx: Db, input: { sessionId: string; attemptId: string; claimId: string }): void {
  worker(ctx, input.sessionId); valid(() => Id.parse(input.claimId));
  const { state } = snapshot(ctx, input.sessionId);
  const attempt = Object.hasOwn(state.attempts, input.attemptId) ? state.attempts[input.attemptId] : null;
  requireState(state.active && attempt, 'An active session and attempt are required.');
  if (attempt.phase === 'finished') return;
  requireState(attempt.phase === 'confirming', 'Record the call response before reviewing its transcript.');
  const id = pair(input.sessionId, input.attemptId), prior = ctx.db.negotiationReview.id.find(id);
  if (prior?.completed || (prior && prior.leaseUntilMicros > ctx.timestamp.microsSinceUnixEpoch)) return;
  requireState(!prior || prior.claimId !== input.claimId, 'An expired claim must be replaced with a fresh claim id.');
  const row = { id, ...input, workerIdentity: ctx.sender.toHexString(), completed: false,
    leaseUntilMicros: ctx.timestamp.microsSinceUnixEpoch + REVIEW_LEASE_MICROS };
  if (prior) ctx.db.negotiationReview.id.update(row); else ctx.db.negotiationReview.insert(row);
}

export function commitNegotiationReview(ctx: Db, input: {
  sessionId: string; claimId: string; commandJson: string; providerTurnsJson: string;
}): void {
  worker(ctx, input.sessionId);
  const command = valid(() => NegotiationCommand.parse(json(input.commandJson)));
  requireState((command.kind === 'finalize' || command.kind === 'failure') && command.requestId === 'post-call-review',
    'Review commits require the stable post-call-review request id.');
  const claim = ctx.db.negotiationReview.id.find(pair(input.sessionId, command.attemptId));
  requireState(claim && claim.claimId === input.claimId && claim.workerIdentity === ctx.sender.toHexString(), 'The durable review claim changed.');
  requireState(claim.completed || claim.leaseUntilMicros > ctx.timestamp.microsSinceUnixEpoch, 'The review claim expired.');
  const { state } = snapshot(ctx, input.sessionId), attempt = state.attempts[command.attemptId];
  const turns = valid(() => NegotiationTurn.array().max(200).parse(json(input.providerTurnsJson)));
  requireState(attempt && canonicalJson(turns) === canonicalJson(attempt.turns), 'Review must use the saved provider evidence.');
  commitCommand(ctx, input, true);
  ctx.db.negotiationReview.id.update({ ...claim, completed: true });
}

/** CAL-40 closes the old run before replacing its active binding. Retain its results. */
export function closeNegotiation(ctx: Db, input: { sessionId: string }): void {
  worker(ctx, input.sessionId);
  const { row, state } = snapshot(ctx, input.sessionId);
  if (!state.active) return;
  state.active = false;
  state.current.revision++; state.handoff.revision = state.current.revision;
  requireState(state.current.revision <= 0xffff_ffff, 'The session revision limit was reached.');
  ctx.db.negotiationSession.sessionId.update({ ...row, stateJson: encoded(state) });
  const current = session(ctx, input.sessionId);
  ctx.db.session.sessionId.update({ ...current, revision: state.current.revision, status: 'closed' });
}

export function negotiationResults(ctx: Reader, sessionId: string) {
  if (!canReadNegotiation(ctx, sessionId)) return [];
  return [...ctx.db.negotiationResult.bySession.filter(sessionId)].map(({ attemptId, revision, updateJson }) => ({ attemptId, revision, updateJson }));
}
export function negotiationWorkerState(ctx: Reader, sessionId: string) {
  worker(ctx, sessionId);
  const row = ctx.db.negotiationSession.sessionId.find(sessionId);
  return row ? [{ stateJson: row.stateJson, mapBindingJson: row.mapBindingJson }] : [];
}
export function negotiationReviewState(ctx: Reader, sessionId: string, attemptId: string) {
  worker(ctx, sessionId);
  const row = ctx.db.negotiationReview.id.find(pair(sessionId, attemptId));
  return row ? [{ claimId: row.claimId, leaseUntilMicros: row.leaseUntilMicros, completed: row.completed }] : [];
}
export function negotiationAgreements(ctx: Reader, sessionId: string) {
  if (!canReadNegotiation(ctx, sessionId)) return [];
  const row = ctx.db.negotiationSession.sessionId.find(sessionId);
  if (!row) return [];
  try {
    const packet = negotiationAgreementPacket(JSON.parse(row.stateJson) as NegotiationState);
    // Signing/payment hosts resolve contacts privately; the agreement projection has none.
    for (const owner of packet.owners) owner.contact = { contactRef: null, registration: 'simulation', callConsent: false };
    return [{ revision: packet.revision, packetJson: encoded(packet) }];
  } catch { return []; }
}
