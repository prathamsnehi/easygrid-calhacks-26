import { randomUUID } from 'node:crypto';
import { createSpacetimeDBService, type SpacetimeDBServiceOptions } from './client.ts';

export interface VoiceMapBinding {
  sessionId: string; routeId: string; routeVersion: number; proposalKey: string;
}
export interface VoiceCandidate {
  decision: 'accepted' | 'refused' | 'conditional' | 'review_required';
  acceptedCompensationCents: number | null;
  condition: { direction: 'north' | 'south' | 'east' | 'west'; target: 'edge' } | null;
  evidenceTurnId: string; evidenceQuote: string; reason: string;
  offerTurnId?: string | null; offerQuote?: string | null;
}
export interface VoiceOutcome {
  status: 'accepted' | 'refused' | 'review_required'; parcelId: string;
  acceptedCompensationCents: number | null; originalMapBinding: VoiceMapBinding;
  resultingMapBinding?: VoiceMapBinding;
  relocationVerification?: {
    verified: true; parcelId: string; acceptedCompensationCents: number;
    originalMapBinding: VoiceMapBinding; resultingMapBinding: VoiceMapBinding; geometryHash: string;
    condition: { direction: 'north' | 'south' | 'east' | 'west'; target: 'edge' };
  };
}
export interface ReserveVoiceAttempt {
  id: string; sessionId: string; requestKey: string; parcelId: string;
  mapBinding: VoiceMapBinding; canonicalJson: string;
  privateContact: { name: string; phone: string };
  consent: true; consentAt: string; bearerTokenHash: string;
  capCents: number; offerCents: number; maxOfferCents?: number;
}
export interface VoiceToolReceipt {
  requestId: string; kind: 'counteroffer' | 'response'; payload: Record<string, unknown>;
  compensationCents?: number; finalOffer?: boolean;
}
export interface VoiceAttempt extends ReserveVoiceAttempt {
  paymentSchedule: 'full-after-signatures'; revision: number; status: string;
  claimId: string | null; providerCallId: string | null;
  candidate: VoiceCandidate | null; outcome: VoiceOutcome | null;
  evidence: Record<string, unknown>[]; createdAtMicros: string; updatedAtMicros: string;
  currentOfferCents: number; finalOfferMade: boolean;
  toolReceipts: Record<string, VoiceToolReceipt>; lastResponseRequestId: string | null;
}
export interface VoiceResult {
  id: string; sessionId: string; revision: number; status: string; parcelId: string;
  paymentSchedule: 'full-after-signatures'; acceptedCompensationCents: number | null;
  originalMapBinding: VoiceMapBinding; resultingMapBinding: VoiceMapBinding | null;
  currentOfferCents: number; finalOfferMade: boolean; eventId: string | null; approvedAt: string | null;
}

interface ViewRow { id: string; sessionId: string; revision: number; status: string }
interface CacheTable<Row> {
  iter(): Iterable<Row>;
  onInsert(callback: (...args: unknown[]) => void): unknown;
  onUpdate(callback: (...args: unknown[]) => void): unknown;
  onDelete(callback: (...args: unknown[]) => void): unknown;
}
/** Narrow adapter for generated SDK connections, also used by transport tests. */
export interface VoiceConnection {
  db: {
    voiceWorkerAttempts: CacheTable<ViewRow & { attemptJson: string }>;
    voiceResults: CacheTable<ViewRow & { resultJson: string }>;
  };
  reducers: {
    reserveVoiceAttempt(input: { inputJson: string }): Promise<unknown>;
    claimVoiceAttempt(input: { id: string; claimId: string }): Promise<unknown>;
    markVoiceAttempt(input: { id: string; claimId: string; status: string; providerCallId: string; evidenceJson: string }): Promise<unknown>;
    saveVoiceCandidate(input: { id: string; claimId: string; candidateJson: string }): Promise<unknown>;
    saveVoiceOutcome(input: { id: string; claimId: string; outcomeJson: string }): Promise<unknown>;
    recordVoiceTool(input: { id: string; claimId: string; requestId: string; kind: string; payloadJson: string }): Promise<unknown>;
  };
  subscriptionBuilder(): {
    onApplied(callback: () => void): {
      onError(callback: (...args: unknown[]) => void): { subscribe(queries: string[]): unknown };
    };
  };
  disconnect(): void;
}
export class VoiceStoreUnavailableError extends Error {
  constructor() {
    super('Authoritative voice state was not confirmed. Keep the attempt locked; do not redial.');
    this.name = 'VoiceStoreUnavailableError';
  }
}
const terminal = new Set(['accepted', 'refused', 'review_required']);
const copy = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** Connect only with a dedicated application token. No CLI credentials are loaded.
 * The generated source must come from this module using the pinned CLI version. */
export async function createVoiceStore(options: SpacetimeDBServiceOptions & { timeoutMs?: number }) {
  if (!options.token?.trim()) throw new Error('Set a stable SPACETIMEDB_TOKEN application token for the voice worker.');
  const service = createSpacetimeDBService(options);
  // Dynamic loading lets the transport tests use an isolated fake connection.
  // Build verifies the generated artifact; its absence is a hard startup failure.
  const bindingsPath = './voice-bindings/index.js';
  let bindings: typeof import('./voice-bindings/index.js');
  try { bindings = await import(bindingsPath); }
  catch { throw new Error('Generate the SpacetimeDB voice bindings and build the service before starting live voice.'); }
  let markDisconnected = () => {};
  let conn: VoiceConnection | undefined;
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    conn = await new Promise<VoiceConnection>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; conn?.disconnect(); reject(new VoiceStoreUnavailableError()); }, timeoutMs);
      const builder = service.configureConnection(bindings.DbConnection.builder())
        .withConfirmedReads(true)
        .onConnect((connected: VoiceConnection) => {
          if (settled) { connected.disconnect(); return; }
          settled = true; clearTimeout(timer); resolve(connected);
        })
        .onConnectError(() => { if (!settled) { settled = true; clearTimeout(timer); reject(new VoiceStoreUnavailableError()); } })
        .onDisconnect(() => markDisconnected());
      conn = builder.build() as VoiceConnection;
    });
    return await createVoiceStoreOnConnection(conn, { timeoutMs, onDisconnect: handler => { markDisconnected = handler; } });
  } catch (error) { conn?.disconnect(); throw error; }
}

/** A cache becomes readable only after onApplied. Every write waits for committed
 * reducer completion AND a matching subscription projection; timeout is unknown. */
export async function createVoiceStoreOnConnection(connection: VoiceConnection, options: {
  timeoutMs?: number; onDisconnect?: (handler: () => void) => void;
} = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let ready = false, stopped = false;
  let tail: Promise<unknown> = Promise.resolve();
  const signals = new Set<() => void>();
  const listeners = new Set<(results: VoiceResult[]) => void>();
  const usedClaims = new Set<string>();
  const ensure = () => { if (!ready || stopped) throw new VoiceStoreUnavailableError(); };
  const attempts = (): VoiceAttempt[] => [...connection.db.voiceWorkerAttempts.iter()].map(row => JSON.parse(row.attemptJson) as VoiceAttempt);
  const results = (): VoiceResult[] => [...connection.db.voiceResults.iter()].map(row => JSON.parse(row.resultJson) as VoiceResult);
  const read = (id: string) => attempts().find(attempt => attempt.id === id) ?? null;
  const changed = () => { for (const signal of signals) signal(); };
  const disconnect = () => { stopped = true; ready = false; changed(); };
  options.onDisconnect?.(disconnect);
  const notify = () => {
    changed();
    if (!ready || stopped) return;
    for (const listener of listeners) { try { listener(copy(results())); } catch { /* Consumer failure cannot change saved state. */ } }
  };
  for (const table of [connection.db.voiceWorkerAttempts, connection.db.voiceResults]) {
    table.onInsert(notify); table.onUpdate(notify); table.onDelete(notify);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { disconnect(); connection.disconnect(); reject(new VoiceStoreUnavailableError()); }, timeoutMs);
    connection.subscriptionBuilder().onApplied(() => {
      if (stopped) return;
      clearTimeout(timer); ready = true;
      for (const attempt of attempts()) if (attempt.claimId) usedClaims.add(attempt.claimId);
      resolve();
    }).onError(() => { clearTimeout(timer); disconnect(); reject(new VoiceStoreUnavailableError()); })
      .subscribe(['SELECT * FROM voice_worker_attempts', 'SELECT * FROM voice_results']);
  });
  function waitFor<T>(readResult: () => T | undefined): Promise<T> {
    ensure();
    return new Promise<T>((resolve, reject) => {
      const finish = (value?: T, error?: Error) => {
        clearTimeout(timer); signals.delete(check);
        if (error) reject(error); else resolve(value as T);
      };
      const check = () => {
        if (stopped) { finish(undefined, new VoiceStoreUnavailableError()); return; }
        try { const value = readResult(); if (value !== undefined) finish(value); }
        catch { finish(undefined, new VoiceStoreUnavailableError()); }
      };
      const timer = setTimeout(() => finish(undefined, new VoiceStoreUnavailableError()), timeoutMs);
      signals.add(check); check();
    });
  }
  function serial<T>(body: () => Promise<T>): Promise<T> {
    const result = tail.then(() => { ensure(); return body(); });
    tail = result.catch(() => {});
    return result;
  }
  async function commit(id: string, operation: () => Promise<unknown>, matches: (attempt: VoiceAttempt) => boolean) {
    // An SDK promise rejection (including lost confirmation) never grants an action.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new VoiceStoreUnavailableError()), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
    ensure();
    return copy(await waitFor(() => { const attempt = read(id); return attempt && matches(attempt) ? attempt : undefined; }));
  }
  return {
    reserveAttempt(input: ReserveVoiceAttempt) {
      return serial(async () => {
        const prior = read(input.id);
        const attempt = await commit(input.id, () => connection.reducers.reserveVoiceAttempt({ inputJson: JSON.stringify(input) }),
          value => value.sessionId === input.sessionId && value.requestKey === input.requestKey);
        return { attempt, replayed: prior !== null };
      });
    },
    claimAttempt(input: { id: string; claimId?: string }) {
      return serial(async () => {
        const before = read(input.id);
        if (!before) throw new Error('Reserve the voice attempt before claiming it.');
        if (before.status !== 'reserved' || before.claimId) return { attempt: copy(before), claimed: false };
        const claimId = input.claimId ?? randomUUID();
        if (usedClaims.has(claimId)) throw new Error('A voice dispatch claim ID must never be reused.');
        usedClaims.add(claimId);
        const attempt = await commit(input.id, () => connection.reducers.claimVoiceAttempt({ id: input.id, claimId }), value => value.claimId !== null);
        return { attempt, claimed: attempt.status === 'dispatching' && attempt.claimId === claimId };
      });
    },
    markAttempt(input: { id: string; claimId: string; status: string; providerCallId?: string; evidence?: Record<string, unknown> }) {
      return serial(async () => {
        const evidence = input.evidence ?? {};
        return commit(input.id, () => connection.reducers.markVoiceAttempt({ id: input.id, claimId: input.claimId,
          status: input.status, providerCallId: input.providerCallId ?? '', evidenceJson: JSON.stringify(evidence) }),
        value => terminal.has(value.status) ||
          (value.status === input.status && (!input.providerCallId || value.providerCallId === input.providerCallId) &&
            (!Object.keys(evidence).length || value.evidence.some(item => canonical(item) === canonical(evidence)))));
      });
    },
    recordTool(input: { id: string; claimId: string; requestId: string; kind: 'counteroffer' | 'response'; payload: Record<string, unknown> }) {
      return serial(async () => {
        const attempt = await commit(input.id, () => connection.reducers.recordVoiceTool({ id: input.id,
          claimId: input.claimId, requestId: input.requestId, kind: input.kind, payloadJson: JSON.stringify(input.payload) }), value => {
          const receipt = value.toolReceipts?.[input.requestId];
          return receipt?.kind === input.kind && canonical(receipt.payload) === canonical(input.payload);
        });
        const receipt = attempt.toolReceipts[input.requestId];
        if (!receipt) throw new VoiceStoreUnavailableError();
        return { attempt, receipt: copy(receipt) };
      });
    },
    saveCandidate(input: { id: string; claimId: string; candidate: VoiceCandidate }) {
      return serial(() => commit(input.id, () => connection.reducers.saveVoiceCandidate({ id: input.id, claimId: input.claimId,
        candidateJson: JSON.stringify(input.candidate) }), value => canonical(value.candidate) === canonical(input.candidate)));
    },
    saveOutcome(input: { id: string; claimId: string; outcome: VoiceOutcome }) {
      return serial(() => commit(input.id, () => connection.reducers.saveVoiceOutcome({ id: input.id, claimId: input.claimId,
        outcomeJson: JSON.stringify(input.outcome) }), value => canonical(value.outcome) === canonical(input.outcome)));
    },
    async getAttempt(id: string) { ensure(); return copy(read(id)); },
    async listPending() { ensure(); return copy(attempts().filter(value => !terminal.has(value.status))); },
    subscribeResults(listener: (value: VoiceResult[]) => void) {
      ensure(); listeners.add(listener); listener(copy(results()));
      return () => { listeners.delete(listener); };
    },
    close() { disconnect(); listeners.clear(); connection.disconnect(); },
  };
}
export type VoiceStore = Awaited<ReturnType<typeof createVoiceStore>>;
