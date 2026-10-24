import { createOwnerHandoffExamples, validateOwnerHandoffFixtures } from '../src/owner-handoff-fixtures.ts';

validateOwnerHandoffFixtures();
const examples = createOwnerHandoffExamples();
console.log('Synthetic development data only. No calls, signatures or payments are executed.');
console.log(`Session: ${examples.packets.initial.sessionId}; owners: ${examples.packets.initial.owners.length}`);
for (const [stage, plan] of Object.entries(examples.settlement.expectedPlans)) {
  console.log(`${stage}: ${plan.status}; USD ${(plan.totalCents / 100).toFixed(2)}; ${plan.entries.length} owners`);
}
console.log(`Expected landowner settlement over two months: USD ${(examples.settlement.expectedTotals.landownerSettlementCents / 100).toFixed(2)} (construction excluded).`);
console.log(`Validated ${examples.negativeCases.length} rejection cases. See examples/owner-handoff.json for inputs and expected results.`);
