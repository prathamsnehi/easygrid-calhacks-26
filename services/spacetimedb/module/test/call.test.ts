import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { decideReview, VOICE_PROMPT } from '../src/call-logic.ts';
import { offerCapCents } from '../src/logic.ts';
import * as module from '../src/index.ts';

const PHONE = '+15551219999';
const env = {
  CARTESIA_API_KEY: 'test-cartesia',
  CARTESIA_VOICE_ID: 'voice',
  CARTESIA_MODEL_ID: 'model',
  CARTESIA_FROM_NUMBER_ID: 'from-number',
  CARTESIA_FALLBACK_TO_NUMBER: '',
  CARTESIA_NEGOTIATION_AGENT_ID: 'agent-test',
  ANTHROPIC_API_KEY: 'test-anthropic',
  ANTHROPIC_MODEL: 'claude-sonnet-5-5',
};

function harness() {
  return createModuleTestHarness(module.default, module);
}

function httpResponse(code: number, body: string) {
  return { code, headers: { entries: [] }, version: { tag: 'Http11' as const }, body };
}

function installEnv(): void {
  (globalThis as { __easygridTestEnv?: typeof env }).__easygridTestEnv = env;
}

function parcel(id: string, recommended = 10_000) {
  return {
    sessionId: 'call-1',
    phone: PHONE,
    consent: true,
    projectBudgetCents: 5_000_000,
    requestKey: 'dial-1',
    parcelId: id,
    ownerAlias: `Owner ${id}`,
    towerCount: 1,
    lineLengthMillis: 1000,
    recommendedOfferCents: recommended,
    offerCapCents: offerCapCents(recommended),
    monthlyRentCents: 2500,
  };
}

test('the spoken prompt names two prices and no decision tools', () => {
  const contracts = readFileSync(new URL('../../../../packages/contracts/src/negotiation-tools.ts', import.meta.url), 'utf8');
  assert.equal(contracts.includes(VOICE_PROMPT), true);
  for (const name of ['evaluate_counteroffer', 'record_owner_response', 'record_refusal']) {
    assert.equal(VOICE_PROMPT.includes(name), false);
  }
  assert.equal(VOICE_PROMPT.includes('final_compensation'), true);
});

test('agreement is saved only for the opening or the one final amount', () => {
  const turns = [
    { id: 'a', role: 'agent', text: 'Our proposal is $100.00 plus $25.00 per month. Does that work for you?' },
    { id: 'b', role: 'owner', text: 'Yes' },
  ];
  const base = { openingCents: 10_000, finalCents: 12_000, monthlyRentCents: 2500, turns, failureReason: '' };
  const agreed = decideReview({ ...base, candidate: { reason: 'AGREED', offerTurnId: 'a', ownerTurnId: 'b', compensationCents: 10_000, monthlyRentCents: 2500 } });
  assert.equal(agreed.outcome, 'accepted');
  assert.equal(agreed.agreedCents, 10_000);
  assert.equal(agreed.nextAction, 'continue');
  const finalOffer = decideReview({
    ...base,
    turns: [
      { id: 'a', role: 'agent', text: 'The final available offer is $120.00 plus $25.00 per month. Does that work for you?' },
      { id: 'b', role: 'owner', text: 'That works' },
    ],
    candidate: { reason: 'AGREED', offerTurnId: 'a', ownerTurnId: 'b', compensationCents: 12_000, monthlyRentCents: 2500 },
  });
  assert.equal(finalOffer.outcome, 'accepted');
  const other = decideReview({ ...base, candidate: { reason: 'AGREED', offerTurnId: 'a', ownerTurnId: 'b', compensationCents: 11_000, monthlyRentCents: 2500 } });
  assert.equal(other.outcome, 'pending');
  assert.equal(other.reason, 'CONFLICTING_EVIDENCE');
  const refused = decideReview({ ...base, turns: [{ id: 'b', role: 'owner', text: 'Please do not call me again.' }], candidate: { reason: 'DO_NOT_CALL', offerTurnId: '', ownerTurnId: 'b', compensationCents: null, monthlyRentCents: null } });
  assert.equal(refused.lockLiveCalls, true);
  assert.equal(refused.outcome, 'refused');
});

test('a committed review is redacted and a second dial is refused', () => {
  installEnv();
  const db = harness();
  const calls: string[] = [];
  const ctx = db.procedureContextBuilder(TestAuth.internal()).http((_test, req) => {
    calls.push(req.uri);
    if (req.uri.endsWith('/agents/calls')) {
      return httpResponse(200, JSON.stringify({ calls: [{ agent_call_id: 'provider-1' }] }));
    }
    return httpResponse(500, '');
  }).build();
  assert.equal(module.start_call(ctx, parcel('L001')), 'requested');
  assert.equal(calls.length, 1);
  assert.equal(module.start_call(ctx, parcel('L001')), 'requested');
  assert.equal(calls.length, 1);
  const attempt = [...db.db.callAttempt.bySession.filter('call-1')][0];
  assert.equal(attempt?.providerCallId, 'provider-1');
  assert.equal(attempt?.openingCents, 10_000);
  assert.equal(attempt?.finalCents, offerCapCents(10_000));
  db.withReducerTx(TestAuth.internal(), tx => {
    tx.db.callTurn.insert({ id: `${attempt!.attemptId}-0`, attemptId: attempt!.attemptId, role: 'owner', text: 'I refuse transmission on my land.', startMs: 0, endMs: 1000, ordinal: 0 });
    module.commit_call_review(tx, {
      attemptId: attempt!.attemptId, reason: 'ACCESS_REFUSED', offerTurnId: '', ownerTurnId: `${attempt!.attemptId}-0`,
      compensationCents: 0, monthlyRentCents: 0, hasAmounts: false, failureReason: '',
    });
  });
  const view = db.withReducerTx(TestAuth.internal(), tx => module.call_result(tx, { sessionId: 'call-1' }));
  const encoded = JSON.stringify(view);
  assert.equal(encoded.includes(PHONE), false);
  assert.equal(encoded.includes('refuse transmission'), false);
  assert.equal(view[0]?.reason, 'ACCESS_REFUSED');
  assert.equal(view[0]?.outcome, 'refused');
  assert.equal(db.db.contact.sessionId.find('call-1')?.phone, PHONE);
  assert.throws(() => module.start_call(ctx, { ...parcel('L009'), requestKey: 'dial-2' }), /BLOCKED_STATE/);
  assert.equal(calls.length, 1);
});

test('a provider failure is a labeled simulation and an allowed yes is saved after hangup', () => {
  installEnv();
  const failed = harness();
  const failedCtx = failed.procedureContextBuilder(TestAuth.internal()).http(() => httpResponse(503, '{"phone":"+15551219999"}')).build();
  assert.equal(module.start_call(failedCtx, { ...parcel('L002'), sessionId: 'call-fail', requestKey: 'dial-fail' }), 'requested');
  const failedView = failed.withReducerTx(TestAuth.internal(), tx => module.call_result(tx, { sessionId: 'call-fail' }));
  assert.equal(failedView[0]?.mode, 'simulated');
  assert.equal(failedView[0]?.reason, 'SERVICE_UNAVAILABLE');
  assert.equal(JSON.stringify(failedView).includes(PHONE), false);
  assert.equal([...failed.db.callAttempt.bySession.filter('call-fail')][0]?.providerCallId, '');

  const db = harness();
  const ctx = db.procedureContextBuilder(TestAuth.internal()).http((_test, req, body) => {
    const text = new TextDecoder().decode(body);
    if (req.uri.endsWith('/agents/calls')) return httpResponse(200, JSON.stringify({ calls: [{ agent_call_id: 'provider-2' }] }));
    if (req.uri.includes('/agents/calls/')) {
      return httpResponse(200, JSON.stringify({
        status: 'completed',
        transcript: [
          { role: 'agent', text: 'Our proposal is $100.00 plus $25.00 per month for transmission access across this parcel. Does that work for you?', start_timestamp: 0, end_timestamp: 2 },
          { role: 'user', text: 'Yes', start_timestamp: 2.2, end_timestamp: 3 },
        ],
      }));
    }
    const request = JSON.parse(text) as { messages: { content: string }[] };
    const transcript = JSON.parse(request.messages[0]!.content) as { transcript: { id: string; role: string }[]; allowedCompensationCents: number[] };
    const owner = transcript.transcript.find(turn => turn.role === 'owner');
    return httpResponse(200, JSON.stringify({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ reason: 'AGREED', offerTurnId: transcript.transcript[0]?.id ?? '', ownerTurnId: owner?.id ?? '', compensationCents: transcript.allowedCompensationCents[0], monthlyRentCents: 2500 }) }],
    }));
  }).build();
  module.start_call(ctx, { ...parcel('L001'), sessionId: 'call-yes', requestKey: 'dial-yes' });
  const attempt = [...db.db.callAttempt.bySession.filter('call-yes')][0];
  module.check_call(ctx, { check: { scheduledId: 1n, scheduledAt: { tag: 'Time', value: { __timestamp_micros_since_unix_epoch__: 0n } }, attemptId: attempt!.attemptId } });
  const view = db.withReducerTx(TestAuth.internal(), tx => module.call_result(tx, { sessionId: 'call-yes' }));
  assert.equal(view[0]?.reason, 'AGREED');
  assert.equal(view[0]?.outcome, 'accepted');
  assert.equal(view[0]?.agreedCents, 10_000);
  assert.equal(view[0]?.mode, 'live');
  const saved = JSON.stringify(view);
  assert.equal(saved.includes(PHONE), false);
  assert.equal(saved.includes('transmission access across this parcel'), false);
});

test('reset_demo_call stops the scheduled check and does not redial that session', () => {
  installEnv();
  const db = harness();
  const calls: string[] = [];
  const ctx = db.procedureContextBuilder(TestAuth.internal()).http((_test, req) => {
    calls.push(req.uri);
    if (req.uri.endsWith('/agents/calls')) return httpResponse(200, JSON.stringify({ calls: [{ agent_call_id: 'provider-reset' }] }));
    if (req.uri.endsWith('/cancel')) return httpResponse(200, '{"cancelled":true}');
    return httpResponse(500, '');
  }).build();
  assert.equal(module.start_call(ctx, { ...parcel('L003'), sessionId: 'call-reset', requestKey: 'dial-reset' }), 'requested');
  const attempt = [...db.db.callAttempt.bySession.filter('call-reset')][0];
  assert.equal([...db.db.callCheck.iter()].some(row => row.attemptId === attempt?.attemptId), true);
  assert.equal(module.reset_demo_call(ctx, { sessionId: 'call-reset' }), 'reset');
  assert.equal(calls.some(uri => uri.endsWith('/provider-reset/cancel')), true);
  const superseded = [...db.db.callAttempt.bySession.filter('call-reset')][0];
  assert.equal(superseded?.phase, 'finished');
  assert.equal(superseded?.reason, 'SUPERSEDED');
  assert.equal([...db.db.callCheck.iter()].some(row => row.attemptId === attempt?.attemptId), false);
  assert.equal(module.start_call(ctx, { ...parcel('L003'), sessionId: 'call-reset', requestKey: 'dial-reset-again' }), 'requested');
  assert.equal(calls.filter(uri => uri.endsWith('/agents/calls')).length, 1);
  assert.equal(module.start_call(ctx, { ...parcel('L004'), sessionId: 'call-reset-next', requestKey: 'dial-next' }), 'requested');
  assert.equal(calls.filter(uri => uri.endsWith('/agents/calls')).length, 2);
});

test('a do-not-call session stays locked when reset is requested', () => {
  installEnv();
  const db = harness();
  const ctx = db.procedureContextBuilder(TestAuth.internal()).http((_test, req) => {
    if (req.uri.endsWith('/agents/calls')) return httpResponse(200, JSON.stringify({ calls: [{ agent_call_id: 'provider-locked' }] }));
    return httpResponse(500, '');
  }).build();
  module.start_call(ctx, { ...parcel('L005'), sessionId: 'call-locked', requestKey: 'dial-locked' });
  const attempt = [...db.db.callAttempt.bySession.filter('call-locked')][0];
  db.withReducerTx(TestAuth.internal(), tx => {
    tx.db.callTurn.insert({ id: `${attempt!.attemptId}-0`, attemptId: attempt!.attemptId, role: 'owner', text: 'Please do not call me again.', startMs: 0, endMs: 1000, ordinal: 0 });
    module.commit_call_review(tx, {
      attemptId: attempt!.attemptId, reason: 'DO_NOT_CALL', offerTurnId: '', ownerTurnId: `${attempt!.attemptId}-0`,
      compensationCents: 0, monthlyRentCents: 0, hasAmounts: false, failureReason: '',
    });
  });
  assert.throws(() => module.reset_demo_call(ctx, { sessionId: 'call-locked' }), /BLOCKED_STATE/);
  assert.equal([...db.db.callAttempt.bySession.filter('call-locked')][0]?.reason, 'DO_NOT_CALL');
  assert.throws(() => module.start_call(ctx, { ...parcel('L005'), sessionId: 'call-locked', requestKey: 'dial-locked-2' }), /BLOCKED_STATE/);
});

test('a provider id that arrives after reset is cancelled instead of saved as a live call', () => {
  installEnv();
  const db = harness();
  const calls: string[] = [];
  const ctx = db.procedureContextBuilder(TestAuth.internal()).http((_test, req) => {
    calls.push(req.uri);
    if (req.uri.endsWith('/agents/calls')) {
      module.reset_demo_call(ctx, { sessionId: 'call-late' });
      return httpResponse(200, JSON.stringify({ calls: [{ agent_call_id: 'provider-late' }] }));
    }
    if (req.uri.endsWith('/cancel')) return httpResponse(200, '{"cancelled":true}');
    return httpResponse(500, '');
  }).build();
  assert.equal(module.start_call(ctx, { ...parcel('L006'), sessionId: 'call-late', requestKey: 'dial-late' }), 'requested');
  const attempt = [...db.db.callAttempt.bySession.filter('call-late')][0];
  assert.equal(attempt?.reason, 'SUPERSEDED');
  assert.equal(attempt?.providerCallId, 'provider-late');
  assert.equal(calls.some(uri => uri.endsWith('/provider-late/cancel')), true);
  assert.equal([...db.db.callCheck.iter()].some(row => row.attemptId === attempt?.attemptId), false);
});
