import test from 'node:test';
import assert from 'node:assert/strict';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractDraft, updateContractDraft} from '../src/contract-authoring.js';
import {createContractWorkflow, createDemoBank, DEMO_ACTORS} from '../server/contract-workflow.mjs';

const now = '2026-10-24T18:00:00Z';
function setup(options = {}) {
  const source = createContractExample(); source.parcels = source.parcels.slice(0, 1);
  const draft = createContractDraft(source,'P-004',{now,id:'draft-workflow-004'});
  const base = options.bank ?? createDemoBank(); let transfers = 0;
  const bank = {...base, transfer:async input => { transfers++; return base.transfer(input); }};
  const flow = createContractWorkflow({source, bank, now:() => now, ...options, ...(options.bank ? {bank} : {})});
  return {source,draft,flow,bank,get transfers(){return transfers;}};
}
async function signBoth(app, draft = app.draft) {
  await app.flow.sign(draft,'utility',DEMO_ACTORS.utility);
  return app.flow.sign(draft,'landowner',DEMO_ACTORS.landowner);
}

test('both version-bound click signatures are required before a 20 percent payment', async () => {
  const app = setup();
  await assert.rejects(app.flow.submit(app.draft,DEMO_ACTORS.requester), /Both current/);
  await app.flow.sign(app.draft,'utility',DEMO_ACTORS.utility);
  await assert.rejects(app.flow.submit(app.draft,DEMO_ACTORS.requester), /Both current/);
  await app.flow.sign(app.draft,'landowner',DEMO_ACTORS.landowner);
  const result = await app.flow.submit(app.draft,DEMO_ACTORS.requester);
  assert.equal(result.payment.status,'paid'); assert.equal(result.payment.amountCents,240000);
  assert.equal(result.bankMode,'simulation'); assert.equal(result.journal.length,1);
  assert.equal(result.journal[0].debitCents,result.journal[0].creditCents);
  assert(result.audit.some(row => row.action === 'payment-reconciled'));
});

test('the requester cannot approve and utility/landowner identities must differ', async () => {
  const app = setup();
  await assert.rejects(app.flow.sign(app.draft,'utility',DEMO_ACTORS.requester), /role/);
  await assert.rejects(app.flow.sign(app.draft,'utility',{id:DEMO_ACTORS.requester.id,role:'utility-approver'}), /cannot approve/);
  await app.flow.sign(app.draft,'utility',DEMO_ACTORS.utility);
  await assert.rejects(app.flow.sign(app.draft,'landowner',{id:DEMO_ACTORS.utility.id,role:'landowner-signer'}), /distinct/);
  await assert.rejects(app.flow.submit(app.draft,DEMO_ACTORS.utility), /role/);
});

test('changed fields or versions invalidate signatures and stale revisions cannot overwrite current work', async () => {
  const app = setup(); await signBoth(app);
  const edited = updateContractDraft(app.draft,{specialConditions:'Changed draft note'},app.source,now);
  await assert.rejects(app.flow.submit(edited,DEMO_ACTORS.requester), /Both current/);
  await assert.rejects(app.flow.sign(app.draft,'utility',DEMO_ACTORS.utility), /stale/);
  await signBoth(app,edited); assert.equal((await app.flow.submit(edited,DEMO_ACTORS.requester)).payment.status,'paid');
});

test('concurrent submissions, repeated clicks and a new draft ID cannot pay the same obligation twice', async () => {
  const app = setup(); await signBoth(app);
  const results = await Promise.all([app.flow.submit(app.draft,DEMO_ACTORS.requester),app.flow.submit(app.draft,DEMO_ACTORS.requester)]);
  assert.equal(results[0].payment.obligationId,results[1].payment.obligationId);
  assert.equal(app.flow.snapshot().journal.length,1);
  assert.equal(app.transfers,1);
  const another = {...app.draft,id:'another-draft'};
  await assert.rejects(app.flow.sign(another,'utility',DEMO_ACTORS.utility), /already|submitted obligation locks/);
});

test('changed recipient and insufficient balance are held before transfer; an independent controller can reject', async () => {
  for (const scenario of ['recipient-changed','insufficient-funds']) {
    const app = setup(); await signBoth(app);
    const result = await app.flow.submit(app.draft,DEMO_ACTORS.requester,{scenario});
    assert.equal(result.payment.status,'held'); assert.equal(result.journal.length,0);
    await assert.rejects(app.flow.reject(app.draft,DEMO_ACTORS.requester), /role/);
    assert.equal((await app.flow.reject(app.draft,DEMO_ACTORS.utility)).payment.status,'rejected');
    assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'rejected');
  }
});

test('a planted bank amount mismatch is escalated and never creates a replacement payment', async () => {
  const app = setup(); await signBoth(app);
  const result = await app.flow.submit(app.draft,DEMO_ACTORS.requester,{scenario:'bank-mismatch'});
  assert.equal(result.payment.status,'review-required'); assert.equal(result.journal.length,0);
  assert(result.audit.some(row => row.observedCents === 239900));
  assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'review-required');
});

test('an unattempted hold can recover after the underlying issue is corrected', async () => {
  const app = setup(); await signBoth(app);
  assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester,{scenario:'recipient-changed'})).payment.status,'held');
  assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester,{scenario:'normal'})).payment.status,'paid');
  assert.equal(app.flow.snapshot().journal.length,1);
});

test('unknown transfer outcomes and a recovered processing record never trigger a blind retry', async () => {
  const base = createDemoBank(); let calls = 0, observed = null;
  const bank = {...base, transfer:async input => { calls++; observed = {...input,recipientMatches:true,status:'completed',transactionRef:'bank-recovered'}; throw new Error('timeout'); }, inspect:async () => ({recipientMatches:true,balanceCents:10000000,existingEvidence:null})};
  const app = setup({bank}); await signBoth(app);
  assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'unknown');
  await app.flow.submit(app.draft,DEMO_ACTORS.requester); assert.equal(calls,1);
  const restored = setup({bank:{...bank,inspect:async () => ({recipientMatches:true,balanceCents:0,existingEvidence:observed})}, initialState:app.flow.snapshot()});
  assert.equal((await restored.flow.reconcile(app.draft,DEMO_ACTORS.requester)).payment.status,'paid'); assert.equal(calls,1);
});

test('the durable pre-transfer save must succeed and read-only sandbox mode cannot submit a transfer', async () => {
  let fail = false, calls = 0; const base = createDemoBank();
  const app = setup({bank:{...base,transfer:async input => { calls++; return base.transfer(input); }},persist:async () => { if(fail)throw new Error('disk unavailable'); }});
  await signBoth(app); fail = true;
  await assert.rejects(app.flow.submit(app.draft,DEMO_ACTORS.requester),/disk unavailable/); assert.equal(calls,0);
  const readOnly = setup({bank:{...createDemoBank(),canTransfer:false}}); await signBoth(readOnly);
  assert.equal((await readOnly.flow.submit(readOnly.draft,DEMO_ACTORS.requester)).payment.status,'held');
});
