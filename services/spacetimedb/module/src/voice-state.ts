import { SenderError, type ViewCtx, type InferSchema } from 'spacetimedb/server';
import { spacetimedb } from './tables.ts';
import type { Db } from './logic.ts';

type Reader = Pick<ViewCtx<InferSchema<typeof spacetimedb>>, 'db' | 'sender'>;
type Json = Record<string, any>;
const TERMINAL = new Set(['accepted', 'refused', 'review_required']);
const PROVIDER_STATUS = new Set(['submitted', 'ringing', 'connected', 'completed', 'unknown', 'failed', 'cancelled']);
const PROGRESS: Record<string, number> = { reserved: 0, dispatching: 1, submitted: 2, ringing: 3, connected: 4, completed: 5, failed: 5, cancelled: 5 };

function fail(code: string, message: string): never { throw new SenderError(`${code}: ${message}`); }
function check(value: unknown, message: string): asserts value { if (!value) fail('INVALID_INPUT', message); }
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function json(value: string, max = 2_000_000): Json {
  check(typeof value === 'string' && value.length <= max, 'The voice payload is too large.');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail('INVALID_INPUT', 'Invalid voice payload.'); }
  check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'A voice object is required.');
  return parsed as Json;
}
function id(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value), 'Invalid voice identifier.');
}
function cents(value: unknown): asserts value is number {
  check(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff, 'Exact integer cents are required.');
}
function mapBinding(value: any): void {
  check(value && typeof value === 'object' && !Array.isArray(value), 'A map binding is required.');
  id(value.sessionId); id(value.routeId);
  check(Number.isSafeInteger(value.routeVersion) && value.routeVersion > 0 && typeof value.proposalKey === 'string' && value.proposalKey.length > 0 && value.proposalKey.length <= 1_800_000, 'Invalid map binding.');
  check(Object.keys(value).sort().join(',') === 'proposalKey,routeId,routeVersion,sessionId', 'Unexpected map binding fields.');
}
function owned(ctx: Reader, attemptId: string) {
  const row = ctx.db.voiceAttempt.id.find(attemptId);
  if (!row || row.workerIdentity !== ctx.sender.toHexString()) fail('FORBIDDEN', 'The voice attempt is unavailable for this worker.');
  return { row, attempt: JSON.parse(row.attemptJson) as Json };
}
function claimed(ctx: Reader, attemptId: string, claimId: string) {
  const saved = owned(ctx, attemptId);
  if (!claimId || saved.attempt.claimId !== claimId) fail('FORBIDDEN', 'The durable voice claim is required.');
  return saved;
}
function persist(ctx: Db, saved: ReturnType<typeof owned>, next: Json): void {
  if (canonical(saved.attempt) === canonical(next)) return;
  check(saved.row.revision < 0xffff_ffff, 'The voice revision limit was reached.');
  next.revision = saved.row.revision + 1;
  next.updatedAtMicros = ctx.timestamp.microsSinceUnixEpoch.toString();
  const attemptJson = JSON.stringify(next);
  check(attemptJson.length <= 4_000_000, 'The saved voice evidence is too large.');
  ctx.db.voiceAttempt.id.update({ ...saved.row, revision: next.revision, status: next.status, attemptJson });
}

/** The server first reconstructs the current map. Its application identity owns this
 * durable reservation; browser/model inputs are never an authenticated worker. */
export function reserveVoiceAttempt(ctx: Db, { inputJson }: { inputJson: string }): void {
  const input = json(inputJson);
  for (const key of ['id', 'sessionId', 'requestKey', 'parcelId']) id(input[key]);
  mapBinding(input.mapBinding);
  check(typeof input.canonicalJson === 'string', 'The canonical map snapshot is required.'); json(input.canonicalJson);
  cents(input.offerCents); cents(input.capCents);
  check(input.offerCents <= input.capCents, 'The recommended offer exceeds its cap.');
  if (input.maxOfferCents !== undefined) {
    cents(input.maxOfferCents);
    check(input.maxOfferCents >= input.offerCents && input.maxOfferCents <= input.capCents, 'The budget maximum must remain between the initial offer and parcel cap.');
  }
  check(input.consent === true && typeof input.consentAt === 'string' && Number.isFinite(Date.parse(input.consentAt)), 'Explicit dated call consent is required.');
  check(input.privateContact && typeof input.privateContact.name === 'string' && input.privateContact.name.length <= 200 &&
    typeof input.privateContact.phone === 'string' && input.privateContact.phone.length > 0 && input.privateContact.phone.length <= 64, 'Private roleplay contact is required.');
  check(typeof input.bearerTokenHash === 'string' && /^[a-f0-9]{64}$/i.test(input.bearerTokenHash), 'An attempt-scoped credential hash is required.');
  const fingerprint = canonical(input), byId = ctx.db.voiceAttempt.id.find(input.id), prior = ctx.db.voiceAttempt.sessionId.find(input.sessionId);
  if (byId || prior) {
    const row = byId ?? prior!;
    if (row.workerIdentity !== ctx.sender.toHexString()) fail('FORBIDDEN', 'The voice session belongs to another worker.');
    if (row.id !== input.id || row.sessionId !== input.sessionId || row.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'This session already has its single original voice attempt.');
    return;
  }
  const now = ctx.timestamp.microsSinceUnixEpoch.toString();
  const attempt = { ...input, paymentSchedule: 'full-after-signatures', revision: 1, status: 'reserved',
    claimId: null, providerCallId: null, providerProgress: 0, candidate: null, outcome: null, evidence: [],
    currentOfferCents: input.offerCents, maxOfferCents: input.maxOfferCents ?? input.capCents,
    finalOfferMade: false, toolReceipts: {}, lastResponseRequestId: null, createdAtMicros: now, updatedAtMicros: now };
  ctx.db.voiceAttempt.insert({ id: input.id, sessionId: input.sessionId, workerIdentity: ctx.sender.toHexString(),
    revision: 1, status: 'reserved', fingerprint, attemptJson: JSON.stringify(attempt) });
}

/** One atomic claimant may cross the provider-write boundary. No lease expiry can redial. */
export function claimVoiceAttempt(ctx: Db, input: { id: string; claimId: string }): void {
  id(input.claimId);
  const saved = owned(ctx, input.id);
  if (saved.attempt.claimId) return;
  if (saved.attempt.status !== 'reserved') fail('BLOCKED_STATE', 'The call may already have been attempted.');
  persist(ctx, saved, { ...saved.attempt, claimId: input.claimId, status: 'dispatching' });
}

export function markVoiceAttempt(ctx: Db, input: { id: string; claimId: string; status: string; providerCallId: string; evidenceJson: string }): void {
  const saved = claimed(ctx, input.id, input.claimId), a = saved.attempt;
  check(PROVIDER_STATUS.has(input.status), 'Invalid provider status.');
  const evidence = json(input.evidenceJson, 200_000);
  if (evidence.turns !== undefined) {
    check(Array.isArray(evidence.turns) && evidence.turns.length <= 200 && evidence.turns.every((turn: any) =>
      turn && typeof turn.id === 'string' && typeof turn.text === 'string' && ['agent', 'owner'].includes(turn.role)), 'Invalid normalized provider turns.');
    check(new Set(evidence.turns.map((turn: any) => turn.id)).size === evidence.turns.length, 'Provider turn identifiers must be unique.');
    if (a.candidate) {
      const priorTurns = [...a.evidence].reverse().find(item => Array.isArray(item.turns))?.turns;
      check(canonical(priorTurns) === canonical(evidence.turns), 'The saved candidate transcript evidence is frozen.');
    }
  }
  if (input.providerCallId) {
    id(input.providerCallId);
    if (a.providerCallId && a.providerCallId !== input.providerCallId) fail('IDEMPOTENCY_CONFLICT', 'The provider call cannot be rebound.');
    const bound = ctx.db.voiceProviderCall.providerCallId.find(input.providerCallId);
    if (bound && bound.attemptId !== input.id) fail('IDEMPOTENCY_CONFLICT', 'The provider call already belongs to another attempt.');
  }
  if (TERMINAL.has(a.status)) return;
  if (['completed', 'failed', 'cancelled'].includes(a.status) && input.status !== a.status) fail('STALE_STATUS', 'A completed provider status cannot be overwritten.');
  if (input.status !== 'unknown' && (PROGRESS[input.status] ?? 0) < (a.providerProgress ?? PROGRESS[a.status] ?? 0)) fail('STALE_STATUS', 'An older provider status cannot overwrite current progress.');
  if (['submitted', 'ringing', 'connected', 'completed'].includes(input.status)) check(input.providerCallId || a.providerCallId, 'The provider call ID is required.');
  if (input.providerCallId && !ctx.db.voiceProviderCall.providerCallId.find(input.providerCallId))
    ctx.db.voiceProviderCall.insert({ providerCallId: input.providerCallId, attemptId: input.id });
  const history = [...a.evidence];
  if (Object.keys(evidence).length && !history.some(item => canonical(item) === canonical(evidence))) {
    check(history.length < 200, 'The evidence limit was reached.'); history.push(evidence);
  }
  persist(ctx, saved, { ...a, status: input.status, providerCallId: input.providerCallId || a.providerCallId,
    providerProgress: Math.max(a.providerProgress ?? 0, PROGRESS[input.status] ?? 0), evidence: history });
}

export function saveVoiceCandidate(ctx: Db, input: { id: string; claimId: string; candidateJson: string }): void {
  const saved = claimed(ctx, input.id, input.claimId), a = saved.attempt, candidate = json(input.candidateJson, 200_000);
  if (a.candidate) {
    if (canonical(a.candidate) !== canonical(candidate)) fail('IDEMPOTENCY_CONFLICT', 'The saved response candidate is immutable.');
    return;
  }
  check(['accepted', 'refused', 'conditional', 'review_required'].includes(candidate.decision), 'Invalid candidate decision.');
  if (candidate.acceptedCompensationCents !== null) { cents(candidate.acceptedCompensationCents); check(candidate.acceptedCompensationCents <= a.capCents, 'The candidate exceeds the approved cap.'); }
  if (['accepted', 'refused', 'conditional'].includes(candidate.decision)) {
    check(typeof candidate.evidenceTurnId === 'string' && candidate.evidenceTurnId.length > 0 &&
      typeof candidate.evidenceQuote === 'string' && candidate.evidenceQuote.length > 0, 'Explicit provider evidence is required for acceptance.');
    const turns = [...a.evidence].reverse().find(item => Array.isArray(item.turns))?.turns ?? [];
    const ownerTurn = turns.find((turn: any) => turn.id === candidate.evidenceTurnId);
    check(ownerTurn?.role === 'owner' && ownerTurn.text.includes(candidate.evidenceQuote), 'The owner quote must match a saved provider turn.');
    if (['accepted', 'conditional'].includes(candidate.decision)) {
      const offerTurn = turns.find((turn: any) => turn.id === candidate.offerTurnId);
      check(typeof candidate.offerQuote === 'string' && candidate.offerQuote.length > 0 && offerTurn?.role === 'agent' &&
        offerTurn.text.includes(candidate.offerQuote) && turns.indexOf(offerTurn) < turns.indexOf(ownerTurn),
      'The accepted offer must refer to the preceding saved agent evidence.');
    }
  }
  if (['accepted', 'conditional'].includes(candidate.decision)) {
    cents(candidate.acceptedCompensationCents);
    check(candidate.acceptedCompensationCents === a.currentOfferCents, 'Acceptance must match the saved authorized offer exactly.');
  }
  if (candidate.decision === 'conditional') check(candidate.condition && candidate.condition.target === 'edge' &&
    ['north', 'south', 'east', 'west'].includes(candidate.condition.direction), 'A verifiable same-parcel edge condition is required.');
  else check(candidate.condition === null, 'Only conditional candidates can carry a spatial condition.');
  if (TERMINAL.has(a.status)) fail('BLOCKED_STATE', 'The attempt already has a terminal outcome.');
  check(a.providerCallId, 'Provider-bound evidence is required before recording a response.');
  persist(ctx, saved, { ...a, candidate });
}

/** Managed-agent tool callbacks record a proposal/answer, not final agreement.
 * Only transcript-corroborated candidate/outcome commits can open contracts. */
export function recordVoiceTool(ctx: Db, input: { id: string; claimId: string; requestId: string; kind: string; payloadJson: string }): void {
  const saved = claimed(ctx, input.id, input.claimId), a = saved.attempt;
  id(input.requestId);
  check(['counteroffer', 'response'].includes(input.kind), 'Unknown voice tool.');
  const payload = json(input.payloadJson, 100_000);
  const receipts = a.toolReceipts ?? {}, prior = Object.hasOwn(receipts, input.requestId) ? receipts[input.requestId] : null;
  if (prior) {
    if (prior.kind !== input.kind || canonical(prior.payload) !== canonical(payload)) fail('IDEMPOTENCY_CONFLICT', 'The voice tool request ID has different content.');
    return;
  }
  check(!a.candidate && !TERMINAL.has(a.status) && !['failed', 'cancelled', 'completed'].includes(a.status), 'The voice response is already frozen.');
  // An authenticated provider tool can arrive before the outbound POST returns
  // its call ID. Its root-verified attempt credential binds this provisional
  // receipt; a final candidate still requires the provider ID and real turns.
  check(Object.keys(receipts).length < 200, 'The voice tool receipt limit was reached.');
  let currentOfferCents = a.currentOfferCents, finalOfferMade = a.finalOfferMade;
  const receipt: Json = { requestId: input.requestId, kind: input.kind, payload };
  if (input.kind === 'counteroffer') {
    if (payload.requestedCents !== null) cents(payload.requestedCents);
    if (!finalOfferMade) currentOfferCents = Math.max(a.offerCents, Math.min(payload.requestedCents ?? a.maxOfferCents, a.maxOfferCents));
    finalOfferMade = true;
    receipt.compensationCents = currentOfferCents; receipt.finalOffer = true;
  }
  persist(ctx, saved, { ...a, currentOfferCents, finalOfferMade,
    lastResponseRequestId: input.kind === 'response' ? input.requestId : a.lastResponseRequestId,
    toolReceipts: { ...receipts, [input.requestId]: receipt } });
}

export function saveVoiceOutcome(ctx: Db, input: { id: string; claimId: string; outcomeJson: string }): void {
  const saved = claimed(ctx, input.id, input.claimId), a = saved.attempt, outcome = json(input.outcomeJson);
  check(TERMINAL.has(outcome.status), 'Invalid final voice outcome.');
  check(outcome.parcelId === a.parcelId && canonical(outcome.originalMapBinding) === canonical(a.mapBinding), 'The outcome must refer to the original parcel and map.');
  if (a.outcome) {
    if (canonical(a.outcome) !== canonical(outcome)) fail('IDEMPOTENCY_CONFLICT', 'A terminal voice outcome cannot be changed.');
    return;
  }
  if (outcome.status === 'accepted') {
    check(a.status === 'completed' && a.providerCallId && a.candidate && ['accepted', 'conditional'].includes(a.candidate.decision), 'A completed call and saved explicit acceptance are required.');
    cents(outcome.acceptedCompensationCents);
    check(outcome.acceptedCompensationCents === a.candidate.acceptedCompensationCents && outcome.acceptedCompensationCents <= a.capCents, 'The accepted amount must remain exactly as agreed in the call.');
    if (a.candidate.decision === 'conditional') {
      const proof = outcome.relocationVerification;
      check(proof?.verified === true && proof.parcelId === a.parcelId && proof.acceptedCompensationCents === outcome.acceptedCompensationCents &&
        canonical(proof.condition) === canonical(a.candidate.condition) &&
        canonical(proof.originalMapBinding) === canonical(a.mapBinding) && canonical(proof.resultingMapBinding) === canonical(outcome.resultingMapBinding) &&
        typeof proof.geometryHash === 'string' && /^[a-f0-9]{64}$/i.test(proof.geometryHash), 'Conditional acceptance requires verified same-parcel relocation evidence at the same amount.');
      mapBinding(outcome.resultingMapBinding);
      check(outcome.resultingMapBinding.sessionId === a.mapBinding.sessionId, 'The relocated route must stay in the original map session.');
    } else check(!outcome.resultingMapBinding || canonical(outcome.resultingMapBinding) === canonical(a.mapBinding), 'Unconditional acceptance cannot silently change the route.');
  } else {
    check(outcome.acceptedCompensationCents === null, 'An unsuccessful outcome cannot create agreed money.');
    if (outcome.status === 'refused') check(a.candidate?.decision === 'refused' && a.providerCallId, 'Refusal requires saved provider-bound owner evidence.');
  }
  persist(ctx, saved, { ...a, status: outcome.status, outcome });
}

export function voiceWorkerAttempts(ctx: Reader) {
  return [...ctx.db.voiceAttempt.byWorker.filter(ctx.sender.toHexString())].map(({ id, sessionId, revision, status, attemptJson }) => ({ id, sessionId, revision, status, attemptJson }));
}
export function voiceResults(ctx: Reader) {
  return [...ctx.db.voiceAttempt.byWorker.filter(ctx.sender.toHexString())].map(row => {
    const a = JSON.parse(row.attemptJson), outcome = a.outcome;
    const result = { id: a.id, sessionId: a.sessionId, revision: row.revision, status: row.status, parcelId: a.parcelId,
      paymentSchedule: 'full-after-signatures', acceptedCompensationCents: outcome?.acceptedCompensationCents ?? null,
      currentOfferCents: a.currentOfferCents, finalOfferMade: a.finalOfferMade,
      eventId: outcome ? `voice-${a.id}-${row.revision}` : null,
      approvedAt: outcome?.status === 'accepted' ? new Date(Number(BigInt(a.updatedAtMicros) / 1000n)).toISOString() : null,
      originalMapBinding: a.mapBinding, resultingMapBinding: outcome?.resultingMapBinding ?? null };
    return { id: row.id, sessionId: row.sessionId, revision: row.revision, status: row.status, resultJson: JSON.stringify(result) };
  });
}
