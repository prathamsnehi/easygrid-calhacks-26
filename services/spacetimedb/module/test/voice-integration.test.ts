import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Identity, Timestamp } from 'spacetimedb';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import * as module from '../src/index.ts';
import type { Db } from '../src/logic.ts';
import {
  reserveVoiceAttempt, claimVoiceAttempt, markVoiceAttempt, recordVoiceTool,
  saveVoiceCandidate, saveVoiceOutcome, voiceWorkerAttempts, voiceResults,
} from '../src/voice-state.ts';
import { createVoiceCoordinator } from '../../../../apps/map-preview/server/voice-coordinator.mjs';
import { createVoiceProposal } from '../../../../apps/map-preview/server/voice-proposal.mjs';
import { createMapContractService } from '../../../../apps/map-preview/server/map-contracts.mjs';
import { createDemoBank, DEMO_ACTORS } from '../../../../apps/map-preview/server/contract-workflow.mjs';
import { createContractDraft } from '../../../../apps/map-preview/src/contract-authoring.js';
import { createWorld } from '../../../../apps/map-preview/src/world.js';
import { createPlacement } from '../../../../apps/map-preview/src/placement.js';
import { computeTransmissionRoutes } from '../../../../apps/map-preview/src/routing.js';
import { analyzeRouteParcels } from '../../../../apps/map-preview/src/parcel-analysis.js';
import { createHandoff } from '../../../../apps/map-preview/src/handoff.js';
import { mapContractRequest } from '../../../../apps/map-preview/src/contract-handoff.js';
import { createEasyGridVoiceRuntime } from '../../../cartesia/easygrid-voice.ts';

test('real reducer transactions connect counteroffer, provider evidence, restored contract and one exact full payment', async () => {
  const db = createModuleTestHarness(module.default, module), worker = new Identity(701n);
  db.clock.set(new Timestamp(1_792_929_600_000_000n));
  const tx = <T>(action: (ctx: Db) => T) => db.withReducerTx(TestAuth.internal(), ctx => action({ ...ctx, db: ctx.db, sender: worker } as Db));
  const read = (id: string) => {
    const row = tx(ctx => voiceWorkerAttempts(ctx)).find(row => row.id === id);
    return row ? JSON.parse(row.attemptJson) : null;
  };
  const publicRows = () => tx(ctx => voiceResults(ctx)).map(row => JSON.parse(row.resultJson));
  const listeners = new Set<(rows: any[]) => void>();
  const commit = (action: (ctx: Db) => void) => { tx(action); for (const listener of listeners) listener(publicRows()); };
  let claims = 0;
  // This facade contains no mutable domain snapshot: every read and mutation uses
  // the actual module datastore and worker authorization inside a reducer transaction.
  const store = {
    async getAttempt(id: string) { return read(id); },
    async reserveAttempt(input: any) {
      const prior = read(input.id);
      commit(ctx => reserveVoiceAttempt(ctx, { inputJson: JSON.stringify(input) }));
      return { attempt: read(input.id), replayed: prior !== null };
    },
    async claimAttempt({ id }: { id: string }) {
      const before = read(id), claimId = `integration-claim-${++claims}`;
      commit(ctx => claimVoiceAttempt(ctx, { id, claimId }));
      const attempt = read(id);
      return { attempt, claimed: before?.status === 'reserved' && !before.claimId && attempt.claimId === claimId };
    },
    async markAttempt({ id, claimId, status, providerCallId = '', evidence = {} }: any) {
      commit(ctx => markVoiceAttempt(ctx, { id, claimId, status, providerCallId, evidenceJson: JSON.stringify(evidence) }));
      return read(id);
    },
    async recordTool({ id, claimId, requestId, kind, payload }: any) {
      commit(ctx => recordVoiceTool(ctx, { id, claimId, requestId, kind, payloadJson: JSON.stringify(payload) }));
      const attempt = read(id); return { attempt, receipt: attempt.toolReceipts[requestId] };
    },
    async saveCandidate({ id, claimId, candidate }: any) {
      commit(ctx => saveVoiceCandidate(ctx, { id, claimId, candidateJson: JSON.stringify(candidate) }));
      return read(id);
    },
    async saveOutcome({ id, claimId, outcome }: any) {
      commit(ctx => saveVoiceOutcome(ctx, { id, claimId, outcomeJson: JSON.stringify(outcome) }));
      return read(id);
    },
    async listPending() { return tx(ctx => voiceWorkerAttempts(ctx)).map(row => JSON.parse(row.attemptJson)).filter(a => !['accepted', 'refused', 'review_required'].includes(a.status)); },
    subscribeResults(listener: (rows: any[]) => void) { listeners.add(listener); listener(publicRows()); return () => listeners.delete(listener); },
  };

  const world = createWorld(), substation = createPlacement(world, 'substation', -43, -17);
  const placements = { substation, datacenter: createPlacement(world, 'datacenter', 43, -17, { substation }) };
  const routes = computeTransmissionRoutes(world, placements), route = routes.candidates[0];
  const handoff = createHandoff({ world, route, placements, analysis: analyzeRouteParcels(world, route, routes.assumptions), sessionId: 'sdk-voice-integration', routeVersion: 1 });
  const context = mapContractRequest(handoff, placements);
  let calls = 0, inspections = 0, transfers = 0, attemptSecret = '', attemptId = '', acceptedCents = 0;
  const runtime = createEasyGridVoiceRuntime({ agentId: 'fixture-agent', fromNumberId: 'fixture-origin',
    service: {
      async call(input: any) {
        calls++; attemptSecret = String(input.dynamicVariables.attempt_authorization).replace(/^Bearer /, '');
        const saved = tx(ctx => voiceWorkerAttempts(ctx)).map(row => JSON.parse(row.attemptJson));
        assert.equal(saved.length, 1); assert.equal(saved[0].status, 'dispatching');
        attemptId = saved[0].id;
        return { id: 'fixture-provider-call', agent_call_id: 'fixture-provider-call', number: 'non-dialable-provider-fixture' };
      },
      async getCall() {
        inspections++;
        acceptedCents = read(attemptId).currentOfferCents;
        return { id: 'fixture-provider-call', agent_id: 'fixture-agent', status: 'completed', transcript: [
          { role: 'assistant', text: `We can offer $${(acceptedCents / 100).toFixed(2)} for transmission access. Does that work for you?` },
          { role: 'user', text: 'Yes, that works for me.' },
        ] };
      },
      async cancelCall() { return { cancelled: true }; },
    },
    reviewer: { async review(input) {
      const offer = input.turns.find(turn => turn.role === 'agent')!, owner = input.turns.find(turn => turn.role === 'owner')!;
      return { ok: true as const, candidate: { decision: 'accepted', acceptedCompensationCents: input.approvedOfferCents[0], condition: null,
        offerTurnId: offer.id, offerQuote: offer.text, evidenceTurnId: owner.id, evidenceQuote: owner.text, reasonCode: 'ACCEPTED' } };
    } },
  });
  const options = { store, runtimeFactory: async () => runtime, createProposal: (input: any) => createVoiceProposal(input, world), world,
    secret: 'sdk-integration-secret-never-used-by-production', now: () => '2026-10-25T12:00:00.000Z' };
  let coordinator = createVoiceCoordinator(options);
  const directory = await mkdtemp(join(tmpdir(), 'easygrid-sdk-voice-'));
  try {
    const baseBank = createDemoBank(), bank = { ...baseBank, transfer: async (input: any) => { transfers++; return baseBank.transfer(input); } };
    const registryOptions = { stateURL: pathToFileURL(join(directory, 'map-contracts.json')), bank,
      resolveProposal: (input: any) => coordinator.resolveProposal(input), resolveNegotiation: (input: any) => coordinator.resolveNegotiation(input) };
    let contracts = await createMapContractService(registryOptions);
    coordinator.setApproveMap((context: any, scope: any) => contracts.approve(context, scope));
    const start = { clientId: 'sdk-browser-client', context, participant: { alias: 'PRIVATE_ROLEPLAY_SENTINEL', phoneE164: '+10000000000', consent: true }, requestKey: 'sdk-start' };
    const receipt = await coordinator.start(start);
    assert.equal(receipt.attemptId, attemptId); assert.equal(calls, 1);
    const opening = read(attemptId).offerCents, requested = opening + Math.floor(opening / 10);
    const tool = await coordinator.tool({ authorization: `Bearer ${attemptSecret}`, providerCallId: 'fixture-provider-call', kind: 'counteroffer',
      input: { requestId: 'sdk-counteroffer', requestedCompensationCents: requested } });
    assert.equal(tool.compensationCents, requested);
    const completed = await coordinator.refresh(attemptId), saved = read(attemptId);
    assert.equal(saved.status, 'accepted', JSON.stringify(saved.outcome)); assert.equal(saved.currentOfferCents, requested);
    assert.equal(saved.candidate.acceptedCompensationCents, requested); assert.equal(saved.outcome.acceptedCompensationCents, requested);
    assert(saved.evidence.some((item: any) => item.turns?.some((turn: any) => turn.id === saved.candidate.evidenceTurnId)));
    assert.equal(completed.acceptedCompensationCents, requested); assert.equal(completed.monthlyRentCents, 0);
    assert.equal(completed.contractApproval.input.parcels.filter((p: any) => p.accepted).length, 1);
    assert.equal(db.db.voiceAttempt.count(), 1n); assert.equal(db.db.obligation.count(), 0n, 'voice reducers never manufacture a bank obligation');

    const approved = completed.contractApproval, draft = createContractDraft(approved.input, approved.demoParcelId, { id: 'sdk-exact-contract' });
    const scope = { demoScope: approved.demoScope, demoParcelId: approved.demoParcelId };
    await contracts.execute(approved.packageId, (flow: any) => flow.sign(draft, 'utility', DEMO_ACTORS.utility), scope);
    await contracts.execute(approved.packageId, (flow: any) => flow.sign(draft, 'landowner', DEMO_ACTORS.landowner), scope);
    const paid = await contracts.execute(approved.packageId, (flow: any) => flow.submit(draft, DEMO_ACTORS.requester), scope);
    assert.equal(paid.payment.status, 'paid'); assert.equal(paid.payment.amountCents, requested);
    assert.equal(paid.journal.length, 1); assert.equal(paid.journal[0].debitCents, requested); assert.equal(paid.journal[0].creditCents, requested);
    assert.equal(transfers, 1);

    await coordinator.start({ ...start, requestKey: 'sdk-repeated-start' }); assert.equal(calls, 1);
    coordinator.close(); coordinator = createVoiceCoordinator(options);
    contracts = await createMapContractService(registryOptions);
    coordinator.setApproveMap((context: any, scope: any) => contracts.approve(context, scope));
    const restored = await coordinator.getResult({ clientId: start.clientId, sessionId: context.sessionId });
    assert.equal(restored.eventId, completed.eventId); assert.equal(restored.approvedAt, completed.approvedAt);
    assert.deepEqual(restored.contractApproval.input, completed.contractApproval.input);
    assert.deepEqual((await coordinator.getActive({ clientId: start.clientId })).record.mapBinding, context.mapBinding);
    await coordinator.start(start); await coordinator.refresh(attemptId);
    const replay = await contracts.execute(approved.packageId, (flow: any) => flow.submit(draft, DEMO_ACTORS.requester), scope);
    assert.equal(calls, 1); assert.equal(inspections, 1); assert.equal(transfers, 1);
    assert.equal(replay.payment.obligationId, paid.payment.obligationId); assert.equal(replay.journal.length, 1);
    const publicText = JSON.stringify({ restored, active: await coordinator.getActive({ clientId: start.clientId }) });
    for (const value of [start.participant.alias, start.participant.phoneE164, attemptSecret, saved.candidate.evidenceQuote, saved.candidate.offerQuote]) assert(!publicText.includes(value));
  } finally { coordinator.close(); await rm(directory, { recursive: true, force: true }); }
});
