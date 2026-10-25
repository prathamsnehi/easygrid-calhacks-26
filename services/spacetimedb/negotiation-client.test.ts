import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGeneratedNegotiationClient, createModuleNegotiationBackend, NEGOTIATION_REDUCERS, NEGOTIATION_VIEWS,
  type GeneratedReducer, type ReducerEventContext,
} from './negotiation-client.ts';

function reducer(): GeneratedReducer<Record<string, unknown>> & {
  emit(ctx: ReducerEventContext, args: Record<string, unknown>): void;
} {
  const listeners = new Set<(ctx: ReducerEventContext, args: Record<string, unknown>) => void>();
  return {
    call() {},
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(ctx, args) {
      for (const listener of [...listeners]) listener(ctx, args);
    },
  };
}

function connection() {
  const reducers = {
    bindNegotiation: reducer(),
    executeNegotiation: reducer(),
    recordNegotiationTranscript: reducer(),
    claimNegotiationReview: reducer(),
    commitNegotiationReview: reducer(),
  };
  const reads: Array<{ name: string; applied: boolean }> = [];
  let applied = false;
  let rows: unknown[] = [];
  return {
    reducers, reads,
    setApplied(value: boolean, next: unknown[] = rows) { applied = value; rows = next; },
    subscribeView(name: string) {
      reads.push({ name, applied });
      if (!applied) return Promise.reject(new Error('subscription is not applied'));
      return Promise.resolve(rows);
    },
  };
}

test('a reducer promise stays pending until the matching callback commits', async () => {
  const clientConnection = connection();
  const client = createGeneratedNegotiationClient(clientConnection);
  const args = { sessionId: 'canonical-session', commandJson: '{}', providerTurnsJson: '[]' };
  let status = 'pending';
  const pending = client.callReducer(NEGOTIATION_REDUCERS.executeNegotiation, args).then(() => { status = 'committed'; }, () => { status = 'rejected'; });
  await Promise.resolve();
  assert.equal(status, 'pending');
  clientConnection.reducers.executeNegotiation.emit({ event: { status: 'committed' } }, { ...args, commandJson: 'other' });
  await Promise.resolve();
  assert.equal(status, 'pending');
  clientConnection.reducers.executeNegotiation.emit({ event: { status: 'failed', message: 'rejected' } }, args);
  await pending;
  assert.equal(status, 'rejected');
  status = 'pending';
  const committed = client.callReducer(NEGOTIATION_REDUCERS.executeNegotiation, args).then(() => { status = 'committed'; });
  clientConnection.reducers.executeNegotiation.emit({ event: { status: 'committed' } }, args);
  await committed;
  assert.equal(status, 'committed');
});

test('worker and review reads reject a cache that has not applied', async () => {
  const clientConnection = connection();
  const backend = createModuleNegotiationBackend(createGeneratedNegotiationClient(clientConnection));
  await assert.rejects(backend.workerState('canonical-session'), /not applied/);
  assert.equal(clientConnection.reads.at(-1)?.applied, false);
  clientConnection.setApplied(true, [{
    stateJson: JSON.stringify({ active: true, handoff: { sessionId: 'canonical-session' }, attempts: {}, receipts: {} }),
  }]);
  const state = await backend.workerState('canonical-session');
  assert.equal(state?.handoff.sessionId, 'canonical-session');
  assert.equal(clientConnection.reads.at(-1)?.name, NEGOTIATION_VIEWS.workerState);
  clientConnection.setApplied(true, [{ claimId: 'review-1', completed: false, leaseUntilMicros: 1 }]);
  assert.deepEqual(await backend.reviewState('canonical-session', 'attempt'), { claimId: 'review-1', completed: false });
  clientConnection.setApplied(true, []);
  assert.equal(await backend.workerState('canonical-session'), null);
});
