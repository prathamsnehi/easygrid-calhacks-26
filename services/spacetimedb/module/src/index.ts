import { SenderError, t } from 'spacetimedb/server';
import { check_call, start_call } from './call.ts';
import { commitStoredReview } from './call-logic.ts';
import {
  publishRoute,
  recordOutcome,
  registerWorker,
  startSession,
} from './logic.ts';
import { spacetimedb } from './tables.ts';

export { check_call, start_call };

const progress = t.object('SessionProgressRow', {
  sessionId: t.string(),
  revision: t.u32(),
  status: t.string(),
  routeVersion: t.u32(),
  publishedRouteCount: t.u32(),
  liveParcelId: t.string(),
  projectBudgetCents: t.u32(),
  explanation: t.string(),
});

const parcelView = t.object('RouteParcelRow', {
  parcelId: t.string(),
  ownerAlias: t.string(),
  towerCount: t.u32(),
  recommendedOfferCents: t.u32(),
  offerCapCents: t.u32(),
  monthlyRentCents: t.u32(),
  role: t.string(),
  outcome: t.string(),
  agreedCompensationCents: t.u32(),
  explanation: t.string(),
});

const commandView = t.object('CommandResultRow', {
  resultCode: t.string(),
  revision: t.u32(),
});

const obligationView = t.object('ObligationRow', {
  id: t.string(),
  parcelId: t.string(),
  stage: t.string(),
  amountCents: t.u32(),
  compensationCents: t.u32(),
});

export const session_progress = spacetimedb.view(
  { name: 'session_progress', public: true },
  { sessionId: t.string() },
  t.array(progress),
  (ctx, { sessionId }) => {
    const row = ctx.db.session.sessionId.find(sessionId);
    if (!row) return [];
    return [{
      sessionId: row.sessionId,
      revision: row.revision,
      status: row.status,
      routeVersion: row.routeVersion,
      publishedRouteCount: row.publishedRouteCount,
      liveParcelId: row.liveParcelId,
      projectBudgetCents: row.projectBudgetCents,
      explanation: row.explanation,
    }];
  },
);

export const current_route = spacetimedb.view(
  { name: 'current_route', public: true },
  { sessionId: t.string() },
  t.array(parcelView),
  (ctx, { sessionId }) => {
    const current = ctx.db.session.sessionId.find(sessionId);
    if (!current || current.routeVersion === 0) return [];
    return [...ctx.db.routeParcel.bySession.filter(sessionId)]
      .filter(row => row.routeVersion === current.routeVersion)
      .map(row => ({
        parcelId: row.parcelId,
        ownerAlias: row.ownerAlias,
        towerCount: row.towerCount,
        recommendedOfferCents: row.recommendedOfferCents,
        offerCapCents: row.offerCapCents,
        monthlyRentCents: row.monthlyRentCents,
        role: row.role,
        outcome: row.outcome,
        agreedCompensationCents: row.agreedCompensationCents,
        explanation: row.explanation,
      }));
  },
);

export const command_result = spacetimedb.view(
  { name: 'command_result', public: true },
  { sessionId: t.string(), requestKey: t.string() },
  t.array(commandView),
  (ctx, { sessionId, requestKey }) => {
    const row = ctx.db.receipt.id.find(JSON.stringify([sessionId, requestKey]));
    if (!row) return [];
    return [{ resultCode: row.resultCode, revision: row.revision }];
  },
);

export const obligations = spacetimedb.view(
  { name: 'obligations', public: true },
  { sessionId: t.string() },
  t.array(obligationView),
  (ctx, { sessionId }) =>
    [...ctx.db.obligation.bySession.filter(sessionId)].map(row => ({
      id: row.id,
      parcelId: row.parcelId,
      stage: row.stage,
      amountCents: row.amountCents,
      compensationCents: row.compensationCents,
    })),
);

export const start_session = spacetimedb.reducer(
  {
    sessionId: t.string(),
    phone: t.string(),
    projectBudgetCents: t.u32(),
    requestKey: t.string(),
  },
  (ctx, input) => startSession(ctx, input),
);

export const register_worker = spacetimedb.reducer(
  {
    sessionId: t.string(),
    expectedRevision: t.u32(),
    requestKey: t.string(),
    workerIdentity: t.string(),
  },
  (ctx, input) => registerWorker(ctx, input),
);

export const publish_route = spacetimedb.reducer(
  {
    sessionId: t.string(),
    expectedRevision: t.u32(),
    requestKey: t.string(),
    parcels: t.array(t.object('RouteParcelInput', {
      parcelId: t.string(),
      ownerAlias: t.string(),
      towerCount: t.u32(),
      lineLengthMillis: t.u32(),
      recommendedOfferCents: t.u32(),
      offerCapCents: t.u32(),
      monthlyRentCents: t.u32(),
    })),
  },
  (ctx, input) => publishRoute(ctx, input),
);

const summaryRow = t.object('NegotiationResultRow', {
  attemptId: t.string(),
  sessionId: t.string(),
  parcelId: t.string(),
  mode: t.string(),
  phase: t.string(),
  lifecycle: t.string(),
  revision: t.u32(),
  outcome: t.string(),
  disposition: t.string(),
  reason: t.string(),
  explanation: t.string(),
  nextAction: t.string(),
  openingCents: t.u32(),
  finalCents: t.u32(),
  monthlyRentCents: t.u32(),
  agreedCents: t.u32(),
});

export const negotiation_result = spacetimedb.view(
  { name: 'negotiation_result', public: true },
  { sessionId: t.string() },
  t.array(summaryRow),
  (ctx, { sessionId }) => [...ctx.db.negotiationSummary.bySession.filter(sessionId)].map(row => ({
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
  })),
);

export const commit_call_review = spacetimedb.reducer(
  {
    attemptId: t.string(),
    reason: t.string(),
    offerTurnId: t.string(),
    ownerTurnId: t.string(),
    compensationCents: t.u32(),
    monthlyRentCents: t.u32(),
    hasAmounts: t.bool(),
    failureReason: t.string(),
  },
  (ctx, input) => {
    if (ctx.sender.toHexString() !== ctx.databaseIdentity.toHexString()) {
      throw new SenderError('FORBIDDEN: Only the database can commit a call review.');
    }
    commitStoredReview(ctx, input.attemptId, input.failureReason ? null : {
      reason: input.reason,
      offerTurnId: input.offerTurnId,
      ownerTurnId: input.ownerTurnId,
      compensationCents: input.hasAmounts ? input.compensationCents : null,
      monthlyRentCents: input.hasAmounts ? input.monthlyRentCents : null,
    }, input.failureReason);
  },
);

export const record_outcome = spacetimedb.reducer(
  {
    sessionId: t.string(),
    expectedRevision: t.u32(),
    requestKey: t.string(),
    parcelId: t.string(),
    outcome: t.string(),
    requestedCents: t.u32(),
    agreedCents: t.u32(),
    explanation: t.string(),
  },
  (ctx, input) => recordOutcome(ctx, input),
);

export default spacetimedb;
