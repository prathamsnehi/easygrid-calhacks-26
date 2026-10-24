import type Cartesia from "@cartesia/cartesia-js";

export interface CallOptions {
  agentId: string;
  fromNumberId: string;
  /** Full international format, for example +14155550123. */
  toNumber: string;
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
            outbound_calls: [{ to_number: options.toNumber }],
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

    /** Fetch the latest status and transcript; does not wait for completion. */
    async getCall(callId: string): Promise<CallRecord> {
      // Keep current call statuses instead of using the SDK's older status enum.
      return client.get<CallRecord>(`/agents/calls/${encodeURIComponent(callId)}`);
    },
  };
}
