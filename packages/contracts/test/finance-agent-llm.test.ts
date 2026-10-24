import test from 'node:test';
import assert from 'node:assert/strict';
import {explainFinanceExceptions} from '../src/finance-agent-llm.ts';
import {emptyCal37State} from '../src/cal37-approval.ts';
import {emptyLaterState} from '../src/cal38-39-settlement.ts';

test('Hyphenate finance LLM reasoner gets redacted policy actions and cannot authorize payments',async()=>{
 const report=await explainFinanceExceptions(emptyCal37State(),emptyLaterState(),{
  async explain(input){
   assert.equal(input.severity,'review');
   assert.deepEqual(input.expectedActionIds,['approval','nessie']);
   assert.equal(JSON.stringify(input).includes('recipientDisplay'),false);
   return {summary:'Review manager approval and sandbox evidence.',rankedActionIds:['nessie','approval']};
  }
 });
 assert.equal(report.modelUsed,true);
 assert.equal(report.requiresHumanApproval,true);
 assert.deepEqual(report.safeActions.map(a=>a.id),['nessie','approval']);
 assert.ok(report.safeActions.every(a=>a.autoExecute===false));
});
test('Finance AI hallucinated tools and omitted actions are blocked',async()=>{
 const baseline=[emptyCal37State(),emptyLaterState()] as const;
 await assert.rejects(explainFinanceExceptions(...baseline,{
  async explain(){return {summary:'Transfer cash now',rankedActionIds:['send-money','approval']}}
 }));
 await assert.rejects(explainFinanceExceptions(...baseline,{
  async explain(){return {summary:'Too few actions',rankedActionIds:['approval']}}
 }));
});
