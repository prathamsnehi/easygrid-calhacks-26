// Controlled DOM behavior test. It does not prove browser layout or visual rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContractWorkspace} from '../src/contract-workspace.js';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractWorkflow,createDemoBank,DEMO_ACTORS} from '../server/contract-workflow.mjs';

function boot({saved = new Map(), workflow = null, apiOverride = null, paymentsEnabled} = {}) {
  const nodes = new Map();
  class Element {
    constructor(id, tag = '') {this.id=id;this.hidden=/\shidden(?:\s|>)/.test(tag);this.disabled=/\sdisabled(?:\s|>)/.test(tag);this.value='';this.textContent='';this.innerHTML='';this.className='';this.children=[];this.listeners=new Map();this.attributes={};}
    addEventListener(type,callback){this.listeners.set(type,callback);}
    setAttribute(name,value){this.attributes[name]=value;}
    focus(){document.activeElement=this;}
    appendChild(child){this.children.push(child);}
    replaceChildren(...children){this.children=children;}
    async emit(type){return this.listeners.get(type)?.({preventDefault(){},target:this});}
  }
  const markup = readFileSync(new URL('../src/contract-workspace.html',import.meta.url),'utf8');
  for (const match of markup.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g)) nodes.set(match[1],new Element(match[1],match[0]));
  const original = globalThis.document;
  globalThis.document = {activeElement:null,querySelector:selector => nodes.get(selector.slice(1)) ?? null,createElement:tag => new Element('',tag)};
  const flow = workflow ?? createContractWorkflow({source:createContractExample(),bank:createDemoBank()});
  const api = async (operation,draft,extra) => {
    if (operation === 'state') return flow.inspect(draft);
    if (operation.startsWith('sign/')) {const side=operation.split('/')[1];return flow.sign(draft,side,DEMO_ACTORS[side]);}
    if (operation === 'submit') return flow.submit(draft,DEMO_ACTORS.requester,extra);
    if (operation === 'construction-complete') return flow.completeConstruction(draft,extra.completion,DEMO_ACTORS.construction);
    if (operation === 'reconcile') return flow.reconcile(draft,DEMO_ACTORS.requester,extra);
    return flow.reject(draft,DEMO_ACTORS.utility,extra);
  };
  const app = createContractWorkspace({storage:{getItem:key => saved.get(key) ?? null,setItem:(key,value) => saved.set(key,value)},api:async (operation,draft,extra = {}) => ({...await (apiOverride ? apiOverride(operation,draft,extra,api) : api(operation,draft,extra)), ...(paymentsEnabled === undefined ? {} : {paymentsEnabled})})});
  return {app,nodes,saved,flow,restore:() => {globalThis.document=original;},flush:() => new Promise(done => setImmediate(done)),
    click:async id => {if(!nodes.get(id).disabled)await nodes.get(id).emit('click');}};
}

test('current signatures unlock payment navigation before the other agreements, and navigation never submits', async () => {
  let submits = 0;
  const ui = boot({apiOverride:async (operation,draft,extra,api) => {
    if (operation === 'submit') submits++;
    return api(operation,draft,extra);
  }});
  try {
    ui.app.open(createContractExample('pending'),{demo:true}); assert.equal(ui.nodes.get('cg-proceed').disabled,true);
    ui.app.setSource(createContractExample()); assert.equal(ui.nodes.get('cg-proceed').disabled,false);
    await ui.click('cg-proceed'); await ui.flush();
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,true);
    await ui.nodes.get('cg-continue-payment').emit('click');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,true);
    await ui.click('cg-sign-utility'); assert.equal(ui.nodes.get('cg-continue-payment').disabled,true);
    await ui.click('cg-sign-landowner'); assert.equal(ui.nodes.get('cg-continue-payment').disabled,false);
    assert.equal(ui.nodes.get('cg-payment-view').hidden,true,'signing never navigates or submits');
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-agreement-preview').hidden,true);
    assert.equal(ui.nodes.get('cg-agreement-sidebar').hidden,true);
    assert.equal(ui.nodes.get('cg-title').textContent,'Review your payment.');
    assert.equal(ui.nodes.get('cg-step-payment').attributes['aria-current'],'step');
    assert.equal(ui.nodes.get('cg-payment-owner').textContent,'Willow Creek Orchard');
    assert.equal(ui.nodes.get('cg-payment-amount').textContent,'$12,000.00');
    assert.equal(ui.nodes.get('cg-submit').disabled,true,'package signatures still gate the final action');
    assert.equal(ui.nodes.get('cg-remaining-panel').hidden,false);
    assert.equal(ui.nodes.get('cg-agreement-progress').textContent,'1 of 2 agreements signed');
    await ui.nodes.get('cg-submit').emit('click'); assert.equal(submits,0);
    await ui.click('cg-review-remaining'); await ui.flush();
    assert.equal(ui.nodes.get('cg-parcel').value,'P-009');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,true);
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-amount').textContent,'$8,000.00');
    assert.equal(ui.nodes.get('cg-remaining-panel').hidden,true);
    assert.equal(ui.nodes.get('cg-submit').disabled,false);
    assert.equal(submits,0,'opening payment is side-effect free');
    await ui.click('cg-back-agreement');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,true);
    assert.equal(ui.nodes.get('cg-title').textContent,'Review your agreement.');
    assert.equal(ui.nodes.get('cg-parcel').value,'P-009');
    assert.equal(ui.nodes.get('cg-landowner-signature-status').textContent,'✓ Signed');
    await ui.nodes.get('cg-submit').emit('click'); assert.equal(submits,0,'hidden final action cannot submit from agreement view');
    await ui.click('cg-continue-payment'); await ui.click('cg-submit');
    assert.equal(submits,1); assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.flow.snapshot().journal.length,1);
  } finally {ui.restore();}
});

async function signEveryAgreement(ui) {
  await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
  ui.nodes.get('cg-parcel').value='P-009'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
  await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
  ui.nodes.get('cg-parcel').value='P-004'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
}

test('Nessie registration requires one explicit click and confirms a record without implying payment', async () => {
  let transferCount = 0, releaseTransfer, bankEvidence = null;
  const bank = {...createDemoBank(), mode:'nessie-sandbox', paymentSemantics:'record-only', amountIncrementCents:100,
    inspect:async input => ({recipientMatches:true,balanceCents:10000000,existingEvidence:bankEvidence?.obligationId === input.obligationId ? bankEvidence : null}),
    transfer:async input => {
      transferCount++;
      await new Promise(resolve => {releaseTransfer=resolve;});
      bankEvidence = {...input,recipientMatches:true,paymentSemantics:'record-only',status:'pending',transactionRef:'nessie-transfer-fixture-001'};
      return bankEvidence;
    },
  };
  const ui = boot({workflow:createContractWorkflow({source:createContractExample(),bank}),paymentsEnabled:true});
  try {
    let constructionStarts = 0;
    ui.app.setConstructionHandler(() => {constructionStarts++;});
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Waiting for all signatures');
    assert.equal(transferCount,0);
    await signEveryAgreement(ui); await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payout-provider').textContent,'Nessie sandbox');
    assert.equal(ui.nodes.get('cg-submit').textContent,'Register full amount · $12,000.00');
    assert.equal(ui.nodes.get('cg-payout-basis').textContent,'100% of $12,000.00 approved compensation');
    assert.equal(ui.nodes.get('cg-payout-recipient').textContent,'Agreement for Willow Creek Orchard');
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Ready to register');
    assert.equal(ui.nodes.get('cg-scenario-wrap').hidden,true);
    assert.equal(ui.nodes.has('cg-preview-completion'),false);
    assert.equal(transferCount,0,'collecting signatures alone cannot send money');
    const sending = ui.click('cg-submit'); await ui.flush();
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.nodes.get('cg-submit').textContent,'Registering amount…');
    await ui.nodes.get('cg-submit').emit('click');
    assert.equal(transferCount,1,'even a direct duplicate event cannot send while busy');
    releaseTransfer(); await sending;
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Pending confirmation');
    assert.equal(ui.nodes.get('cg-transfer-reference').hidden,false);
    assert.equal(ui.nodes.get('cg-transfer-reference-value').textContent,'nessie-transfer-fixture-001');
    assert.equal(ui.nodes.get('cg-reconcile').hidden,false);
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.nodes.has('cg-completion-panel'),false);
    assert.equal(ui.flow.snapshot().journal.length,0,'pending bank acknowledgement is not payment');
    bankEvidence.status='recorded'; await ui.click('cg-reconcile');
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Recorded in Nessie');
    assert.equal(ui.nodes.get('cg-submit').textContent,'Recorded in Nessie · $12,000.00');
    await ui.click('cg-back-agreement');
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,false);
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-transfer-reference').hidden,false);
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.nodes.get('cg-reconcile').hidden,true);
    assert.equal(ui.nodes.has('cg-completion-panel'),false);
    assert.equal(ui.nodes.has('cg-pay-balance'),false);
    assert.equal(ui.flow.snapshot().journal.length,0,'a Nessie record never posts a paid journal');
    assert.equal(constructionStarts,0,'a Nessie record never starts construction');
    assert.match(ui.nodes.get('cg-payout-help').textContent,/No account balances move/);
    assert.equal(ui.nodes.get('cg-transfer-reference-label').textContent,'Record reference');
    assert.equal(ui.nodes.get('cg-payment-state').textContent,'Recorded in Nessie');
    assert.match(ui.nodes.get('cg-execution-status').textContent,/landowner has not been paid/);
    assert.equal(transferCount,1,'reconciliation never submits another transfer');
  } finally {ui.restore();}
});

test('disabled Nessie writes keep a signed full payment locked and explain the missing setup', async () => {
  let transferCount=0;
  const bank={...createDemoBank(),mode:'nessie-sandbox', paymentSemantics:'record-only', amountIncrementCents:100,canTransfer:false,transfer:async () => {transferCount++;throw new Error('Writes are disabled.');}};
  const ui=boot({workflow:createContractWorkflow({source:createContractExample(),bank}),paymentsEnabled:false});
  try {
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await signEveryAgreement(ui); await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-panel').hidden,false);
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,false);
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Setup required');
    assert.match(ui.nodes.get('cg-payout-help').textContent,/not enabled/);
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    await ui.click('cg-continue-payment'); await ui.click('cg-submit');
    assert.equal(transferCount,0);
  } finally {ui.restore();}
});

test('Nessie rejects fractional amounts in the UI before any API submission without rounding approved compensation', async () => {
  const source = createContractExample(); source.parcels[0].compensationCents = 114425;
  let submissions = 0;
  const bank = {...createDemoBank(),mode:'nessie-sandbox',paymentSemantics:'record-only',amountIncrementCents:100};
  const ui = boot({workflow:createContractWorkflow({source,bank}),apiOverride:async (operation,draft,extra,api) => {
    if (operation === 'submit') submissions++;
    return api(operation,draft,extra);
  }});
  try {
    ui.app.open(source,{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await signEveryAgreement(ui); await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,false);
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-submit').textContent,'Register full amount · $1,144.25');
    assert.equal(ui.nodes.get('cg-parcel-total').textContent,'$1,144.25');
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Whole-dollar amount required');
    assert.match(ui.nodes.get('cg-payout-help').textContent,/whole-dollar records only.*\$1,144\.25.*will not be rounded/);
    await ui.nodes.get('cg-submit').emit('click');
    assert.equal(submissions,0,'even a direct event cannot send a fractional amount to the API');
    assert.match(ui.nodes.get('cg-feedback').textContent,/will not be rounded/);
    assert.equal(source.parcels[0].compensationCents,114425);
    assert.equal(ui.flow.snapshot().journal.length,0);
  } finally {ui.restore();}
});

test('a lost Nessie registration response stays locked until a status check recovers the existing record', async () => {
  const calls = [];
  let transfers = 0, stateUnavailable = false, bankEvidence = null;
  const bank = {...createDemoBank(), mode:'nessie-sandbox', paymentSemantics:'record-only', amountIncrementCents:100,
    inspect:async input => ({recipientMatches:true,balanceCents:10000000,existingEvidence:bankEvidence?.obligationId === input.obligationId ? bankEvidence : null}),
    transfer:async input => {
      transfers++;
      return bankEvidence = {...input,recipientMatches:true,paymentSemantics:'record-only',status:'pending',transactionRef:'nessie-lost-response-fixture'};
    },
  };
  const ui = boot({workflow:createContractWorkflow({source:createContractExample(),bank}),apiOverride:async (operation,draft,extra,api) => {
    calls.push(operation);
    if (operation === 'state' && stateUnavailable) throw new Error('The service is unavailable.');
    const result = await api(operation,draft,extra);
    if (operation === 'submit') throw new Error('The payment response was lost.');
    return result;
  }});
  try {
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await signEveryAgreement(ui); await ui.click('cg-continue-payment');
    await ui.click('cg-continue-payment'); await ui.click('cg-submit');
    assert.equal(transfers,1);
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Outcome unknown');
    await ui.click('cg-back-agreement');
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,false);
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.nodes.get('cg-reconcile').hidden,false);
    assert.match(ui.nodes.get('cg-payout-help').textContent,/Check record status/);
    assert.equal(ui.flow.snapshot().journal.length,0);
    await ui.nodes.get('cg-submit').emit('click');
    assert.equal(calls.filter(operation => operation === 'submit').length,1,'a lost response cannot enable a replacement request');
    stateUnavailable = true; await ui.click('cg-reconcile');
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Outcome unknown');
    await ui.click('cg-back-agreement');
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,false);
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    bankEvidence.status = 'recorded';
    stateUnavailable = false; await ui.click('cg-reconcile');
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Recorded in Nessie');
    assert.equal(ui.nodes.get('cg-submit').textContent,'Recorded in Nessie · $12,000.00');
    await ui.click('cg-back-agreement');
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,false);
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-transfer-reference').hidden,false);
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    assert.equal(ui.flow.snapshot().journal.length,0);
    assert.deepEqual(calls.slice(-2),['state','reconcile']);
    assert.equal(ui.nodes.get('cg-feedback').textContent,'');
    assert.equal(transfers,1);
  } finally {ui.restore();}
});

test('a status check finding no attempted payment unlocks only a new explicit payment click', async () => {
  const demoBank = createDemoBank();
  let requestReachedServer = false, transfers = 0;
  const bank = {...demoBank,transfer:async input => {transfers++;return demoBank.transfer(input);}};
  const ui = boot({workflow:createContractWorkflow({source:createContractExample(),bank}),apiOverride:async (operation,draft,extra,api) => {
    if (operation === 'submit' && !requestReachedServer) throw new Error('The request could not reach the service.');
    return api(operation,draft,extra);
  }});
  try {
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await signEveryAgreement(ui); await ui.click('cg-continue-payment'); await ui.click('cg-continue-payment'); await ui.click('cg-submit');
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    ui.app.review(); await ui.flush(); await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Outcome unknown','ordinary navigation cannot silently recover a lost submission');
    assert.equal(ui.nodes.get('cg-submit').disabled,true);
    await ui.click('cg-reconcile');
    assert.equal(ui.nodes.get('cg-payout-status').textContent,'Ready to send');
    assert.equal(ui.nodes.get('cg-submit').disabled,false);
    assert.equal(transfers,0,'checking a missing obligation never creates a transfer');
    requestReachedServer = true; await ui.click('cg-continue-payment'); await ui.click('cg-submit');
    assert.equal(ui.nodes.get('cg-submit').textContent,'Paid in full · $12,000.00');
    assert.equal(transfers,1);
  } finally {ui.restore();}
});

test('editing invalidates signatures, parcel switches preserve edits, and source changes lock open drafts', async () => {
  const ui = boot();
  try {
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner'); assert.equal(ui.nodes.get('cg-submit').disabled,true);
    await ui.click('cg-continue-payment'); assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    await ui.click('cg-back-agreement'); assert.equal(ui.nodes.get('cg-payment-view').hidden,true);
    ui.nodes.get('cg-notes').value='Review this draft note.'; await ui.nodes.get('cg-notes').emit('input');
    assert.equal(ui.nodes.get('cg-submit').disabled,true); assert.equal(ui.nodes.get('cg-utility-signature-status').textContent,'Sign ↗');
    assert.equal(ui.nodes.get('cg-continue-payment').disabled,true);
    await ui.nodes.get('cg-continue-payment').emit('click'); assert.equal(ui.nodes.get('cg-payment-view').hidden,true);
    ui.nodes.get('cg-parcel').value='P-009'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    ui.nodes.get('cg-parcel').value='P-004'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    assert.equal(ui.nodes.get('cg-notes').value,'Review this draft note.');
    ui.app.invalidate(); assert.equal(ui.nodes.get('cg-submit').disabled,true); assert.equal(ui.nodes.get('cg-download').disabled,true);
  } finally {ui.restore();}
});

test('optional construction never triggers another payment and invalidation aborts late callbacks', async () => {
  const ui = boot();
  try {
    let signal, complete, notices = 0;
    const handler = input => {signal=input.signal;complete=input.onComplete;notices++;return Promise.resolve();};
    ui.app.setConstructionHandler(handler);
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
    ui.nodes.get('cg-parcel').value='P-009'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner'); await ui.click('cg-continue-payment'); await ui.click('cg-submit');
    ui.nodes.get('cg-parcel').value='P-004'; await ui.nodes.get('cg-parcel').emit('change'); await ui.flush();
    await ui.click('cg-continue-payment'); await ui.click('cg-submit'); await ui.flush();
    assert.equal(notices,1); assert.equal(ui.nodes.has('cg-pay-balance'),false);
    ui.app.setConstructionHandler(handler); assert.equal(notices,1);
    ui.app.invalidate(); assert.equal(signal.aborted,true);
    await assert.rejects(complete(),/context changed/);
    assert.equal(ui.nodes.has('cg-pay-balance'),false);
    assert.equal(ui.flow.snapshot().construction.status,'in-progress');
  } finally {ui.restore();}
});

test('a late signature response cannot re-enable submission after the source approval is revoked', async () => {
  let resolveSignature;
  const ui = boot({apiOverride:async (operation,draft) => {
    if(operation === 'state')return {draftId:draft.id,documentHash:'a'.repeat(64),signatures:{},audit:[],journal:[],bankMode:'simulation'};
    return new Promise(resolve => {resolveSignature=resolve;});
  }});
  try {
    ui.app.open(createContractExample(),{demo:true}); await ui.click('cg-proceed'); await ui.flush();
    const pending = ui.click('cg-sign-utility'); await ui.flush(); ui.app.invalidate();
    resolveSignature({signatures:{utility:{simulated:true,signedAt:'2026-10-24T18:00:00Z'},landowner:{simulated:true,signedAt:'2026-10-24T18:00:00Z'}},audit:[],journal:[],bankMode:'simulation'});
    await pending; assert.equal(ui.nodes.get('cg-continue-payment').disabled,true); assert.equal(ui.nodes.get('cg-submit').disabled,true); assert.equal(ui.nodes.get('cg-stale').hidden,false);
  } finally {ui.restore();}
});


test('the explicit representative demo shows and signs only one owner while preserving the full source binding', async () => {
  const source=createContractExample(); source.parcels[1].ownerName='Amelia Standish'; source.parcels[1].compensationCents=114400;
  const calls=[];
  const ui=boot({workflow:createContractWorkflow({source,bank:createDemoBank()}),apiOverride:async (operation,draft,extra,api) => {
    calls.push({operation,draft:structuredClone(draft)});
    const result=await api(operation,draft,extra);
    return {...result,demoScope:'single-owner',demoParcelId:'P-009',paymentReady:Boolean(result.signatures.utility && result.signatures.landowner)};
  }});
  try {
    ui.app.open(source,{demo:true,demoParcelId:'P-009'});
    assert.equal(ui.nodes.get('cg-owner-count').textContent,'1');
    assert.equal(ui.nodes.get('cg-total').textContent,'$1,144.00');
    assert.equal(ui.nodes.get('cg-gate-scope-label').textContent,'SINGLE-LANDOWNER DEMO');
    await ui.click('cg-proceed'); await ui.flush();
    assert.equal(ui.nodes.get('cg-selection-bar').hidden,true);
    assert.equal(ui.nodes.get('cg-parcel').children.length,1);
    assert.equal(ui.nodes.get('cg-parcel').value,'P-009');
    assert.equal(ui.nodes.has('cg-sign-all'),false);
    assert.equal(ui.nodes.has('cg-payment-parcel-select'),false);
    assert.match(ui.nodes.get('cg-preview').innerHTML,/SINGLE-LANDOWNER DEMO/);
    assert.doesNotMatch(ui.nodes.get('cg-preview').innerHTML,/every current final-route agreement|after all final-route agreements are signed/);
    await ui.click('cg-sign-utility'); await ui.click('cg-sign-landowner');
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-payment-owner').textContent,'Amelia Standish');
    assert.equal(ui.nodes.get('cg-payment-amount').textContent,'$1,144.00');
    assert.equal(ui.nodes.get('cg-payment-timing').textContent,'After both parties sign this agreement');
    assert.equal(ui.nodes.get('cg-remaining-panel').hidden,true);
    assert.equal(ui.nodes.get('cg-submit').disabled,false,'scoped paymentReady works while all-route packageReady is false');
    assert.equal(calls.filter(call=>call.operation.startsWith('sign/')).length,2);
    assert(calls.every(call=>call.draft.parcelId==='P-009'));
    assert(calls.every(call=>JSON.parse(call.draft.sourceKey).parcels.length===2),'canonical route source is never sliced');
    assert.equal(calls.filter(call=>call.operation==='submit').length,0);
  } finally {ui.restore();}
});

test('a representative view never treats all-route readiness as scoped authorization', async () => {
  const ui=boot({apiOverride:async (operation,draft) => ({draftId:draft.id,documentHash:'a'.repeat(64),packageReady:true,
    signatures:{utility:{simulated:true,signedAt:'2026-10-24T18:00:00Z'},landowner:{simulated:true,signedAt:'2026-10-24T18:00:00Z'}},audit:[],journal:[],bankMode:'simulation'})});
  try {
    ui.app.open(createContractExample(),{demo:true,demoParcelId:'P-009'}); await ui.click('cg-proceed'); await ui.flush();
    await ui.click('cg-continue-payment');
    assert.equal(ui.nodes.get('cg-payment-view').hidden,false);
    assert.equal(ui.nodes.get('cg-submit').disabled,true,'missing scoped metadata cannot relax the final action');
  } finally {ui.restore();}
});
