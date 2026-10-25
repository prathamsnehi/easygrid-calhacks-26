import type { NegotiationState } from '@easygrid/contracts';
import type { NegotiationBackend } from './negotiation-host.ts';

/** Reducer and view names exported by the CAL-41 module. Generated bindings use the
 * camel-case methods; these strings are the module names those methods call. */
export const NEGOTIATION_REDUCERS = {
  bindNegotiation: 'bind_negotiation',
  executeNegotiation: 'execute_negotiation',
  recordNegotiationTranscript: 'record_negotiation_transcript',
  claimNegotiationReview: 'claim_negotiation_review',
  commitNegotiationReview: 'commit_negotiation_review',
} as const;

export const NEGOTIATION_VIEWS = {
  workerState: 'negotiation_worker_state',
  reviewState: 'negotiation_review_state',
  results: 'negotiation_results',
} as const;

const VIEW_NAMES = new Set<string>(Object.values(NEGOTIATION_VIEWS));

/** Commit acknowledgement from a generated reducer callback. A resolved call is not
 * enough: the promise waits until this status is `committed`. */
export interface ReducerEventContext {
  event: { status?: string; message?: string };
}

export interface GeneratedReducer<T extends Record<string, unknown>> {
  call(args: T): void;
  /** Register a callback. Return an unsubscribe function. */
  onEvent(listener: (ctx: ReducerEventContext, args: T) => void): () => void;
}

/** The subset of a generated `DbConnection` this adapter uses. `subscribeView` must
 * resolve with rows only after that view subscription has applied. It must not return
 * an earlier cache. */
export interface GeneratedNegotiationConnection {
  reducers: {
    bindNegotiation: GeneratedReducer<Record<string, unknown>>;
    executeNegotiation: GeneratedReducer<Record<string, unknown>>;
    recordNegotiationTranscript: GeneratedReducer<Record<string, unknown>>;
    claimNegotiationReview: GeneratedReducer<Record<string, unknown>>;
    commitNegotiationReview: GeneratedReducer<Record<string, unknown>>;
  };
  subscribeView(name: string, args: Record<string, string>): Promise<unknown[]>;
}

export interface NegotiationModuleClient {
  callReducer(name: string, args: Record<string, unknown>): Promise<void>;
  readView(name: string, args: Record<string, string>): Promise<unknown[]>;
}

function sameArgs(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commitError(name: string, ctx: ReducerEventContext): Error {
  const status = ctx.event?.status ?? 'uncommitted';
  const message = ctx.event?.message;
  return new Error(message ? `${name} ${status}: ${message}` : `${name} did not commit (${status}).`);
}

/** Wait until the matching generated reducer callback reports a commit. */
export function callGeneratedReducer<T extends Record<string, unknown>>(
  reducer: GeneratedReducer<T>, name: string, args: T,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const unsubscribe = reducer.onEvent((ctx, received) => {
      if (settled || !sameArgs(received, args)) return;
      settled = true;
      unsubscribe();
      if (ctx.event?.status === 'committed') resolve();
      else reject(commitError(name, ctx));
    });
    try {
      reducer.call(args);
    } catch (error) {
      if (!settled) {
        settled = true;
        unsubscribe();
        reject(error instanceof Error ? error : new Error(`${name} failed before commit.`));
      }
    }
  });
}

/** Adapt generated reducer methods and view subscriptions. This does not open a
 * connection and does not target the previously published CAL-29 database. */
export function createGeneratedNegotiationClient(connection: GeneratedNegotiationConnection): NegotiationModuleClient {
  const reducers = connection.reducers;
  const methods = {
    [NEGOTIATION_REDUCERS.bindNegotiation]: reducers.bindNegotiation,
    [NEGOTIATION_REDUCERS.executeNegotiation]: reducers.executeNegotiation,
    [NEGOTIATION_REDUCERS.recordNegotiationTranscript]: reducers.recordNegotiationTranscript,
    [NEGOTIATION_REDUCERS.claimNegotiationReview]: reducers.claimNegotiationReview,
    [NEGOTIATION_REDUCERS.commitNegotiationReview]: reducers.commitNegotiationReview,
  } as const;
  return {
    callReducer(name, args) {
      const reducer = methods[name as keyof typeof methods];
      if (!reducer) return Promise.reject(new Error(`Unknown negotiation reducer: ${name}.`));
      return callGeneratedReducer(reducer, name, args);
    },
    readView(name, args) {
      if (!VIEW_NAMES.has(name)) return Promise.reject(new Error(`Unknown negotiation view: ${name}.`));
      return connection.subscribeView(name, args);
    },
  };
}

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/** CAL-33's `NegotiationBackend`, backed by reducer commits and fresh view reads. */
export function createModuleNegotiationBackend(client: NegotiationModuleClient): NegotiationBackend {
  return {
    async executeNegotiation(input) {
      await client.callReducer(NEGOTIATION_REDUCERS.executeNegotiation, input);
    },
    async recordNegotiationTranscript(input) {
      await client.callReducer(NEGOTIATION_REDUCERS.recordNegotiationTranscript, input);
    },
    async claimNegotiationReview(input) {
      await client.callReducer(NEGOTIATION_REDUCERS.claimNegotiationReview, input);
    },
    async commitNegotiationReview(input) {
      await client.callReducer(NEGOTIATION_REDUCERS.commitNegotiationReview, input);
    },
    async workerState(sessionId) {
      const rows = await client.readView(NEGOTIATION_VIEWS.workerState, { sessionId });
      const first = row(rows[0]);
      if (!first) return null;
      if (typeof first.stateJson !== 'string') throw new Error('The worker view did not return saved state.');
      return JSON.parse(first.stateJson) as NegotiationState;
    },
    async reviewState(sessionId, attemptId) {
      const rows = await client.readView(NEGOTIATION_VIEWS.reviewState, { sessionId, attemptId });
      const first = row(rows[0]);
      if (!first) return null;
      if (typeof first.claimId !== 'string' || typeof first.completed !== 'boolean') {
        throw new Error('The review view did not return the current claim.');
      }
      return { claimId: first.claimId, completed: first.completed };
    },
  };
}
