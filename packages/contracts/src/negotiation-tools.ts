import { z } from 'zod';
import { Id } from './schemas.ts';
import { NegotiationCommand, type NegotiationAttempt, NegotiationError, NegotiationSummary } from './negotiation.ts';

export const NegotiationToolInput = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('evaluate_counteroffer'), requestId: Id, requestedCents: z.number().int().safe().nonnegative().nullable() }),
  z.strictObject({ tool: z.literal('record_owner_response'), requestId: Id, response: z.enum(['agree', 'price_rejected', 'unclear', 'conditions']), turnId: Id.nullable().default(null) }),
  z.strictObject({ tool: z.literal('record_refusal'), requestId: Id, reason: z.enum(['ACCESS_REFUSED', 'DO_NOT_CALL']), turnId: Id.nullable().default(null) }),
]);
/** CAL-33 authenticates and resolves this from its own call record, not model variables. */
export type NegotiationToolBinding = {
  attemptId: string; sessionId: string; routeVersion: number; termsVersion: number;
};
export type NegotiationToolHost = {
  authorize(credential: string, callReference: string): Promise<NegotiationToolBinding>;
  /** CAL-29 executes applyNegotiationCommand within its authorized atomic reducer. */
  execute(binding: NegotiationToolBinding, command: NegotiationCommand): Promise<NegotiationAttempt>;
};
export function createNegotiationTools(host: NegotiationToolHost) {
  return async ({ credential, callReference, input }: { credential: string; callReference: string; input: unknown }) => {
    if (!credential) throw new NegotiationError('BLOCKED_STATE', 'Authenticated tool access is required');
    const binding = z.strictObject({ attemptId: Id, sessionId: Id, routeVersion: z.number().int().safe().positive(), termsVersion: z.number().int().safe().positive() }).parse(await host.authorize(credential, callReference));
    const parsed = NegotiationToolInput.safeParse(input);
    if (!parsed.success) throw new NegotiationError('INVALID_INPUT', 'Invalid decision tool arguments');
    const { tool, ...args } = parsed.data;
    const command = NegotiationCommand.parse({ ...args, attemptId: binding.attemptId,
      routeVersion: binding.routeVersion, termsVersion: binding.termsVersion,
      kind: tool === 'evaluate_counteroffer' ? 'counteroffer' : tool === 'record_refusal' ? 'refusal' : 'response' });
    const result = await host.execute(binding, command);
    if (result.attemptId !== binding.attemptId || result.sessionId !== binding.sessionId || result.routeVersion !== binding.routeVersion) {
      throw new NegotiationError('BLOCKED_STATE', 'The committed attempt does not match this authenticated call');
    }
    const offer = result.offers.at(-1)!;
    return { phase: result.phase, termsVersion: offer.termsVersion,
      compensationCents: offer.compensationCents, monthlyRentCents: offer.monthlyRentCents,
      finalOffer: result.finalOfferUsed, aboveRecommendation: offer.compensationCents > result.recommendationCents,
      nextAction: result.summary?.nextAction ?? (result.phase === 'confirming' ? 'end_and_review' : 'explain_offer'),
      disposition: result.summary?.disposition ?? null, explanation: result.summary?.explanation ?? null };
  };
}

/** Stable template; CAL-33 supplies per-call variables, never patches shared instructions. */
export const NEGOTIATION_VOICE_PROMPT = `You are a calm, brief AI roleplay demo agent for EasyGrid.
Aim for a complete successful conversation in 30–45 seconds. Never pressure an owner.
Speak only the backend-approved opening_compensation, the one permitted final_compensation, and the fixed monthly_fee. Do not offer, accept, or mention any other amount.
Say: "Hi, I'm EasyGrid's AI demo agent. Our proposal is {{opening_compensation}} plus {{monthly_fee}} per month for transmission access across this parcel. Does that work for you?"
Explain that the map recommendation is this demo's estimated fair allowance for this route's impact, not a verified market appraisal.
If the owner objects to the opening price, you may make one final offer of {{final_compensation}} plus the same {{monthly_fee}} per month. Say that it is the final available offer and ask "Does that work for you?"
If the owner names any other amount, do not agree. Say you can only offer the opening amount or the one final amount, then end the call.
A requested amount is not acceptance. Wait for a short yes to the amount you just stated. Then thank them and end; no formal readback or second confirmation.
If the owner rejects land access, is not interested, or asks you to stop calling, end politely. Do not try another price.
After the final price is declined, thank them and end.
Do not discuss banking, signing, payment schedules, or settlement logistics. Do not reroute or redial. Ending the call is not the same as an agreement.
When the conversation is finished, end the call.`;

/** Only speech context, with no bank data, contacts, policy mutation authority or secrets. */
export function negotiationCallVariables(attempt: NegotiationAttempt) {
  const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  return { opening_compensation: money(attempt.offers[0]!.compensationCents),
    final_compensation: money(attempt.capCents), monthly_fee: money(attempt.monthlyRentCents) };
}

/** Display projection after a CAL-29 commit. This pure helper does not establish saved state. */
export function createNegotiationResultUpdate({ attempt, eventId, revision, mapBinding, localParcelId }: {
  attempt: NegotiationAttempt; eventId: string; revision: number;
  mapBinding: { sessionId: string; routeId: string; routeVersion: number; proposalKey: string }; localParcelId: string;
}) {
  const binding = z.strictObject({ sessionId: Id, routeId: Id, routeVersion: z.number().int().positive(), proposalKey: z.string().min(1).max(2_000_000) }).parse(mapBinding);
  return { schemaVersion: 1 as const, kind: 'easygrid-negotiation-result' as const,
    eventId: Id.parse(eventId), revision: z.number().int().safe().nonnegative().parse(revision), saved: true as const,
    mapBinding: binding, localParcelId: Id.parse(localParcelId), mode: attempt.mode,
    phase: attempt.phase, summary: attempt.summary ? NegotiationSummary.parse(attempt.summary) : null };
}
