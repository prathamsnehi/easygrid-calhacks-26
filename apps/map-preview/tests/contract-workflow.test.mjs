import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractDraft, updateContractDraft} from '../src/contract-authoring.js';
import {createNessieSandboxBank} from '../server/nessie-sandbox.mjs';
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

test('both version-bound click signatures are required before one full payment', async () => {
  const app = setup();
  await assert.rejects(app.flow.submit(app.draft,DEMO_ACTORS.requester), /Both current/);
  await app.flow.sign(app.draft,'utility',DEMO_ACTORS.utility);
  await assert.rejects(app.flow.submit(app.draft,DEMO_ACTORS.requester), /Both current/);
  await app.flow.sign(app.draft,'landowner',DEMO_ACTORS.landowner);
  const result = await app.flow.submit(app.draft,DEMO_ACTORS.requester);
  assert.equal(result.payment.status,'paid'); assert.equal(result.payment.amountCents,1200000);
  assert.equal(result.bankMode,'simulation'); assert.equal(result.journal.length,1);
  assert.equal(result.signatures.utility.approvedPaymentCents,1200000);
  assert.equal(result.journal[0].stage,'full');
  assert.equal(result.journal[0].debitAccount,'demo-land-use-compensation');
  assert.equal(result.balancePayment,undefined);
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

test('persisted signatures from an older approval cannot satisfy the new representative package', async () => {
  const source = createContractExample(), bank = createDemoBank();
  const original = createContractWorkflow({source,bank,now:() => now});
  for (const parcel of source.parcels) {
    const draft = createContractDraft(source,parcel.parcelId,{now,id:`old-${parcel.parcelId}`});
    await original.sign(draft,'utility',DEMO_ACTORS.utility);
    await original.sign(draft,'landowner',DEMO_ACTORS.landowner);
  }
  const changed = structuredClone(source); changed.project.signerName = 'New Representative';
  for (const legacy of [false,true]) {
    const initialState = original.snapshot();
    if (legacy) Object.values(initialState.documents).forEach(doc => delete doc.sourceHash);
    const flow = createContractWorkflow({source:changed,bank,initialState,now:() => now});
    const first = createContractDraft(changed,'P-004',{now,id:'new-004'});
    await flow.sign(first,'utility',DEMO_ACTORS.utility);
    assert.equal((await flow.sign(first,'landowner',DEMO_ACTORS.landowner)).packageReady,false);
    await assert.rejects(flow.submit(first,DEMO_ACTORS.requester), /Every final-route/);
    const second = createContractDraft(changed,'P-009',{now,id:'new-009'});
    await flow.sign(second,'utility',DEMO_ACTORS.utility);
    assert.equal((await flow.sign(second,'landowner',DEMO_ACTORS.landowner)).packageReady,true);
  }
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
  assert(result.audit.some(row => row.observedCents === 1199900));
  assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'review-required');
});

test('an unattempted hold can recover after the underlying issue is corrected', async () => {
  const app = setup(); await signBoth(app);
  assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester,{scenario:'recipient-changed'})).payment.status,'held');
  assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester,{scenario:'normal'})).payment.status,'paid');
  assert.equal(app.flow.snapshot().journal.length,1);
});

test('a missing recipient blocks utility signature and an unattempted mapping loss recovers from a durable hold', async () => {
  const base = createDemoBank(), saved = []; let missing = true;
  const bank = {...base,recipientBinding:ownerId => {
    if (missing) throw new Error('No configured recipient for this fictional owner.');
    return base.recipientBinding(ownerId);
  }};
  const app = setup({bank,persist:async state => {saved.push(state);}});
  await assert.rejects(app.flow.sign(app.draft,'utility',DEMO_ACTORS.utility),/No configured recipient/);
  assert.equal(app.transfers,0);
  missing = false;await signBoth(app);missing = true;
  const held = await app.flow.submit(app.draft,DEMO_ACTORS.requester);
  assert.equal(held.payment.status,'held');assert.match(held.payment.reason,/No transfer was attempted/);
  assert.equal(Object.values(saved.at(-1).obligations)[0].status,'held');assert.equal(app.transfers,0);
  missing = false;
  const paid = await app.flow.submit(app.draft,DEMO_ACTORS.requester);
  assert.equal(paid.payment.status,'paid');assert.equal(paid.journal.length,1);assert.equal(app.transfers,1);
});

test('failed and rejected provider transfers require review and never permit a replacement submission', async () => {
  for (const failure of ['failed','rejected']) {
    const base = createDemoBank();let providerStatus = 'pending';
    const bank = {...base,
      transfer:async input => ({...await base.transfer(input),status:providerStatus}),
      inspect:async input => {
        const result = await base.inspect(input);
        return {...result,existingEvidence:result.existingEvidence ? {...result.existingEvidence,status:providerStatus} : null};
      },
    };
    const app = setup({bank});await signBoth(app);
    assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'submitted');
    providerStatus = failure;
    const failed = await app.flow.reconcile(app.draft,DEMO_ACTORS.requester);
    assert.equal(failed.payment.status,'review-required');assert.match(failed.payment.reason,/failed or rejected/);
    assert.equal(failed.journal.length,0);assert.equal(failed.construction.paidCount,0);
    assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'review-required');
    assert.equal(app.transfers,1);
    assert(failed.audit.some(row => row.action === 'bank-payment-failed' && row.bankStatus === failure));
    // A terminal failure returned immediately from the submission uses the same gate.
    const immediate = setup({bank:{...createDemoBank(),transfer:async input => ({...input,recipientMatches:true,status:failure,transactionRef:'terminal-test-transfer'})}});
    await signBoth(immediate);
    assert.equal((await immediate.flow.submit(immediate.draft,DEMO_ACTORS.requester)).payment.status,'review-required');
    await immediate.flow.submit(immediate.draft,DEMO_ACTORS.requester);assert.equal(immediate.transfers,1);
  }
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


test('legacy stages are rejected by every payment command without contacting the bank', async () => {
  const app = setup(); await signBoth(app);
  for (const stage of ['initial','balance','monthly_fee']) {
    await assert.rejects(app.flow.submit(app.draft,DEMO_ACTORS.requester,{stage}), /Only the full/);
    await assert.rejects(app.flow.reconcile(app.draft,DEMO_ACTORS.requester,{stage}), /Only the full/);
    await assert.rejects(app.flow.reject(app.draft,DEMO_ACTORS.utility,{stage}), /Only the full/);
  }
  assert.equal(app.transfers,0);
  assert.deepEqual(app.flow.snapshot().obligations,{});
});

test('legacy staged attempts and journal evidence cannot be bypassed by a new full obligation', async () => {
  for (const stage of ['initial','balance']) {
    for (const status of ['checking','processing','unknown','submitted','paid','review-required']) {
      const base = setup(), state = base.flow.snapshot();
      const id = `${stage}-${createHash('sha256').update(JSON.stringify([base.source.sessionId,base.draft.parcelId])).digest('hex').slice(0,32)}`;
      state.obligations[id] = {id,stage,parcelId:base.draft.parcelId,status,amountCents:240000,documentHash:'legacy-hash'};
      const restored = setup({initialState:state});
      await assert.rejects(signBoth(restored), /legacy staged-payment attempt/);
      await assert.rejects(restored.flow.submit(restored.draft,DEMO_ACTORS.requester), /legacy staged-payment attempt/);
      assert.equal(restored.transfers,0);
      assert.deepEqual(restored.flow.snapshot(),state,'legacy payment evidence must remain intact');
    }
  }
  for (const evidence of ['transaction','journal','orphaned-journal']) {
    const base = setup(), state = base.flow.snapshot();
    const id = `initial-${createHash('sha256').update(JSON.stringify([base.source.sessionId,base.draft.parcelId])).digest('hex').slice(0,32)}`;
    if (evidence !== 'orphaned-journal') state.obligations[id] = {id,stage:'initial',parcelId:base.draft.parcelId,status:'held',...(evidence === 'transaction' ? {transactionRef:'legacy-transfer'} : {})};
    if (evidence !== 'transaction') state.journal.push({obligationId:id,debitCents:240000,creditCents:240000});
    const restored = setup({initialState:state});
    await assert.rejects(signBoth(restored), /legacy staged-payment attempt/);
    assert.deepEqual(restored.flow.snapshot(),state);
  }
});

test('legacy unattempted holds remain preserved while freshly signed full terms can pay once', async () => {
  const base = setup(), state = base.flow.snapshot();
  const id = `initial-${createHash('sha256').update(JSON.stringify([base.source.sessionId,base.draft.parcelId])).digest('hex').slice(0,32)}`;
  const previous = {id,stage:'initial',parcelId:base.draft.parcelId,status:'held',amountCents:240000,reason:'Insufficient funds'};
  state.obligations[id] = previous;
  const restored = setup({initialState:state});await signBoth(restored);
  const paid = await restored.flow.submit(restored.draft,DEMO_ACTORS.requester);
  assert.equal(paid.payment.status,'paid');assert.equal(paid.payment.amountCents,1200000);
  assert.equal(restored.transfers,1);assert.deepEqual(restored.flow.snapshot().obligations[id],previous);
});

test('a copied partial or inconsistent attempted record is never accepted as a full payment', async () => {
  const original = setup();await signBoth(original);
  const paid = await original.flow.submit(original.draft,DEMO_ACTORS.requester), id = paid.payment.obligationId;
  for (const change of [{amountCents:240000},{stage:'initial'},{id:'another-obligation'},{parcelId:'another-parcel'},{status:'held'},{status:'rejected'},
    {status:'held',id:'mismatched-record-id',transactionRef:null},{status:'rejected',id:'mismatched-record-id',transactionRef:null}]) {
    const state = original.flow.snapshot();Object.assign(state.obligations[id],change);
    const restored = setup({initialState:state});
    await assert.rejects(restored.flow.inspect(original.draft),/does not establish this full compensation|legacy staged-payment attempt/);
    await assert.rejects(restored.flow.submit(original.draft,DEMO_ACTORS.requester),/does not establish this full compensation|legacy staged-payment attempt/);
    await assert.rejects(restored.flow.reconcile(original.draft,DEMO_ACTORS.requester),/does not establish this full compensation|legacy staged-payment attempt/);
    assert.equal(restored.transfers,0);assert.deepEqual(restored.flow.snapshot(),state);
  }
});


test('verified record-only outcomes never post a paid journal or unlock construction, including restarts', async () => {
  const base=createDemoBank();let calls=0;
  const receipt=input=>({...input,recipientMatches:true,paymentSemantics:'record-only',status:'recorded',transactionRef:'nessie-record-1'});
  let evidence=null;
  const bank={...base,paymentSemantics:'record-only',amountIncrementCents:100,
    transfer:async input=>{calls++;evidence=receipt(input);return evidence;},
    inspect:async()=>({recipientMatches:true,balanceCents:10000000,existingEvidence:evidence})};
  const app=setup({bank});await signBoth(app);
  const result=await app.flow.submit(app.draft,DEMO_ACTORS.requester);
  assert.equal(result.payment.status,'recorded');assert.equal(result.payment.paymentSemantics,'record-only');
  assert.equal(result.payment.amountCents,1200000);assert.equal(result.payment.transactionRef,'nessie-record-1');
  assert.equal(result.journal.length,0);assert.equal(result.construction.status,'not-applicable');
  assert.equal(result.construction.paidCount,0);assert.equal(app.flow.snapshot().construction,undefined);
  await assert.rejects(app.flow.completeConstruction(app.draft,{},DEMO_ACTORS.construction),/does not establish payment/);
  const restored=setup({bank,initialState:app.flow.snapshot()});
  assert.equal((await restored.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'recorded');
  assert.equal((await restored.flow.reconcile(app.draft,DEMO_ACTORS.requester)).payment.status,'recorded');
  assert.equal(calls,1);assert.equal(restored.flow.snapshot().journal.length,0);
});

test('a record-only capability prevents completed or executed evidence from claiming money was paid', async () => {
  for (const status of ['completed','executed']) {
    const bank={...createDemoBank(),paymentSemantics:'record-only',transfer:async input=>({...input,recipientMatches:true,status,transactionRef:'provider-record'})};
    const app=setup({bank});await signBoth(app);
    const result=await app.flow.submit(app.draft,DEMO_ACTORS.requester);
    assert.notEqual(result.payment.status,'paid');assert.equal(result.journal.length,0);
    assert.equal(result.construction.status,'not-applicable');assert.equal(app.flow.snapshot().construction,undefined);
  }
});

test('integer-only record preflight holds exact fractional compensation without calling the provider', async () => {
  const source=createContractExample();source.parcels=source.parcels.slice(0,1);source.parcels[0].compensationCents=5516;
  const draft=createContractDraft(source,'P-004',{id:'fractional-record'});let calls=0;
  const bank=createNessieSandboxBank({apiKey:'test',baseUrl:'https://prod-api.nessieisreal.com',payerId:'payer',
    recipients:{'OWNER-DEMO-004':{accountId:'payee',customerId:'customer'}},allowTransfers:true,
    fetcher:async()=>{calls++;throw new Error('No provider calls allowed');}});
  const flow=createContractWorkflow({source,bank});await signBoth({flow,draft});
  const result=await flow.submit(draft,DEMO_ACTORS.requester);
  assert.equal(result.payment.status,'held');assert.equal(result.payment.amountCents,5516);
  assert.match(result.payment.reason,/whole-dollar/);assert.match(result.payment.reason,/not rounded/);
  assert.equal(calls,0);assert.equal(result.journal.length,0);
});

test('prior unknown outcomes stay locked after switching to record-only semantics', async () => {
  const app=setup({bank:{...createDemoBank(),transfer:async()=>{throw new Error('unconfirmed POST');}}});
  await signBoth(app);assert.equal((await app.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'unknown');
  let calls=0;
  const bank={...createDemoBank(),paymentSemantics:'record-only',transfer:async()=>{calls++;throw new Error('must not retry');}};
  const restored=setup({bank,initialState:app.flow.snapshot()});
  assert.equal((await restored.flow.submit(app.draft,DEMO_ACTORS.requester)).payment.status,'unknown');
  assert.equal((await restored.flow.reconcile(app.draft,DEMO_ACTORS.requester)).payment.status,'unknown');
  assert.equal(calls,0);assert.equal(restored.flow.snapshot().journal.length,0);
});

test('record-only restart rejects prior paid or settlement-journal evidence without rewriting or hiding it', async () => {
  const original=setup();await signBoth(original);await original.flow.submit(original.draft,DEMO_ACTORS.requester);
  for (const evidence of ['paid-and-journal','paid-only','journal-only']) {
    const state=original.flow.snapshot();
    if (evidence==='paid-only') state.journal=[];
    if (evidence==='journal-only') state.obligations={};
    const before=JSON.stringify(state);let saved=0;
    const bank={...createDemoBank(),paymentSemantics:'record-only',amountIncrementCents:100};
    assert.throws(()=>createContractWorkflow({source:original.source,bank,initialState:state,persist:async()=>{saved++;}}),/Existing settlement evidence requires controller review/);
    assert.equal(JSON.stringify(state),before,'old payment and journal evidence must stay intact');
    assert.equal(saved,0,'startup failure must not replace the preserved ledger');
  }
});

test('agreement progress counts only both current signatures and refreshes after another agreement changes', async () => {
  const source=createContractExample(), drafts=source.parcels.map((parcel,index)=>createContractDraft(source,parcel.parcelId,{id:`progress-${index}`,now}));
  let providerCalls=0;
  const bank={...createDemoBank(),inspect:async()=>{providerCalls++;throw new Error('No provider access expected');},transfer:async()=>{providerCalls++;throw new Error('No provider access expected');}};
  const flow=createContractWorkflow({source,bank,now:()=>now});
  const check=(result,signedCount,nextUnsignedParcelId)=>{
    assert.deepEqual(result.agreementProgress,{signedCount,totalCount:drafts.length,nextUnsignedParcelId});
    assert.equal(result.packageReady,signedCount===drafts.length);
  };
  check(await flow.inspect(drafts[0]),0,drafts[0].parcelId);
  for (let index=0;index<drafts.length;index++) {
    check(await flow.sign(drafts[index],'utility',DEMO_ACTORS.utility),index,drafts[index].parcelId);
    check(await flow.sign(drafts[index],'landowner',DEMO_ACTORS.landowner),index+1,drafts[index+1]?.parcelId ?? null);
  }
  const edited=updateContractDraft(drafts[1],{specialConditions:'New access schedule requires fresh consent'},source,now);
  check(await flow.inspect(edited),drafts.length-1,edited.parcelId);
  check(await flow.inspect(drafts[0]),drafts.length-1,edited.parcelId);
  await assert.rejects(flow.submit(drafts[0],DEMO_ACTORS.requester),/Every final-route/);
  check(await flow.sign(edited,'utility',DEMO_ACTORS.utility),drafts.length-1,edited.parcelId);
  check(await flow.sign(edited,'landowner',DEMO_ACTORS.landowner),drafts.length,null);
  const restored=createContractWorkflow({source,bank,initialState:flow.snapshot(),now:()=>now});
  check(await restored.inspect(drafts[0]),drafts.length,null);
  assert.equal(providerCalls,0);
});

test('agreement progress excludes signatures from an earlier source approval after restart', async () => {
  const source=createContractExample(), bank=createDemoBank();
  const flow=createContractWorkflow({source,bank,now:()=>now});
  for (const parcel of source.parcels) await signBoth({flow,draft:createContractDraft(source,parcel.parcelId,{id:`old-progress-${parcel.parcelId}`,now})});
  const changed=structuredClone(source);changed.project.signerName='A New Representative';
  const restored=createContractWorkflow({source:changed,bank,initialState:flow.snapshot(),now:()=>now});
  const draft=createContractDraft(changed,changed.parcels[0].parcelId,{id:'new-progress-source',now});
  const result=await restored.inspect(draft);
  assert.deepEqual(result.agreementProgress,{signedCount:0,totalCount:changed.parcels.length,nextUnsignedParcelId:changed.parcels[0].parcelId});
  assert.equal(result.packageReady,false);
});
