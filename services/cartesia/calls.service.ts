import type Cartesia from "@cartesia/cartesia-js";

export interface CallOptions {
  agentId: string;
  fromNumberId: string;
  /** Full international format, for example +14155550123. */
  toNumber: string;
  /** Non-secret, per-call context; never mutate a shared agent prompt. */
  dynamicVariables?: Record<string, string | number | boolean>;
}

export interface StartedCall {
  /** Alias for Cartesia's agent_call_id, usable with getCall. */
  id: string;
  agent_call_id: string;
  number: string;
  [key: string]: unknown;
}

export interface TranscriptTurn {
  role: string;
  text?: string | null;
  start_timestamp?: number;
  end_timestamp?: number;
  [key: string]: unknown;
}

/** Technical call details, not a business qualification result. */
export interface CallRecord {
  id: string;
  agent_id: string;
  /** Current documented states: created, started, completed, failed. */
  status: string;
  transcript?: TranscriptTurn[] | null;
  end_reason?: string | null;
  error_message?: string | null;
  summary?: string | null;
  [key: string]: unknown;
}

interface OutboundCallResult {
  number: string;
  agent_call_id?: string;
  error?: unknown;
  [key: string]: unknown;
}

export function createCallsService(client: Cartesia) {
  return {
    /** Starts one call and returns immediately after Cartesia accepts it. */
    async call(options: CallOptions): Promise<StartedCall> {
      const response = await client.post<{ calls: OutboundCallResult[] }>(
        "/agents/calls",
        {
          body: {
            agent_id: options.agentId,
            from_number_id: options.fromNumberId,
            outbound_calls: [{ to_number: options.toNumber,
              ...(options.dynamicVariables ? { dynamic_variables: options.dynamicVariables } : {}) }],
          },
        },
      );

      const result = response.calls[0];
      // Cartesia can reject a destination even when the HTTP response is 200.
      if (result?.error != null) {
        const detail =
          typeof result.error === "string"
            ? result.error
            : JSON.stringify(result.error);
        throw new Error(`Cartesia could not start the call: ${detail}`, {
          cause: result.error,
        });
      }
      if (!result?.agent_call_id) {
        throw new Error("Cartesia did not return a call ID.");
      }

      return {
        ...result,
        agent_call_id: result.agent_call_id,
        id: result.agent_call_id,
      };
    },

    /** Only a started provider call can be cancelled; request abort does not hang up. */
    async cancelCall(callId: string): Promise<{ cancelled: boolean }> {
      return client.post<{ cancelled: boolean }>(`/agents/calls/${encodeURIComponent(callId)}/cancel`);
    },

    /** Fetch the latest status and transcript; does not wait for completion. */
    async getCall(callId: string): Promise<CallRecord> {
      // Keep current call statuses instead of using the SDK's older status enum.
      return client.get<CallRecord>(`/agents/calls/${encodeURIComponent(callId)}`);
    },
  };
}

/** CAL-29 schedules this check using a persisted connected timestamp, not a browser timer. */
export async function enforceConnectedCallDeadline({ service, callId, connectedAtMs, nowMs, limitMs = 60_000 }: {
  service: { getCall(id: string): Promise<CallRecord>; cancelCall(id: string): Promise<{ cancelled: boolean }> };
  callId: string; connectedAtMs: number; nowMs: number; limitMs?: number;
}): Promise<{ status: 'within_limit' | 'ended' | 'cancelled' | 'unknown'; reason: 'TIME_LIMIT' | null }> {
  if (![connectedAtMs, nowMs, limitMs].every(Number.isSafeInteger) || connectedAtMs < 0 || nowMs < connectedAtMs || limitMs <= 0) {
    throw new Error('Valid persisted timestamps and a positive connected-call limit are required.');
  }
  if (nowMs - connectedAtMs < limitMs) return { status: 'within_limit', reason: null };
  try {
    const record = await service.getCall(callId);
    if (record.status === 'completed' || record.status === 'failed') return { status: 'ended', reason: null };
    if (record.status !== 'started') return { status: 'unknown', reason: 'TIME_LIMIT' };
    const result = await service.cancelCall(callId);
    return { status: result.cancelled ? 'cancelled' : 'unknown', reason: 'TIME_LIMIT' };
  } catch { return { status: 'unknown', reason: 'TIME_LIMIT' }; }
}
