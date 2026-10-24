import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerHandoff, assertAgreementReady, createSettlementPlan, createVoiceHandoff,
  settlementObligationId } from '../src/owner-handoff.ts';
import { createInitialOwnerHandoff, createAcceptedOwnerHandoff, createOwnerHandoffExamples,
  createOwnerHandoffCurrent, evaluateOwnerHandoffFixture, validateOwnerHandoffFixtures,
  createOwnerSettlementContext } from '../src/owner-handoff-fixtures.ts';

const examples = createOwnerHandoffExamples();

test('owner sample factories are deterministic, fresh and serializable under the shared schema', () => {
  validateOwnerHandoffFixtures();
  assert.deepEqual(createOwnerHandoffExamples(), examples);
  for (const packet of Object.values(examples.packets))
    assert.deepEqual(OwnerHandoff.parse(JSON.parse(JSON.stringify(packet))), packet);
  const edited = createInitialOwnerHandoff();
  edited.owners[0]!.alias = 'Changed copy';
  edited.parcels[0]!.terms.compensationCents = 1;
  assert.equal(createInitialOwnerHandoff().owners[0]!.alias, 'Morgan Reed');
  assert.equal(createInitialOwnerHandoff().parcels[0]!.terms.compensationCents, 1000000);
});

for (const item of examples.negativeCases) {
  test(`owner fixture rejection: ${item.id}`, () => {
    assert.deepEqual(evaluateOwnerHandoffFixture(JSON.parse(JSON.stringify(item))), {
      accepted: false, errorCode: item.expectedError,
    });
  });
}

test('negotiation requires a distinct accepted result after the counteroffer', () => {
  const { initial, counteroffer, accepted } = examples.packets;
  assert.equal(initial.parcels[0]!.terms.compensationCents, 1000000);
  assert.equal(counteroffer.parcels[0]!.terms.compensationCents, 1200000);
  assert.equal(counteroffer.parcels[0]!.terms.explicitConfirmation, false);
  assert.equal(accepted.parcels[0]!.terms.compensationCents, 1200000);
  assert.equal(accepted.parcels[0]!.terms.termsVersion, 2);
  assert.equal(accepted.parcels[0]!.terms.explicitConfirmation, true);
  assertAgreementReady(accepted, createOwnerHandoffCurrent(accepted));
});

test('20 percent, exact balances and two months reconcile for both fictional owners', () => {
  const { expectedPlans, expectedLedger, expectedTotals } = examples.settlement;
  assert.equal(expectedPlans.contract.totalCents, 400000);
  assert.equal(expectedPlans.completion.totalCents, 1600000);
  assert.equal(expectedPlans.monthOne.totalCents, 50000);
  assert.equal(expectedPlans.monthTwo.totalCents, 50000);
  assert.equal(expectedPlans.monthOne.entries[0]!.dueOn, '2026-12-01');
  assert.equal(expectedPlans.monthTwo.entries[0]!.dueOn, '2027-01-01');
  assert.equal(expectedLedger.length, 8);
  assert.equal(new Set(expectedLedger.map(row => row.obligationId)).size, 8);
  assert.equal(expectedLedger.reduce((sum, row) => sum + row.amountCents, 0), 2100000);
  for (const [ownerId, total] of [['O001', 1260000], ['O002', 840000]] as const) {
    const entries = expectedLedger.filter(row => row.ownerId === ownerId);
    assert.equal(entries.length, 4);
    assert.equal(entries.reduce((sum, row) => sum + row.amountCents, 0), total);
    assert.equal(new Set(entries.map(row => row.paymentRecipientRef)).size, 1);
  }
  assert.equal(expectedTotals.constructionExcluded, true);
  assert.ok(Object.values(expectedPlans).every(plan => plan.status === 'planned' && plan.mode === 'simulated'));
  assert.ok(expectedLedger.every(row => row.status === 'expected_simulated_paid'));
});

test('each documented stage reproduces its expected plan using the exported helper', () => {
  const { contexts, expectedPlans } = examples.settlement;
  for (const stage of ['contract', 'completion', 'monthOne', 'monthTwo'] as const)
    assert.deepEqual(createSettlementPlan(examples.packets.accepted, contexts[stage]), expectedPlans[stage]);
});

test('reroute keeps original user and bank identity without a callable owner on the new route', () => {
  const { initial, refused, rerouted } = examples.packets;
  assert.deepEqual(refused.userRole, initial.userRole);
  assert.deepEqual(rerouted.userRole, initial.userRole);
  assert.deepEqual(rerouted.owners[0]!.banking, initial.owners[0]!.banking);
  assert.deepEqual(rerouted.parcels.map(p => p.parcelId), ['L002']);
  assert.equal(rerouted.owners[0]!.contact.callConsent, false);
  const voice = createVoiceHandoff(rerouted);
  assert.equal(voice.roleOnRoute, false);
  assert.equal(voice.parcels.some(p => p.ownerId === 'O001'), false);
  assert.equal(voice.parcels.some(p => p.contact.registration === 'registered'), false);
});

test('public samples contain references and masked banking, never private contact or account data', () => {
  assert.equal(/"(?:phone|phoneE164|email|routingNumber|accountNumber|apiKey|token|privateKey)"/.test(JSON.stringify(examples)), false);
  for (const packet of Object.values(examples.packets)) {
    for (const owner of packet.owners) {
      assert.equal(owner.synthetic, true);
      assert.equal(owner.banking.mode, 'simulated');
      assert.match(owner.banking.accountDisplay, /^\*{4}\d{4}$/);
      assert.match(owner.banking.paymentRecipientRef, /^mock-/);
    }
  }
  for (const voice of Object.values(examples.voice))
    assert.equal(/banking|paymentRecipientRef|accountDisplay|bankDisplay/.test(JSON.stringify(voice)), false);
});

test('new demo isolates identity and obligation IDs while old result stays independently readable', () => {
  const { accepted, newDemo } = examples.packets;
  assert.equal(newDemo.userRole, null);
  assert.equal(newDemo.owners[0]!.contact.callConsent, false);
  assert.equal(newDemo.owners[0]!.contact.contactRef, null);
  assert.notEqual(newDemo.sessionId, accepted.sessionId);
  assert.notEqual(settlementObligationId(accepted.sessionId, 'L001', 'contract_tranche'),
    settlementObligationId(newDemo.sessionId, 'L001', 'contract_tranche'));
  assert.equal(createAcceptedOwnerHandoff().sessionId, 'demo-example-001');
});

test('regenerated contract IDs cannot change the sample business obligation', () => {
  const packet = createAcceptedOwnerHandoff();
  const before = createOwnerSettlementContext(packet);
  const after = structuredClone(before);
  after.contracts = after.contracts.map(c => ({ ...c, contractId: `${c.contractId}-replacement`, contractVersion: 2 }));
  after.approvedPackage.contractVersions = Object.fromEntries(after.contracts.map(c => [c.contractId, c.contractVersion]));
  const first = createSettlementPlan(packet, before);
  const second = createSettlementPlan(packet, after);
  assert.deepEqual(first.entries.map(e => e.obligationId), second.entries.map(e => e.obligationId));
});

test('a partial initial-payment retry plans only the unpaid owner and preserves its full amount', () => {
  const { packets, retry } = examples;
  const plan = createSettlementPlan(packets.accepted, retry.context);
  assert.deepEqual(plan, retry.expectedPlan);
  assert.deepEqual(plan.entries.map(e => e.ownerId), ['O002']);
  assert.equal(plan.totalCents, 160000);
  assert.equal(retry.context.settledObligations[0]!.amountCents, 240000);
  assert.equal(plan.totalCents + retry.context.settledObligations[0]!.amountCents, 400000);
});
