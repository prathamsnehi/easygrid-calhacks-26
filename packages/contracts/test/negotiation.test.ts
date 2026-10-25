import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialOwnerHandoff, createOwnerHandoffCurrent } from '../src/owner-handoff-fixtures.ts';
import { applyNegotiationCommand, permittedNegotiationMaximum, negotiationAgreementPacket, negotiationExplanation,
  NegotiationSummary, NegotiationCandidate, type NegotiationState, type NegotiationCommand, type NegotiationTurn, type NegotiationReason } from '../src/negotiation.ts';
import { createNegotiationTools, NEGOTIATION_VOICE_PROMPT } from '../src/negotiation-tools.ts';

function fixture(): NegotiationState {
  const handoff = createInitialOwnerHandoff(); handoff.referenceBinding = 'canonical';
  for (const p of handoff.parcels) {
    p.offerCapCents = Math.floor(p.terms.compensationCents * 6 / 5);
    p.offerPolicy = { policyId: 'recommended-times-1.2-v1', basis: 'route-impact-v1', recommendedOfferCents: p.terms.compensationCents,
      multiplierNumerator: 6, multiplierDenominator: 5, rounding: 'floor-cent' };
  }
  handoff.owners[0]!.contact = { contactRef: 'registered-synthetic', registration: 'registered', callConsent: true };
  const current = createOwnerHandoffCurrent(handoff);
  current.offerPolicies = Object.fromEntries(handoff.parcels.map(p => [p.parcelId, { policyId: p.offerPolicy!.policyId,
    basis: p.offerPolicy!.basis, recommendedOfferCents: p.offerPolicy!.recommendedOfferCents, offerCapCents: p.offerCapCents }]));
  return { active: true, liveCallLocked: false, workflow: 'negotiating', handoff, current, attempts: {}, receipts: {} };
}
function setup(initial = fixture(), attemptId = 'attempt-1', parcelId = 'L001', mode: 'live' | 'simulated' = 'live') {
  let state = initial, seq = 0;
  const run = (args: Record<string, unknown>, turns: NegotiationTurn[] = []) => {
    const termsVersion = state.attempts[attemptId]?.offers.at(-1)?.termsVersion ?? state.current.termsVersions[parcelId];
    const change = applyNegotiationCommand(state, { attemptId, requestId: `operation-${++seq}`, routeVersion: 1, termsVersion, ...args }, turns);
    state = change.state; return change;
  };
  run({ kind: 'prepare', parcelId, mode });
  return { run, get state() { return state; }, get attempt() { return state.attempts[attemptId]!; } };
}
function turns(amount = 1_000_000, owner = 'Yes, that works.'): NegotiationTurn[] {
  return [{ id: 'offer-turn', role: 'agent', text: `We can offer $${amount / 100} plus $300 per month. Does that work for you?`, startMs: 0, endMs: 4000 },
    { id: 'owner-turn', role: 'owner', text: owner, startMs: 4500, endMs: 5500 }];
}
const accepted = (amount = 1_000_000) => ({ reason: 'AGREED', offerTurnId: 'offer-turn', ownerTurnId: 'owner-turn', compensationCents: amount, monthlyRentCents: 30000 });

test('opening offer, fixed exact monthly terms and all-route reservations', () => {
  const initial = fixture(); initial.handoff.parcels[0]!.terms.monthlyRentIsApproximate = true;
  initial.handoff.parcels[0]!.terms.comparisonRentTotalCents = 59999;
  const s = setup(initial);
  assert.equal(s.attempt.offers[0]!.compensationCents, 1_000_000);
  assert.equal(s.state.handoff.parcels[0]!.terms.comparisonRentTotalCents, 60000);
  assert.equal(s.state.handoff.parcels[0]!.terms.monthlyRentIsApproximate, false);
  assert.equal(initial.handoff.revision, 0, 'pure transition never edits original snapshot');
  assert.equal(permittedNegotiationMaximum(s.state.handoff, 'L001'), 1_200_000);
});
for (const [requested, expected] of [[1_100_000, 1_100_000], [1_500_000, 1_200_000], [null, 1_200_000], [900_000, 1_000_000]] as const) {
  test(`single final offer for request ${requested}`, () => {
    const s = setup(); s.run({ kind: 'counteroffer', requestedCents: requested });
    assert.equal(s.attempt.offers.at(-1)!.compensationCents, expected);
    assert.equal(s.attempt.offers.at(-1)!.monthlyRentCents, 30000);
    assert.equal(s.attempt.finalOfferUsed, true); assert.equal(s.attempt.summary, null);
    s.run({ kind: 'counteroffer', requestedCents: 9_000_000 });
    assert.equal(s.attempt.offers.at(-1)!.compensationCents, expected);
    assert(s.attempt.offers.length <= 2);
    assert.equal(s.state.handoff.parcels[0]!.offerPolicy!.recommendedOfferCents, 1_000_000);
  });
}
test('project headroom wins over parcel cap; equality fits and insufficient opening blocks', () => {
  const initial = fixture(); initial.handoff.budgetCents = 12_000_000;
  const s = setup(initial); s.run({ kind: 'counteroffer', requestedCents: 1_500_000 });
  assert.equal(s.attempt.offers.at(-1)!.compensationCents, 1_100_000);
  const exact = fixture(); exact.handoff.budgetCents = 11_900_000;
  const noIncrease = setup(exact); assert.equal(noIncrease.attempt.finalOfferUsed, true);
  exact.handoff.budgetCents--; assert.throws(() => setup(exact), /Opening offer/);
});
test('concurrent parcels reserve each other’s increased offers', () => {
  const initial = fixture(); initial.handoff.budgetCents = 12_100_000;
  const a = setup(initial); a.run({ kind: 'counteroffer', requestedCents: 1_200_000 });
  const b = setup(a.state, 'attempt-2', 'L002', 'simulated');
  assert.equal(permittedNegotiationMaximum(b.state.handoff, 'L002'), 800000);
  b.run({ kind: 'counteroffer', requestedCents: 960000 });
  assert.equal(b.attempt.offers.at(-1)!.compensationCents, 800000);
});
test('clear agreement to the opening offer succeeds without a readback; other parcels still block readiness', () => {
  const s = setup(); s.run({ kind: 'response', response: 'agree', turnId: 'owner-turn' }, turns());
  assert.equal(s.attempt.phase, 'confirming'); assert.equal(s.attempt.summary, null);
  s.run({ kind: 'finalize', candidate: accepted() }, turns());
  assert.equal(s.attempt.summary!.disposition, 'successful');
  assert.equal(s.attempt.summary!.explanation, 'Owner agreed to $10,000 plus $300/month.');
  assert.equal(s.state.handoff.parcels[0]!.terms.accessConsent, 'allowed');
  assert.throws(() => negotiationAgreementPacket(s.state), /Every affected parcel/);
});
test('final increase succeeds, and a brief goodbye does not invalidate owner agreement', () => {
  const s = setup(); s.run({ kind: 'counteroffer', requestedCents: 1_100_000 });
  const transcript = [...turns(1_100_000), { id: 'goodbye', role: 'agent' as const, text: 'Thank you, goodbye.', startMs: 6000, endMs: 7000 }];
  s.run({ kind: 'response', response: 'agree', turnId: 'owner-turn' }, transcript);
  s.run({ kind: 'finalize', candidate: accepted(1_100_000) }, transcript);
  assert.equal(s.attempt.summary!.agreedCents, 1_100_000);
  assert.equal(s.attempt.summary!.termsVersion, 2);
});
test('specific rejected-price explanation does not imply refusal of land access', () => {
  const s = setup(); s.run({ kind: 'counteroffer', requestedCents: 1_500_000 });
  s.run({ kind: 'response', response: 'price_rejected', turnId: 'owner-turn' }, [{id:'requested',role:'owner',text:'I want $15,000.',startMs:0,endMs:500}, ...turns(1_200_000, 'No, that price is too low.').map(t=>({...t,startMs:t.startMs+1000,endMs:t.endMs+1000}))]);
  assert.equal(s.attempt.summary!.explanation, 'Owner requested $15,000; our final offer was $12,000. Price too high.');
  assert.equal(s.attempt.summary!.accessConsent, 'unknown'); assert.equal(s.state.workflow, 'stopped');
  assert.equal(s.attempt.summary!.nextAction, 'stop');
});
for (const [reason, text] of [['ACCESS_REFUSED', 'I do not want transmission lines on my land.'], ['DO_NOT_CALL', 'Stop calling me.']] as const) {
  test(`clear ${reason} stops immediately and locks further live calls`, () => {
    const s = setup(); s.run({ kind: 'refusal', reason, turnId: 'owner-turn' }, turns(1_000_000, text));
    assert.equal(s.attempt.summary!.disposition, 'unsuccessful'); assert(s.state.liveCallLocked);
    assert.equal(s.attempt.offers.length, 1); assert.equal(s.state.workflow, 'stopped');
    s.run({ kind: 'failure', reason: 'MODEL_UNAVAILABLE' });
    assert.equal(s.attempt.summary!.reason, reason, 'later failures never erase definite refusal');
  });
}
for (const [response, reason] of [['unclear', 'UNCLEAR_RESPONSE'], ['conditions', 'ADDITIONAL_CONDITIONS']] as const) {
  test(`${response} stops with review and factual detail`, () => {
    const s = setup(); s.run({ kind: 'response', response, turnId: 'owner-turn' }, turns(1_000_000, 'Maybe, if you move the tower.'));
    assert.equal(s.attempt.summary!.reason, reason); assert.equal(s.attempt.summary!.disposition, 'needs_review');
    assert.equal(s.state.workflow, 'stopped');
  });
}
for (const text of ['I want $10,000.', 'Yes, but move the tower.', 'Maybe.', 'No.', 'Yes to a different offer.']) {
  test(`unconditional acceptance is not inferred from ${text}`, () => {
    const s = setup(); const transcript = turns(1_000_000, text);
    s.run({ kind: 'response', response: 'agree', turnId: 'owner-turn' }, transcript);
    s.run({ kind: 'finalize', candidate: accepted() }, transcript);
    assert.equal(s.attempt.summary!.reason, 'CONFLICTING_EVIDENCE');
  });
}
test('wrong spoken money, fabricated turn, later contradiction and missing live event cannot become accepted', () => {
  for (const scenario of ['money', 'fake', 'later', 'missing']) {
    const s = setup(); const transcript = turns(scenario === 'money' ? 1_200_000 : 1_000_000);
    if (scenario === 'later') transcript.push({ id: 'contradiction', role: 'owner', text: 'Actually, no.', startMs: 6000, endMs: 7000 });
    if (scenario !== 'missing') s.run({ kind: 'response', response: 'agree', turnId: 'owner-turn' }, transcript);
    s.run({ kind: 'finalize', candidate: { ...accepted(), ...(scenario === 'fake' ? { ownerTurnId: 'invented' } : {}) } }, transcript);
    assert.equal(s.attempt.summary!.reason, 'CONFLICTING_EVIDENCE', scenario);
  }
});
for (const reason of ['DISCONNECTED', 'NO_ANSWER', 'BUSY', 'SERVICE_UNAVAILABLE', 'CONNECTION_UNKNOWN', 'TRANSCRIPT_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MALFORMED_OUTPUT', 'TIME_LIMIT'] as const) {
  test(`${reason} has a specific review explanation and does not invent an offer`, () => {
    const s = setup(); s.run({ kind: 'failure', reason });
    const summary = NegotiationSummary.parse(s.attempt.summary);
    assert.equal(summary.disposition, 'needs_review'); assert.equal(summary.offeredCents, null);
    assert(!summary.explanation.includes('$')); assert.equal(s.state.workflow, 'stopped');
  });
}
test('missing transcript and budget changes block acceptance', () => {
  const empty = setup(); empty.run({ kind: 'finalize', candidate: accepted() });
  assert.equal(empty.attempt.summary!.reason, 'TRANSCRIPT_UNAVAILABLE');
  const s = setup(); s.run({ kind: 'response', response: 'agree', turnId: 'owner-turn' }, turns());
  s.state.handoff.budgetCents = 11_899_999;
  s.run({ kind: 'finalize', candidate: accepted() }, turns());
  assert.equal(s.attempt.summary!.reason, 'BUDGET_CHANGED');
});
test('operation replay precedes stale terms, conflicting keys fail, and new delivery keys cannot add an offer', () => {
  const s = setup(); const command = { kind: 'counteroffer', requestedCents: 1_100_000, attemptId: 'attempt-1', requestId: 'final-offer', routeVersion: 1, termsVersion: 1 };
  const once = applyNegotiationCommand(s.state, command), again = applyNegotiationCommand(once.state, command);
  assert.equal(again.replayed, true); assert.deepEqual(again.result, once.result);
  assert.throws(() => applyNegotiationCommand(once.state, { ...command, requestedCents: 1_200_000 }), /different content/);
  const different = applyNegotiationCommand(once.state, { ...command, requestId: 'delivery-2', termsVersion: 2, requestedCents: 1_200_000 });
  assert.equal(different.result.offers.length, 2); assert.equal(different.result.offers[1]!.compensationCents, 1_100_000);
});
test('closed/stale/unbound inputs, forged caps, fractional cents and duplicate attempts are rejected', () => {
  const command = { kind: 'counteroffer', requestedCents: 1_100_000, attemptId: 'attempt-1', requestId: 'check', routeVersion: 1, termsVersion: 1 };
  const s = setup(); const closed = structuredClone(s.state); closed.active = false;
  assert.throws(() => applyNegotiationCommand(closed, command), /closed/);
  assert.throws(() => applyNegotiationCommand(s.state, { ...command, routeVersion: 2 }), /Route changed/);
  assert.throws(() => applyNegotiationCommand(s.state, { ...command, termsVersion: 2 }), /Terms changed/);
  assert.throws(() => applyNegotiationCommand(s.state, { ...command, requestedCents: 12.5 }), /Invalid negotiation/);
  assert.throws(() => applyNegotiationCommand(s.state, { kind: 'prepare', attemptId: 'attempt-1', routeVersion: 1, termsVersion: 1, parcelId: 'L001', mode: 'live', requestId: 'another-prepare' }), /Invalid negotiation|already exists/);
  const unbound = fixture(); unbound.handoff.referenceBinding = 'local-fixture'; assert.throws(() => setup(unbound), /local fixture|bind/);
  const forged = fixture(); forged.current.offerPolicies!.L001!.recommendedOfferCents++; assert.throws(() => setup(forged), /authoritative/);
});
test('tools resolve binding on the server and return only concise safe fields', async () => {
  const s = setup(); let authorizations = 0;
  const tool = createNegotiationTools({ authorize: async credential => { assert.equal(credential, 'synthetic-auth'); authorizations++;
    return { attemptId: 'attempt-1', sessionId: s.state.handoff.sessionId, routeVersion: 1, termsVersion: 1 }; },
    execute: async (_binding, command: NegotiationCommand) => s.run(command).result });
  await assert.rejects(tool({ credential: '', callReference: 'call', input: {} }), /Authenticated/);
  await assert.rejects(tool({ credential: 'synthetic-auth', callReference: 'call', input: { tool: 'evaluate_counteroffer', requestId: 'tool', requestedCents: 1_100_000, attemptId: 'forged' } }), /Invalid decision/);
  const result = await tool({ credential: 'synthetic-auth', callReference: 'call', input: { tool: 'evaluate_counteroffer', requestId: 'tool', requestedCents: 1_100_000 } });
  assert.equal(result.compensationCents, 1_100_000); assert(result.finalOffer); assert(result.aboveRecommendation);
  assert.equal(authorizations, 2); assert(!JSON.stringify(result).includes('registered-synthetic'));
  assert(NEGOTIATION_VOICE_PROMPT.includes('30–45')); assert(NEGOTIATION_VOICE_PROMPT.includes('no formal readback'));
});
test('floor-cent cap and unsafe aggregate values are handled exactly', () => {
  const state = fixture(), p = state.handoff.parcels[0]!;
  p.terms.compensationCents = 101737; p.offerPolicy!.recommendedOfferCents = 101737; p.offerCapCents = 122084;
  state.current.offerPolicies!.L001!.recommendedOfferCents = 101737; state.current.offerPolicies!.L001!.offerCapCents = 122084;
  const s = setup(state); assert.equal(permittedNegotiationMaximum(s.state.handoff, 'L001'), 122084);
  const overflow = fixture(); overflow.handoff.parcels[0]!.terms.monthlyRentIsApproximate = true;
  overflow.handoff.parcels[0]!.terms.monthlyRentCents = Number.MAX_SAFE_INTEGER;
  assert.throws(() => setup(overflow), /safe integer/);
});

test('tool response can be staged before the transcript exists; only actual completed evidence accepts', () => {
  const s = setup(); s.run({ kind: 'response', response: 'agree', turnId: null });
  assert.equal(s.attempt.phase, 'confirming'); assert.equal(s.attempt.summary, null);
  s.run({ kind: 'finalize', candidate: accepted() }, turns());
  assert.equal(s.attempt.summary!.disposition, 'successful');
});
test('unverified live refusal immediately locks and stops, then actual transcript corroborates', () => {
  const s = setup(); s.run({ kind: 'refusal', reason: 'DO_NOT_CALL', turnId: null });
  assert(s.state.liveCallLocked); assert.equal(s.state.workflow, 'stopped'); assert.equal(s.attempt.summary, null);
  s.run({ kind: 'finalize', candidate: { reason: 'DO_NOT_CALL', offerTurnId: null, ownerTurnId: 'owner-turn', compensationCents: null, monthlyRentCents: null } }, turns(1_000_000, 'Stop calling me.'));
  assert.equal(s.attempt.summary!.reason, 'DO_NOT_CALL');
});
test('tool claims cannot invent requested price or a price rejection', () => {
  const s = setup(); s.run({ kind: 'counteroffer', requestedCents: 1_500_000 });
  s.run({ kind: 'response', response: 'price_rejected', turnId: 'owner-turn' }, turns(1_200_000, 'No, that price is too low.'));
  assert.equal(s.attempt.summary!.requestedCents, null);
  assert(!s.attempt.summary!.explanation.includes('$15,000'));
  const positive = setup(); positive.run({ kind: 'response', response: 'price_rejected', turnId: 'owner-turn' }, turns());
  assert.equal(positive.attempt.summary!.reason, 'CONFLICTING_EVIDENCE');
});
test('a simulation cannot replace an existing uncertain live attempt', () => {
  const s = setup(); s.run({ kind: 'failure', reason: 'CONNECTION_UNKNOWN' });
  assert.throws(() => applyNegotiationCommand(s.state, { kind: 'prepare', attemptId: 'simulated-replacement', requestId: 'new', routeVersion: 1,
    termsVersion: 1, parcelId: 'L001', mode: 'simulated' }), /stopped/);
});
test('acceptance cannot come from rewritten or duplicated transcript turns', () => {
  const s = setup(); s.run({ kind: 'response', response: 'agree', turnId: 'owner-turn' }, turns());
  const changed = turns(); changed[1]!.text = 'I disagree.';
  assert.throws(() => s.run({ kind: 'finalize', candidate: accepted() }, changed), /Transcript changed/);
  assert.throws(() => s.run({ kind: 'finalize', candidate: accepted() }, [...turns(), turns()[0]!]), /identities\/order/);
});

test('spoken-word dollar amounts and a natural short yes can confirm the exact offer', () => {
  const s = setup(), transcript = turns(1_000_000, 'Yeah, that sounds good.');
  transcript[0]!.text = 'We can offer ten thousand dollars plus three hundred dollars per month. Does that work for you?';
  s.run({kind:'response',response:'agree',turnId:'owner-turn'},transcript);
  s.run({kind:'finalize',candidate:accepted()},transcript);
  assert.equal(s.attempt.summary!.disposition,'successful');
});
test('a yes to a different trailing question cannot establish acceptance', () => {
  const s=setup(),transcript=turns();transcript[0]!.text += ' Are you still there?';
  s.run({kind:'response',response:'agree',turnId:'owner-turn'},transcript);
  s.run({kind:'finalize',candidate:accepted()},transcript);
  assert.equal(s.attempt.summary!.reason,'CONFLICTING_EVIDENCE');
});


test('mismatched spoken terms give the actual and approved amounts in the review reason', () => {
  const s=setup(),transcript=turns(1_200_000);
  s.run({kind:'response',response:'agree',turnId:'owner-turn'},transcript);
  s.run({kind:'finalize',candidate:accepted()},transcript);
  assert.equal(s.attempt.summary!.explanation,'Agent stated $12,000 plus $300/month; approved terms were $10,000 plus $300/month. Terms did not match.');
});

test('a natural polite closing is allowed after the owner agreed', () => {
  const s=setup(),transcript=[...turns(),{id:'closing',role:'agent' as const,text:'Thanks very much for your time. Have a great day, goodbye!',startMs:6000,endMs:8000}];
  s.run({kind:'response',response:'agree',turnId:'owner-turn'},transcript);
  s.run({kind:'finalize',candidate:accepted()},transcript);
  assert.equal(s.attempt.summary!.disposition,'successful');
});
test('all affected parcels must agree before the shared agreement packet unlocks', () => {
  const a=setup();a.run({kind:'response',response:'agree',turnId:'owner-turn'},turns());a.run({kind:'finalize',candidate:accepted()},turns());
  const b=setup(a.state,'attempt-2','L002','simulated');
  const transcript=turns(800000);transcript[0]!.text='We can offer $8000 plus $200 per month. Does that work for you?';
  b.run({kind:'response',response:'agree',turnId:'owner-turn'},transcript);
  b.run({kind:'finalize',candidate:{...accepted(800000),monthlyRentCents:20000}},transcript);
  assert.equal(negotiationAgreementPacket(b.state).routeStatus,'ready_for_agreements');
});


test('a later refusal tool candidate cannot reuse an earlier agreement event', () => {
  const s=setup();s.run({kind:'response',response:'agree',turnId:null});
  s.run({kind:'refusal',reason:'DO_NOT_CALL',turnId:null});
  s.run({kind:'finalize',candidate:accepted()},turns());
  assert.equal(s.attempt.summary!.disposition,'needs_review');
  assert.equal(s.state.workflow,'stopped');assert(s.state.liveCallLocked);
});

test('a price objection alone cannot corroborate categorical access refusal', () => {
  const s=setup();const transcript=turns(1_000_000,"I don't want that price. I'd need more.");
  s.run({kind:'finalize',candidate:{...accepted(),reason:'ACCESS_REFUSED'}},transcript);
  assert.equal(s.attempt.summary!.reason,'CONFLICTING_EVIDENCE');
  assert.equal(s.attempt.summary!.accessConsent,'unknown');
});

for(const text of ["We cannot offer $10000 plus $300 per month. Does that work for you?",
  'We can offer $10000 plus $300 per month if the budget changes. Does that work for you?']) {
  test(`a yes to unavailable or conditional spoken terms cannot establish agreement: ${text}`,()=>{
    const s=setup(),transcript=turns();transcript[0]!.text=text;
    s.run({kind:'response',response:'agree',turnId:'owner-turn'},transcript);
    s.run({kind:'finalize',candidate:accepted()},transcript);
    assert.equal(s.attempt.summary!.disposition,'needs_review');
  });
}

test('a friendly no-problem reply is not evidence of a price refusal', () => {
  const s=setup();s.run({kind:'finalize',candidate:{...accepted(),reason:'PRICE_REJECTED'}},turns(1_000_000,'No problem, that works.'));
  assert.equal(s.attempt.summary!.reason,'CONFLICTING_EVIDENCE');
});


test('model extraction cannot invent provider failure facts', () => {
  for(const reason of ['BUSY','NO_ANSWER','DISCONNECTED','TIME_LIMIT','MODEL_TIMEOUT']) {
    assert.equal(NegotiationCandidate.safeParse({...accepted(),reason}).success,false);
  }
});
