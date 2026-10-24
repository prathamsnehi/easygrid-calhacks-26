import test from 'node:test';
import assert from 'node:assert/strict';
import {runFinanceReconciliation} from '../src/finance-agent.js';
const deps = {
  loadObligations: async () => [
    {obligationId:'rent-1',agreementId:'A',period:'2026-11',expectedCents:50000,contractHash:'h1'},
    {obligationId:'rent-2',agreementId:'A',period:'2026-12',expectedCents:50000,contractHash:'h1'}
  ],
  loadBankMovements: async () => [
    {transactionId:'n1',amountCents:50000,period:'2026-11',obligationId:'rent-1',source:'nessie' as const},
    {transactionId:'n2',amountCents:49899,period:'2026-12',obligationId:'rent-2',source:'nessie' as const}
  ]
};
test('detects 101 cent month-two underpayment and requires review',async()=>{
  const r=await runFinanceReconciliation('s1','run1','2026-10-24T00:00:00Z',deps);
  assert.equal(r.decisions[0].status,'matched');
  assert.equal(r.decisions[1].differenceCents,101);
  assert.equal(r.decisions[1].suggestedAction,'request_review');
  assert.equal(r.requiresHumanApproval,true);
  assert.deepEqual(r.decisions[1].transactionIds,['n2']);
});
test('does not execute or approve money and fails closed on duplicate bank evidence',async()=>{
  await assert.rejects(runFinanceReconciliation('s1','run1','now',{
    ...deps,loadBankMovements:async()=>[...(await deps.loadBankMovements()),...(await deps.loadBankMovements())]
  }),/Duplicate bank transaction/);
});
test('unmatched bank movement is flagged',async()=>{
  const r=await runFinanceReconciliation('s1','run2','now',{
    ...deps,loadBankMovements:async()=>[...(await deps.loadBankMovements()),{transactionId:'orphan',amountCents:100,period:'2026-12',obligationId:'unknown',source:'nessie' as const}]
  });
  assert.equal(r.decisions[2].suggestedAction,'request_review');
});
