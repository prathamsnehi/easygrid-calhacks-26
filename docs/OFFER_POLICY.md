# Route compensation and negotiation limits

CAL-30 / CAL-27. The map uses fictional USD allowances to prepare an initial offer; it does not estimate real market value.

## Calculation

For each affected parcel:

- Recommended offer = allocated centerline allowance + allocated tower-foundation allowance, in integer cents.
- Negotiation limit = `floor(recommendedOfferCents * 6 / 5)`, evaluated with integer arithmetic.
- Monthly rent is separate and does not receive the 20% increase.

The existing parcel land-use rates and selected route geometry determine both allowance components. Per-span rounding is allocated across affected parcels so their recommendations still sum exactly to the route's compensation cost. Whole-parcel reference prices in the general map inspector do not determine these offers or limits.

Example: a recommendation of $1,017.37 has a $1,220.84 limit. A counteroffer changes `terms.compensationCents`, never the recommendation used to calculate that limit. A new route requires a new analysis and policy binding. Project budget checks still apply independently.

Corridor-only parcels with no priced centerline or foundation impact remain **Review required**. Their zero modeled allowance is not a completed valuation. Such a route is ineligible for the map call handoff and has `simulationChecksPassed: false` until a separately implemented review resolves the missing estimate.

## Handoff fields

All current map `ownerHandoff.parcels` carry:

```json
{
  "offerCapCents": 122084,
  "offerPolicy": {
    "policyId": "recommended-times-1.2-v1",
    "basis": "route-impact-v1",
    "recommendedOfferCents": 101737,
    "multiplierNumerator": 6,
    "multiplierDenominator": 5,
    "rounding": "floor-cent"
  }
}
```

The shared schema rejects an inconsistent cap. The bank-free `createVoiceHandoff` view retains this policy independently of the changing terms. The map envelope also exposes the line/foundation breakdown and recommendation status for the operator UI.

The host must bind the recommendation and cap to canonical route IDs and versions and retain an authoritative record. Pass that record to `assertAgreementReady` as:

```ts
currentState.offerPolicies = {
  [parcelId]: {
    policyId: 'recommended-times-1.2-v1',
    basis: 'route-impact-v1',
    recommendedOfferCents: 101737,
    offerCapCents: 122084,
  },
};
```

Do not build this trusted record from an incoming model response or counteroffer. Readiness validation checks the exact policy-bearing parcel set and values, catching stripped or inflated policies. Schema version 1 remains compatible with older policy-free packets; all newly generated map packets use the policy. The standalone owner-handoff scenario pack also retains legacy packets for compatibility checks.

## Calling-agent integration

Use the recommendation as the initial proposed compensation and the cap as the agent's internal limit. Explain the route impact and separate monthly fee. For the approved CAL-34 demo, an owner's request above the cap receives one
final counteroffer at the smaller of the cap and available project budget; it
is not acceptance or automatically a review failure. A proposal by the system
above either limit must be blocked. Monthly fees stay fixed. A rejected final
offer stops the flow without automatic rerouting. See [CAL-34 scope](cal-34-negotiation-policy.md).
Enforce these limits in the host before promising or recording terms; prompt
instructions alone are not an enforcement boundary.

This change provides the UI, handoff data and shared validation. Live host storage, per-offer enforcement and calling-agent wiring remain integration work.
