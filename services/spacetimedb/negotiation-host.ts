import {
  NegotiationError, type NegotiationState, type NegotiationCommand, type NegotiationAttempt,
  type NegotiationTurn, type NegotiationToolBinding,
} from '@easygrid/contracts';

/** Implement using generated reducers plus worker-authorized views. Reducer promises
 * must resolve after commit, and reads must be fresh/subscription-ready. No Node cache
 * may supply mutation authority or be treated as the durable store. */
export interface NegotiationBackend {
  executeNegotiation(input: { sessionId: string; commandJson: string; providerTurnsJson: string }): Promise<void>;
  recordNegotiationTranscript(input: { sessionId: string; attemptId: string; requestId: string; providerTurnsJson: string }): Promise<void>;
  claimNegotiationReview(input: { sessionId: string; attemptId: string; claimId: string }): Promise<void>;
  commitNegotiationReview(input: { sessionId: string; claimId: string; commandJson: string; providerTurnsJson: string }): Promise<void>;
  workerState(sessionId: string): Promise<NegotiationState | null>;
  reviewState(sessionId: string, attemptId: string): Promise<{ claimId: string; completed: boolean } | null>;
}
function requireState(value: unknown, message: string): asserts value {
  if (!value) throw new NegotiationError('BLOCKED_STATE', message);
}

/** CAL-33 supplies its authenticated call binding and provider turns; CAL-41 owns
 * commits, saved receipts and review leases. This adapter never dials or loads secrets. */
export function createSavedNegotiationHost({ backend, sessionId, newClaimId }: {
  backend: NegotiationBackend; sessionId: string; newClaimId: () => string;
}) {
  // These are owned lease tokens only. Acquisition/exclusion/recovery lives in the DB.
  const ownedClaims = new Map<string, string>();
  async function savedAttempt(command: NegotiationCommand): Promise<NegotiationAttempt> {
    const state = await backend.workerState(sessionId);
    requireState(state?.active && state.handoff.sessionId === sessionId, 'The authoritative session is unavailable or closed.');
    const key = JSON.stringify([sessionId, command.attemptId, command.requestId]);
    const result = state.receipts[key]?.result ?? (Object.hasOwn(state.attempts, command.attemptId) ? state.attempts[command.attemptId] : null);
    requireState(result?.attemptId === command.attemptId && result.sessionId === sessionId && result.routeVersion === command.routeVersion,
      'The saved result does not match the submitted attempt.');
    return structuredClone(result);
  }
  return {
    async execute(binding: NegotiationToolBinding, command: NegotiationCommand, turns: NegotiationTurn[] = []) {
      requireState(binding.sessionId === sessionId && binding.attemptId === command.attemptId &&
        binding.routeVersion === command.routeVersion && binding.termsVersion === command.termsVersion,
      'The command does not match the authenticated call binding.');
      await backend.executeNegotiation({ sessionId, commandJson: JSON.stringify(command), providerTurnsJson: JSON.stringify(turns) });
      return savedAttempt(command);
    },
    async recordTranscript(attemptId: string, requestId: string, turns: NegotiationTurn[]) {
      await backend.recordNegotiationTranscript({ sessionId, attemptId, requestId, providerTurnsJson: JSON.stringify(turns) });
    },
    async claimReview(attemptId: string) {
      const claimId = newClaimId();
      await backend.claimNegotiationReview({ sessionId, attemptId, claimId });
      const claim = await backend.reviewState(sessionId, attemptId);
      if (!claim || claim.completed || claim.claimId !== claimId) return null;
      const state = await backend.workerState(sessionId);
      const attempt = state && Object.hasOwn(state.attempts, attemptId) ? state.attempts[attemptId] : null;
      if (!state?.active || !attempt || attempt.phase !== 'confirming') return null;
      ownedClaims.set(attemptId, claimId);
      return { attempt: structuredClone(attempt), turns: structuredClone(attempt.turns) };
    },
    async commit(command: NegotiationCommand, turns: NegotiationTurn[]) {
      const claimId = ownedClaims.get(command.attemptId);
      requireState(claimId, 'This worker did not acquire the durable review claim.');
      await backend.commitNegotiationReview({ sessionId, claimId, commandJson: JSON.stringify(command), providerTurnsJson: JSON.stringify(turns) });
      return savedAttempt(command);
    },
  };
}
