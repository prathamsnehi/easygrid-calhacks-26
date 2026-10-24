import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OwnerHandoff, HandoffError, splitCompensation, monthlyFeeDueDate, settlementObligationId,
  assertAgreementReady, createSettlementPlan, createVoiceHandoff,
} from '../src/owner-handoff.ts';
import { createInitialOwnerHandoff, createAcceptedOwnerHandoff, createOwnerHandoffCurrent, createOwnerSettlementContext } from '../src/owner-handoff-fixtures.ts';

const blocked = (f: () => unknown, code = 'BLOCKED_STATE') => assert.throws(f, error => error instanceof HandoffError && error.code === code);

function attachOfferPolicies(packet: OwnerHandoff, recommendations = packet.parcels.map(p => p.terms.compensationCents)) {
  packet.parcels.forEach((parcel, index) => {
    const recommendedOfferCents = recommendations[index]!;
    parcel.offerPolicy = { policyId: 'recommended-times-1.2-v1', basis: 'route-impact-v1',
      recommendedOfferCents, multiplierNumerator: 6, multiplierDenominator: 5, rounding: 'floor-cent' };
    parcel.offerCapCents = Number(BigInt(recommendedOfferCents) * 6n / 5n);
  });
  return packet;
}
function currentWithOfferPolicies(packet: OwnerHandoff) {
  return { ...createOwnerHandoffCurrent(packet), offerPolicies: Object.fromEntries(packet.parcels.flatMap(parcel =>
    parcel.offerPolicy ? [[parcel.parcelId, { policyId: parcel.offerPolicy.policyId, basis: parcel.offerPolicy.basis,
      recommendedOfferCents: parcel.offerPolicy.recommendedOfferCents, offerCapCents: parcel.offerCapCents }]] : [])) };
}

test('fixed recommendation caps use exact 120 percent with cent floor, including zero and safe bounds', () => {
  const largestRecommendation = Number((5n * (BigInt(Number.MAX_SAFE_INTEGER) + 1n) - 1n) / 6n);
  for (const amount of [0, 1, 2, 3, 4, 5, 99, 101, 101737, largestRecommendation]) {
    const packet = attachOfferPolicies(createInitialOwnerHandoff(), [amount, 800000]);
    assert.equal(OwnerHandoff.safeParse(packet).success, true);
    assert.equal(BigInt(packet.parcels[0]!.offerCapCents), BigInt(amount) * 6n / 5n);
    assert(packet.parcels[0]!.offerCapCents >= amount);
    const altered = structuredClone(packet); altered.parcels[0]!.offerCapCents -= 1;
    assert.equal(OwnerHandoff.safeParse(altered).success, false);
  }
  const overflow = createInitialOwnerHandoff();
  overflow.parcels[0]!.offerPolicy = { policyId: 'recommended-times-1.2-v1', basis: 'route-impact-v1',
    recommendedOfferCents: largestRecommendation + 1, multiplierNumerator: 6, multiplierDenominator: 5, rounding: 'floor-cent' };
  overflow.parcels[0]!.offerCapCents = Number.MAX_SAFE_INTEGER;
  assert.equal(OwnerHandoff.safeParse(overflow).success, false);
  for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const packet = attachOfferPolicies(createInitialOwnerHandoff());
    packet.parcels[0]!.offerPolicy!.recommendedOfferCents = invalid;
    assert.equal(OwnerHandoff.safeParse(packet).success, false);
  }
});

test('legacy handoff examples remain valid without a recommendation policy', () => {
  const packet = createAcceptedOwnerHandoff();
  assert(!packet.parcels.some(parcel => parcel.offerPolicy));
  assert.deepEqual(assertAgreementReady(packet, createOwnerHandoffCurrent(packet)), packet);
  assert(createVoiceHandoff(packet).parcels.every(parcel => !('offerPolicy' in parcel)));
});

test('counteroffers change current terms without rebasing the recommendation or negotiation limit', () => {
  const packet = attachOfferPolicies(createInitialOwnerHandoff()), fixed = structuredClone(packet.parcels[0]!.offerPolicy);
  packet.parcels[0]!.terms.outcome = 'counteroffer';
  packet.parcels[0]!.terms.compensationCents = 1150000;
  packet.parcels[0]!.terms.termsVersion += 1;
  const voice = createVoiceHandoff(packet);
  assert.equal(voice.parcels[0]!.terms.compensationCents, 1150000);
  assert.deepEqual(voice.parcels[0]!.offerPolicy, fixed);
  assert.equal(voice.parcels[0]!.offerCapCents, 1200000);
  // An excessive request is representable for review; it is never agreement-ready.
  packet.parcels[0]!.terms.compensationCents = 1300000;
  assert.equal(OwnerHandoff.safeParse(packet).success, true);
  assert.equal(createVoiceHandoff(packet).parcels[0]!.offerCapCents, 1200000);
  packet.parcels[0]!.offerCapCents = 1560000;
  assert.equal(OwnerHandoff.safeParse(packet).success, false);
});

test('agreement binds fixed recommendation policies to trusted state and cannot strip or inflate them', () => {
  const packet = attachOfferPolicies(createAcceptedOwnerHandoff(), [1000000, 800000]);
  const trusted = currentWithOfferPolicies(packet);
  assert.equal(assertAgreementReady(packet, trusted).parcels[0]!.offerCapCents, 1200000);
  blocked(() => assertAgreementReady(packet, createOwnerHandoffCurrent(packet)), 'STALE_VERSION');
  const stripped = structuredClone(packet); delete stripped.parcels[0]!.offerPolicy;
  blocked(() => assertAgreementReady(stripped, trusted), 'STALE_VERSION');
  const inflated = structuredClone(packet);
  inflated.parcels[0]!.offerPolicy!.recommendedOfferCents = 2000000;
  inflated.parcels[0]!.offerCapCents = 2400000;
  assert.equal(OwnerHandoff.safeParse(inflated).success, true, 'arithmetic alone does not authorize a new basis');
  blocked(() => assertAgreementReady(inflated, trusted), 'STALE_VERSION');
  const wrongKey = structuredClone(trusted);
  wrongKey.offerPolicies.L999 = wrongKey.offerPolicies.L001!;
  delete wrongKey.offerPolicies.L001;
  blocked(() => assertAgreementReady(packet, wrongKey), 'STALE_VERSION');
  const alteredTrusted = structuredClone(trusted); alteredTrusted.offerPolicies.L001!.offerCapCents += 1;
  blocked(() => assertAgreementReady(packet, alteredTrusted), 'STALE_VERSION');
});

test('accepted offers obey the fixed cap boundary and whole-project budget independently', () => {
  const packet = attachOfferPolicies(createAcceptedOwnerHandoff(), [1000000, 800000]);
  const trusted = currentWithOfferPolicies(packet);
  assert.equal(packet.parcels[0]!.terms.compensationCents, packet.parcels[0]!.offerCapCents);
  assert.doesNotThrow(() => assertAgreementReady(packet, trusted));
  const above = structuredClone(packet); above.parcels[0]!.terms.compensationCents += 1;
  blocked(() => assertAgreementReady(above, trusted));
  const budget = structuredClone(packet);
  budget.budgetCents = budget.constructionCents + budget.parcels.reduce((sum, parcel) =>
    sum + parcel.terms.compensationCents + parcel.terms.comparisonRentTotalCents, 0) - 1;
  blocked(() => assertAgreementReady(budget, trusted));
});

test('voice context preserves detached offer policies and the failed valuation check without banking', () => {
  const packet = attachOfferPolicies(createInitialOwnerHandoff()); packet.simulationChecksPassed = false;
  const voice = createVoiceHandoff(packet);
  assert.equal(voice.simulationChecksPassed, false);
  assert.equal(voice.parcels[0]!.offerPolicy!.recommendedOfferCents, 1000000);
  voice.parcels[0]!.offerPolicy!.recommendedOfferCents = 1;
  assert.equal(packet.parcels[0]!.offerPolicy!.recommendedOfferCents, 1000000);
  assert(!JSON.stringify(voice).includes('banking'));
  assert(!JSON.stringify(voice).includes('mock-recipient'));
});

test('20 percent uses integer-cent floor and conserves every cent up to the safe integer limit', () => {
  for (const cents of [0, 1, 4, 5, 99, 101, 1200000, Number.MAX_SAFE_INTEGER]) {
    const split = splitCompensation(cents);
    assert.equal(BigInt(split.contractTrancheCents), BigInt(cents) / 5n);
    assert.equal(split.contractTrancheCents + split.completionBalanceCents, cents);
  }
  for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) blocked(() => splitCompensation(invalid), 'INVALID_INPUT');
});

test('rent uses anchored calendar anniversaries, including leap years and month-end clamping', () => {
  assert.equal(monthlyFeeDueDate('2026-01-31', 1), '2026-02-28');
  assert.equal(monthlyFeeDueDate('2026-01-31', 2), '2026-03-31');
  assert.equal(monthlyFeeDueDate('2028-01-31', 1), '2028-02-29');
  assert.equal(monthlyFeeDueDate('2026-11-01', 2), '2027-01-01');
  blocked(() => monthlyFeeDueDate('2026-02-30', 1), 'INVALID_INPUT');
  blocked(() => monthlyFeeDueDate('2026-01-01', 0), 'INVALID_INPUT');
  blocked(() => monthlyFeeDueDate('9999-12-31', 1));
});

test('obligation IDs distinguish sessions, parcels and months without delimiter collisions', () => {
  const a = settlementObligationId('demo:a', 'b', 'contract_tranche');
  const b = settlementObligationId('demo', 'a:b', 'contract_tranche');
  assert.notEqual(a, b);
  assert.notEqual(a, settlementObligationId('new-demo', 'b', 'contract_tranche'));
  assert.notEqual(settlementObligationId('demo', 'L001', 'monthly_fee', '2026-12'), settlementObligationId('demo', 'L001', 'monthly_fee', '2027-01'));
  blocked(() => settlementObligationId('demo', 'L001', 'monthly_fee'), 'INVALID_INPUT');
  blocked(() => settlementObligationId('demo', 'L001', 'completion_balance', '2026-12'), 'INVALID_INPUT');
});

test('banking is mandatory, owner-linked and distinct; undocumented private contact fields are rejected', () => {
  const packet = createInitialOwnerHandoff();
  const malformed = structuredClone(packet) as unknown as { owners: Array<Record<string, unknown>> };
  delete malformed.owners[0]!.banking;
  assert.equal(OwnerHandoff.safeParse(malformed).success, false);
  const mismatch = structuredClone(packet); mismatch.owners[0]!.banking.ownerId = 'O002';
  assert.equal(OwnerHandoff.safeParse(mismatch).success, false);
  const reused = structuredClone(packet); reused.owners[1]!.banking.paymentRecipientRef = reused.owners[0]!.banking.paymentRecipientRef;
  assert.equal(OwnerHandoff.safeParse(reused).success, false);
  const privateField = { ...packet, owners: packet.owners.map(o => ({ ...o, phoneE164: 'not-a-fixture-field' })) };
  assert.equal(OwnerHandoff.safeParse(privateField).success, false);
});

test('local contact placeholders cannot assert canonical consent and voice projection has no banking', () => {
  const packet = createInitialOwnerHandoff();
  packet.owners[0]!.contact.callConsent = true;
  assert.equal(OwnerHandoff.safeParse(packet).success, false);
  packet.owners[0]!.contact.registration = 'registered';
  assert.equal(OwnerHandoff.safeParse(packet).success, false);
  const accepted = createAcceptedOwnerHandoff(), voice = createVoiceHandoff(accepted);
  assert.equal(voice.roleOnRoute, true);
  assert.equal(JSON.stringify(voice).includes('mock-recipient'), false);
  assert.equal(JSON.stringify(voice).includes('banking'), false);
  voice.parcels[0]!.contact.contactRef = 'changed';
  assert.notEqual(accepted.owners[0]!.contact.contactRef, 'changed');
});

test('historical user role survives a route change without acquiring another owner contact', () => {
  const packet = createInitialOwnerHandoff();
  packet.parcels = packet.parcels.filter(p => p.parcelId !== 'L001');
  const voice = createVoiceHandoff(packet);
  assert.deepEqual(voice.userRole, { parcelId: 'L001', ownerId: 'O001' });
  assert.equal(voice.roleOnRoute, false);
  assert.deepEqual(voice.parcels.map(p => p.ownerId), ['O002']);
});

test('accepted terms require independent explicit evidence and exact negotiated monthly rent', () => {
  const packet = createAcceptedOwnerHandoff();
  for (const property of ['explicitConfirmation', 'confirmationRef', 'accessConsent', 'monthlyRentIsApproximate'] as const) {
    const bad = structuredClone(packet);
    const values = { explicitConfirmation: false, confirmationRef: null, accessConsent: 'unknown', monthlyRentIsApproximate: true };
    Object.assign(bad.parcels[0]!.terms, { [property]: values[property] });
    blocked(() => assertAgreementReady(bad, createOwnerHandoffCurrent(packet)), 'INVALID_INPUT');
  }
  const approximate = createInitialOwnerHandoff();
  approximate.parcels[0]!.terms.comparisonRentTotalCents += 1;
  approximate.parcels[0]!.terms.monthlyRentIsApproximate = true;
  assert.equal(OwnerHandoff.safeParse(approximate).success, true);
});

test('safe aggregate accounting rejects overflow even when individual cents are valid', () => {
  const packet = createAcceptedOwnerHandoff();
  packet.constructionCents = Number.MAX_SAFE_INTEGER;
  packet.budgetCents = Number.MAX_SAFE_INTEGER;
  blocked(() => assertAgreementReady(packet, createOwnerHandoffCurrent(packet)));
});

test('approval and signed contracts bind the current session, route and exact contract versions', () => {
  const packet = createAcceptedOwnerHandoff();
  const staleApproval = createOwnerSettlementContext(packet);
  staleApproval.approvedPackage.routeVersion += 1;
  blocked(() => createSettlementPlan(packet, staleApproval));
  const staleContract = createOwnerSettlementContext(packet);
  staleContract.contracts[0]!.routeVersion += 1;
  blocked(() => createSettlementPlan(packet, staleContract));
  const regenerated = createOwnerSettlementContext(packet);
  regenerated.contracts[0]!.contractVersion += 1;
  blocked(() => createSettlementPlan(packet, regenerated));
  const changedTerms = createOwnerSettlementContext(packet);
  changedTerms.contracts[0]!.compensationCents += 1;
  blocked(() => createSettlementPlan(packet, changedTerms));
});

test('approval covers every affected parcel exactly once, without extra or omitted contracts', () => {
  const packet = createAcceptedOwnerHandoff();
  const omitted = createOwnerSettlementContext(packet); omitted.contracts.pop();
  blocked(() => createSettlementPlan(packet, omitted));
  const duplicate = createOwnerSettlementContext(packet); duplicate.contracts[1] = structuredClone(duplicate.contracts[0]!);
  blocked(() => createSettlementPlan(packet, duplicate));
  const extraTerms = createOwnerSettlementContext(packet); extraTerms.approvedPackage.termsVersions.L999 = 1;
  blocked(() => createSettlementPlan(packet, extraTerms));
});

test('completion references current approval and completion dates; monthly fees require settled balances', () => {
  const packet = createAcceptedOwnerHandoff();
  const oldCompletion = createOwnerSettlementContext(packet, 'completion_balance');
  oldCompletion.completion!.approvalId = 'old-approval';
  blocked(() => createSettlementPlan(packet, oldCompletion));
  const future = createOwnerSettlementContext(packet, 'completion_balance'); future.asOfDate = '2026-10-31';
  blocked(() => createSettlementPlan(packet, future));
  const missingBalance = createOwnerSettlementContext(packet, 'monthly_fee');
  missingBalance.settledObligations = missingBalance.settledObligations.filter(record => record.obligationId === settlementObligationId(packet.sessionId, record.parcelId, 'contract_tranche'));
  blocked(() => createSettlementPlan(packet, missingBalance));
});

test('plans are detached results, not receipts, and preserve the expected cents through every stage', () => {
  const packet = createAcceptedOwnerHandoff(), before = structuredClone(packet);
  const initial = createSettlementPlan(packet, createOwnerSettlementContext(packet));
  const balance = createSettlementPlan(packet, createOwnerSettlementContext(packet, 'completion_balance'));
  const rent = createSettlementPlan(packet, createOwnerSettlementContext(packet, 'monthly_fee'));
  assert.equal(initial.status, 'planned'); assert.equal(initial.mode, 'simulated');
  assert.equal(initial.totalCents, 400000); assert.equal(balance.totalCents, 1600000); assert.equal(rent.totalCents, 50000);
  assert.deepEqual(packet, before);
});

test('settled evidence freezes amounts and route instead of trusting only a paid ID', () => {
  const original = createAcceptedOwnerHandoff();
  const originalPaid = createOwnerSettlementContext(original, 'completion_balance').settledObligations;
  const changed = structuredClone(original);
  changed.parcels[0]!.terms.compensationCents = 1400000;
  changed.parcels[0]!.terms.termsVersion += 1;
  const context = createOwnerSettlementContext(changed, 'completion_balance');
  context.settledObligations = originalPaid;
  blocked(() => createSettlementPlan(changed, context));
  const wrongAmount = createOwnerSettlementContext(original, 'completion_balance');
  wrongAmount.settledObligations[0]!.amountCents -= 1;
  blocked(() => createSettlementPlan(original, wrongAmount));
});

test('partial settlement retries plan only remaining rows without double paying successful rows', () => {
  const packet = createAcceptedOwnerHandoff();
  const context = createOwnerSettlementContext(packet);
  context.settledObligations = createOwnerSettlementContext(packet, 'completion_balance').settledObligations.slice(0, 1);
  const remaining = createSettlementPlan(packet, context);
  assert.equal(remaining.entries.length, 1);
  assert.equal(remaining.entries[0]!.ownerId, 'O002');
  assert.equal(remaining.totalCents, 160000);
  assert.equal(remaining.alreadySettledObligationIds.length, 1);
});
