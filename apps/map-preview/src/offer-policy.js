/** Transparent demo negotiation policy. Amounts are USD integer cents, not appraisals. */
export const OFFER_POLICY_ID='recommended-times-1.2-v1';

export function negotiationLimitCents(recommendedOfferCents){
  if(!Number.isSafeInteger(recommendedOfferCents)||recommendedOfferCents<0)throw new Error('Recommended offer must be nonnegative safe-integer cents.');
  const limit=BigInt(recommendedOfferCents)*6n/5n;
  if(limit>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Negotiation limit exceeds safe-integer cents.');
  return Number(limit);
}

export function createOfferPolicy(recommendedOfferCents){
  negotiationLimitCents(recommendedOfferCents);
  return {policyId:OFFER_POLICY_ID,basis:'route-impact-v1',recommendedOfferCents,
    multiplierNumerator:6,multiplierDenominator:5,rounding:'floor-cent'};
}
