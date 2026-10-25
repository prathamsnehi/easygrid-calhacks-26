import { t } from 'spacetimedb/server';
import {
  publishRoute,
  recordOutcome,
  registerWorker,
  startSession,
} from './logic.ts';
import { spacetimedb } from './tables.ts';

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
