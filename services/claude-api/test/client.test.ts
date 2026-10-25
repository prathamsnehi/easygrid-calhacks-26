import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeNegotiationReviewer, reviewCompletedNegotiation, type NegotiationReviewHost } from '../src/client.ts';
import type { NegotiationAttempt } from '@easygrid/contracts';
const offers = [{ termsVersion: 1, compensationCents: 1_000_000, monthlyRentCents: 30000, final: false }];
const turns = [{ id: 'offer', role: 'agent' as const, text: 'We offer $10000 plus $300 per month. Does that work?', startMs: 0, endMs: 3000 },
  { id: 'yes', role: 'owner' as const, text: 'Yes.', startMs: 3500, endMs: 4500 }];
const candidate = { reason: 'AGREED', offerTurnId: 'offer', ownerTurnId: 'yes', compensationCents: 1_000_000, monthlyRentCents: 30000 } as const;
const answer = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

test('one explicit-model request carries only trusted offer history and transcript; result stays provider-neutral', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const reviewer = createClaudeNegotiationReviewer({ apiKey: 'synthetic-key', model: 'test-model', fetch: async (url, init) => {
    assert.equal((init!.headers as Record<string, string>)['x-api-key'], 'synthetic-key');
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return Response.json(answer(JSON.stringify(candidate)));
  } });
  const result = await reviewer.review({ offers, turns });
  assert(result.ok); assert.deepEqual(result.candidate, candidate); assert(result.durationMs >= 0);
  assert.equal(requests.length, 1); assert.equal(requests[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0]!.body.model, 'test-model');
  assert(!JSON.stringify(requests[0]!.body).includes('synthetic-key'));
});
for (const [name, response, reason] of [
  ['HTTP failure', () => Response.json({ error: 'private detail' }, { status: 503 }), 'MODEL_UNAVAILABLE'],
  ['invalid JSON', () => Response.json(answer('not JSON')), 'MALFORMED_OUTPUT'],
  ['extra fields', () => Response.json(answer(JSON.stringify({ ...candidate, bank: 'invented' }))), 'MALFORMED_OUTPUT'],
  ['truncated output', () => Response.json({ ...answer(JSON.stringify(candidate)), stop_reason: 'max_tokens' }), 'MALFORMED_OUTPUT'],
] as const) {
  test(`${name} stays review-required without automatic retry or raw error leakage`, async () => {
    let calls = 0;
    const reviewer = createClaudeNegotiationReviewer({ apiKey: 'synthetic', model: 'test', fetch: async () => { calls++; return response(); } });
    const result = await reviewer.review({ offers, turns });
    assert(!result.ok); assert.equal(result.reason, reason); assert.equal(calls, 1);
    assert(!JSON.stringify(result).includes('private detail'));
  });
}
test('missing transcript makes no request', async () => {
  let calls = 0;
  const reviewer = createClaudeNegotiationReviewer({ apiKey: 'synthetic', model: 'test', fetch: async () => { calls++; throw Error(); } });
  assert.deepEqual((await reviewer.review({ offers, turns: [] })).ok, false); assert.equal(calls, 0);
});
test('bounded request cancellation yields review, never acceptance', async () => {
  const reviewer = createClaudeNegotiationReviewer({ apiKey: 'synthetic', model: 'test', timeoutMs: 10,
    fetch: async (_url, init) => new Promise<Response>((_resolve,reject)=>{
      const keepAlive=setTimeout(()=>reject(new Error('timeout did not abort')),1000);
      const abort=()=>{clearTimeout(keepAlive);reject(new DOMException('aborted','AbortError'));};
      if(init!.signal!.aborted)abort();else init!.signal!.addEventListener('abort',abort,{once:true});
    }) });
  const result = await reviewer.review({ offers, turns }); assert(!result.ok); assert.equal(result.reason, 'MODEL_TIMEOUT');
});
test('durable host claim prevents duplicate extraction and uses a stable finalization receipt', async () => {
  let claimed = false, requests = 0;
  const attempt = { attemptId: 'attempt', routeVersion: 1, phase: 'confirming', offers } as NegotiationAttempt;
  const commits: unknown[] = [];
  const host: NegotiationReviewHost = { claimReview: async () => { if (claimed) return null; claimed = true; return { attempt, turns }; },
    commit: async command => { commits.push(command); return attempt; } };
  const reviewer = { review: async () => { requests++; return { ok: true as const, candidate, durationMs: 12 }; } };
  const result = await reviewCompletedNegotiation(host, reviewer, 'attempt');
  assert.equal(result!.reviewDurationMs, 12); assert.equal(await reviewCompletedNegotiation(host, reviewer, 'attempt'), null);
  assert.equal(requests, 1); assert.equal((commits[0] as { requestId: string }).requestId, 'post-call-review');
});
