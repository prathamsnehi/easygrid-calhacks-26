import { SenderError, type ReducerCtx } from 'spacetimedb/server';
import type { InferSchema } from 'spacetimedb/server';
import { spacetimedb } from './tables.ts';

export type Db = ReducerCtx<InferSchema<typeof spacetimedb>>;

export const MAX_PUBLISHED_ROUTES = 3;

export interface RouteParcelInput {
  parcelId: string;
  ownerAlias: string;
  towerCount: number;
  lineLengthMillis: number;
  recommendedOfferCents: number;
  offerCapCents: number;
  monthlyRentCents: number;
}

export interface StartSessionInput {
  sessionId: string;
  phone: string;
  projectBudgetCents: number;
  requestKey: string;
}

export interface PublishRouteInput {
  sessionId: string;
  expectedRevision: number;
  requestKey: string;
  parcels: readonly RouteParcelInput[];
}

export interface RecordOutcomeInput {
  sessionId: string;
  expectedRevision: number;
  requestKey: string;
  parcelId: string;
  outcome: string;
  requestedCents: number;
  agreedCents: number;
  explanation: string;
}

export interface RegisterWorkerInput {
  sessionId: string;
  expectedRevision: number;
  requestKey: string;
  workerIdentity: string;
}

function fail(code: string, message: string): never {
  throw new SenderError(`${code}: ${message}`);
}

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail('INVALID_INPUT', `${label} must be a nonnegative integer cent amount.`);
  }
  return value;
}

function text(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    fail('INVALID_INPUT', `${label} must be 1 to ${max} characters.`);
  }
  return trimmed;
}

export function offerCapCents(recommendedOfferCents: number): number {
  return Number((BigInt(recommendedOfferCents) * 6n) / 5n);
}

export function contractTrancheCents(compensationCents: number): number {
  return Math.floor(compensationCents / 5);
}

function pairId(sessionId: string, parcelId: string): string {
  return JSON.stringify([sessionId, parcelId]);
}

function routeParcelId(sessionId: string, routeVersion: number, parcelId: string): string {
  return JSON.stringify([sessionId, routeVersion, parcelId]);
}

function receiptId(sessionId: string, requestKey: string): string {
  return JSON.stringify([sessionId, requestKey]);
}

export function obligationId(sessionId: string, parcelId: string): string {
  return JSON.stringify([sessionId, parcelId, 'contract_tranche', null]);
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function senderHex(ctx: Db): string {
  return ctx.sender.toHexString();
}

function loadSession(ctx: Db, sessionId: string) {
  const row = ctx.db.session.sessionId.find(sessionId);
  if (!row) fail('NOT_FOUND', 'No session exists with that id.');
  return row;
}

function authorize(ctx: Db, operatorIdentity: string, workerIdentity: string): void {
  const sender = senderHex(ctx);
  if (sender !== operatorIdentity && (workerIdentity === '' || sender !== workerIdentity)) {
    fail('FORBIDDEN', 'This identity cannot change the session.');
  }
}

/** Matching request key returns the original result. A different payload conflicts. Runs before revision checks. */
function beginCommand(ctx: Db, sessionId: string, requestKey: string, body: unknown): { replay: boolean } {
  const key = text(requestKey, 'Request key', 128);
  const existing = ctx.db.receipt.id.find(receiptId(sessionId, key));
  if (!existing) return { replay: false };
  if (existing.fingerprint !== fingerprint(body)) {
    fail('IDEMPOTENCY_CONFLICT', 'This request key was already used with a different payload.');
  }
  return { replay: true };
}

function commitReceipt(ctx: Db, sessionId: string, requestKey: string, body: unknown, resultCode: string, revision: number): void {
  ctx.db.receipt.insert({
    id: receiptId(sessionId, text(requestKey, 'Request key', 128)),
    sessionId,
    requestKey: text(requestKey, 'Request key', 128),
    fingerprint: fingerprint(body),
    resultCode,
    revision,
  });
}

function currentParcels(ctx: Db, sessionId: string, routeVersion: number) {
  return [...ctx.db.routeParcel.bySession.filter(sessionId)].filter(row => row.routeVersion === routeVersion);
}

function excluded(ctx: Db, sessionId: string, parcelId: string): boolean {
  return ctx.db.exclusion.id.find(pairId(sessionId, parcelId)) !== null;
}

export function startSession(ctx: Db, input: StartSessionInput): void {
  const sessionId = text(input.sessionId, 'Session id', 128);
  const phone = text(input.phone, 'Phone', 32);
  const projectBudgetCents = cents(input.projectBudgetCents, 'Project budget');
  const body = { sessionId, phone, projectBudgetCents, requestKey: text(input.requestKey, 'Request key', 128) };
  if (beginCommand(ctx, sessionId, input.requestKey, body).replay) return;
  if (ctx.db.session.sessionId.find(sessionId)) {
    fail('IDEMPOTENCY_CONFLICT', 'That session id already exists.');
  }
  ctx.db.session.insert({
    sessionId,
    operatorIdentity: senderHex(ctx),
    workerIdentity: '',
    revision: 1,
    status: 'awaiting_route',
    routeVersion: 0,
    publishedRouteCount: 0,
    liveParcelId: '',
    projectBudgetCents,
    explanation: '',
  });
  ctx.db.contact.insert({ sessionId, phone });
  commitReceipt(ctx, sessionId, input.requestKey, body, 'SESSION_STARTED', 1);
}

export function registerWorker(ctx: Db, input: RegisterWorkerInput): void {
  const sessionId = text(input.sessionId, 'Session id', 128);
  const workerIdentity = text(input.workerIdentity, 'Worker identity', 128);
  const body = {
    sessionId,
    expectedRevision: input.expectedRevision,
    requestKey: text(input.requestKey, 'Request key', 128),
    workerIdentity,
  };
  if (beginCommand(ctx, sessionId, input.requestKey, body).replay) return;
  const current = loadSession(ctx, sessionId);
  if (senderHex(ctx) !== current.operatorIdentity) fail('FORBIDDEN', 'Only the session operator can register a worker.');
  if (current.revision !== input.expectedRevision) fail('STALE_REVISION', 'The session revision changed.');
  const revision = current.revision + 1;
  ctx.db.session.sessionId.update({ ...current, workerIdentity, revision });
  commitReceipt(ctx, sessionId, input.requestKey, body, 'WORKER_REGISTERED', revision);
}

export function publishRoute(ctx: Db, input: PublishRouteInput): void {
  const sessionId = text(input.sessionId, 'Session id', 128);
  if (ctx.db.negotiationSession.sessionId.find(sessionId)) fail('BLOCKED_STATE', 'This session uses the CAL-41 negotiation workflow.');
  const parcels = input.parcels.map(normalizeParcel);
  const body = { sessionId, expectedRevision: input.expectedRevision, requestKey: text(input.requestKey, 'Request key', 128), parcels };
  if (beginCommand(ctx, sessionId, input.requestKey, body).replay) return;
  const current = loadSession(ctx, sessionId);
  authorize(ctx, current.operatorIdentity, current.workerIdentity);
  if (current.revision !== input.expectedRevision) fail('STALE_REVISION', 'The session revision changed.');
  if (current.status === 'needs_review' || current.status === 'agreement_ready' || current.status === 'negotiating') {
    fail('BLOCKED_STATE', 'The session cannot accept a route in its current state.');
  }
  if (current.publishedRouteCount >= MAX_PUBLISHED_ROUTES) {
    const revision = current.revision + 1;
    ctx.db.session.sessionId.update({
      ...current,
      revision,
      status: 'blocked',
      explanation: 'The session reached the three-route limit.',
    });
    commitReceipt(ctx, sessionId, input.requestKey, body, 'ROUTE_BLOCKED', revision);
    return;
  }

  const towers = parcels.filter(parcel => parcel.towerCount > 0);
  if (towers.length === 0) fail('INVALID_INPUT', 'The route has no tower parcel to negotiate.');
  for (const parcel of towers) {
    if (excluded(ctx, sessionId, parcel.parcelId)) {
      fail('INVALID_INPUT', `Parcel ${parcel.parcelId} already refused and cannot return.`);
    }
  }
  const recommendedTotal = towers.reduce((sum, parcel) => sum + parcel.recommendedOfferCents, 0);
  if (recommendedTotal > current.projectBudgetCents) {
    fail('INVALID_INPUT', 'The recommended offers exceed the project budget.');
  }
  towers.sort((a, b) => b.towerCount - a.towerCount || b.lineLengthMillis - a.lineLengthMillis || (a.parcelId < b.parcelId ? -1 : a.parcelId > b.parcelId ? 1 : 0));
  const live = towers[0];
  if (!live) fail('INVALID_INPUT', 'The route has no tower parcel to negotiate.');
  const others = towers.slice(1).reduce((sum, parcel) => sum + parcel.recommendedOfferCents, 0);
  const allowedMax = Math.min(live.offerCapCents, current.projectBudgetCents - others);
  if (live.recommendedOfferCents > allowedMax) {
    fail('INVALID_INPUT', 'The live parcel opening offer does not fit the remaining budget.');
  }

  const routeVersion = current.routeVersion + 1;
  const revision = current.revision + 1;
  for (const parcel of towers) {
    const isLive = parcel.parcelId === live.parcelId;
    ctx.db.routeParcel.insert({
      id: routeParcelId(sessionId, routeVersion, parcel.parcelId),
      sessionId,
      routeVersion,
      parcelId: parcel.parcelId,
      ownerAlias: parcel.ownerAlias,
      towerCount: parcel.towerCount,
      lineLengthMillis: parcel.lineLengthMillis,
      recommendedOfferCents: parcel.recommendedOfferCents,
      offerCapCents: parcel.offerCapCents,
      monthlyRentCents: parcel.monthlyRentCents,
      role: isLive ? 'live' : 'simulated',
      outcome: isLive ? 'pending' : 'accepted_simulated',
      agreedCompensationCents: isLive ? 0 : parcel.recommendedOfferCents,
      explanation: isLive ? '' : 'Hackathon demo: this owner was not called and is recorded as agreed.',
    });
  }
  ctx.db.session.sessionId.update({
    ...current,
    revision,
    status: 'negotiating',
    routeVersion,
    publishedRouteCount: current.publishedRouteCount + 1,
    liveParcelId: live.parcelId,
    explanation: '',
  });
  commitReceipt(ctx, sessionId, input.requestKey, body, 'ROUTE_PUBLISHED', revision);
}

function normalizeParcel(parcel: RouteParcelInput): RouteParcelInput {
  const recommendedOfferCents = cents(parcel.recommendedOfferCents, 'Recommended offer');
  const offerCap = cents(parcel.offerCapCents, 'Offer cap');
  const expectedCap = offerCapCents(recommendedOfferCents);
  if (parcel.towerCount > 0 && recommendedOfferCents === 0) {
    fail('INVALID_INPUT', 'A tower parcel needs a recommended offer.');
  }
  if (offerCap !== expectedCap) {
    fail('INVALID_INPUT', 'The offer cap must be 120 percent of the recommendation, rounded down to cents.');
  }
  return {
    parcelId: text(parcel.parcelId, 'Parcel id', 128),
    ownerAlias: text(parcel.ownerAlias, 'Owner alias', 128),
    towerCount: cents(parcel.towerCount, 'Tower count'),
    lineLengthMillis: cents(parcel.lineLengthMillis, 'Line length'),
    recommendedOfferCents,
    offerCapCents: offerCap,
    monthlyRentCents: cents(parcel.monthlyRentCents, 'Monthly fee'),
  };
}

export function recordOutcome(ctx: Db, input: RecordOutcomeInput): void {
  if (ctx.db.negotiationSession.sessionId.find(input.sessionId)) fail('BLOCKED_STATE', 'This session uses the CAL-41 negotiation workflow.');
  const sessionId = text(input.sessionId, 'Session id', 128);
  const parcelId = text(input.parcelId, 'Parcel id', 128);
  const outcome = text(input.outcome, 'Outcome', 32);
  const requestedCents = cents(input.requestedCents, 'Requested compensation');
  const agreedCents = cents(input.agreedCents, 'Agreed compensation');
  const explanation = input.explanation.trim();
  const body = {
    sessionId,
    expectedRevision: input.expectedRevision,
    requestKey: text(input.requestKey, 'Request key', 128),
    parcelId,
    outcome,
    requestedCents,
    agreedCents,
    explanation,
  };
  if (beginCommand(ctx, sessionId, input.requestKey, body).replay) return;
  const current = loadSession(ctx, sessionId);
  authorize(ctx, current.operatorIdentity, current.workerIdentity);
  if (current.revision !== input.expectedRevision) fail('STALE_REVISION', 'The session revision changed.');
  if (current.status !== 'negotiating' || current.liveParcelId !== parcelId) {
    fail('BLOCKED_STATE', 'Only the current live landowner can produce an outcome.');
  }
  const parcel = ctx.db.routeParcel.id.find(routeParcelId(sessionId, current.routeVersion, parcelId));
  if (!parcel || parcel.role !== 'live' || parcel.outcome !== 'pending') {
    fail('BLOCKED_STATE', 'The live negotiation is no longer pending.');
  }
  if (outcome === 'accepted') accept(ctx, current, parcel, requestedCents, agreedCents, input.requestKey, body);
  else if (outcome === 'refused') close(ctx, current, parcel, 'refused', 'needs_replan', 'REFUSED', explanation, input.requestKey, body);
  else if (outcome === 'needs_review') close(ctx, current, parcel, 'needs_review', 'needs_review', 'NEEDS_REVIEW', explanation, input.requestKey, body);
  else fail('INVALID_INPUT', 'Outcome must be accepted, refused, or needs_review.');
}

function allowedMaxFor(ctx: Db, sessionBudget: number, sessionId: string, routeVersion: number, liveParcelId: string, liveCap: number): number {
  const others = currentParcels(ctx, sessionId, routeVersion)
    .filter(row => row.parcelId !== liveParcelId)
    .reduce((sum, row) => sum + row.recommendedOfferCents, 0);
  return Math.min(liveCap, sessionBudget - others);
}

function accept(
  ctx: Db,
  current: ReturnType<typeof loadSession>,
  parcel: ReturnType<typeof currentParcels>[number],
  requestedCents: number,
  agreedCents: number,
  requestKey: string,
  body: unknown,
): void {
  const allowedMax = allowedMaxFor(ctx, current.projectBudgetCents, current.sessionId, current.routeVersion, parcel.parcelId, parcel.offerCapCents);
  const target = requestedCents === 0 ? parcel.recommendedOfferCents : requestedCents <= allowedMax ? requestedCents : allowedMax;
  if (agreedCents !== target) {
    fail('INVALID_INPUT', 'The agreed compensation does not match the one permitted raise.');
  }
  const revision = current.revision + 1;
  ctx.db.routeParcel.id.update({
    ...parcel,
    outcome: 'accepted_live',
    agreedCompensationCents: agreedCents,
    explanation: '',
  });
  const parcels = currentParcels(ctx, current.sessionId, current.routeVersion).map(row =>
    row.parcelId === parcel.parcelId ? { ...row, agreedCompensationCents: agreedCents } : row,
  );
  for (const row of parcels) {
    const compensation = row.parcelId === parcel.parcelId ? agreedCents : row.agreedCompensationCents;
    const id = obligationId(current.sessionId, row.parcelId);
    if (ctx.db.obligation.id.find(id)) {
      fail('DUPLICATE_OBLIGATION', 'That compensation tranche is already recorded.');
    }
    ctx.db.obligation.insert({
      id,
      sessionId: current.sessionId,
      parcelId: row.parcelId,
      stage: 'contract_tranche',
      amountCents: contractTrancheCents(compensation),
      compensationCents: compensation,
      requestKey: text(requestKey, 'Request key', 128),
    });
  }
  ctx.db.agreement.insert({ sessionId: current.sessionId, routeVersion: current.routeVersion, revision });
  ctx.db.session.sessionId.update({
    ...current,
    revision,
    status: 'agreement_ready',
    explanation: '',
  });
  commitReceipt(ctx, current.sessionId, requestKey, body, 'ACCEPTED', revision);
}

function close(
  ctx: Db,
  current: ReturnType<typeof loadSession>,
  parcel: ReturnType<typeof currentParcels>[number],
  parcelOutcome: string,
  status: string,
  resultCode: string,
  explanation: string,
  requestKey: string,
  body: unknown,
): void {
  const note = text(explanation, 'Explanation', 500);
  const revision = current.revision + 1;
  ctx.db.routeParcel.id.update({ ...parcel, outcome: parcelOutcome, explanation: note });
  if (parcelOutcome === 'refused' && !excluded(ctx, current.sessionId, parcel.parcelId)) {
    ctx.db.exclusion.insert({
      id: pairId(current.sessionId, parcel.parcelId),
      sessionId: current.sessionId,
      parcelId: parcel.parcelId,
    });
  }
  ctx.db.session.sessionId.update({
    ...current,
    revision,
    status,
    explanation: note,
  });
  commitReceipt(ctx, current.sessionId, requestKey, body, resultCode, revision);
}
