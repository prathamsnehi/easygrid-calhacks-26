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
import { reserveVoiceAttempt, claimVoiceAttempt, markVoiceAttempt, saveVoiceCandidate, saveVoiceOutcome, recordVoiceTool, voiceWorkerAttempts, voiceResults } from './voice-state.ts';
import {
  bindNegotiation, executeNegotiation, claimNegotiationReview, commitNegotiationReview,
  closeNegotiation, recordNegotiationTranscript, negotiationResults, negotiationWorkerState, negotiationReviewState, negotiationAgreements,
} from './negotiation-state.ts';

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

const summaryRow = t.object('CallResultRow', {
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

export const call_result = spacetimedb.view(
  { name: 'call_result', public: true },
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

export const bind_negotiation = spacetimedb.reducer(
  { sessionId: t.string(), expectedRevision: t.u32(), requestKey: t.string(), handoffJson: t.string(), mapBindingJson: t.string() },
  (ctx, input) => bindNegotiation(ctx, input),
);
export const execute_negotiation = spacetimedb.reducer(
  { sessionId: t.string(), commandJson: t.string(), providerTurnsJson: t.string() },
  (ctx, input) => executeNegotiation(ctx, input),
);
export const claim_negotiation_review = spacetimedb.reducer(
  { sessionId: t.string(), attemptId: t.string(), claimId: t.string() },
  (ctx, input) => claimNegotiationReview(ctx, input),
);
export const record_negotiation_transcript = spacetimedb.reducer(
  { sessionId: t.string(), attemptId: t.string(), requestId: t.string(), providerTurnsJson: t.string() },
  (ctx, input) => recordNegotiationTranscript(ctx, input),
);
export const commit_negotiation_review = spacetimedb.reducer(
  { sessionId: t.string(), claimId: t.string(), commandJson: t.string(), providerTurnsJson: t.string() },
  (ctx, input) => commitNegotiationReview(ctx, input),
);
export const close_negotiation = spacetimedb.reducer(
  { sessionId: t.string() }, (ctx, input) => closeNegotiation(ctx, input),
);
export const negotiation_results = spacetimedb.view(
  { name: 'negotiation_results', public: true }, { sessionId: t.string() },
  t.array(t.object('NegotiationResultRow', { attemptId: t.string(), revision: t.u32(), updateJson: t.string() })),
  (ctx, { sessionId }) => negotiationResults(ctx, sessionId),
);
export const negotiation_worker_state = spacetimedb.view(
  { name: 'negotiation_worker_state', public: true }, { sessionId: t.string() },
  t.array(t.object('NegotiationWorkerStateRow', { stateJson: t.string(), mapBindingJson: t.string() })),
  (ctx, { sessionId }) => negotiationWorkerState(ctx, sessionId),
);
export const negotiation_review_state = spacetimedb.view(
  { name: 'negotiation_review_state', public: true }, { sessionId: t.string(), attemptId: t.string() },
  t.array(t.object('NegotiationReviewStateRow', { claimId: t.string(), leaseUntilMicros: t.u64(), completed: t.bool() })),
  (ctx, { sessionId, attemptId }) => negotiationReviewState(ctx, sessionId, attemptId),
);
export const negotiation_agreements = spacetimedb.view(
  { name: 'negotiation_agreements', public: true }, { sessionId: t.string() },
  t.array(t.object('NegotiationAgreementRow', { revision: t.u32(), packetJson: t.string() })),
  (ctx, { sessionId }) => negotiationAgreements(ctx, sessionId),
);

export const reserve_voice_attempt = spacetimedb.reducer({ inputJson: t.string() }, (ctx, input) => reserveVoiceAttempt(ctx, input));
export const claim_voice_attempt = spacetimedb.reducer({ id: t.string(), claimId: t.string() }, (ctx, input) => claimVoiceAttempt(ctx, input));
export const mark_voice_attempt = spacetimedb.reducer({ id: t.string(), claimId: t.string(), status: t.string(), providerCallId: t.string(), evidenceJson: t.string() }, (ctx, input) => markVoiceAttempt(ctx, input));
export const save_voice_candidate = spacetimedb.reducer({ id: t.string(), claimId: t.string(), candidateJson: t.string() }, (ctx, input) => saveVoiceCandidate(ctx, input));
export const save_voice_outcome = spacetimedb.reducer({ id: t.string(), claimId: t.string(), outcomeJson: t.string() }, (ctx, input) => saveVoiceOutcome(ctx, input));
export const record_voice_tool = spacetimedb.reducer({ id: t.string(), claimId: t.string(), requestId: t.string(), kind: t.string(), payloadJson: t.string() }, (ctx, input) => recordVoiceTool(ctx, input));
export const voice_worker_attempts = spacetimedb.view({ name: 'voice_worker_attempts', public: true }, t.array(t.object('VoiceWorkerAttemptRow', {
  id: t.string(), sessionId: t.string(), revision: t.u32(), status: t.string(), attemptJson: t.string(),
})), ctx => voiceWorkerAttempts(ctx));
export const voice_results = spacetimedb.view({ name: 'voice_results', public: true }, t.array(t.object('VoiceResultRow', {
  id: t.string(), sessionId: t.string(), revision: t.u32(), status: t.string(), resultJson: t.string(),
})), ctx => voiceResults(ctx));

export default spacetimedb;
