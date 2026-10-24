import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createContractExample} from '../src/contract-fixtures.js';
import {createContractDraft, updateContractDraft, renderContractDocument} from '../src/contract-authoring.js';
import {createContractWorkflow, createDemoBank, DEMO_ACTORS as actors} from '../server/contract-workflow.mjs';
import {createContractAPI} from '../server/contract-api.mjs';

function fixture(options = {}) {
  const source = createContractExample(); source.parcels[0].compensationCents += 1;
  const drafts = source.parcels.map((p, index) => createContractDraft(source, p.parcelId, {id: `contract-${index}`}));
  const bank = options.bank ?? createDemoBank();
  const workflow = createContractWorkflow({source, bank, ...options});
  return {source, drafts, bank, workflow};
}
async function signAll(workflow, drafts) {
  for (const draft of drafts) {
    await workflow.sign(draft, 'utility', actors.utility);
    await workflow.sign(draft, 'landowner', actors.landowner);
  }
}
async function fund(workflow, drafts) {
  await signAll(workflow, drafts);
  let result;
  for (const draft of drafts) result = await workflow.submit(draft, actors.requester);
  return result;
}
const completion = result => ({...result.construction, eventId: 'theo-construction-completed'});

test('complete package signatures and confirmed payments gate one route construction run', async () => {
  const {workflow, drafts} = fixture();
  await workflow.sign(drafts[0], 'utility', actors.utility);
  await workflow.sign(drafts[0], 'landowner', actors.landowner);
  await assert.rejects(workflow.submit(drafts[0], actors.requester), /Every final-route/);
  await signAll(workflow, drafts);
  const first = await workflow.submit(drafts[0], actors.requester);
  assert.equal(first.construction.status, 'awaiting-initial-payments');
  assert.equal(first.construction.paidCount, 1);
  await assert.rejects(workflow.submit(drafts[0], actors.requester, {stage:'balance'}), /construction completion/);
  const second = await workflow.submit(drafts[1], actors.requester);
  assert.equal(second.construction.status, 'in-progress');
  assert.equal(workflow.snapshot().audit.filter(row => row.action === 'construction-started').length, 1);
  await workflow.submit(drafts[1], actors.requester);
  assert.equal(workflow.snapshot().journal.length, 2);
});

test('host completion is version bound, role gated, immutable and never pays the balance itself', async () => {
  const {workflow, drafts} = fixture();
  await assert.rejects(workflow.completeConstruction(drafts[0], {}, actors.construction), /current construction run/);
  const funded = await fund(workflow, drafts);
  await assert.rejects(workflow.completeConstruction(drafts[0], completion(funded), actors.requester), /role/);
  for (const field of ['constructionId','packageHash','sessionId','routeId','routeVersion']) {
    await assert.rejects(workflow.completeConstruction(drafts[0], {...completion(funded), [field]: 'obsolete'}, actors.construction), /current construction run/);
  }
  const done = await workflow.completeConstruction(drafts[0], completion(funded), actors.construction);
  const replay = await workflow.completeConstruction(drafts[0], completion(funded), actors.construction);
  assert.equal(done.construction.status, 'completed');
  assert.equal(done.balancePayment, null);
  assert.equal(replay.construction.completedAt, done.construction.completedAt);
  assert.equal(workflow.snapshot().audit.filter(row => row.action === 'construction-completed').length, 1);
  assert.equal(workflow.snapshot().journal.length, 2);
});

test('an unsigned replacement of another parcel invalidates complete-package payment readiness', async () => {
  const {workflow, drafts, source} = fixture();
  await signAll(workflow, drafts);
  const replacement = createContractDraft(source, drafts[1].parcelId, {id:'replacement-contract'});
  await workflow.inspect(replacement);
  await assert.rejects(workflow.submit(drafts[0], actors.requester), /Every final-route/);
});

test('explicit balance payment uses the exact remainder once across concurrency and restart', async () => {
  const {workflow, drafts, source, bank} = fixture();
  const funded = await fund(workflow, drafts);
  await workflow.completeConstruction(drafts[0], completion(funded), actors.construction);
  const [paid] = await Promise.all([workflow.submit(drafts[0], actors.requester, {stage:'balance'}), workflow.submit(drafts[0], actors.requester, {stage:'balance'})]);
  assert.equal(paid.payment.amountCents, 240000);
  assert.equal(paid.balancePayment.amountCents, 960001);
  assert.equal(paid.payment.amountCents + paid.balancePayment.amountCents, source.parcels[0].compensationCents);
  assert.equal(workflow.snapshot().journal.length, 3);
  const restored = createContractWorkflow({source, bank, initialState:workflow.snapshot()});
  const replay = await restored.submit(drafts[0], actors.requester, {stage:'balance'});
  assert.equal(replay.balancePayment.status, 'paid');
  assert.equal(restored.snapshot().journal.length, 3);
  await restored.submit(drafts[1], actors.requester, {stage:'balance'});
  assert.equal(restored.snapshot().journal.length, 4);
});

test('held and uncertain initial payments cannot start construction; uncertain balance requires reconciliation', async () => {
  const baseBank = createDemoBank(); let loseBalanceResponse = true, transfers = 0;
  const bank = {...baseBank, transfer: async input => {
    transfers++; const evidence = await baseBank.transfer(input);
    if (input.obligationId.startsWith('balance-') && loseBalanceResponse) { loseBalanceResponse = false; throw new Error('Lost bank response'); }
    return evidence;
  }};
  const {workflow, drafts} = fixture({bank});
  await signAll(workflow, drafts);
  const held = await workflow.submit(drafts[0], actors.requester, {scenario:'insufficient-funds'});
  assert.equal(held.payment.status, 'held');
  assert.equal(held.construction.status, 'awaiting-initial-payments');
  await workflow.submit(drafts[0], actors.requester);
  const funded = await workflow.submit(drafts[1], actors.requester);
  await workflow.completeConstruction(drafts[0], completion(funded), actors.construction);
  const unknown = await workflow.submit(drafts[0], actors.requester, {stage:'balance'});
  assert.equal(unknown.balancePayment.status, 'unknown');
  await workflow.submit(drafts[0], actors.requester, {stage:'balance'});
  assert.equal(transfers, 3);
  const resolved = await workflow.reconcile(drafts[0], actors.requester, {stage:'balance'});
  assert.equal(resolved.balancePayment.status, 'paid');
  assert.equal(transfers, 3);
});

test('pending evidence, changed approved recipient and regenerated contracts cannot bypass payment gates', async () => {
  const baseBank = createDemoBank(); let pending = true, recipient = 'approved-recipient';
  const bank = {...baseBank, recipientBinding: () => recipient,
    transfer: async input => ({...await baseBank.transfer(input), status:pending ? 'pending' : 'completed'})};
  const {workflow, drafts, source} = fixture({bank});
  await signAll(workflow, drafts);
  const submitted = await workflow.submit(drafts[0], actors.requester);
  assert.equal(submitted.payment.status, 'submitted');
  assert.equal(submitted.construction.paidCount, 0);
  pending = false;
  await workflow.reconcile(drafts[0], actors.requester);
  const funded = await workflow.submit(drafts[1], actors.requester);
  await workflow.completeConstruction(drafts[0], completion(funded), actors.construction);
  recipient = 'changed-recipient';
  assert.equal((await workflow.submit(drafts[0], actors.requester, {stage:'balance'})).balancePayment.status, 'held');
  const changed = updateContractDraft(drafts[0], {specialConditions:'Different approved document'}, source);
  await assert.rejects(workflow.inspect(changed), /locks this parcel/);
  await assert.rejects(workflow.submit(drafts[0], actors.requester, {stage:'monthly_fee'}), /Only initial/);
  assert.doesNotMatch(renderContractDocument(drafts[0], source), /Monthly usage fee|monthly anniversaries/);
});

test('HTTP adapter persists completion and exact balance through a service restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easygrid-cal38-'));
  const stateURL = pathToFileURL(join(directory, 'ledger.json'));
  let server;
  async function start() {
    const api = await createContractAPI({environment:{}, stateURL});
    server = createServer((req, res) => api(req, res, new URL(req.url, 'http://localhost').pathname));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  const stop = () => new Promise(resolve => server.close(resolve));
  async function command(operation, draft, extra = {}) {
    return new Promise((resolve, reject) => {
      const req = request({hostname:'127.0.0.1', port:server.address().port, path:`/api/contracts/${operation}`, method:'POST', headers:{host:'127.0.0.1:4177','content-type':'application/json','x-easygrid-demo':'1'}}, res => {
        let body = ''; res.on('data', chunk => {body += chunk;}); res.on('end', () => {
          try { const result = JSON.parse(body); assert.equal(res.statusCode, 200, result.error); resolve(result); } catch (error) { reject(error); }
        });
      });
      req.on('error', reject); req.end(JSON.stringify({draft,...extra}));
    });
  }
  try {
    await start();
    const source = createContractExample(), drafts = source.parcels.map((p, i) => createContractDraft(source, p.parcelId, {id:`http-${i}`}));
    for (const draft of drafts) { await command('sign/utility', draft); await command('sign/landowner', draft); }
    await command('submit', drafts[0]);
    const funded = await command('submit', drafts[1]);
    await command('construction-complete', drafts[0], {completion:completion(funded)});
    await command('submit', drafts[0], {stage:'balance'});
    await stop(); await start();
    const restored = await command('submit', drafts[0], {stage:'balance'});
    assert.equal(restored.construction.status, 'completed');
    assert.equal(restored.balancePayment.status, 'paid');
    assert.equal(restored.journal.length, 2);
  } finally {
    if (server?.listening) await stop();
    assert(directory.startsWith(join(tmpdir(), 'easygrid-cal38-')));
    await rm(directory, {recursive:true, force:true});
  }
});
