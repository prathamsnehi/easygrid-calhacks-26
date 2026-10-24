import test from 'node:test';
import assert from 'node:assert/strict';
import { negotiationLimitCents, createOfferPolicy } from '../src/offer-policy.js';

test('negotiation ceiling is exactly 120 percent, floored to a payable cent',()=>{
  for(const [recommended,limit] of [[0,0],[1,1],[2,2],[3,3],[4,4],[5,6],[101737,122084],[100000,120000]]){
    assert.equal(negotiationLimitCents(recommended),limit);
    assert(BigInt(limit)*5n<=BigInt(recommended)*6n);
    assert(BigInt(limit+1)*5n>BigInt(recommended)*6n);
    assert.deepEqual(createOfferPolicy(recommended),{policyId:'recommended-times-1.2-v1',basis:'route-impact-v1',
      recommendedOfferCents:recommended,multiplierNumerator:6,multiplierDenominator:5,rounding:'floor-cent'});
  }
});

test('invalid and overflowing recommendations fail instead of silently changing the cap',()=>{
  for(const amount of [-1,1.2,NaN,Infinity,undefined,null,'100',Number.MAX_SAFE_INTEGER]){
    assert.throws(()=>negotiationLimitCents(amount));
    assert.throws(()=>createOfferPolicy(amount));
  }
  const largest=Number((BigInt(Number.MAX_SAFE_INTEGER)*5n+4n)/6n);
  assert(Number.isSafeInteger(negotiationLimitCents(largest)));
});
