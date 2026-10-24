import { z } from 'zod';
import * as s from './schemas.ts';
import { validateNegotiation } from './policy.ts';

/** Provider text cannot choose IDs, revisions, evidence references, approvals or payment state. */
export const ClaudeNegotiationOutput = z.strictObject({
  ...s.Terms, outcome: s.NegotiationStatus, accessConsent: s.AccessConsent,
  explicitConfirmation: z.boolean(), conditions: z.array(s.Text),
  confidence: z.number().min(0).max(1).optional(),
});
export type ClaudeContext = {
  base: s.NegotiationResult; offerCapCents: number;
  /** Supplied by a trusted operator/provider evidence adapter, never by model text. */
  confirmationVerified: boolean; accessConsentVerified: z.infer<typeof s.AccessConsent>;
};
export function normalizeClaudeOutput(raw: unknown, context: ClaudeContext, failure?: 'timeout') {
  const base = s.NegotiationResult.parse(context.base);
  const parsed = ClaudeNegotiationOutput.safeParse(raw);
  if (failure === 'timeout' || !parsed.success) {
    return { result: { ...base, outcome: failure === 'timeout' ? 'pending' as const : 'review_required' as const,
      accessConsent: 'unknown' as const, explicitConfirmation: false,
      conditions: [...base.conditions, failure === 'timeout' ? 'Model timeout; verify provider status before retry.' : 'Malformed model output; operator review required.'] },
      fallback: true, reason: failure === 'timeout' ? 'MODEL_TIMEOUT' : 'MALFORMED_MODEL_OUTPUT' };
  }
  const proposed = parsed.data;
  const result: s.NegotiationResult = { ...base, ...proposed,
    accessConsent: proposed.accessConsent === 'refused' ? 'refused' : context.accessConsentVerified,
    explicitConfirmation: proposed.explicitConfirmation && context.confirmationVerified,
  };
  if (result.accessConsent === 'refused') result.outcome = 'refused';
  if (result.outcome !== 'refused' &&
      result.upfrontCents + (result.depositCreditPolicy === 'separate_charge' ? result.depositCents : 0) > context.offerCapCents) {
    result.outcome = 'review_required'; result.explicitConfirmation = false;
    return { result, fallback: true, reason: 'OFFER_CAP_EXCEEDED' };
  }
  try { validateNegotiation(result, context.offerCapCents); }
  catch {
    result.outcome = 'review_required'; result.explicitConfirmation = false;
    return { result, fallback: true, reason: 'UNVERIFIED_OR_BLOCKED_TERMS' };
  }
  return { result, fallback: false, reason: 'VALIDATED_PROPOSAL' };
}
